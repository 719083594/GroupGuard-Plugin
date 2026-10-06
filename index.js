import {fileURLToPath} from 'node:url'
import {GroupGuard,commandMessage} from './lib/core.mjs'
import {OneBotAdapter} from './lib/adapter.mjs'
const PluginBase=globalThis.plugin||(await import('../../lib/plugins/plugin.js')).default
export const engine=new GroupGuard(fileURLToPath(new URL('.',import.meta.url)),{onError:error=>globalThis.logger?.warn('[GroupGuard] '+(error.message||error))})
const adapters=new WeakMap()
export function adapterFor(bot){let a=adapters.get(bot);if(!a){if(typeof bot?.sendApi!=='function')throw new Error('群管需要支持 sendApi 的 OneBot v11 机器人');a=new OneBotAdapter((action,params)=>bot.sendApi(action,params));adapters.set(bot,a)}return a}
function registerOnline(){
  const bots=globalThis.Bot?.bots?Object.values(Bot.bots):[]
  for(const bot of bots)if(bot&&typeof bot.sendApi==='function'&&(bot.uin||bot.self_id))engine.register(String(bot.uin||bot.self_id),adapterFor(bot))
}
export class GroupGuardCommands extends PluginBase {
  constructor(){super({name:'GroupGuard-Plugin 群管',dsc:'独立群管理、审核、发言榜与定时任务',event:'message',priority:-9000,rule:[
    {reg:/^[#/＃](?:群管|群卫)(?:帮助|版本|发言日榜|昨日榜|发言月榜|日报|赞我)?\s*$/,fnc:'publicCommand',title:'群管帮助与群服务',description:'#群管帮助 / #群管发言日榜 / #群管昨日榜 / #群管发言月榜 / #群管日报 / #群管赞我'},
    {reg:/^[#/＃]?(?:禁言|解禁)(?:\s.*)?$/,fnc:'adminCommand',title:'群管禁言与解禁',description:'禁言 @成员 [10分钟] / 解禁 @成员；默认禁言10分钟，需要操作人与机器人群管理权限'},
    {reg:/^[#/＃](?:群管|群卫)(?:状态|开启|关闭|设置|黑名单|白名单|禁言|解禁|踢|全体禁言|全体解禁|撤回|设管理|撤管理|头衔|待审核|同意|拒绝)(?:\s.*)?$/,fnc:'adminCommand',title:'群管群管理',description:'#群管开启 / #群管状态 / 禁言 @成员 10分钟 / #群管撤回 @成员 5；以 #群管帮助 为准'},
    {reg:/^[#/＃](?:群管|群卫)(?:全局|群黑名单|群白名单|更新日志|更新|日志)(?:\s.*)?$/,fnc:'masterCommand',permission:'master',title:'群管全局设置与维护',description:'仅主人私聊：#群管全局 字段 值 / #群管群黑名单 添加 群号 / #群管更新 / #群管日志'},
    {reg:/^#(?:确认加群|拒绝加群)$/,fnc:'adminCommand',title:'群管引用审核',description:'引用群管发出的申请通知：#确认加群 / #拒绝加群'}
  ]})}
  init(){registerOnline();engine.start();if(globalThis.groupGuardRegisterTimer)clearInterval(globalThis.groupGuardRegisterTimer);globalThis.groupGuardRegisterTimer=setInterval(registerOnline,15000);globalThis.groupGuardRegisterTimer.unref()}
  async accept(e){e=e||this.e;if(!/^[#/＃](?:群管|群卫)|^#(?:确认加群|拒绝加群)$/.test(commandMessage(e.msg)))await engine.handle({...e,post_type:'message'},adapterFor(e.bot));return false}
  publicCommand(e){return engine.handle({...e,post_type:'message'},adapterFor(e.bot))}
  adminCommand(e){return engine.handle({...e,post_type:'message'},adapterFor(e.bot))}
  masterCommand(e){return engine.handle({...e,post_type:'message'},adapterFor(e.bot))}
}
class GroupGuardEvent extends PluginBase {
  constructor(event,type,subtype){super({name:'群管 '+event,dsc:'独立审核与通知处理',event,priority:-9000});this.type=type;this.subtype=subtype}
  accept(e){e=e||this.e;return engine.handle({...e,post_type:this.type,request_type:'group',...(this.type==='notice'?{notice_type:'group_'+this.subtype}:{sub_type:this.subtype})},adapterFor(e.bot))}
}
export class GroupGuardInvite extends GroupGuardEvent {constructor(){super('request.group.invite','request','invite')}}
export class GroupGuardJoin extends GroupGuardEvent {constructor(){super('request.group.add','request','add')}}
export class GroupGuardIncrease extends GroupGuardEvent {constructor(){super('notice.group.increase','notice','increase')}}
export class GroupGuardDecrease extends GroupGuardEvent {constructor(){super('notice.group.decrease','notice','decrease')}}
// TRSS loads module.apps when present. Keep utilities out of its constructor scan.
export const apps={GroupGuardCommands,GroupGuardInvite,GroupGuardJoin,GroupGuardIncrease,GroupGuardDecrease}
