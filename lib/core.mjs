import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {ConfigStore,id} from './config.mjs'
import {StateStore} from './state.mjs'
import {normalize} from './adapter.mjs'
import {parseCommand,commandMessage} from './command.mjs'
import {textSegment,timeParts} from './utils.mjs'
import {publicHelpText,masterHelpText} from './help-content.mjs'
import {fetchNews,redact} from './features/news.mjs'
import {securityMethods} from './security.mjs'
import {statisticsMethods} from './features/statistics.mjs'
import {membersMethods} from './features/members.mjs'
import {settingsMethods} from './features/settings.mjs'
import {reviewMethods} from './features/review.mjs'
import {automationMethods} from './features/automation.mjs'
import {likesMethods} from './features/likes.mjs'
import {statusMethods} from './features/status.mjs'

export const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
export const HELP=publicHelpText(version)
export {commandMessage}
export {duration,timeParts} from './utils.mjs'

export class GroupGuard{
  constructor(root,{now=()=>Date.now(),fetcher=fetch,onError=console.error,helpImages=null,statusImage=null,statusTimeoutMs=8000,updater=null}={}){
    this.root=root;this.now=now;this.fetcher=fetcher;this.currentConfig=null
    this.onError=error=>{try{onError(redact(String(error?.message||error),this.currentConfig||{}))}catch{}}
    this.config=new ConfigStore(root)
    const config=this.config.read();this.currentConfig=config
    this.store=new StateStore(root,{now:this.now(),timezone:config.timezone,legacyInstall:this.config.wasLegacy})
    try{this.config.migrate()}catch(error){this.store.close();throw error}
    this.state=this.store.value;this.state.operations??={};this.state.exits??={}
    this.stateFile=this.store.file
    if(helpImages!==null&&typeof helpImages!=='function'){this.store.close();throw new TypeError('INVALID_HELP_READER')}
    if(statusImage!==null&&typeof statusImage!=='function'){this.store.close();throw new TypeError('INVALID_STATUS_RENDERER')}
    if(!Number.isInteger(statusTimeoutMs)||statusTimeoutMs<1||statusTimeoutMs>30000){this.store.close();throw new TypeError('INVALID_STATUS_TIMEOUT')}
    this.helpImages=helpImages;this.statusImage=statusImage;this.statusTimeoutMs=statusTimeoutMs;this.version=version;this.updater=updater
    this.adapters=new Map();this.reviewing=new Set();this.cooldowns=new Map();this.queue=new Map();this.locks=new Map();this.events=new Map()
    this.timer=null;this.dirty=false;this.ticking=false;this.closed=false
    if(!config.masters.length)this.onError('[GroupGuard] 未配置插件主人：请在 config/local.json 的 masters 手动填写负责人 QQ；自动退群豁免不继承 TRSS 主人。')
  }
  register(botId,adapter){this.adapters.set(id(botId),adapter)}
  save(){this.store.save(this.state);this.dirty=false}
  trySave(){try{this.save();return true}catch(error){this.dirty=true;this.onError(error);return false}}
  close(){if(this.closed)return;clearInterval(this.timer);this.timer=null;try{if(this.dirty)this.trySave()}finally{this.store.close();this.closed=true}}
  start(){if(this.timer)return;this.timer=setInterval(()=>{if(this.dirty)this.trySave();this.tick().catch(this.onError)},15000);this.timer.unref()}
  audit(e,action,detail){this.state.audit.push({time:this.now(),bot:e.self_id,group:e.group_id||'',user:e.user_id,action,detail:redact(String(detail),this.currentConfig||{}).slice(0,400)});this.state.audit=this.state.audit.slice(-500);this.dirty=true}
  async withLock(key,fn){
    const previous=this.locks.get(key)||Promise.resolve()
    const work=previous.catch(()=>{}).then(fn);this.locks.set(key,work)
    try{return await work}finally{if(this.locks.get(key)===work)this.locks.delete(key)}
  }
  eventKey(e){
    const value=e.message_id
    if(e.post_type!=='message'||!['string','number'].includes(typeof value)||
      typeof value==='number'&&!Number.isSafeInteger(value)||!String(value).trim())return ''
    return e.self_id+':'+(e.group_id||'private')+':'+String(value).trim()
  }
  async handle(raw,adapter){
    const e=normalize(raw);id(e.self_id);id(e.user_id);if(e.group_id)id(e.group_id)
    this.register(e.self_id,adapter)
    const eventKey=this.eventKey(e)
    for(const [key,value] of this.events)if(this.now()-value.time>2*3600000)this.events.delete(key)
    if(eventKey&&this.events.has(eventKey))return this.events.get(eventKey).work
    const key=e.self_id+':'+(e.group_id||'private'),previous=this.queue.get(key)||Promise.resolve()
    const work=previous.catch(()=>{}).then(()=>this.dispatch(e,adapter))
    this.queue.set(key,work)
    if(eventKey){this.events.set(eventKey,{time:this.now(),work});if(this.events.size>5000)this.events.delete(this.events.keys().next().value)}
    try{return await work}finally{if(this.queue.get(key)===work)this.queue.delete(key)}
  }
  requestKey(p){return createHash('sha256').update(p.bot+':'+p.type+':'+p.flag).digest('hex')}
  async effect(e,a,action,params){
    const event=this.eventKey(e)
    if(!event)throw new Error('消息缺少标识，未执行管理操作')
    const key=createHash('sha256').update(event+':'+action+':'+JSON.stringify(params)).digest('hex')
    const resource=action==='delete_msg'?e.self_id+':message:'+params.message_id:''
    if(resource&&Object.entries(this.state.operations).some(([id,entry])=>id!==key&&entry.resource===resource&&['pending','unknown'].includes(entry.status))){
      const error=new Error('此消息的撤回结果仍待核验，不重复提交');error.outcome='unknown';throw error
    }
    const previous=this.state.operations[key]
    if(previous){
      if(previous.status==='success')return {alreadyCompleted:true}
      const error=new Error(previous.status==='failed'?'此消息的操作已明确失败，请用新消息重新操作':'此消息已经提交或结果待核验，不重复执行')
      error.outcome=previous.status==='failed'?'failed':'unknown';throw error
    }
    for(const [id,entry] of Object.entries(this.state.operations))if(this.now()-entry.time>7*86400000)delete this.state.operations[id]
    if(Object.keys(this.state.operations).length>=5000)throw new Error('操作防重记录已满，请主人检查后再执行')
    this.state.operations[key]={status:'pending',time:this.now(),action,...resource?{resource}:{}}
    try{this.save()}catch(error){delete this.state.operations[key];throw new Error('状态保存失败，未执行本次操作')}
    try{
      const value=await a.api(action,params)
      this.state.operations[key].status='success';this.trySave();return value
    }catch(error){
      this.state.operations[key].status=error.outcome==='failed'?'failed':'unknown';this.trySave()
      if(error.outcome!=='failed'){const unknown=new Error('平台操作已提交但结果无法确认，请先核验，不要重复操作');unknown.outcome='unknown';throw unknown}
      throw error
    }
  }
  async reply(e,a,text){return e.group_id?a.sendGroup(e.group_id,Array.isArray(text)?text:textSegment(text)):a.sendPrivate(e.user_id,Array.isArray(text)?text:textSegment(text))}
  async notify(e,a,text){try{return await this.reply(e,a,text)}catch(error){this.onError('[GroupGuard] 结果通知失败：'+redact(String(error.message||error),this.currentConfig||{}));return null}}
  async daily(c,e){return fetchNews({store:this.config,botId:e.self_id,groupId:e.group_id,config:c,fetcher:this.fetcher})}
  async showHelp(e,a,c,args){
    const text=publicHelpText(version)+(this.master(e,c)&&!e.group_id?'\n\n'+masterHelpText(version):'')
    if(args!=='文字'&&this.helpImages){
      let images
      try{images=await this.helpImages({isMaster:this.master(e,c),privateChat:!e.group_id})}catch(error){this.onError(error)}
      const valid=Array.isArray(images)&&images.length>0&&images.length<=8&&images.every(image=>Buffer.isBuffer(image)&&image.length>=4&&image.length<=2*1024*1024&&image[0]===255&&image[1]===216&&image.at(-2)===255&&image.at(-1)===217)
      if(valid){
        for(const image of images){
          try{await this.reply(e,a,[{type:'image',data:{file:'base64://'+image.toString('base64')}}])}
          catch(error){this.onError(error);await this.notify(e,a,'帮助图片发送未能确认，请发送 #群管帮助 文字');break}
        }
        return true
      }
    }
    await this.notify(e,a,text);return true
  }
  async dispatch(e,a){
    let c
    try{
      c=this.config.read();this.currentConfig=c
      const g=this.config.group(e.self_id,e.group_id,c)
      this.expire(c)
      for(const [key,record] of Object.entries(this.state.requests))if(this.now()-record.time>7*86400000)delete this.state.requests[key]
      if(e.post_type==='request')return await this.withLock('request:'+e.self_id+':'+e.sub_type+':'+e.flag,()=>this.request(e,a,c,g))
      if(e.post_type==='notice')return await this.notice(e,a,c,g)
      this.record(e,g,c)
      const command=parseCommand(e.msg,{replyId:e.replyId,groupId:e.group_id})
      if(!command)return false
      const {name:cmd,args}=command,key=e.self_id+':'+e.user_id
      for(const [id,time] of this.cooldowns)if(this.now()-time>60000)this.cooldowns.delete(id)
      if(this.cooldowns.has(key)&&this.now()-this.cooldowns.get(key)<1000)return true
      this.cooldowns.set(key,this.now())
      if(cmd==='帮助')return this.showHelp(e,a,c,args)
      if(cmd==='版本'){await this.notify(e,a,'群管 '+version+' · TRSS＋NapCat · 独立群管理插件');return true}
      if(cmd==='同意'||cmd==='拒绝'){await this.review(e,a,c,args,cmd==='同意');return true}
      if(['全局','群黑名单','群白名单','更新','更新日志','日志'].includes(cmd)){
        if(!this.master(e,c))throw new Error('需要机器人主人权限')
        if(e.group_id)throw new Error('请主人私聊使用全局配置、名单与更新命令')
        await this.globalCommand(e,a,c,cmd,args);return true
      }
      if(cmd==='开启'||cmd==='关闭'){
        await this.permission(e,a,c,{owner:true})
        this.config.setGroup(e.self_id,e.group_id,x=>{x.enabled=cmd==='开启'})
        this.audit(e,'enabled',cmd);this.trySave();await this.notify(e,a,'群管已'+cmd+'（仅本群）');return true
      }
      if(!e.group_id)throw new Error('群管理和辅助命令请在群里使用')
      if(cmd==='状态')return await this.showStatus(e,a,c,g,args)
      if(!g.enabled)throw new Error('本群尚未开启群管，请群主或机器人主人发送 #群管开启')
      if(cmd==='设置'){await this.groupSetting(e,a,c,g,args);return true}
      if(cmd==='黑名单'||cmd==='白名单'){await this.memberList(e,a,c,g,cmd,args);return true}
      if(['今日榜','昨日榜','月榜'].includes(cmd)){await this.showRank(e,a,c,g,cmd);return true}
      if(cmd==='日报'){await this.notify(e,a,await this.daily(c,e));return true}
      if(cmd==='赞我'){await this.like(e,a,c,g);return true}
      if(cmd==='待审核'){
        await this.permission(e,a,c)
        const rows=this.state.pending.filter(p=>p.bot===e.self_id&&(p.group===e.group_id||c.managementGroups.map(String).includes(e.group_id)))
        await this.notify(e,a,'群管待审核\n'+(rows.map(p=>p.id+' · '+(p.type==='invite'?'邀机器人入群':'成员加群')+' · 群'+p.group+' · 用户'+p.user).join('\n')||'暂无'));return true
      }
      if(cmd==='撤回'){await this.recall(e,a,c,g,args);return true}
      await this.memberAction(e,a,c,cmd,args);return true
    }catch(error){
      this.onError(error)
      const text=error.code&&/^E[A-Z]+$/.test(error.code)?'本地保存或读取失败，请主人检查日志':redact(String(error.message||error),c||this.currentConfig||{})
      await this.notify(e,a,'群管：'+text);return true
    }
  }
}
Object.assign(GroupGuard.prototype,securityMethods,statisticsMethods,membersMethods,settingsMethods,reviewMethods,automationMethods,likesMethods,statusMethods)
