import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'

const BOT='100000001',BOT2='100000002',GROUP='200000001',GROUP2='200000002',USER='300000001',MASTER='400000001'
const PROMPT='自动退群测试提示'
const ok=data=>({status:'ok',retcode:0,data})
const text=params=>Array.isArray(params.message)?params.message.map(segment=>segment.data?.text||'').join(''):String(params.message||'')

function fixture(t,{config={},members,roles={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-autoquit-'))
  let now=Date.parse('2026-11-01T00:00:10Z'),engine,counter=0
  const calls=[],errors=[],overrides={},list=members||[{user_id:BOT,role:'admin'},{user_id:BOT2,role:'admin'},{user_id:USER,role:'member'}]
  const adapter=new OneBotAdapter(async(action,params)=>{
    calls.push({action,params})
    if(overrides[action])return overrides[action](params)
    if(action==='get_group_member_info')return ok({role:roles[String(params.user_id)]||'member'})
    if(action==='get_group_member_list')return ok(list)
    if(action==='send_group_msg'||action==='send_private_msg')return ok({message_id:++counter})
    return ok({})
  })
  function open(){engine=new GroupGuard(root,{now:()=>now,onError:error=>errors.push(String(error))});engine.register(BOT,adapter);return engine}
  t.after(()=>{engine?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})})
  open()
  engine.config.update(c=>Object.assign(c,{autoQuitEnabled:true,minGroupMember:10,autoQuitTime:'08:00',autoQuitMessage:PROMPT+' {memberCount}/{minMember}',groups:[{botId:BOT,groupId:GROUP,enabled:true}]},config))
  const base={post_type:'notice',notice_type:'group_increase',self_id:BOT,user_id:BOT,group_id:GROUP,operator_id:USER,message:[]}
  return {
    root,adapter,calls,errors,overrides,list,
    get engine(){return engine},get now(){return now},
    advance:milliseconds=>{now+=milliseconds},
    notice:extra=>engine.handle({...base,time:Math.floor(now/1000),...extra},adapter),
    tick:()=>engine.tick(),
    restart:()=>{engine.close();return open()},
    prompts:()=>calls.filter(call=>call.action==='send_group_msg'&&text(call.params).startsWith(PROMPT)),
    leaves:()=>calls.filter(call=>call.action==='set_group_leave')
  }
}

test('相同入群通知重复和无time重放都只提示/退群一次',async t=>{
  for(const withoutTime of [false,true]){
    const f=fixture(t),extra=withoutTime?{time:undefined}:{time:Math.floor(f.now/1000)}
    await Promise.all([f.notice(extra),f.notice(extra)])
    f.advance(5000);await f.notice(extra)
    assert.equal(f.prompts().length,1);assert.equal(f.leaves().length,1)
    assert.deepEqual(f.leaves()[0].params,{group_id:Number(GROUP),is_dismiss:false})
  }
})

test('入群通知与定时巡检并发共享bot/group锁，不重复提示或退群',async t=>{
  const f=fixture(t);let release,entered
  const reached=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  f.overrides.send_group_msg=async params=>{if(text(params).startsWith(PROMPT)){entered();await gate}return ok({message_id:1})}
  const notice=f.notice();await reached
  const tick=f.tick();await new Promise(resolve=>setImmediate(resolve));release()
  await Promise.all([notice,tick])
  assert.equal(f.prompts().length,1);assert.equal(f.leaves().length,1)
})

test('成功和未知退群结果跨重启、跨日均不直接重提',async t=>{
  for(const outcome of ['success','unknown']){
    const f=fixture(t)
    if(outcome==='unknown')f.overrides.set_group_leave=()=>{throw new Error('synthetic transport timeout')}
    const oldTime=Math.floor(f.now/1000)
    await f.notice();assert.equal(f.leaves().length,1)
    f.restart();await f.notice({time:oldTime});await f.notice({time:undefined})
    f.advance(86400000);await f.tick()
    assert.equal(f.leaves().length,1,outcome);assert.equal(f.prompts().length,1,outcome)
    assert.equal(f.engine.state.exits[BOT+':'+GROUP].status,outcome)
  }
})

test('平台明确拒绝退群同日不重提，次日可由巡检重试',async t=>{
  const f=fixture(t)
  f.overrides.set_group_leave=()=>({status:'failed',retcode:1,message:'synthetic permission denial'})
  await f.notice();await f.notice({time:undefined});await f.tick()
  assert.equal(f.leaves().length,1);assert.equal(f.engine.state.exits[BOT+':'+GROUP].status,'failed')
  f.restart();await f.notice({time:undefined});assert.equal(f.leaves().length,1)
  delete f.overrides.set_group_leave;f.advance(86400000);await f.tick()
  assert.equal(f.leaves().length,2);assert.equal(f.prompts().length,2)
  assert.equal(f.engine.state.exits[BOT+':'+GROUP].status,'success')
})

test('unknown必须有晚于上一轮at的可信新入群时间才开启新一轮',async t=>{
  const f=fixture(t)
  f.overrides.set_group_leave=()=>{throw new Error('synthetic unknown leave result')}
  const oldTime=Math.floor(f.now/1000)
  await f.notice();f.advance(5000)
  for(const time of [undefined,null,oldTime,oldTime-1,'invalid',Math.floor(f.now/1000)+3600])await f.notice({time})
  assert.equal(f.leaves().length,1);assert.equal(f.prompts().length,1)
  const entryTime=Math.floor(f.now/1000)
  await f.notice({time:entryTime});await f.notice({time:entryTime})
  assert.equal(f.leaves().length,2);assert.equal(f.prompts().length,2)
  assert.equal(f.engine.state.exits[BOT+':'+GROUP].entryTime,entryTime)
  f.restart();await f.notice({time:entryTime});assert.equal(f.leaves().length,2)
})

test('首次无time的unknown仍可被后续可信新入群证明替代',async t=>{
  const f=fixture(t)
  f.overrides.set_group_leave=()=>{throw new Error('synthetic unknown leave result')}
  await f.notice({time:undefined});f.advance(2000)
  await f.notice({time:undefined});assert.equal(f.leaves().length,1)
  await f.notice();assert.equal(f.leaves().length,2)
})

test('初始claim保存失败不提示/退群且回滚未发送记录，恢复后可执行',async t=>{
  const f=fixture(t),save=f.engine.save.bind(f.engine)
  f.engine.save=()=>{throw new Error('synthetic claim save failure')}
  await f.notice()
  assert.equal(f.prompts().length,0);assert.equal(f.leaves().length,0)
  assert.equal(f.engine.state.exits[BOT+':'+GROUP],undefined)
  f.engine.save=save;await f.notice()
  assert.equal(f.prompts().length,1);assert.equal(f.leaves().length,1)
})

test('提示明确失败或结果未知都不调用leave，同日不重复发提示',async t=>{
  for(const outcome of ['failed','unknown']){
    const f=fixture(t)
    f.overrides.send_group_msg=params=>{
      if(!text(params).startsWith(PROMPT))return ok({message_id:1})
      if(outcome==='failed')return {status:'failed',retcode:1,message:'synthetic prompt denial'}
      throw new Error('synthetic prompt timeout')
    }
    await f.notice();await f.notice({time:undefined})
    assert.equal(f.prompts().length,1);assert.equal(f.leaves().length,0)
    assert.equal(f.engine.state.exits[BOT+':'+GROUP].promptStatus,outcome)
  }
})

test('提示已成功但第二次保存失败仍不得调用leave',async t=>{
  const f=fixture(t),save=f.engine.save.bind(f.engine);let saves=0
  f.engine.save=()=>{if(++saves===2)throw new Error('synthetic post-prompt save failure');return save()}
  await f.notice();await f.notice({time:undefined})
  assert.equal(f.prompts().length,1);assert.equal(f.leaves().length,0)
  assert.equal(f.engine.state.exits[BOT+':'+GROUP].promptStatus,'success')
  assert.equal(f.engine.state.exits[BOT+':'+GROUP].status,'failed')
})

test('白群、管理群、插件主人、管理员邀请和机器人群主豁免保留',async t=>{
  const cases=[
    {config:{whiteGroups:[GROUP],blackGroups:[GROUP]}},
    {config:{managementGroups:[GROUP]}},
    {config:{masters:[MASTER]},event:{operator_id:MASTER}},
    {config:{masters:[MASTER]},members:[{user_id:BOT,role:'admin'},{user_id:MASTER,role:'member'}]},
    {config:{allowAdminInvite:true},roles:{[USER]:'admin'}},
    {config:{allowAdminInvite:true},roles:{[USER]:'owner'}},
    {members:[{user_id:BOT,role:'owner'},{user_id:USER,role:'member'}]},
    {config:{autoQuitEnabled:false}}
  ]
  for(const item of cases){const f=fixture(t,item);await f.notice(item.event);assert.equal(f.prompts().length,0);assert.equal(f.leaves().length,0)}
})

test('管理员邀请身份查询抛错不退群；框架主人不自动进入masters豁免',async t=>{
  const f=fixture(t,{config:{allowAdminInvite:true}})
  f.overrides.get_group_member_info=()=>{throw new Error('synthetic unavailable member lookup')}
  await f.notice();assert.equal(f.prompts().length,0);assert.equal(f.leaves().length,0)
  const g=fixture(t);await g.notice({isMaster:true})
  assert.equal(g.prompts().length,1);assert.equal(g.leaves().length,1)
})

test('人数足够时不退群，群黑名单仍可触发；机器人与群之间隔离',async t=>{
  const f=fixture(t,{config:{minGroupMember:1}})
  await f.notice();assert.equal(f.leaves().length,0)
  f.engine.config.update(c=>{c.blackGroups=[GROUP,GROUP2]})
  await f.notice();await f.notice({group_id:GROUP2});await f.notice({self_id:BOT2,user_id:BOT2})
  assert.equal(f.leaves().length,3);assert.equal(f.prompts().length,3)
  assert.equal(Object.keys(f.engine.state.exits).length,3)
})
