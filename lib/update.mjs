import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'

const exec=promisify(execFile)
export const officialOrigin='https://github.com/719083594/GroupGuard-Plugin.git'
const active=new Set()
const privatePaths=['config/local.json','config/standalone.json','data','.env','.env.*']
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
const commitPattern=/^[a-f0-9]{40,64}$/
const isTimeout=error=>Boolean(error?.timedOut||error?.killed||error?.code==='ETIMEDOUT')

async function defaultRunGit(args,{cwd,timeoutMs}){
  return exec('git',['-c','safe.directory='+cwd,'-c','core.hooksPath=','-c','gc.auto=0','-c','maintenance.auto=false','-C',cwd,...args],{timeout:timeoutMs,maxBuffer:1024*1024,windowsHide:true})
}
function version(root){
  try{const value=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;return typeof value==='string'?value.slice(0,80):'未知'}catch{return '未知'}
}
function dataDirectory(root){
  const dir=path.join(root,'data')
  if(fs.existsSync(dir)&&(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink()))throw new Error('更新记录目录不安全，已停止更新')
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  if(!samePath(fs.realpathSync(dir),dir))throw new Error('更新记录目录不安全，已停止更新')
  return dir
}
function saveRecord(dir,record){
  const file=path.join(dir,'update-history.json')
  if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>256*1024))throw new Error('更新记录文件不安全，已停止更新')
  let records=[]
  if(fs.existsSync(file)){records=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(records))throw new Error('更新记录格式错误，已停止更新')}
  const index=records.findIndex(item=>item.id===record.id)
  if(index<0)records.push(record);else records[index]=record
  const temp=file+'.'+randomUUID()+'.tmp'
  try{fs.writeFileSync(temp,JSON.stringify(records.slice(-20),null,2)+'\n',{mode:0o600});fs.renameSync(temp,file)}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
}

/** Only the normal Git implementation is used in production. runGit is injectable
 * for isolated local repositories/tests; it receives an argument array, never a shell. */
export async function update(root,{runGit=defaultRunGit,timeoutMs=30000,now=()=>new Date().toISOString()}={}){
  if(typeof root!=='string'||!root||typeof runGit!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new TypeError('无效的更新参数')
  const base=fs.realpathSync(root),key=process.platform==='win32'?base.toLowerCase():base
  if(active.has(key))throw new Error('群管正在更新，请等待本次任务完成')
  active.add(key)
  let lock,dir,record
  const run=async(...args)=>{
    const result=await runGit(args,{cwd:base,timeoutMs})
    if(!result||typeof result.stdout!=='string')throw new Error('Git 未返回可确认结果')
    return result.stdout.trim()
  }
  const head=async()=>{const value=await run('rev-parse','--verify','HEAD');if(!commitPattern.test(value))throw new Error('无法确认源码提交');return value}
  try{
    let gitRoot
    try{gitRoot=fs.realpathSync(await run('rev-parse','--show-toplevel'))}
    catch{throw new Error('此目录不是有效 Git 安装。ZIP 安装请手动替换新发布包并保留 config/local.json 与 data；或改用官方 Git 克隆安装')}
    if(!samePath(gitRoot,base))throw new Error('Git 根目录不是本插件，已停止更新')
    const urls=(await run('remote','get-url','--all','origin')).split(/\r?\n/)
    if(urls.length!==1||urls[0]!==officialOrigin)throw new Error('只允许精确的群管官方 origin 更新；请核对官方 Git 安装来源')
    let branch
    try{branch=await run('symbolic-ref','--quiet','--short','HEAD')}catch{throw new Error('当前为分离 HEAD，已停止更新；仅支持 main 分支')}
    if(branch!=='main')throw new Error('当前分支不受支持，已停止更新；仅支持 main 分支')
    for(const marker of ['MERGE_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','CHERRY_PICK_HEAD','REVERT_HEAD']){
      const markerPath=await run('rev-parse','--git-path',marker)
      if(fs.existsSync(path.resolve(base,markerPath)))throw new Error('存在未完成的合并、变基或提交操作，已停止更新')
    }
    if(await run('ls-files','-z','--',...privatePaths))throw new Error('实例配置或 data 已被 Git 跟踪，已停止更新；请先保护实例数据')
    if(await run('status','--porcelain=v1','--untracked-files=all'))throw new Error('源码有未提交或未跟踪改动，已停止更新；请先备份并处理本地修改')
    const before=await head(),beforeVersion=version(base)
    dir=dataDirectory(base)
    const lockFile=path.join(dir,'update.lock')
    try{lock=fs.openSync(lockFile,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw new Error('存在群管更新锁，请先核对上次更新记录；不会自动删除或重试');throw error}
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,time:now(),before})+'\n')
    record={id:randomUUID(),time:now(),status:'fetching',before,beforeVersion}
    saveRecord(dir,record)
    // Inspect the fetched official main before allowing it to touch instance files.
    try{await run('fetch','--no-tags','origin','main')}
    catch(error){record.status=isTimeout(error)?'fetch-unknown':'fetch-failed';record.timedOut=isTimeout(error);record.after=await head();saveRecord(dir,record);throw new Error(isTimeout(error)?'获取官方 main 超时，已核对当前提交且未执行源码合并；请查看更新记录后再处理':'获取官方 main 失败，未执行源码合并；配置与数据未主动修改')}
    const target=await run('rev-parse','--verify','FETCH_HEAD')
    if(!commitPattern.test(target))throw new Error('无法确认官方 main 提交，已停止更新')
    record.target=target
    const targetFiles=(await run('ls-tree','-r','--name-only',target)).split(/\r?\n/)
    if(targetFiles.some(file=>file==='config/local.json'||file==='config/standalone.json'||file==='data'||file.startsWith('data/')||/^\.env(?:\.|$)/.test(file)))throw new Error('官方目标提交含实例配置或 data 路径，已停止更新以保护数据')
    try{await run('merge-base','--is-ancestor',before,target)}catch{throw new Error('本地与官方 main 已分叉，不能快进更新；未覆盖本地源码')}
    record.status='pulling';saveRecord(dir,record)
    let pullError
    try{await run('pull','--ff-only','--no-rebase','origin','main')}catch(error){pullError=error}
    const after=await head(),clean=!(await run('status','--porcelain=v1','--untracked-files=all'))
    const currentBranch=await run('symbolic-ref','--quiet','--short','HEAD')
    const instancesTracked=await run('ls-files','-z','--',...privatePaths)
    const verified=after===target&&clean&&currentBranch==='main'&&!instancesTracked
    record.after=after;record.afterVersion=version(base);record.timedOut=isTimeout(pullError)
    if(pullError){
      if(verified&&after!==before){record.status='updated-verified-after-error';saveRecord(dir,record);return `群管源码已拉取：${before.slice(0,12)} → ${after.slice(0,12)}。拉取进程异常${record.timedOut?'或超时':''}后已核验目标提交与干净工作树。配置与数据保留；请主人重启使源码生效。`}
      record.status=isTimeout(pullError)?'pull-unknown':'pull-failed';saveRecord(dir,record)
      throw new Error(isTimeout(pullError)?'拉取超时，已读回当前提交并保存记录；结果仍不确定，不会自动重试，请核对后再处理':'拉取失败，已保存更新前后提交；不会重置、清理或自动重试，请核对更新记录')
    }
    if(!verified){record.status='verification-unknown';saveRecord(dir,record);throw new Error('拉取命令已结束，但提交、分支或工作树核验不一致；已保存记录，不会重复拉取或假报成功')}
    record.status=before===after?'already-current':'updated';saveRecord(dir,record)
    return before===after?`群管源码已经最新（${after.slice(0,12)}，版本 ${record.afterVersion}）。未自动重启。`:`群管源码已拉取：${before.slice(0,12)} → ${after.slice(0,12)}（${beforeVersion} → ${record.afterVersion}）。配置与数据保留；请主人重启使源码生效。`
  }catch(error){
    if(record&&!['fetch-unknown','fetch-failed','pull-unknown','pull-failed','verification-unknown'].includes(record.status)){
      record.status='stopped';try{record.after=await head();saveRecord(dir,record)}catch{}
    }
    // Do not expose raw Git stderr, remote credentials, or local filesystem paths.
    if(error instanceof TypeError)throw error
    const safeMessages=/^(此目录|Git 根|只允许|当前|存在|实例|源码|获取官方|无法确认|官方目标|本地与官方|拉取|更新记录)/
    throw new Error(safeMessages.test(error.message)?error.message:'群管更新检查失败，已停止；请核对本地 Git 与更新记录')
  }finally{
    if(lock!==undefined){try{fs.closeSync(lock)}catch{};try{fs.unlinkSync(path.join(dir,'update.lock'))}catch{}}
    active.delete(key)
  }
}
