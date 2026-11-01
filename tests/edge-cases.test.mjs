import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard} from '../lib/core.mjs'
import {OneBotAdapter,unwrap} from '../lib/adapter.mjs'

const BOT='100000001',GROUP='200000001',ADMIN='300000001',TARGET='400000001'
const ok=data=>({status:'ok',retcode:0,data})
const text=p=>(p.message??[]).filter(s=>s.type==='text').map(s=>s.data.text).join('')
function fixture(t,{timezone='Asia/Shanghai',group={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-edge-'))
  fs.mkdirSync(path.join(root,'config'),{recursive:true})
  const c=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
  Object.assign(c,{timezone,masters:[ADMIN],groups:[{botId:BOT,groupId:GROUP,enabled:true,...group}]})
  fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify(c))
  let now=Date.parse('2026-11-01T04:00:00Z'),counter=1000,engine
  const calls=[],replies=[],errors=[],overrides={}
  const adapter=new OneBotAdapter(async(action,params)=>{
    calls.push({action,params})
    if(overrides[action])return overrides[action](params)
    if(action==='get_group_member_info')return ok({role:String(params.user_id)===TARGET?'member':'admin'})
    if(action==='get_msg')return ok({group_id:GROUP,user_id:TARGET})
    if(action==='send_group_msg'||action==='send_private_msg'){replies.push(params);return ok({message_id:++counter})}
    return ok({})
  })
  const create=()=>new GroupGuard(root,{now:()=>now,onError:e=>errors.push(String(e)),fetcher:async()=>{throw new Error('unexpected network request')}})
  engine=create()
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true})})
  const event=(msg,extra={})=>({self_id:BOT,group_id:GROUP,user_id:ADMIN,message_id:++counter,post_type:'message',msg,message:[],...extra})
  return {
    root,adapter,calls,replies,errors,overrides,event,get engine(){return engine},
    get lastText(){return replies.length?text(replies.at(-1)):''},
    actions(name){return calls.filter(x=>x.action===name)},
    setTime(value){now=Date.parse(value)},restart(){engine.close();engine=create()},
    async run(msg,extra={}){now+=1100;return engine.handle(event(msg,extra),adapter)},
    async request(flag){return engine.handle(event('',{post_type:'request',request_type:'group',sub_type:'add',flag,user_id:TARGET}),adapter)}
  }
}

test('present but invalid OneBot status is unknown even when retcode claims success or failure',async()=>{
  for(const status of ['',null,undefined,false,0,'async','OK',{},[]])for(const retcode of [0,100]){
    assert.throws(()=>unwrap({status,retcode,data:'untrusted'}),error=>error.outcome==='unknown')
    const adapter=new OneBotAdapter(async()=>({status,retcode,data:'untrusted'}))
    await assert.rejects(adapter.api('synthetic_action'),error=>error.outcome==='unknown')
  }
  assert.equal(unwrap({status:'ok',data:'status only'}),'status only')
  assert.equal(unwrap({retcode:0,data:'retcode only'}),'retcode only')
  assert.throws(()=>unwrap({status:'failed',retcode:0}),error=>error.outcome==='failed')
})

test('empty/null/invalid message IDs do not collapse distinct read commands or execute member changes',async t=>{
  const f=fixture(t)
  for(const message_id of ['',null,undefined,'   ',false,{},NaN,1.5]){
    const before=f.replies.length
    await f.run('#群管版本',{message_id})
    assert.equal(f.replies.length,before+1);assert.match(f.lastText,/TRSS/)
    await f.run('#群管状态',{message_id})
    assert.equal(f.replies.length,before+2);assert.match(f.lastText,/本群/)
    await f.run('#群管禁言 '+TARGET+' 1分钟',{message_id})
    assert.match(f.lastText,/缺少标识|未执行/)
  }
  assert.equal(f.actions('set_group_ban').length,0)
  assert.equal(f.engine.state.groups[BOT+':'+GROUP],undefined)
})

test('unknown recall reports pending rather than failure and blocks both a new command and restart replay',async t=>{
  const f=fixture(t),reference={message:[{type:'reply',data:{id:51}}]}
  const event=f.event('撤回',reference)
  f.overrides.delete_msg=()=>{throw new Error('synthetic uncertain delete response')}
  await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('delete_msg').length,1)
  assert.match(f.lastText,/成功0条，失败0条/);assert.match(f.lastText,/待核验1条/)
  delete f.overrides.delete_msg
  await f.run('撤回',reference)
  assert.equal(f.actions('delete_msg').length,1)
  assert.match(f.lastText,/失败0条/);assert.match(f.lastText,/待核验1条/)
  f.restart();await f.run('撤回',reference)
  assert.equal(f.actions('delete_msg').length,1);assert.match(f.lastText,/待核验1条/)
  await f.engine.handle(event,f.adapter);assert.equal(f.actions('delete_msg').length,1)
})

test('explicitly failed recall can be retried with a new command without being mistaken for unknown',async t=>{
  const f=fixture(t),reference={message:[{type:'reply',data:{id:52}}]}
  f.overrides.delete_msg=()=>({status:'failed',retcode:100,message:'synthetic rejection'})
  await f.run('撤回',reference)
  assert.equal(f.actions('delete_msg').length,1);assert.match(f.lastText,/失败1条/)
  assert.equal(/待核验/.test(f.lastText),false)
  delete f.overrides.delete_msg
  await f.run('撤回',reference)
  assert.equal(f.actions('delete_msg').length,2);assert.match(f.lastText,/成功1条，失败0条/)
})

test('UTC+14 monthly rollover keeps October when November begins and removes September',async t=>{
  const f=fixture(t,{timezone:'Pacific/Kiritimati'})
  for(const at of ['2026-09-15T00:00:00Z','2026-10-31T09:30:00Z','2026-10-31T10:30:00Z']){
    f.setTime(at);await f.run('synthetic ordinary message',{user_id:TARGET})
  }
  const state=f.engine.state.groups[BOT+':'+GROUP]
  assert.deepEqual(Object.keys(state.months).sort(),['2026-10','2026-11'])
  assert.equal(state.months['2026-10'][TARGET].count,1)
  assert.equal(state.months['2026-11'][TARGET].count,1)
  await f.run('#群管月榜');assert.match(f.lastText,/2026-11/)
})

test('spring DST yesterday is March 8 rather than the date twenty-four hours ago',async t=>{
  const f=fixture(t,{timezone:'America/New_York'})
  f.setTime('2026-03-07T17:00:00Z');await f.run('older',{user_id:TARGET,sender:{nickname:'two-days-old'}})
  f.setTime('2026-03-08T16:00:00Z');await f.run('yesterday',{user_id:TARGET,sender:{nickname:'correct-yesterday'}})
  f.setTime('2026-03-09T04:30:00Z');await f.run('#群管昨日榜')
  assert.match(f.lastText,/2026-03-08/);assert.match(f.lastText,/correct-yesterday/)
  assert.equal(f.lastText.includes('two-days-old'),false)
  assert.deepEqual(Object.keys(f.engine.state.groups[BOT+':'+GROUP].days).sort(),['2026-03-08','2026-03-09'])
})

test('fall DST yesterday is October 31 rather than the earlier part of November 1',async t=>{
  const f=fixture(t,{timezone:'America/New_York'})
  f.setTime('2026-10-31T16:00:00Z');await f.run('yesterday',{user_id:TARGET,sender:{nickname:'fall-yesterday'}})
  f.setTime('2026-11-02T04:30:00Z');await f.run('#群管昨日榜')
  assert.match(f.lastText,/2026-10-31/);assert.match(f.lastText,/fall-yesterday/)
  assert.deepEqual(Object.keys(f.engine.state.groups[BOT+':'+GROUP].days).sort(),['2026-10-31','2026-11-01'])
})

test('automatic approval pre-submit save failure performs no platform action and the replay can retry',async t=>{
  const f=fixture(t,{group:{joinMode:'accept'}}),save=f.engine.save
  f.engine.save=()=>{throw new Error('synthetic pre-submit save failure')}
  try{await f.request('save-failed-auto')}finally{f.engine.save=save}
  assert.equal(f.actions('set_group_add_request').length,0)
  assert.match(f.lastText,/保存失败.*尚未向平台提交/)
  assert.deepEqual(f.engine.state.requests,{})
  await f.request('save-failed-auto')
  assert.equal(f.actions('set_group_add_request').length,1)
  assert.equal(f.actions('set_group_add_request')[0].params.approve,true)
})

test('manual review save failure rolls back the reservation and leaves the pending item retryable',async t=>{
  const f=fixture(t,{group:{joinMode:'manual'}})
  await f.request('manual-save-failure');const p=f.engine.state.pending[0],save=f.engine.save
  const original=fs.readFileSync(path.join(f.root,'data/state.json'),'utf8')
  f.engine.save=()=>{throw new Error('synthetic pre-submit save failure')}
  try{await f.run('#群管同意 '+p.id)}finally{f.engine.save=save}
  assert.equal(f.actions('set_group_add_request').length,0)
  assert.equal(f.engine.state.pending.length,1);assert.deepEqual(f.engine.state.requests,{})
  assert.equal(fs.readFileSync(path.join(f.root,'data/state.json'),'utf8'),original)
  await f.run('#群管同意 '+p.id)
  assert.equal(f.actions('set_group_add_request').length,1);assert.equal(f.engine.state.pending.length,0)
})

test('save failure while retrying an explicit review failure restores its prior failed status',async t=>{
  const f=fixture(t,{group:{joinMode:'manual'}})
  await f.request('manual-failed-then-save-failed');const p=f.engine.state.pending[0]
  f.overrides.set_group_add_request=()=>({status:'failed',retcode:100,message:'synthetic platform rejection'})
  await f.run('#群管同意 '+p.id)
  assert.equal(f.actions('set_group_add_request').length,1)
  const previous=structuredClone(f.engine.state.requests),save=f.engine.save
  assert.equal(Object.values(previous)[0].status,'failed')
  f.engine.save=()=>{throw new Error('synthetic retry save failure')}
  try{await f.run('#群管同意 '+p.id)}finally{f.engine.save=save}
  assert.equal(f.actions('set_group_add_request').length,1);assert.deepEqual(f.engine.state.requests,previous)
  delete f.overrides.set_group_add_request
  await f.run('#群管拒绝 '+p.id)
  assert.equal(f.actions('set_group_add_request').length,2);assert.equal(f.engine.state.pending.length,0)
})
