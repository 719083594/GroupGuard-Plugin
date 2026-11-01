import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard,timeParts} from '../lib/core.mjs'
import {StateStore} from '../lib/state.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'

const BOT='100000001',BOT2='100000002',GROUP='200000001',GROUP2='200000002'
const USER='300000001'
const user=n=>String(300000001+n)
const INITIAL=Date.parse('2026-11-01T04:00:00Z')
const configurations=[{botId:BOT,groupId:GROUP,enabled:true,likes:true},{botId:BOT,groupId:GROUP2,enabled:true,likes:true},{botId:BOT2,groupId:GROUP,enabled:true,likes:true}]

function rootFor(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-state-likes-'))
  fs.mkdirSync(path.join(root,'config'),{recursive:true})
  fs.copyFileSync(new URL('../config/default.json',import.meta.url),path.join(root,'config/default.json'))
  fs.copyFileSync(new URL('../config/default.json',import.meta.url),path.join(root,'config/local.json'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  return root
}

function fixture(t,{legacy=false,oldState,at=INITIAL}={}){
  const root=rootFor(t),file=path.join(root,'config/local.json')
  const config=JSON.parse(fs.readFileSync(file,'utf8'))
  config.groups=structuredClone(configurations)
  if(legacy){delete config.schemaVersion;delete config.newsSources;delete config.legacy;config.dailyApi=''}
  fs.writeFileSync(file,JSON.stringify(config))
  if(oldState!==undefined){fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.writeFileSync(path.join(root,'data/state.json'),JSON.stringify(oldState))}
  let now=at,counter=1000,onLike=async()=>({status:'ok',retcode:0,data:{}})
  const calls=[],replies=[],errors=[],adapters=new Map()
  for(const bot of [BOT,BOT2])adapters.set(bot,new OneBotAdapter(async(action,params)=>{
    calls.push({bot,action,params})
    if(action==='send_like')return onLike({bot,params})
    if(action==='get_group_member_info')return {status:'ok',retcode:0,data:{role:String(params.user_id)===bot?'admin':'member'}}
    if(action==='send_group_msg'||action==='send_private_msg'){
      replies.push({bot,...params});return {status:'ok',retcode:0,data:{message_id:++counter}}
    }
    return {status:'ok',retcode:0,data:{}}
  }))
  const create=()=>new GroupGuard(root,{now:()=>now,onError:error=>errors.push(String(error))})
  let engine=create()
  t.after(()=>engine.close())
  return {
    root,calls,replies,errors,get engine(){return engine},get now(){return now},
    get likes(){return calls.filter(c=>c.action==='send_like')},
    get lastText(){return replies.at(-1)?.message?.filter(s=>s.type==='text').map(s=>s.data.text).join('')??''},
    day(){return timeParts(now,'Asia/Shanghai').day},
    setTime(value){now=typeof value==='number'?value:Date.parse(value)},
    setOutcome(fn){onLike=fn},
    restart(){engine.close();engine=create();return engine},
    async like(who=USER,{bot=BOT,group=GROUP,advance=1100}={}){
      now+=advance
      return engine.handle({message_id:++counter,self_id:bot,group_id:group,user_id:who,msg:'赞我',message:[],post_type:'message'},adapters.get(bot))
    }
  }
}

test('100 submitted likes are the account cap; the eleventh person causes no platform call',async t=>{
  const f=fixture(t)
  for(let i=0;i<10;i++)await f.like(user(i))
  assert.equal(f.likes.length,10)
  assert.equal(f.likes.reduce((n,c)=>n+c.params.times,0),100)
  assert.ok(f.likes.every(c=>c.params.times===10))
  await f.like(user(10))
  assert.equal(f.likes.length,10);assert.match(f.lastText,/额度已用完/)
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'data/state.json'),'utf8'))
  assert.equal(saved.likes[BOT][f.day()].used,100)
})

test('same user across groups is not submitted or charged twice',async t=>{
  const f=fixture(t)
  await f.like(USER);await f.like(USER,{group:GROUP2})
  assert.equal(f.likes.length,1);assert.match(f.lastText,/不重复/)
  for(let i=1;i<10;i++)await f.like(user(i),{group:i%2?GROUP:GROUP2})
  assert.equal(f.likes.length,10)
  await f.like(user(10));assert.equal(f.likes.length,10);assert.match(f.lastText,/额度已用完/)
})

test('different robots can each submit ten shares and have separate user deduplication',async t=>{
  const f=fixture(t)
  for(const bot of [BOT,BOT2])for(let i=0;i<11;i++)await f.like(user(i),{bot})
  assert.equal(f.likes.filter(c=>c.bot===BOT).length,10)
  assert.equal(f.likes.filter(c=>c.bot===BOT2).length,10)
  assert.equal(f.likes.filter(c=>c.params.user_id===Number(USER)).length,2)
})

test('concurrent requests in different groups share one account reservation lock',async t=>{
  const f=fixture(t);let active=0,maxActive=0
  f.setOutcome(async()=>{
    active++;maxActive=Math.max(maxActive,active)
    await new Promise(resolve=>setImmediate(resolve))
    active--;return {status:'ok',retcode:0,data:{}}
  })
  await Promise.all(Array.from({length:25},(_,i)=>f.like(user(i),{group:i%2?GROUP:GROUP2})))
  assert.equal(f.likes.length,10);assert.equal(maxActive,1)
  assert.equal(f.likes.reduce((n,c)=>n+c.params.times,0),100)
  assert.equal(f.replies.filter(r=>r.message?.some(s=>/额度已用完/.test(s.data?.text??''))).length,15)
})

test('restart retains used budget and user records rather than allocating a new daily cap',async t=>{
  const f=fixture(t)
  for(let i=0;i<9;i++)await f.like(user(i))
  f.restart()
  await f.like(USER,{group:GROUP2});assert.equal(f.likes.length,9);assert.match(f.lastText,/不重复/)
  await f.like(user(9));await f.like(user(10))
  assert.equal(f.likes.length,10);assert.match(f.lastText,/额度已用完/)
})

test('Asia/Shanghai midnight opens the next date without clearing the previous ledger',async t=>{
  const f=fixture(t,{at:Date.parse('2026-11-01T15:59:40Z')})
  for(let i=0;i<10;i++)await f.like(user(i))
  const previous=f.day();assert.equal(previous,'2026-11-01')
  await f.like(user(10));assert.equal(f.likes.length,10)
  f.setTime('2026-11-01T16:00:01Z');await f.like(USER)
  assert.equal(f.day(),'2026-11-02');assert.equal(f.likes.length,11)
  assert.equal(f.engine.state.likes[BOT][previous].used,100)
  assert.equal(f.engine.state.likes[BOT][f.day()].used,10)
})

for(const outcome of ['failed','unknown'])test(`${outcome} platform outcome consumes one share and is never resubmitted, including after restart`,async t=>{
  const f=fixture(t)
  f.setOutcome(async()=>{
    if(outcome==='failed')return {status:'failed',retcode:100,message:'synthetic rejection'}
    throw new Error('synthetic transport timeout')
  })
  await f.like(USER)
  assert.equal(f.likes.length,1)
  assert.equal(f.engine.state.likes[BOT][f.day()].users[USER].status,outcome)
  assert.match(f.lastText,outcome==='failed'?/未成功.*额度已保留/:/无法确认.*保留额度/)
  await f.like(USER,{group:GROUP2});assert.equal(f.likes.length,1)
  f.restart();await f.like(USER);assert.equal(f.likes.length,1)
  f.setOutcome(async()=>({status:'ok',retcode:0,data:{}}))
  for(let i=1;i<10;i++)await f.like(user(i))
  await f.like(user(10));assert.equal(f.likes.length,10);assert.match(f.lastText,/额度已用完/)
})

for(const stateKind of ['absent','empty legacy successes'])test(`legacy config with ${stateKind} stays blocked on migration day and opens next day`,async t=>{
  const f=fixture(t,{legacy:true,...(stateKind==='absent'?{}:{oldState:{groups:{},likes:{},pending:[],jobs:{},audit:[]}})})
  assert.equal(f.engine.config.wasLegacy,true)
  await f.like(USER);assert.equal(f.likes.length,0);assert.match(f.lastText,/次日启用/)
  f.restart();await f.like(USER,{group:GROUP2});assert.equal(f.likes.length,0)
  f.setTime('2026-11-01T16:00:01Z');await f.like(USER)
  assert.equal(f.likes.length,1);assert.match(f.lastText,/已提交10个赞/)
})

test('existing schema 1 state alone is enough to block unknown daily submissions even with new config',async t=>{
  const f=fixture(t,{oldState:{groups:{},likes:{},pending:[],audit:[],jobs:{}}})
  assert.equal(f.engine.config.wasLegacy,false)
  await f.like(USER);assert.equal(f.likes.length,0);assert.match(f.lastText,/次日启用/)
  const backup=path.join(f.root,'data/state.schema-v1.backup.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(backup,'utf8')).likes,{})
})

test('second state writer is rejected without changing the original owner or ledger',t=>{
  const f=fixture(t),file=path.join(f.root,'data/state.json'),lock=path.join(f.root,'data/.groupguard.lock')
  const before=fs.readFileSync(file,'utf8'),owner=fs.readFileSync(lock,'utf8')
  assert.throws(()=>new StateStore(f.root),/已有状态写入进程|第二个写入者/)
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readFileSync(lock,'utf8'),owner)
  f.engine.close();const next=new StateStore(f.root);next.close()
})

test('changed lock ownership prevents the old state writer from saving over the ledger',t=>{
  const f=fixture(t),file=path.join(f.root,'data/state.json'),lock=path.join(f.root,'data/.groupguard.lock')
  const before=fs.readFileSync(file,'utf8'),owner=fs.readFileSync(lock,'utf8')
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'synthetic-other-owner'}))
  try{
    assert.throws(()=>f.engine.save(),/锁已变化|停止保存/)
    assert.equal(fs.readFileSync(file,'utf8'),before)
  }finally{fs.writeFileSync(lock,owner)}
})

test('future state schema is rejected with exact original file retained and no orphan lock',t=>{
  const root=rootFor(t),directory=path.join(root,'data'),file=path.join(directory,'state.json')
  fs.mkdirSync(directory,{recursive:true})
  const future='{"schemaVersion":99,"likes":{},"groups":{},"futureField":{"retain":true}}\n'
  fs.writeFileSync(file,future)
  let instance
  try{assert.throws(()=>{instance=new StateStore(root)},/版本|schema|支持/)}finally{instance?.close()}
  assert.equal(fs.readFileSync(file,'utf8'),future)
  assert.equal(fs.existsSync(path.join(directory,'.groupguard.lock')),false)
  assert.equal(fs.existsSync(path.join(directory,'state.schema-v1.backup.json')),false)
})

test('future config schema cannot start an engine or rewrite the original config',t=>{
  const root=rootFor(t),file=path.join(root,'config/local.json')
  const future='{"schemaVersion":99,"unknown":{"retain":true}}\n';fs.writeFileSync(file,future)
  let instance
  try{assert.throws(()=>{instance=new GroupGuard(root,{onError:()=>{}})},/版本|schema|支持/)}finally{instance?.close()}
  assert.equal(fs.readFileSync(file,'utf8'),future)
  assert.equal(fs.existsSync(path.join(root,'data/.groupguard.lock')),false)
})

for(const [name,value]of [
  ['malformed JSON','{broken'],['non-object root','[]'],['non-object likes','{"schemaVersion":2,"likes":[]}'],
  ['non-array pending','{"schemaVersion":2,"pending":{}}'],
  ['invalid budget record','{"schemaVersion":2,"likes":{"100000001":{"2026-11-01":{"used":"wrong","users":{}}}}}']
])test(`${name} state fails closed without rewriting the original`,t=>{
  const root=rootFor(t),directory=path.join(root,'data'),file=path.join(directory,'state.json')
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file,value)
  let instance
  try{assert.throws(()=>{instance=new StateStore(root)})}finally{instance?.close()}
  assert.equal(fs.readFileSync(file,'utf8'),value)
  assert.equal(fs.existsSync(path.join(directory,'.groupguard.lock')),false)
})
