import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {update,officialOrigin} from '../lib/update.mjs'

const exec=promisify(execFile)
function git(root,...args){return execFileSync('git',['-c','safe.directory='+root,'-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim()}
function fixture(t,{advance=true}={}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-update-')),root=path.join(temp,'plugin'),remote=path.join(temp,'official.git'),upstream=path.join(temp,'upstream')
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100}))
  fs.mkdirSync(root);git(root,'init','--initial-branch=main');git(root,'config','user.name','Test');git(root,'config','user.email','test@example.invalid')
  fs.writeFileSync(path.join(root,'.gitignore'),'data/\nconfig/local.json\n')
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'groupguard-plugin',version:'2.0.0'}))
  fs.writeFileSync(path.join(root,'source.mjs'),'export const value=1\n');git(root,'add','.');git(root,'commit','-m','baseline')
  git(temp,'clone','--bare',root,remote);git(root,'remote','add','origin',officialOrigin)
  git(temp,'clone',remote,upstream);git(upstream,'config','user.name','Test');git(upstream,'config','user.email','test@example.invalid')
  if(advance){fs.writeFileSync(path.join(upstream,'source.mjs'),'export const value=2\n');fs.writeFileSync(path.join(upstream,'package.json'),JSON.stringify({name:'groupguard-plugin',version:'2.0.1'}));git(upstream,'add','.');git(upstream,'commit','-m','next');git(upstream,'push','origin','main')}
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'data'))
  fs.writeFileSync(path.join(root,'config/local.json'),'synthetic private config');fs.writeFileSync(path.join(root,'data/state.json'),'synthetic state')
  const calls=[]
  const runGit=async(args,{cwd,timeoutMs})=>{
    calls.push([...args]);const actual=[...args]
    if(['fetch','pull'].includes(actual[0]))actual[actual.indexOf('origin')]=remote
    return exec('git',['-c','safe.directory='+cwd,'-c','core.hooksPath=','-C',cwd,...actual],{encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024,windowsHide:true})
  }
  return {root,temp,remote,upstream,runGit,calls,target:git(upstream,'rev-parse','HEAD')}
}

test('官方main快进更新，保留配置/data并记录前后提交，不重启或安装依赖',async t=>{
  const f=fixture(t),before=git(f.root,'rev-parse','HEAD'),message=await update(f.root,{runGit:f.runGit})
  assert(message.includes('源码已拉取'));assert(message.includes('重启'))
  assert.equal(git(f.root,'rev-parse','HEAD'),f.target)
  assert.equal(fs.readFileSync(path.join(f.root,'config/local.json'),'utf8'),'synthetic private config')
  assert.equal(fs.readFileSync(path.join(f.root,'data/state.json'),'utf8'),'synthetic state')
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'data/update-history.json'),'utf8')).at(-1)
  assert.equal(record.before,before);assert.equal(record.after,f.target);assert.equal(record.status,'updated')
  assert(f.calls.some(args=>args.join(' ')==='pull --ff-only --no-rebase origin main'))
  assert(!f.calls.some(args=>['reset','clean','stash'].includes(args[0])))
  assert(!fs.existsSync(path.join(f.root,'data/update.lock')))
})

test('已经最新可准确报告',async t=>{
  const f=fixture(t,{advance:false});assert((await update(f.root,{runGit:f.runGit})).includes('已经最新'))
})

test('脏树、错误来源、异常分支和进行中合并均在拉取前停止',async t=>{
  for(const change of [
    f=>fs.writeFileSync(path.join(f.root,'untracked.txt'),'local'),
    f=>git(f.root,'remote','set-url','origin','https://example.invalid/private-token'),
    f=>git(f.root,'checkout','-b','feature'),
    f=>git(f.root,'checkout','--detach'),
    f=>fs.writeFileSync(path.join(f.root,'.git/MERGE_HEAD'),f.target)
  ]){
    const f=fixture(t);change(f);const before=git(f.root,'rev-parse','HEAD')
    await assert.rejects(update(f.root,{runGit:f.runGit}),error=>!error.message.includes('private-token'))
    assert.equal(git(f.root,'rev-parse','HEAD'),before);assert(!f.calls.some(args=>args[0]==='pull'||args[0]==='fetch'))
  }
})

test('实例路径被跟踪、上层仓库、ZIP安装明确拒绝',async t=>{
  const f=fixture(t);git(f.root,'add','-f','config/local.json');git(f.root,'commit','-m','invalid tracked instance')
  await assert.rejects(update(f.root,{runGit:f.runGit}),/Git 跟踪/)
  const sub=path.join(f.root,'nested');fs.mkdirSync(sub)
  await assert.rejects(update(sub,{runGit:f.runGit}),/Git 根目录不是本插件/)
  const zip=path.join(f.temp,'zip');fs.mkdirSync(zip)
  await assert.rejects(update(zip,{runGit:f.runGit}),/ZIP 安装/)
})

test('分叉不覆盖本地提交；官方目标包含实例文件也不合并',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'local.mjs'),'local');git(f.root,'add','.');git(f.root,'commit','-m','local change')
  const before=git(f.root,'rev-parse','HEAD')
  await assert.rejects(update(f.root,{runGit:f.runGit}),/分叉/);assert.equal(git(f.root,'rev-parse','HEAD'),before)
  const g=fixture(t);fs.mkdirSync(path.join(g.upstream,'data'));fs.writeFileSync(path.join(g.upstream,'data/bad.json'),'synthetic');git(g.upstream,'add','-f','data/bad.json');git(g.upstream,'commit','-m','invalid data');git(g.upstream,'push','origin','main')
  await assert.rejects(update(g.root,{runGit:g.runGit}),/目标提交含实例/)
  assert(!g.calls.some(args=>args[0]==='pull'))
})

test('拉取已完成后返回超时，读回确认而不重复拉取',async t=>{
  const f=fixture(t);let pulls=0
  const runGit=async(args,options)=>{const result=await f.runGit(args,options);if(args[0]==='pull'){pulls++;const error=new Error('simulated timeout');error.timedOut=true;throw error}return result}
  const message=await update(f.root,{runGit});assert(message.includes('已核验'));assert.equal(pulls,1);assert.equal(git(f.root,'rev-parse','HEAD'),f.target)
})

test('拉取超时未能证明完成，保存未知结果且不自动重试',async t=>{
  const f=fixture(t);let pulls=0
  const runGit=async(args,options)=>{if(args[0]==='pull'){pulls++;const error=new Error('secret raw remote details');error.timedOut=true;throw error}return f.runGit(args,options)}
  await assert.rejects(update(f.root,{runGit}),error=>error.message.includes('不确定')&&!error.message.includes('secret'))
  assert.equal(pulls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'data/update-history.json'),'utf8')).at(-1).status,'pull-unknown')
})

test('同插件并发更新只有一个进入拉取',async t=>{
  const f=fixture(t);let release,entered
  const waiting=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  const runGit=async(args,options)=>{if(args[0]==='pull'){entered();await gate}return f.runGit(args,options)}
  const first=update(f.root,{runGit});await waiting
  await assert.rejects(update(f.root,{runGit}),/正在更新/);release();await first
  assert.equal(f.calls.filter(args=>args[0]==='pull').length,1)
})

test('获取来源失败或超时不进入pull，不泄露原始网络错误',async t=>{
  for(const timedOut of [false,true]){
    const f=fixture(t),before=git(f.root,'rev-parse','HEAD')
    const runGit=async(args,options)=>{if(args[0]==='fetch'){const error=new Error('https://secret.invalid/token');error.timedOut=timedOut;throw error}return f.runGit(args,options)}
    await assert.rejects(update(f.root,{runGit}),error=>error.message.includes('获取官方')&&!error.message.includes('secret'))
    assert.equal(git(f.root,'rev-parse','HEAD'),before);assert(!f.calls.some(args=>args[0]==='pull'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'data/update-history.json'),'utf8')).at(-1).status,timedOut?'fetch-unknown':'fetch-failed')
  }
})

test('上次遗留锁不被自动删除，也不重复进入网络阶段',async t=>{
  const f=fixture(t),lock=path.join(f.root,'data/update.lock')
  fs.writeFileSync(lock,'synthetic previous update')
  await assert.rejects(update(f.root,{runGit:f.runGit}),/更新锁/)
  assert.equal(fs.readFileSync(lock,'utf8'),'synthetic previous update')
  assert(!f.calls.some(args=>args[0]==='fetch'||args[0]==='pull'))
})
