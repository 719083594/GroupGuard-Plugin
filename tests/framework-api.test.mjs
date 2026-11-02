import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createGroupGuard,OneBotError,version} from '../api.mjs'
import {attachGroupGuard} from '../examples/framework-adapter.mjs'

const source=fileURLToPath(new URL('..',import.meta.url))
const BOT='100000001',GROUP='200000001',ADMIN='300000001',MASTER='300000002',MEMBER='300000003',TARGET='300000004'
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=','base64')
const text=row=>(row?.params.message||[]).filter(s=>s.type==='text').map(s=>s.data.text).join('')
async function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-api-'))
  for(const name of ['lib','resources'])fs.cpSync(path.join(source,name),path.join(root,name),{recursive:true})
  fs.mkdirSync(path.join(root,'config'));fs.copyFileSync(path.join(source,'config/default.json'),path.join(root,'config/default.json'))
  const calls=[];let clock=Date.now(),sequence=0
  const call=async(botId,action,params)=>{
    calls.push({botId,action,params})
    if(options.call)return options.call(botId,action,params)
    let data={message_id:90000+calls.length}
    if(action==='get_group_member_info')data={role:[BOT,ADMIN].includes(String(params.user_id))?'admin':'member'}
    return {status:'ok',retcode:0,data}
  }
  const guard=createGroupGuard({root,framework:'合成宿主框架',call,now:()=>clock,...options,onError:()=>{}})
  guard.engine.config.update(c=>{c.masters=[MASTER]})
  const event=(msg,extra={})=>{clock+=2000;return {post_type:'message',self_id:BOT,group_id:GROUP,user_id:ADMIN,message_id:++sequence,message:[{type:'text',data:{text:msg}}],...extra}}
  t.after(async()=>{await guard.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,guard,calls,event,call}
}

test('公共API在没有TRSS的Node进程可导入，不创建data、监听或读取框架全局',()=>{
  const code=`Object.defineProperty(globalThis,'plugin',{get(){throw Error('FRAMEWORK_GLOBAL_ACCESSED')}});const http=await import('node:http');http.default.createServer=()=>{throw Error('UNEXPECTED_LISTENER')};await import(${JSON.stringify(new URL('../api.mjs',import.meta.url).href)});console.log('API_IMPORT_OK')`
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:20000})
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/API_IMPORT_OK/)
  assert.throws(()=>createGroupGuard({}),/call/)
})

test('通用框架收发、账号注册、群开关、统计与版本共用核心',async t=>{
  const f=await fixture(t)
  assert.equal(f.guard.version,version)
  assert.equal(f.guard.registerBot(BOT),f.guard.registerBot(BOT))
  await f.guard.handle(f.event('#群管版本'));assert.match(text(f.calls.at(-1)),/合成宿主框架/)
  await f.guard.handle(f.event('#群管开启',{user_id:MASTER}))
  assert.equal(f.guard.engine.config.group(BOT,GROUP).enabled,true)
  await f.guard.handle(f.event('普通消息',{user_id:MEMBER}))
  await f.guard.handle(f.event('#群管今日榜'));assert.match(text(f.calls.at(-1)),/300000003/)
  assert(f.calls.every(c=>c.botId===BOT))
  f.guard.removeBot(BOT);assert.equal(f.guard.engine.adapters.size,0)
})

test('公开帮助不依赖AI或TRSS；状态可注入宿主图片生成，未注入退文字',async t=>{
  const f=await fixture(t,{statusImage:async html=>{assert.match(html,/本群/);return PNG}})
  await f.guard.handle(f.event('#群管帮助'))
  assert(f.calls.at(-1).params.message.some(s=>s.type==='image'))
  await f.guard.handle(f.event('#群管状态'))
  assert(f.calls.at(-1).params.message.some(s=>s.type==='image'))
  await f.guard.handle(f.event('#群管状态 文字'));assert.match(text(f.calls.at(-1)),/本群/)
  const plain=await fixture(t)
  await plain.guard.handle(plain.event('#群管状态'));assert.match(text(plain.calls.at(-1)),/本群/)
})

test('通用入口沿用真实权限、主人来源及操作防重，不接受裸API成功结果',async t=>{
  const f=await fixture(t)
  await f.guard.handle(f.event('#群管全局 inviteMode accept',{group_id:undefined,user_id:MEMBER}))
  assert.equal(f.guard.engine.config.read().inviteMode,'off')
  await f.guard.handle(f.event('#群管全局 inviteMode accept',{group_id:undefined,user_id:MASTER}))
  assert.equal(f.guard.engine.config.read().inviteMode,'accept')
  f.guard.engine.config.setGroup(BOT,GROUP,g=>{g.enabled=true})
  const e=f.event('#群管禁言 '+TARGET+' 1分钟')
  await f.guard.handle(e);await f.guard.handle(e)
  assert.equal(f.calls.filter(c=>c.action==='set_group_ban').length,1)
  const adapter=f.guard.registerBot(BOT)
  assert.equal(typeof adapter.api,'function')
  const broken=await fixture(t,{call:async()=>({data:{}})})
  await assert.rejects(broken.guard.registerBot(BOT).api('anything'),/缺少成功状态/)
})

test('框架异常保持结果未知且隐藏SDK异常秘密，明确失败可由OneBotError提供',async t=>{
  const f=await fixture(t,{call:async()=>{throw Error('synthetic-secret-sdk-token')}})
  await assert.rejects(f.guard.registerBot(BOT).api('send_group_msg'),e=>e.outcome==='unknown'&&!e.message.includes('synthetic-secret'))
  const failed=await fixture(t,{call:async()=>{throw new OneBotError('合成明确失败','failed')}})
  await assert.rejects(failed.guard.registerBot(BOT).api('send_group_msg'),e=>e.outcome==='failed')
})

test('网页显式启用且受认证保护，关闭后释放同一数据锁',async t=>{
  const f=await fixture(t)
  const admin=await f.guard.openAdmin({port:0})
  assert.equal((await fetch('http://127.0.0.1:'+admin.address.port+'/')).status,200)
  assert.equal((await fetch('http://127.0.0.1:'+admin.address.port+'/api/config')).status,401)
  assert.equal(await f.guard.openAdmin({port:0}),admin)
  const lock=path.join(f.root,'data/.groupguard.lock');assert(fs.existsSync(lock))
  await f.guard.close();assert(!fs.existsSync(lock))
  assert.throws(()=>f.guard.handle(f.event('#群管版本')),/已关闭/)
  await f.guard.close()
})

test('框架模板订阅和取消订阅可执行，不偷偷启动HTTP或直连NapCat',async t=>{
  const f=await fixture(t);await f.guard.close()
  let handler,removed=false
  const attached=attachGroupGuard({root:f.root,name:'合成适配模板',call:f.call,botIds:[BOT],onError:()=>{},subscribe:fn=>{handler=fn;return()=>{removed=true}}})
  handler(f.event('#群管版本'))
  for(let i=0;i<100&&!f.calls.some(c=>text(c).includes('合成适配模板'));i++)await new Promise(r=>setTimeout(r,20))
  assert(f.calls.some(c=>text(c).includes('合成适配模板')))
  await attached.detach();assert.equal(removed,true)
})
