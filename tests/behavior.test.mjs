import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'

const BOT='100000001',GROUP='200000001',ELSEWHERE='200000002'
const ADMIN='300000001',MASTER='300000002',TARGET='400000001',ORDINARY='400000002',NOTIFY='300000003'
const SECRET='behavior-synthetic/key+value=not-real'
const text=params=>(params.message??[]).filter(x=>x.type==='text').map(x=>x.data.text).join('')
const ok=data=>({status:'ok',retcode:0,data})

function fixture(t,{group={},config={},fetcher=async()=>{throw new Error('unexpected test network request')},updater=null}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-behavior-'))
  fs.mkdirSync(path.join(root,'config'),{recursive:true})
  fs.copyFileSync(new URL('../config/default.json',import.meta.url),path.join(root,'config/default.json'))
  const c=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
  Object.assign(c,{masters:[MASTER],groups:[{botId:BOT,groupId:GROUP,enabled:true,...group}]},config)
  fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify(c))
  let now=Date.parse('2026-11-01T04:00:00Z'),counter=1000,engine
  const calls=[],replies=[],errors=[],overrides={}
  const members={[BOT]:{role:'owner'},[ADMIN]:{role:'admin'},[MASTER]:{role:'owner'},[TARGET]:{role:'member'},[ORDINARY]:{role:'member'},[NOTIFY]:{role:'member'}}
  const adapter=new OneBotAdapter(async(action,params)=>{
    calls.push({action,params})
    if(overrides[action])return overrides[action](params)
    if(action==='get_group_member_info')return ok(members[String(params.user_id)])
    if(action==='get_msg')return ok({group_id:GROUP,user_id:TARGET})
    if(action==='send_group_msg'||action==='send_private_msg'){
      replies.push(params);return ok({message_id:++counter})
    }
    return ok({})
  })
  const create=()=>{
    const e=new GroupGuard(root,{now:()=>now,onError:error=>errors.push(String(error)),fetcher,updater})
    e.register(BOT,adapter);return e
  }
  engine=create()
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true})})
  const event=(msg,extra={})=>({self_id:BOT,group_id:GROUP,user_id:ADMIN,post_type:'message',message:[],message_id:++counter,msg,...extra})
  return {
    root,adapter,calls,replies,errors,overrides,members,event,get engine(){return engine},
    get lastText(){return replies.length?text(replies.at(-1)):''},
    actions(name){return calls.filter(c=>c.action===name)},
    advance(ms){now+=ms},setTime(value){now=typeof value==='number'?value:Date.parse(value)},
    restart(){engine.close();engine=create()},
    async run(msg,extra={}){now+=1100;return engine.handle(event(msg,extra),adapter)},
    async request(flag,{sub_type='add',...extra}={}){
      return engine.handle(event('',{post_type:'request',request_type:'group',sub_type,flag,user_id:TARGET,...extra}),adapter)
    }
  }
}

test('statistics off still records message IDs and quoted bare 撤回 deletes the correct message',async t=>{
  const f=fixture(t,{group:{statistics:false}})
  const original=f.event('ordinary text',{user_id:TARGET,message_id:51})
  await f.engine.handle(original,f.adapter)
  const state=f.engine.getGroup(original)
  assert.ok(state.history.some(x=>x.id==='51'));assert.deepEqual(state.days,{})
  await f.run('撤回',{message:[{type:'reply',data:{id:51}}]})
  assert.deepEqual(f.actions('delete_msg').map(c=>c.params),[{message_id:'51'}])
  assert.match(f.lastText,/成功1条，失败0条/);assert.equal(state.history.some(x=>x.id==='51'),false)
})

test('slow management API is not duplicated after cooldown or after restart replay',async t=>{
  const f=fixture(t);let started,release
  const began=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
  f.overrides.set_group_ban=async()=>{started();await gate;return ok({})}
  const event=f.event('#群管禁言 '+TARGET+' 1分钟')
  const first=f.engine.handle(event,f.adapter);await began
  await new Promise(resolve=>setTimeout(resolve,1050));f.advance(1500)
  const replay=f.engine.handle(event,f.adapter);release();await Promise.all([first,replay])
  assert.equal(f.actions('set_group_ban').length,1)
  f.restart();f.advance(1100);await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('set_group_ban').length,1);assert.match(f.lastText,/已经完成|不重复/)
})

test('successful action with failed result delivery stays successful and is never retried',async t=>{
  const f=fixture(t),event=f.event('#群管禁言 '+TARGET+' 1分钟')
  f.overrides.send_group_msg=params=>{
    if(text(params).includes('禁言成功'))throw new Error('synthetic delivery failure')
    f.replies.push(params);return ok({message_id:7000})
  }
  await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('set_group_ban').length,1)
  assert.ok(f.errors.some(x=>/结果通知失败/.test(x)))
  assert.equal(f.replies.some(r=>/禁言失败|禁言未成功/.test(text(r))),false)
  f.restart();await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('set_group_ban').length,1);assert.match(f.lastText,/已经完成/)
})

test('network-unknown management result is protected across restart and event replay',async t=>{
  const f=fixture(t),event=f.event('#群管踢 '+TARGET)
  f.overrides.set_group_kick=()=>{throw new Error('synthetic transport timeout')}
  await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('set_group_kick').length,1);assert.match(f.lastText,/无法确认|先核验/)
  f.restart();delete f.overrides.set_group_kick
  await f.engine.handle(event,f.adapter)
  assert.equal(f.actions('set_group_kick').length,1);assert.match(f.lastText,/待核验|不重复/)
})

test('completed automatic approval cannot execute again on replay or restart',async t=>{
  const f=fixture(t,{group:{joinMode:'accept'}})
  await f.request('auto-approved');await f.request('auto-approved')
  assert.equal(f.actions('set_group_add_request').length,1)
  f.restart();await f.request('auto-approved')
  assert.equal(f.actions('set_group_add_request').length,1)
  assert.equal(f.actions('set_group_add_request')[0].params.approve,true)
})

test('manual approval may retry an explicit failure with a new message, but not an unknown outcome',async t=>{
  const f=fixture(t,{group:{joinMode:'manual'}})
  await f.request('manual-failed');const p=f.engine.state.pending[0]
  f.overrides.set_group_add_request=()=>({status:'failed',retcode:100,message:'synthetic explicit failure'})
  await f.run('#群管同意 '+p.id)
  assert.equal(f.engine.state.pending.length,1);assert.equal(f.actions('set_group_add_request').length,1)
  delete f.overrides.set_group_add_request
  await f.run('#群管同意 '+p.id)
  assert.equal(f.actions('set_group_add_request').length,2);assert.equal(f.engine.state.pending.length,0)
  await f.request('manual-unknown');const unknown=f.engine.state.pending[0]
  f.overrides.set_group_add_request=()=>{throw new Error('synthetic request timeout')}
  await f.run('#群管同意 '+unknown.id)
  assert.equal(f.actions('set_group_add_request').length,3);assert.match(f.lastText,/无法确认|先核验/)
  f.restart();delete f.overrides.set_group_add_request
  await f.run('#群管拒绝 '+unknown.id)
  assert.equal(f.actions('set_group_add_request').length,3);assert.match(f.lastText,/不重复|待核验/)
})

test('review works before enabled checking but notification location/private reviewer permissions still apply',async t=>{
  const f=fixture(t,{group:{enabled:false},config:{inviteMode:'manual',managementGroups:[GROUP],notifyUsers:[NOTIFY]}})
  await f.request('disabled-invite',{sub_type:'invite'});const p=f.engine.state.pending[0]
  await f.run('#群管待审核');assert.match(f.lastText,/尚未开启/)
  await f.run('#群管同意 '+p.id,{group_id:ELSEWHERE});assert.match(f.lastText,/通知群/)
  await f.run('#群管同意 '+p.id,{user_id:ORDINARY});assert.match(f.lastText,/权限/)
  await f.run('#群管同意 '+p.id,{group_id:'',user_id:ORDINARY});assert.match(f.lastText,/权限/)
  assert.equal(f.actions('set_group_add_request').length,0)
  await f.run('#群管同意 '+p.id,{group_id:'',user_id:NOTIFY})
  assert.equal(f.actions('set_group_add_request').length,1);assert.equal(f.engine.state.pending.length,0)
  await f.request('disabled-invite-2',{sub_type:'invite'});const p2=f.engine.state.pending[0]
  await f.run('#群管拒绝 '+p2.id)
  assert.equal(f.actions('set_group_add_request').length,2);assert.match(f.lastText,/审核成功/)
})

test('scheduled API errors redact synthetic Key/URL in audit, diagnostic callback and owner log reply',async t=>{
  const f=fixture(t,{group:{dailyEnabled:true,dailyTime:'18:00'},fetcher:async()=>{throw new Error(`synthetic API error ${SECRET} https://news.example.test/?key=${encodeURIComponent(SECRET)}`)}})
  f.engine.config.setNews(BOT,GROUP,{url:'https://news.example.test/',authType:'bearer',keyAction:'replace',key:SECRET})
  f.setTime('2026-11-01T10:00:00Z');await f.engine.tick()
  assert.ok(f.engine.state.audit.some(x=>x.action==='job-failed'));assert.ok(f.errors.length)
  await f.run('#群管日志',{group_id:'',user_id:MASTER})
  for(const output of [JSON.stringify(f.engine.state.audit),f.errors.join('\n'),f.lastText]){
    assert.equal(output.includes(SECRET),false);assert.equal(output.includes(encodeURIComponent(SECRET)),false)
    assert.equal(output.includes('https://news.example.test/'),false)
  }
})

test('missed news is not replayed after restart, while next normal time sends exactly once',async t=>{
  let requests=0
  const f=fixture(t,{group:{dailyEnabled:true,dailyTime:'18:00'},fetcher:async()=>{requests++;return {ok:true,json:async()=>({text:'synthetic daily news'})}}})
  f.engine.config.setNews(BOT,GROUP,{url:'https://news.example.test/'})
  f.setTime('2026-11-01T09:59:00Z');await f.engine.tick()
  f.restart();f.setTime('2026-11-01T10:01:00Z');await f.engine.tick();assert.equal(requests,0)
  f.setTime('2026-11-02T10:00:00Z');await f.engine.tick();await f.engine.tick()
  assert.equal(requests,1);assert.equal(f.replies.filter(r=>text(r)==='synthetic daily news').length,1)
  f.restart();await f.engine.tick();assert.equal(requests,1)
})

test('injected updater runs through plugin-master/framework-master private commands only',async t=>{
  const roots=[]
  const f=fixture(t,{updater:async root=>{roots.push(root);return 'synthetic source pulled; restart required'}})
  await f.run('#群管更新',{group_id:''});assert.equal(roots.length,0)
  await f.run('#群管更新',{user_id:MASTER});assert.equal(roots.length,0);assert.match(f.lastText,/私聊/)
  await f.run('#群管更新',{user_id:MASTER,group_id:''})
  assert.deepEqual(roots,[f.root]);assert.match(f.lastText,/synthetic source pulled/)
  await f.run('/群管更新',{user_id:ORDINARY,group_id:'',isMaster:true})
  assert.deepEqual(roots,[f.root,f.root])
})

test('unknown target role is rejected for every member action even when the actor is a master',async t=>{
  const f=fixture(t);f.members[TARGET]={role:'unexpected-platform-role'}
  for(const cmd of ['禁言 '+TARGET+' 1分钟','踢 '+TARGET,'设管理 '+TARGET,'撤管理 '+TARGET,'头衔 '+TARGET+' test']){
    await f.run('#群管'+cmd,{user_id:MASTER});assert.match(f.lastText,/身份不明|未能确认/)
  }
  for(const action of ['set_group_ban','set_group_kick','set_group_admin','set_group_special_title'])assert.equal(f.actions(action).length,0)
})

test('chat setters cannot overwrite credentials/protected fields or echo supplied synthetic Keys',async t=>{
  const f=fixture(t)
  f.engine.config.setNews(BOT,GROUP,{url:'https://news.example.test/',authType:'bearer',keyAction:'replace',key:SECRET})
  const file=path.join(f.root,'config/local.json'),before=fs.readFileSync(file,'utf8')
  for(const field of ['newsSources','newsSources.0.key','dailyApi','masters','groups','botId','groupId','enabled','scheduledMute','__proto__']){
    await f.run('#群管设置 '+field+' '+SECRET,{user_id:MASTER})
    assert.match(f.lastText,/保护|未知/);assert.equal(f.lastText.includes(SECRET),false)
  }
  for(const field of ['newsSources','dailyApi','masters','groups','schemaVersion','legacy','constructor','__proto__']){
    await f.run('#群管全局 '+field+' '+SECRET,{user_id:MASTER,group_id:''})
    assert.match(f.lastText,/保护|未知/);assert.equal(f.lastText.includes(SECRET),false)
  }
  assert.equal(fs.readFileSync(file,'utf8'),before)
  assert.equal(f.engine.config.getNews(BOT,GROUP).key,SECRET)
  for(const output of [f.errors.join('\n'),JSON.stringify(f.engine.state.audit),JSON.stringify(f.replies)])assert.equal(output.includes(SECRET),false)
})
