import {fileURLToPath} from 'node:url'
import {GroupGuard,OneBotAdapter} from './api.mjs'
import {createHelpImages} from './lib/help-images.mjs'
import {commandRules} from './lib/command.mjs'
import {createAdminServer} from './lib/admin.mjs'
import {createStatusImageRenderer} from './lib/status-image.mjs'
import {attachShutdown} from './lib/lifecycle.mjs'
import {environmentHints} from './lib/environment.mjs'

const PluginBase=globalThis.plugin||(await import('../../lib/plugins/plugin.js')).default
const root=fileURLToPath(new URL('.',import.meta.url))
const statusImage=createStatusImageRenderer({
  tplFile:fileURLToPath(new URL('./resources/status.html',import.meta.url)),
  render:async(name,data)=>{
    // TRSS is only known in this entry point, and only loaded for an image request.
    const {default:renderer}=await import('../../lib/renderer/loader.js')
    if(typeof renderer?.render!=='function')throw new Error('STATUS_RENDERER_UNAVAILABLE')
    return renderer.render(name,data)
  }
})
export const engine=new GroupGuard(root,{helpImages:createHelpImages({root}),statusImage,onError:error=>globalThis.logger?.warn('[GroupGuard] '+(error?.message||error))})
const adapters=new WeakMap()
let adminPromise
export function startAdmin(){
  if(process.env.GROUPGUARD_ADMIN_ENABLED==='0')return Promise.resolve(null)
  if(!adminPromise){
    adminPromise=createAdminServer({root,store:engine.config,engine,host:process.env.GROUPGUARD_ADMIN_HOST||'127.0.0.1',port:Number(process.env.GROUPGUARD_ADMIN_PORT||15083),publicUrl:process.env.GROUPGUARD_ADMIN_PUBLIC_URL||'',onError:error=>globalThis.logger?.warn('[GroupGuard 管理] '+(error?.message||error))})
    adminPromise.then(admin=>globalThis.logger?.info('[GroupGuard] 配置界面已启动，端口 '+admin.address.port+'；初始密码见插件 data/admin-initial-password.txt。')).catch(()=>{adminPromise=null})
  }
  return adminPromise
}
engine.loginLink=async({botId,userId,isMaster})=>{
  const admin=await startAdmin()
  if(!admin)throw new Error('网页配置已关闭，请启用 GROUPGUARD_ADMIN_ENABLED 后重启机器人')
  return admin.createLoginLink({principal:botId+':'+userId,authorize:async()=>{
    if(engine.config.read().masters.map(String).includes(String(userId)))return true
    if(!isMaster)return false
    const {default:cfg}=await import('../../lib/config/config.js')
    return cfg.master?.[botId]?.includes(String(userId))===true
  }})
}
const closeEngine=engine.close.bind(engine)
let unregisterShutdown=()=>{}
engine.close=()=>{
  unregisterShutdown()
  try{closeEngine()}finally{
    if(adminPromise)adminPromise.then(admin=>admin?.close()).catch(()=>{})
    if(globalThis.groupGuardRegisterTimer){clearInterval(globalThis.groupGuardRegisterTimer);delete globalThis.groupGuardRegisterTimer}
  }
}
unregisterShutdown=attachShutdown(engine)
export function adapterFor(bot) {
  let adapter=adapters.get(bot)
  if(!adapter){
    if(typeof bot?.sendApi!=='function')throw new Error('群管需要支持 sendApi 的 OneBot v11 机器人')
    adapter=new OneBotAdapter((action,params)=>bot.sendApi(action,params))
    adapters.set(bot,adapter)
  }
  return adapter
}

function registerOnline() {
  const bots=globalThis.Bot?.bots?Object.values(globalThis.Bot.bots):[]
  for(const bot of bots)if(bot&&typeof bot.sendApi==='function'&&(bot.uin||bot.self_id))engine.register(String(bot.uin||bot.self_id),adapterFor(bot))
}

// accept() and a rule callback can see the same event in different TRSS loaders.
// Share the in-flight/result promise, including when the first call exceeds cooldown.
const eventObjects=new WeakMap(),messageResults=new Map()
function messageKey(event) {
  if(event.message_id===undefined||event.message_id===null||event.message_id==='')return ''
  return [event.self_id||event.bot?.uin||event.bot?.self_id||'',event.group_id||'private',event.user_id||'',event.message_id].join(':')
}
function dispatchOnce(event) {
  if(!event||typeof event!=='object')return Promise.resolve(false)
  if(eventObjects.has(event))return eventObjects.get(event)
  const key=messageKey(event),now=Date.now()
  for(const [id,result] of messageResults)if(now-result.created>120*60000)messageResults.delete(id)
  if(key&&messageResults.has(key)){
    const promise=messageResults.get(key).promise
    eventObjects.set(event,promise)
    return promise
  }
  const promise=Promise.resolve().then(()=>engine.handle({...event,post_type:'message'},adapterFor(event.bot)))
  eventObjects.set(event,promise)
  if(key){
    messageResults.set(key,{created:now,promise})
    while(messageResults.size>5000)messageResults.delete(messageResults.keys().next().value)
  }
  return promise
}

export class GroupGuardCommands extends PluginBase {
  constructor(){
    // A framework master filter would wrongly reject plugin-only masters.
    super({name:'GroupGuard-Plugin 群管',dsc:'独立群管理、审核与群内辅助功能',event:'message',priority:-9000,rule:commandRules()})
  }
  init(){
    registerOnline();engine.start()
    const environment=environmentHints()
    if(environment.adminEnabled&&environment.needsHostSetup)globalThis.logger?.warn('[GroupGuard] 检测到容器环境，管理页当前只在容器内监听。请在宿主机运行本插件 scripts/install.py 配置网页入口，详见 README；QQ 群管不受影响。')
    startAdmin().catch(error=>globalThis.logger?.warn('[GroupGuard] 配置界面启动失败：'+(error?.message||error)))
    if(globalThis.groupGuardRegisterTimer)clearInterval(globalThis.groupGuardRegisterTimer)
    globalThis.groupGuardRegisterTimer=setInterval(registerOnline,15000)
    globalThis.groupGuardRegisterTimer.unref()
  }
  accept(event){return dispatchOnce(event||this.e)}
  dispatchCommand(event){return dispatchOnce(event||this.e)}
  publicCommand(event){return this.dispatchCommand(event)}
  adminCommand(event){return this.dispatchCommand(event)}
  masterCommand(event){return this.dispatchCommand(event)}
}

class GroupGuardEvent extends PluginBase {
  constructor(event,type,subtype){super({name:'群管 '+event,dsc:'审核与成员通知',event,priority:-9000});this.type=type;this.subtype=subtype}
  accept(event){
    const raw=event||this.e
    return engine.handle({...raw,post_type:this.type,request_type:'group',...(this.type==='notice'?{notice_type:'group_'+this.subtype}:{sub_type:this.subtype})},adapterFor(raw.bot))
  }
}
export class GroupGuardInvite extends GroupGuardEvent {constructor(){super('request.group.invite','request','invite')}}
export class GroupGuardJoin extends GroupGuardEvent {constructor(){super('request.group.add','request','add')}}
export class GroupGuardIncrease extends GroupGuardEvent {constructor(){super('notice.group.increase','notice','increase')}}
export class GroupGuardDecrease extends GroupGuardEvent {constructor(){super('notice.group.decrease','notice','decrease')}}
// TRSS loads module.apps. Utilities are intentionally excluded from constructor scan.
export const apps={GroupGuardCommands,GroupGuardInvite,GroupGuardJoin,GroupGuardIncrease,GroupGuardDecrease}
