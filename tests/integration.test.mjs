import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {normalize,OneBotAdapter} from '../lib/adapter.mjs'

const source=fileURLToPath(new URL('..',import.meta.url))
const packageVersion=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version
const BOT='100000001',GROUP='200000001',ACTOR='345678901',MASTER='123456789',TARGET='456789012'
async function fixture(t,{enabled=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-trss-'))
  fs.mkdirSync(path.join(root,'config'))
  for(const name of ['lib','resources'])fs.cpSync(path.join(source,name),path.join(root,name),{recursive:true})
  for(const name of ['index.js','api.mjs','package.json','CHANGELOG.md'])fs.copyFileSync(path.join(source,name),path.join(root,name))
  fs.copyFileSync(path.join(source,'config/default.json'),path.join(root,'config/default.json'))
  const previousPlugin=globalThis.plugin
  globalThis.plugin=class PluginBase {constructor(options){Object.assign(this,options)}}
  const entry=await import(pathToFileURL(path.join(root,'index.js')).href)
  t.after(()=>{
    entry.engine.close()
    if(previousPlugin===undefined)delete globalThis.plugin;else globalThis.plugin=previousPlugin
    fs.rmSync(root,{recursive:true,force:true})
  })
  let clock=Date.parse('2026-11-01T04:00:00Z'),sequence=0
  entry.engine.now=()=>clock
  entry.engine.config.setGroup(BOT,GROUP,g=>{g.enabled=enabled})
  const roles={[BOT]:'admin',[ACTOR]:'admin',[MASTER]:'member',[TARGET]:'member'}
  const calls=[],failures=new Map()
  const bot={uin:Number(BOT),beforeAction:null,async sendApi(action,params){
    calls.push({action,params:structuredClone(params)})
    if(bot.beforeAction)await bot.beforeAction(action,params)
    if(failures.has(action))return {status:'failed',retcode:100,message:failures.get(action)}
    let data={message_id:9000+calls.length}
    if(action==='get_group_member_info')data={user_id:params.user_id,role:roles[String(params.user_id)]||'member',nickname:'synthetic'}
    if(action==='get_msg')data={message_id:params.message_id,group_id:Number(GROUP),user_id:Number(TARGET),sender:{user_id:Number(TARGET),role:'member'}}
    if(action==='get_group_member_list')data=Object.entries(roles).map(([user_id,role])=>({user_id:Number(user_id),role}))
    return {status:'ok',retcode:0,data}
  }}
  const event=(msg,options={})=>{
    clock+=2000
    return {self_id:Number(BOT),group_id:Number(GROUP),user_id:Number(ACTOR),message_id:++sequence,msg,message:[{type:'text',data:{text:msg}}],isMaster:false,bot,...options}
  }
  return {root,entry,p:new entry.GroupGuardCommands(),roles,calls,failures,bot,event,advance:ms=>{clock+=ms}}
}
// Exercise the real exported entry with the framework's accept/rule ordering,
// including its optional permission filter. Core permissions still execute.
async function route(plugin,event) {
  plugin.e=event
  const accepted=await plugin.accept(event)
  if(accepted)return accepted
  for(const rule of plugin.rule||[]){
    if(rule.permission==='master'&&event.isMaster!==true)continue
    if(rule.reg.test(event.msg)&&await plugin[rule.fnc](event))return true
  }
  return false
}
const sent=calls=>calls.filter(call=>['send_group_msg','send_private_msg'].includes(call.action))
const textOf=call=>(call?.params.message||[]).filter(segment=>segment.type==='text').map(segment=>segment.data.text).join('')

test('声明检查接受Windows检出的CRLF且仍拒绝内容漂移，不改写源文件',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-manifest-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  for(const name of ['lib/config.mjs','lib/command.mjs','config/default.json','package.json','scripts/manifest.mjs']){
    const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(source,name),file)
  }
  const script=path.join(root,'scripts/manifest.mjs'),file=path.join(root,'plugin.manifest.json')
  assert.equal(spawnSync(process.execPath,[script],{encoding:'utf8'}).status,0)
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\r?\n/g,'\r\n'))
  const before=fs.readFileSync(file)
  assert.equal(spawnSync(process.execPath,[script,'--check'],{encoding:'utf8'}).status,0)
  assert.deepEqual(fs.readFileSync(file),before)
  const changed=JSON.parse(before.toString());changed.version='unexpected-version';fs.writeFileSync(file,JSON.stringify(changed,null,2)+'\r\n')
  assert.equal(spawnSync(process.execPath,[script,'--check'],{encoding:'utf8'}).status,1)
})

test('实际入口启动并关闭嵌入管理页面，不修改群配置或接收OneBot事件',async t=>{
  const f=await fixture(t),before=fs.readFileSync(path.join(f.root,'config/local.json'),'utf8')
  const old=process.env.GROUPGUARD_ADMIN_PORT
  process.env.GROUPGUARD_ADMIN_PORT='0'
  try{
    const admin=await f.entry.startAdmin()
    assert.equal(await f.entry.startAdmin(),admin)
    const base='http://127.0.0.1:'+admin.address.port
    const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/GroupGuard/)
    const session=await fetch(base+'/api/session');assert.deepEqual(await session.json(),{authenticated:false})
    assert.equal((await fetch(base+'/api/config')).status,401)
    assert.equal(fs.readFileSync(path.join(f.root,'config/local.json'),'utf8'),before)
    assert.equal(f.calls.length,0)
    await admin.close()
  }finally{if(old===undefined)delete process.env.GROUPGUARD_ADMIN_PORT;else process.env.GROUPGUARD_ADMIN_PORT=old}
})

test('TRSS 实际入口保持 apps 导出，禁用群可查公开帮助，取消入口不执行',async t=>{
  const f=await fixture(t,{enabled:false})
  assert.deepEqual(Object.keys(f.entry.apps).sort(),['GroupGuardCommands','GroupGuardDecrease','GroupGuardIncrease','GroupGuardInvite','GroupGuardJoin'])
  assert.equal(f.p.rule.some(rule=>rule.permission==='master'),false)
  assert.equal(await route(f.p,f.event('/群管帮助 文字')),true)
  assert.match(textOf(sent(f.calls).at(-1)),/群管/)
  assert.equal(await route(f.p,f.event('#群管版本')),true)
  assert.ok(textOf(sent(f.calls).at(-1)).includes('群管 '+packageVersion))
  const before=f.calls.length
  for(const cmd of ['#群管','/群管','#群卫帮助','＃群管帮助','／群管版本','#确认加群','#拒绝加群','#群管发言日榜','#群管发言月榜','#群管赞我','#赞我','撤回','快来赞我'])assert.equal(await route(f.p,f.event(cmd)),false,cmd)
  assert.equal(f.calls.length,before)
})

test('主人私聊穿过 TRSS 路由：插件 masters 与框架主人均可，普通用户及群聊不可',async t=>{
  const f=await fixture(t)
  f.entry.engine.config.update(c=>{c.masters=[MASTER]})
  assert.equal(await route(f.p,f.event('#群管全局 inviteMode manual',{group_id:'',user_id:Number(MASTER)})),true)
  assert.equal(f.entry.engine.config.read().inviteMode,'manual')
  assert.match(textOf(sent(f.calls).at(-1)),/保存/)
  await route(f.p,f.event('/群管全局 notifyInviter 开',{group_id:'',isMaster:true}))
  assert.equal(f.entry.engine.config.read().notifyInviter,true)
  await route(f.p,f.event('#群管全局 inviteMode reject',{group_id:''}))
  assert.equal(f.entry.engine.config.read().inviteMode,'manual')
  assert.match(textOf(sent(f.calls).at(-1)),/主人/)
  await route(f.p,f.event('#群管全局 inviteMode reject',{user_id:Number(MASTER)}))
  assert.equal(f.entry.engine.config.read().inviteMode,'manual')
  assert.match(textOf(sent(f.calls).at(-1)),/私聊/)
  await route(f.p,f.event('#群管全局 masters []',{group_id:'',user_id:Number(MASTER)}))
  assert.deepEqual(f.entry.engine.config.read().masters,[MASTER])
})

test('真实 OneBot 适配与核心权限：普通成员/机器人权限拒绝，平台失败不得报成功',async t=>{
  const f=await fixture(t)
  f.roles[ACTOR]='member'
  await route(f.p,f.event('禁言 '+TARGET+' 10分钟'))
  assert.equal(f.calls.some(call=>call.action==='set_group_ban'),false)
  f.roles[ACTOR]='admin';f.roles[BOT]='member'
  await route(f.p,f.event('/禁言 '+TARGET+' 10分钟'))
  assert.equal(f.calls.some(call=>call.action==='set_group_ban'),false)
  f.roles[BOT]='admin'
  await route(f.p,f.event('#群管禁言 '+TARGET+' 10分钟'))
  assert.deepEqual(f.calls.find(call=>call.action==='set_group_ban').params,{group_id:Number(GROUP),user_id:Number(TARGET),duration:600})
  assert.match(textOf(sent(f.calls).at(-1)),/成功/)
  f.failures.set('set_group_ban','模拟平台拒绝')
  await route(f.p,f.event('解禁 '+TARGET))
  assert.match(textOf(sent(f.calls).at(-1)),/模拟平台拒绝/)
  assert.doesNotMatch(textOf(sent(f.calls).at(-1)),/成功/)
})

test('accept、规则回调及复制事件共用同次结果，首轮超过冷却仍只执行一次',async t=>{
  const f=await fixture(t)
  let release,started
  const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
  f.bot.beforeAction=async action=>{if(action==='set_group_ban'){started();await gate}}
  let handled=0
  const original=f.entry.engine.handle.bind(f.entry.engine)
  f.entry.engine.handle=(...args)=>{handled++;return original(...args)}
  const e=f.event('禁言 '+TARGET+' 10分钟')
  const first=f.p.accept(e)
  await entered
  f.advance(2500)
  const second=f.p.dispatchCommand({...e})
  release()
  assert.deepEqual(await Promise.all([first,second]),[true,true])
  f.advance(2500)
  assert.equal(await f.p.adminCommand({...e}),true)
  assert.equal(handled,1)
  assert.equal(f.calls.filter(call=>call.action==='set_group_ban').length,1)
  const state=f.entry.engine.state.groups[BOT+':'+GROUP]
  assert.equal(state.history.filter(row=>String(row.id)===String(e.message_id)).length,1)
  assert.equal(Object.values(state.days).reduce((sum,table)=>sum+(table[ACTOR]?.count||0),0),1)
})

test('群引用裸撤回复用平台同群校验，source 引用保留；无引用与私聊不触发',async t=>{
  const f=await fixture(t)
  const quoted=f.event('撤回',{message:[{type:'reply',data:{id:77}},{type:'text',data:{text:'撤回'}}]})
  assert.equal(await route(f.p,quoted),true)
  assert.equal(f.calls.some(call=>call.action==='get_msg'&&Number(call.params.message_id)===77),true)
  assert.equal(f.calls.some(call=>call.action==='delete_msg'&&Number(call.params.message_id)===77),true)
  assert.equal(normalize(f.event('撤回',{source:{message_id:78}})).replyId,'78')
  const count=f.calls.filter(call=>call.action==='delete_msg').length
  assert.equal(await route(f.p,f.event('撤回')),false)
  assert.equal(await route(f.p,f.event('撤回',{group_id:'',source:{message_id:78}})),false)
  assert.equal(f.calls.filter(call=>call.action==='delete_msg').length,count)
})

test('群申请和成员事件保留正确框架事件与 OneBot 适配，工具不进入 apps 构造扫描',async t=>{
  const f=await fixture(t)
  const received=[]
  f.entry.engine.handle=async (raw,adapter)=>{received.push({raw,adapter});return false}
  const definitions=[
    ['GroupGuardInvite','request.group.invite','request','invite'],
    ['GroupGuardJoin','request.group.add','request','add'],
    ['GroupGuardIncrease','notice.group.increase','notice','group_increase'],
    ['GroupGuardDecrease','notice.group.decrease','notice','group_decrease']
  ]
  for(const [name,event,postType,subtype] of definitions){
    const plugin=new f.entry.apps[name]()
    assert.equal(plugin.event,event)
    await plugin.accept(f.event(''))
    const last=received.at(-1)
    assert.equal(last.raw.post_type,postType)
    assert.equal(postType==='request'?last.raw.sub_type:last.raw.notice_type,subtype)
    assert.equal(last.adapter instanceof Object,true)
    assert.equal(typeof last.adapter.api,'function')
  }
  assert.equal(f.entry.adapterFor(f.bot),f.entry.adapterFor(f.bot))
  assert.throws(()=>f.entry.adapterFor({}),/sendApi/)
  await assert.rejects(new OneBotAdapter(async()=>({data:{}})).api('fake'),/缺少成功状态/)
  await assert.rejects(new OneBotAdapter(async()=>({status:'failed',retcode:2,message:'失败'})).api('fake'),/失败/)
})

test('网页登录只接受主人私聊，群聊和普通成员不能获取临时链接',async t=>{
  const f=await fixture(t)
  f.entry.engine.config.update(c=>{c.masters=[MASTER]})
  let issued=0
  f.entry.engine.loginLink=async meta=>{assert.equal(meta.botId,BOT);assert.equal(meta.userId,MASTER);issued++;return 'https://synthetic.example/#login='+'x'.repeat(43)}
  await route(f.p,f.event('#群管登录',{group_id:undefined,user_id:Number(ACTOR)}));assert.equal(issued,0)
  await route(f.p,f.event('#群管登录',{user_id:Number(MASTER)}));assert.equal(issued,0)
  await route(f.p,f.event('#群管登录',{group_id:undefined,user_id:Number(MASTER)}));assert.equal(issued,1)
  assert.match(textOf(sent(f.calls).at(-1)),/https:\/\/synthetic.example\/\#login=/)
})

test('独立声明覆盖全部最终指令与敏感新闻字段，不泄露默认实例数据',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'plugin.manifest.json'),'utf8'))
  assert.equal(manifest.version,packageVersion)
  assert.equal(manifest.runtime.independentHttp,false)
  assert.equal(manifest.runtime.integrationApi,'api.mjs')
  assert.deepEqual(manifest.runtime.frameworksBundled,['TRSS'])
  assert.equal(manifest.runtime.frameworkApiAutoStart,false)
  assert.equal(manifest.management.browserStatus,'implemented')
  assert.equal(manifest.management.serverProvided,true)
  assert.equal(manifest.management.defaultHost,'127.0.0.1')
  assert.equal(manifest.management.defaultPort,15083)
  assert.deepEqual(manifest.configs[0].defaults.masters,[])
  assert.deepEqual(manifest.configs[0].defaults.newsSources,[])
  const fields=manifest.configs[0].fields
  assert.equal(fields.find(field=>field.path==='masters').chatWritable,false)
  const news=fields.find(field=>field.path==='newsSources')
  assert.equal(news.chatWritable,false)
  assert.equal(news.fields.find(field=>field.name==='key').sensitive,true)
  const names=manifest.commandTable.map(command=>command.name)
  for(const name of ['帮助','今日榜','昨日榜','月榜','日报','赞我','全局','更新'])assert.equal(names.includes(name),true,name)
  assert.equal(manifest.commandTable.find(command=>command.name==='赞我').command,'赞我')
  assert.equal(manifest.commandTable.some(command=>command.command==='#群管赞我'),false)
})
