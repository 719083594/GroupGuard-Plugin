import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {ConfigStore,atomic,id} from './config.mjs'
import {normalize} from './adapter.mjs'

export const version='1.0.1'
export const HELP=`群管 GroupGuard ${version}
【查看】#群管帮助 / #群管状态 / #群管版本
【群设置·管理】#群管开启 / #群管关闭
#群管设置 字段 值（布尔用 开/关，数组用 JSON）
#群管黑名单 添加/删除 QQ；#群管白名单 添加/删除 QQ
【群操作·管理】禁言 @成员 [10分钟] / 解禁 @成员（默认禁言10分钟）
#群管踢 @成员 / #群管全体禁言 / #群管全体解禁
#群管撤回（引用）；#群管撤回 @成员 5
【群主能力】#群管设管理 @成员 / #群管撤管理 @成员
#群管头衔 @成员 头衔（需机器人群主）
【统计】#群管发言日榜 / #群管昨日榜 / #群管发言月榜
【服务】#群管日报 / #群管赞我（需先开启）
【审核·管理】#群管待审核；引用审核通知 #群管同意 / #群管拒绝
也可 #群管同意/拒绝 请求编号；#确认加群/#拒绝加群为兼容入口
【主人私聊】#群管全局 字段 值；#群管群黑名单/群白名单 添加/删除 群号
#群管更新 / #群管更新日志 / #群管日志
设置示例：#群管设置 scheduledMute 开；#群管设置 muteTime 23:00
审核示例：#群管设置 answers ["答案"]；#群管设置 joinMode answer`

export function commandMessage(text){
  const msg=String(text||'').trim().replace(/^[/＃]/,'#')
  return /^#?(?:禁言|解禁)(?:\s|$)/.test(msg)?'#群管'+msg.replace(/^#/,''):msg
}

export function timeParts(now,timezone){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]))
  return {day:`${p.year}-${p.month}-${p.day}`,month:`${p.year}-${p.month}`,time:`${p.hour}:${p.minute}`}
}
function chineseNumber(s){
  const nums={'零':0,'一':1,'壹':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
  const units={'十':10,'百':100,'千':1000}
  if(/^\d+$/.test(s))return Number(s)
  let n=0,sum=0
  for(const char of s){if(char in nums)n=nums[char];else if(char in units){sum+=(n||1)*units[char];n=0}else throw new Error('禁言时长不合法')}
  return sum+n
}
export function duration(s){
  const m=s.match(/^([\d零一壹二两三四五六七八九十百千]+)(秒|分|分钟|时|小时|天)?$/)
  if(!m)throw new Error('请使用 10分钟、2小时、1天这样的时长')
  const v=chineseNumber(m[1])*({'秒':1,'分':60,'分钟':60,'时':3600,'小时':3600,'天':86400}[m[2]||'分钟'])
  if(!Number.isInteger(v)||v<1||v>30*86400)throw new Error('禁言时间必须在1秒～30天之间')
  return v
}
const replace=(s,values)=>s.replace(/\{(\w+)\}/g,(m,k)=>String(values[k]??m))
const textSegment=text=>[{type:'text',data:{text}}]
export class GroupGuard {
  constructor(root,{now=()=>Date.now(),fetcher=fetch,onError=console.error,helpImages=null}={}){
    this.root=root;this.config=new ConfigStore(root);this.now=now;this.fetcher=fetcher;this.onError=onError
    if(helpImages!==null&&typeof helpImages!=='function')throw new TypeError('INVALID_HELP_READER')
    this.helpImages=helpImages
    this.stateFile=path.join(root,'data/state.json')
    this.state={groups:{},pending:[],jobs:{},audit:[]}
    if(fs.existsSync(this.stateFile))Object.assign(this.state,JSON.parse(fs.readFileSync(this.stateFile,'utf8')))
    this.adapters=new Map();this.reviewing=new Set();this.cooldowns=new Map();this.queue=new Map();this.timer=null;this.dirty=false;this.ticking=false
  }
  register(botId,adapter){this.adapters.set(id(botId),adapter)}
  save(){atomic(this.stateFile,this.state);this.dirty=false}
  close(){clearInterval(this.timer);this.timer=null;if(this.dirty)this.save()}
  start(){if(this.timer)return;this.timer=setInterval(()=>{if(this.dirty)this.save();this.tick().catch(this.onError)},15000);this.timer.unref()}
  audit(e,action,detail){this.state.audit.push({time:this.now(),bot:e.self_id,group:e.group_id,user:e.user_id,action,detail:String(detail).slice(0,400)});this.state.audit=this.state.audit.slice(-500);this.dirty=true}
  master(e,c){return e.isMaster||c.masters.map(String).includes(e.user_id)}
  getGroup(e){const key=e.self_id+':'+e.group_id;return this.state.groups[key]??= {days:{},months:{},history:[]}}
  async permission(e,a,c,{owner=false,botOwner=false,botAdmin=false}={}){
    if(!e.group_id)throw new Error('请在群里使用这个命令')
    const actor=await a.member(e.group_id,e.user_id)
    if(!this.master(e,c)&&!['owner',...(owner?[]:['admin'])].includes(actor?.role))throw new Error(owner?'需要群主或机器人主人权限':'需要群管理员、群主或机器人主人权限')
    if(botOwner||botAdmin){const bot=await a.member(e.group_id,e.self_id);if(botOwner&&bot?.role!=='owner')throw new Error('这个操作需要机器人是群主');if(botAdmin&&!['owner','admin'].includes(bot?.role))throw new Error('请先给机器人群管理员权限')}
  }
  async target(e,a,args,{allowAdmin=false}={}){
    const t=id(e.at.find(value=>value!==e.self_id)||args.match(/^\s*(\d+)/)?.[1]||'')
    if(t===e.self_id||t===e.user_id)throw new Error('不能对机器人或操作人自己执行此操作')
    const member=await a.member(e.group_id,t)
    if(!member||!member.role)throw new Error('未能确认目标的群成员身份')
    if(member.role==='owner'||member.role==='admin'&&!allowAdmin)throw new Error('不能对群主或管理员执行此操作')
    return t
  }
  async reply(e,a,text){return e.group_id?a.sendGroup(e.group_id,Array.isArray(text)?text:textSegment(text)):a.sendPrivate(e.user_id,Array.isArray(text)?text:textSegment(text))}
  record(e,g,c){
    if(!g.enabled||!e.group_id||!e.message_id||e.user_id===e.self_id)return
    const state=this.getGroup(e),now=this.now(),time=timeParts(now,c.timezone)
    if(state.history.some(x=>String(x.id)===String(e.message_id)))return
    state.history.push({id:String(e.message_id),user:e.user_id,time:now});state.history=state.history.filter(x=>now-x.time<=120*60000).slice(-500)
    if(g.statistics){
      const yesterday=timeParts(now-86400000,c.timezone).day
      for(const d of Object.keys(state.days))if(d!==time.day&&d!==yesterday)delete state.days[d]
      const previousMonth=timeParts(new Date(time.month+'-01T12:00:00Z').getTime()-86400000,c.timezone).month
      for(const m of Object.keys(state.months))if(m!==time.month&&m!==previousMonth)delete state.months[m]
      for(const table of [state.days[time.day]??= {},state.months[time.month]??= {}]){
        if(!Object.hasOwn(table,e.user_id)&&Object.keys(table).length>=5000)continue
        const row=table[e.user_id]??= {count:0,images:0,name:e.user_id}
        row.count++;row.images+=e.message.filter(s=>s.type==='image').length;row.name=String(e.sender?.card||e.sender?.nickname||e.user_id).slice(0,60)
      }
    }
    this.dirty=true
  }
  async handle(raw,adapter){
    const e=normalize(raw);id(e.self_id);id(e.user_id);if(e.group_id)id(e.group_id);this.register(e.self_id,adapter)
    const key=e.self_id+':'+(e.group_id||'private')
    const prev=this.queue.get(key)||Promise.resolve()
    const work=prev.catch(()=>{}).then(()=>this.dispatch(e,adapter))
    this.queue.set(key,work)
    try{return await work}finally{if(this.queue.get(key)===work)this.queue.delete(key)}
  }
  async dispatch(e,a){
    try{
      const c=this.config.read(),g=this.config.group(e.self_id,e.group_id,c)
      this.expire(c)
      if(e.post_type==='request')return await this.request(e,a,c,g)
      if(e.post_type==='notice')return await this.notice(e,a,c,g)
      this.record(e,g,c)
      let msg=commandMessage(e.msg)
      if(/^#(确认加群|拒绝加群)$/.test(msg))msg=msg==='#确认加群'?'#群管同意':'#群管拒绝'
      if(!/^#(?:群管|群卫)/.test(msg))return false
      msg=msg.replace(/^#群卫/,'#群管')
      const cooldownKey=e.self_id+':'+e.user_id
      for(const [k,t] of this.cooldowns)if(this.now()-t>60000)this.cooldowns.delete(k)
      if(this.now()-(this.cooldowns.get(cooldownKey)||0)<1000)return true
      this.cooldowns.set(cooldownKey,this.now())
      const [cmd,...rest]=msg.slice(3).trim().split(/\s+/),args=rest.join(' ')
      if(!cmd||cmd==='帮助'){
        let images
        if(args!=='文字'&&this.helpImages){
          try{images=await this.helpImages({isMaster:this.master(e,c),privateChat:!e.group_id})}
          catch{this.onError('[GroupGuard] 固定帮助图片不可用，使用文字版')}
        }
        const valid=Array.isArray(images)&&images.length>0&&images.length<=8&&images.every(image=>Buffer.isBuffer(image)&&image.length>=4&&image.length<=2*1024*1024&&image[0]===255&&image[1]===216&&image.at(-2)===255&&image.at(-1)===217)
        if(valid){for(const image of images)await this.reply(e,a,[{type:'image',data:{file:'base64://'+image.toString('base64')}}]);return true}
        await this.reply(e,a,HELP);return true
      }
      if(cmd==='版本'){await this.reply(e,a,`群管 ${version} · 独立 OneBot 群管理 · 无游戏依赖`);return true}
      if(cmd==='同意'||cmd==='拒绝'){await this.review(e,a,c,args,cmd==='同意');return true}
      if(cmd==='全局'||cmd==='群黑名单'||cmd==='群白名单'||cmd==='更新'||cmd==='更新日志'||cmd==='日志'){
        if(!this.master(e,c))throw new Error('需要机器人主人权限')
        if(e.group_id)throw new Error('请主人私聊使用全局配置、名单与更新命令')
        await this.globalCommand(e,a,c,cmd,args);return true
      }
      if(cmd==='开启'||cmd==='关闭'){
        await this.permission(e,a,c,{owner:true});this.config.setGroup(e.self_id,e.group_id,g=>{g.enabled=cmd==='开启'})
        this.audit(e,'enabled',cmd);this.save();await this.reply(e,a,`群管已${cmd}（仅本群）`);return true
      }
      if(!e.group_id)throw new Error('群管理和统计命令请在群里使用')
      if(cmd==='状态'){
        await this.permission(e,a,c)
        const bot=await a.member(e.group_id,e.self_id)
        await this.reply(e,a,`群管 ${version}\n本群：${g.enabled?'开启':'关闭'}；机器人：${bot?.role||'未知'}\n统计：${g.statistics}；撤回：${g.recall}；点赞：${g.likes}\n欢迎：${g.welcomeEnabled}；退群通知：${g.leaveEnabled}\n入群审核：${g.joinMode}；退群拉黑：${g.autoBlacklistOnLeave}\n定时禁言：${g.scheduledMute} ${g.muteTime}～${g.unmuteTime}\n日报：${g.dailyEnabled} ${g.dailyTime}；API：${c.dailyApi?'已设置':'未设置'}\n邀请审核：${c.inviteMode}；自动退群：${c.autoQuitEnabled}\n时区：${c.timezone}`);return true
      }
      if(!g.enabled)throw new Error('本群尚未开启群管，请群主或机器人主人发送 #群管开启')
      if(cmd==='设置'){
        await this.permission(e,a,c);const space=args.indexOf(' ');if(space<0)throw new Error('用法：#群管设置 字段 值')
        const field=args.slice(0,space);const current=g[field]
        if(current===undefined||['enabled','botId','groupId'].includes(field))throw new Error('未知或不可直接修改的群设置字段，请查看 README 的字段表')
        const value=this.parseValue(args.slice(space+1),current)
        this.config.setGroup(e.self_id,e.group_id,g=>{g[field]=value});this.audit(e,'setting',field);this.save();await this.reply(e,a,`已保存 ${field} = ${JSON.stringify(value)}，立即生效`);return true
      }
      if(cmd==='黑名单'||cmd==='白名单'){
        await this.permission(e,a,c);const field=cmd==='黑名单'?'blackUsers':'whiteUsers'
        if(!args){await this.reply(e,a,`${cmd}：${g[field].join('、')||'空'}`);return true}
        const m=args.match(/^(添加|删除)\s+(\d+)$/);if(!m)throw new Error(`用法：#群管${cmd} 添加/删除 QQ`);const target=id(m[2])
        this.config.setGroup(e.self_id,e.group_id,g=>{g[field]=m[1]==='添加'?[...new Set([...g[field].map(String),target])]:g[field].filter(x=>String(x)!==target)})
        this.audit(e,cmd,`${m[1]} ${target}`);this.save();await this.reply(e,a,`${cmd}已${m[1]} ${target}`);return true
      }
      if(['发言日榜','昨日榜','发言月榜'].includes(cmd)){
        if(!g.statistics)throw new Error('本群统计已关闭')
        const p=timeParts(cmd==='昨日榜'?this.now()-86400000:this.now(),c.timezone),state=this.getGroup(e)
        const table=cmd==='发言月榜'?state.months[p.month]:state.days[p.day]
        const rows=Object.entries(table||{}).sort((a,b)=>b[1].count-a[1].count).slice(0,g.rankLimit)
        await this.reply(e,a,`群管·${cmd} ${cmd==='发言月榜'?p.month:p.day}\n`+(rows.map(([u,r],i)=>`${i+1}. ${r.name} (${u})：${r.count}条 / ${r.images}张图片`).join('\n')||'暂无发言记录'));return true
      }
      if(cmd==='日报'){await this.reply(e,a,await this.daily(c));return true}
      if(cmd==='赞我'){
        if(!g.likes)throw new Error('本群点赞功能未开启：#群管设置 likes 开')
        const key='like:'+e.self_id+':'+e.user_id,day=timeParts(this.now(),c.timezone).day
        if(this.state.jobs[key]===day)throw new Error('今天已经点赞过了')
        await a.api('send_like',{user_id:Number(e.user_id),times:10});this.state.jobs[key]=day;this.save();await this.reply(e,a,'已提交10次点赞（最终次数以 QQ 为准）');return true
      }
      if(cmd==='待审核'){
        await this.permission(e,a,c)
        const rows=this.state.pending.filter(p=>p.bot===e.self_id&&(p.group===e.group_id||c.managementGroups.map(String).includes(e.group_id)))
        await this.reply(e,a,'群管待审核\n'+(rows.map(p=>`${p.id} · ${p.type==='invite'?'邀机器人入群':'成员加群'} · 群${p.group} · 用户${p.user}`).join('\n')||'暂无'));return true
      }
      if(cmd==='撤回'){await this.recall(e,a,c,g,args);return true}
      if(['禁言','解禁','踢','全体禁言','全体解禁','设管理','撤管理','头衔'].includes(cmd)){
        const owner=['设管理','撤管理','头衔'].includes(cmd)
        await this.permission(e,a,c,{owner,botOwner:owner,botAdmin:true})
        let target='',action='',params={group_id:Number(e.group_id)}
        if(cmd.startsWith('全体')){action='set_group_whole_ban';params.enable=cmd==='全体禁言'}
        else{
          target=await this.target(e,a,args,{allowAdmin:cmd==='撤管理'||cmd==='头衔'});params.user_id=Number(target)
          const tail=e.at.length?args:args.replace(/^\d+\s*/,'')
          if(cmd==='禁言'||cmd==='解禁'){action='set_group_ban';params.duration=cmd==='解禁'?0:duration(tail||'10分钟')}
          if(cmd==='踢'){action='set_group_kick';params.reject_add_request=false}
          if(cmd==='设管理'||cmd==='撤管理'){action='set_group_admin';params.enable=cmd==='设管理'}
          if(cmd==='头衔'){if(!tail||tail.length>30)throw new Error('头衔长度应为1～30个字符');action='set_group_special_title';params.special_title=tail;params.duration=-1}
        }
        await a.api(action,params);this.audit(e,cmd,target||'全群');this.save();await this.reply(e,a,`群管：${cmd}成功${target?' · '+target:''}`);return true
      }
      throw new Error('未知群管命令，请发送 #群管帮助')
    }catch(error){this.onError('[GroupGuard] '+error.message);await this.reply(e,a,'群管：'+error.message).catch(this.onError);return true}
  }
  parseValue(text,current){
    text=text.trim()
    if(typeof current==='boolean'){if(['开','true','开启','1'].includes(text))return true;if(['关','false','关闭','0'].includes(text))return false;throw new Error('开关值请用 开/关')}
    if(typeof current==='number'){if(!/^\d+$/.test(text))throw new Error('请输入整数');return Number(text)}
    if(Array.isArray(current)){const v=JSON.parse(text);if(!Array.isArray(v))throw new Error('请输入 JSON 数组');return v}
    return text
  }
  async globalCommand(e,a,c,cmd,args){
    if(cmd==='全局'){
      const split=args.indexOf(' ');if(split<0)throw new Error('用法：#群管全局 字段 值')
      const field=args.slice(0,split)
      if(!Object.hasOwn(c,field)||['groups','masters'].includes(field))throw new Error('未知/受保护字段，masters 请在本地配置')
      const value=this.parseValue(args.slice(split+1),c[field]);this.config.update(c=>{c[field]=value});this.audit(e,'global',field);this.save();await this.reply(e,a,`全局 ${field} 已保存`);return
    }
    if(cmd==='群黑名单'||cmd==='群白名单'){
      const field=cmd==='群黑名单'?'blackGroups':'whiteGroups'
      if(!args){await this.reply(e,a,`${cmd}：${c[field].join('、')||'空'}`);return}
      const m=args.match(/^(添加|删除)\s+(\d+)$/);if(!m)throw new Error('用法：#群管群黑名单/群白名单 添加/删除 群号');const target=id(m[2])
      this.config.update(c=>{c[field]=m[1]==='添加'?[...new Set([...c[field].map(String),target])]:c[field].filter(x=>String(x)!==target)});this.audit(e,cmd,args);this.save();await this.reply(e,a,`${cmd}已${m[1]} ${target}`);return
    }
    if(cmd==='日志'){await this.reply(e,a,this.state.audit.slice(-20).map(x=>`${new Date(x.time).toISOString()} ${x.action} 群${x.group} ${x.detail}`).join('\n')||'暂无日志');return}
    if(cmd==='更新日志'){await this.reply(e,a,fs.readFileSync(path.join(this.root,'CHANGELOG.md'),'utf8').slice(0,3500));return}
    const {update}=await import('./update.mjs');await this.reply(e,a,await update(this.root))
  }
  async recall(e,a,c,g,args){
    if(!g.recall)throw new Error('本群撤回功能已关闭')
    await this.permission(e,a,c)
    const state=this.getGroup(e)
    let messages=[]
    if(e.replyId){
      const msg=await a.api('get_msg',{message_id:e.replyId})
      if(String(msg?.group_id)!==e.group_id)throw new Error('只能撤回本群消息')
      const target=id(msg.user_id||msg.sender?.user_id)
      if(target!==e.self_id){await this.permission(e,a,c,{botAdmin:true});const member=await a.member(e.group_id,target);if(!member?.role||member.role!=='member')throw new Error('不能撤回群主、管理员或身份不明成员的消息')}
      messages=[String(e.replyId)]
    }else{
      await this.permission(e,a,c,{botAdmin:true})
      const target=await this.target(e,a,args),tail=e.at.length?args:args.replace(/^\d+\s*/,'')
      const count=Number(tail||'1');if(!Number.isInteger(count)||count<1||count>g.recallLimit)throw new Error(`撤回数量必须在1～${g.recallLimit}之间`)
      messages=state.history.filter(x=>x.user===target&&this.now()-x.time<=g.recallWindowMinutes*60000).slice(-count).reverse().map(x=>x.id)
    }
    let success=0,failed=0
    for(const message of messages){try{await a.api('delete_msg',{message_id:message});success++;state.history=state.history.filter(x=>x.id!==message)}catch{failed++}if(messages.length>1)await new Promise(r=>setTimeout(r,150))}
    this.audit(e,'recall',`${success}/${messages.length}`);this.save()
    await this.reply(e,a,`撤回完成：成功${success}条，失败${failed}条${messages.length?'':'（没有可撤回记录）'}`)
  }
  expire(c){const n=this.state.pending.length;this.state.pending=this.state.pending.filter(x=>this.now()-x.time<c.requestExpireMinutes*60000);if(n!==this.state.pending.length){this.dirty=true;this.save()}}
  async approve(p,a,approve,reason=''){await a.api('set_group_add_request',{flag:p.flag,sub_type:p.type,approve,reason})}
  async request(e,a,c,g){
    if(e.request_type!=='group')return false
    const type=e.sub_type
    if(type!=='invite'&&type!=='add')return false
    if(type==='invite'&&c.inviteMode==='off'||type==='add'&&(!g.enabled||g.joinMode==='off'))return false
    if(!e.flag)throw new Error('申请缺少 OneBot flag，无法处理')
    const p={id:randomUUID().slice(0,8),bot:e.self_id,group:e.group_id,user:e.user_id,type,flag:e.flag,time:this.now(),comment:String(e.comment||'').slice(0,1000),notices:[]}
    if(this.state.pending.some(x=>x.bot===p.bot&&x.flag===p.flag&&x.type===p.type))return true
    let decision=null,reason=''
    if(type==='invite'){
      if(c.blackGroups.map(String).includes(p.group)){decision=false;reason='群在黑名单'}
      else if(c.whiteGroups.map(String).includes(p.group)||this.master(e,c)){decision=true;reason='白名单或主人邀请'}
      else if(c.allowAdminInvite){try{const member=await a.member(p.group,p.user);if(['owner','admin'].includes(member?.role)){decision=true;reason='管理员邀请'}}catch{/* cannot verify: manual review */}}
      if(decision===null&&c.inviteMode!=='manual'){decision=c.inviteMode==='accept';reason='全局邀请策略'}
    }else{
      if(g.blackUsers.map(String).includes(p.user)){decision=false;reason='用户在黑名单'}
      else if(g.whiteUsers.map(String).includes(p.user)){decision=true;reason='用户在白名单'}
      else if(g.joinMode==='accept'||g.joinMode==='reject'){decision=g.joinMode==='accept';reason='本群入群策略'}
      else if(g.joinMode==='answer'){
        const answer=p.comment.includes('答案：')?p.comment.split('答案：').slice(1).join('答案：').trim():p.comment.trim()
        decision=g.answers.some(x=>g.exactMatch?answer.toLowerCase()===x.toLowerCase():answer.toLowerCase().includes(x.toLowerCase()));reason=decision?'答案匹配':'答案不匹配'
      }
      if(decision===true&&g.minLevel>0){
        try{const data=await a.api('get_stranger_info',{user_id:Number(p.user),no_cache:true});const level=data?.qqLevel??data?.qq_level??data?.level;if(level===undefined||level===null||level===''||!Number.isFinite(Number(level)))throw new Error('等级未知');decision=Number(level)>=g.minLevel;reason=decision?'等级与条件满足':'QQ等级不足'}catch{decision=null;reason='无法可靠取得 QQ 等级，转人工审核'}
      }
    }
    if(decision!==null){await this.approve(p,a,decision,reason);this.audit(e,'request',`${type} ${decision} ${reason}`);this.save();await this.notifyResult(p,a,c,decision,reason);return true}
    if(this.state.pending.length>=c.maxPendingRequests){this.audit(e,'request-full',p.group);this.save();await this.notifyManagers(p,a,c,`群管：待审核队列已满，群${p.group}申请未自动处理，请手动审核。`);return true}
    this.state.pending.push(p);this.save()
    await this.notifyManagers(p,a,c,`群管·${type==='invite'?'机器人入群邀请':'成员加群申请'}\n编号：${p.id}\n群号：${p.group}\n用户：${p.user}\n${g.question?'配置问题：'+g.question+'\n':''}留言：${p.comment||'无'}\n${reason}\n引用此条 #群管同意 / #群管拒绝；或发送 #群管同意/拒绝 ${p.id}\n${c.requestExpireMinutes}分钟内有效`)
    if(c.notifyInviter&&type==='invite')await a.sendPrivate(p.user,`群管：邀请已进入审核，编号 ${p.id}，有效期${c.requestExpireMinutes}分钟。`).catch(this.onError)
    this.save();return true
  }
  async notifyManagers(p,a,c,text){
    const groups=p.type==='add'?[...new Set([p.group,...c.managementGroups.map(String)])]:c.managementGroups.map(String)
    for(const gid of groups){try{const r=await a.sendGroup(gid,textSegment(text));if(r?.message_id)p.notices.push({group:gid,id:String(r.message_id)})}catch(error){this.onError(error)}}
    for(const user of c.notifyUsers){try{const r=await a.sendPrivate(user,textSegment(text));if(r?.message_id)p.notices.push({user:String(user),id:String(r.message_id)})}catch(error){this.onError(error)}}
  }
  async notifyResult(p,a,c,approve,reason){
    const text=`群管：群${p.group} / 用户${p.user} ${approve?'已同意':'已拒绝'} · ${reason}`
    await this.notifyManagers({...p,notices:[]},a,c,text)
    if(c.notifyInviter&&p.type==='invite')await a.sendPrivate(p.user,textSegment(text)).catch(this.onError)
  }
  async review(e,a,c,args,approve){
    const p=this.state.pending.find(p=>p.bot===e.self_id&&(args?p.id===args:p.notices.some(n=>n.id===e.replyId&&(e.group_id?n.group===e.group_id:n.user===e.user_id))))
    if(!p)throw new Error('未找到有效申请，请引用群管通知或填写请求编号')
    if(e.group_id){
      if(!p.notices.some(n=>n.group===e.group_id))throw new Error('请在该请求的通知群审核')
      await this.permission(e,a,c).catch(error=>{if(p.type!=='invite'||!c.allowInviterConfirm||p.user!==e.user_id)throw error})
    }else if(!this.master(e,c)&&!c.notifyUsers.map(String).includes(e.user_id)&&!(p.type==='invite'&&c.allowInviterConfirm&&p.user===e.user_id))throw new Error('需要主人、通知管理用户或被允许的邀请者权限')
    if(this.reviewing.has(p.id))throw new Error('该申请正在处理，请稍候')
    this.reviewing.add(p.id)
    try{
      if(p.type==='add'){const bot=await a.member(p.group,p.bot);if(!['owner','admin'].includes(bot?.role))throw new Error('目标群中机器人没有管理权限')}
      await this.approve(p,a,approve,'群管人工审核');this.state.pending=this.state.pending.filter(x=>x.id!==p.id);this.audit(e,'review',`${p.id} ${approve}`);this.save();await this.notifyResult(p,a,c,approve,'人工审核');await this.reply(e,a,`审核成功：${p.id} ${approve?'同意':'拒绝'}`)
    }finally{this.reviewing.delete(p.id)}
  }
  async notice(e,a,c,g){
    const decrease=['group_decrease','group.decrease'].includes(e.notice_type),increase=['group_increase','group.increase'].includes(e.notice_type)
    if(!increase&&!decrease)return false
    if(e.user_id===e.self_id){if(increase)await this.autoQuit(e,a,c,{operator:e.operator_id});return c.autoQuitEnabled}
    if(!g.enabled)return false
    if(decrease&&g.autoBlacklistOnLeave){this.config.setGroup(e.self_id,e.group_id,x=>{x.blackUsers=[...new Set([...x.blackUsers.map(String),e.user_id])]});this.audit(e,'leave-blacklist',e.user_id);this.save()}
    if(increase&&g.welcomeEnabled||decrease&&g.leaveEnabled){await a.sendGroup(e.group_id,textSegment(replace(increase?g.welcomeMessage:g.leaveMessage,{userId:e.user_id,groupId:e.group_id,name:e.member?.card||e.member?.nickname||e.user_id})));return true}
    return false
  }
  async daily(c){
    if(!c.dailyApi)throw new Error('日报 API 未配置。请主人私聊 #群管全局 dailyApi https://你的接口')
    const res=await this.fetcher(c.dailyApi,{signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error(`日报 API HTTP ${res.status}`)
    const data=await res.json(),image=data.imageUrl||data.data?.image||data.data?.imageUrl
    if(image){if(typeof image!=='string'||!/^https?:\/\//.test(image))throw new Error('日报图片网址格式不合法');return [{type:'image',data:{file:image}}]}
    const text=data.text||data.data?.text||(Array.isArray(data.data?.news)?data.data.news.join('\n'):'')
    if(typeof text!=='string'||!text.trim())throw new Error('日报 API 应返回 imageUrl、data.image、text 或 data.news')
    return textSegment(text.slice(0,4000))
  }
  async autoQuit(e,a,c,{operator}={}){
    if(!c.autoQuitEnabled||c.whiteGroups.map(String).includes(e.group_id)||c.managementGroups.map(String).includes(e.group_id))return
    if(operator&&c.masters.map(String).includes(String(operator)))return
    if(operator&&c.allowAdminInvite){try{if(['owner','admin'].includes((await a.member(e.group_id,operator))?.role))return}catch{return}}
    const members=await a.api('get_group_member_list',{group_id:Number(e.group_id)})
    if(!Array.isArray(members)||members.some(m=>c.masters.map(String).includes(String(m.user_id))))return
    if(members.find(m=>String(m.user_id)===e.self_id)?.role==='owner')return
    if(!c.blackGroups.map(String).includes(e.group_id)&&members.length>=c.minGroupMember)return
    await a.sendGroup(e.group_id,textSegment(replace(c.autoQuitMessage,{memberCount:members.length,minMember:c.minGroupMember,groupIds:c.managementGroups.join('、')})))
    await a.api('set_group_leave',{group_id:Number(e.group_id),is_dismiss:false});this.audit(e,'auto-quit',members.length);this.save()
  }
  async job(key,day,fn){
    if(this.state.jobs[key]===day)return
    // Persist the claim before a side effect; a restart never duplicates a scheduled send.
    this.state.jobs[key]=day;this.save()
    try{await fn()}catch(error){this.state.audit.push({time:this.now(),action:'job-failed',detail:key+' '+error.message});this.state.audit=this.state.audit.slice(-500);this.save();this.onError(error)}
  }
  async tick(){
    if(this.ticking)return;this.ticking=true
    try{
      const c=this.config.read();this.expire(c);const p=timeParts(this.now(),c.timezone)
      for(const [k,day] of Object.entries(this.state.jobs))if(day!==p.day)delete this.state.jobs[k]
      for(const [bot,a] of this.adapters){
        const configured=[...new Set(c.groups.filter(g=>(!g.botId||g.botId==='*'||String(g.botId)===bot)&&g.enabled).map(g=>String(g.groupId)))]
        for(const gid of configured){
          const g=this.config.group(bot,gid,c),e={self_id:bot,group_id:gid,user_id:bot}
          if(!g.enabled)continue
          if(g.scheduledMute){
            for(const [time,enable] of [[g.muteTime,true],[g.unmuteTime,false]])if(p.time===time)await this.job(`mute:${bot}:${gid}:${time}`,p.day,async()=>{const member=await a.member(gid,bot);if(!['owner','admin'].includes(member?.role))throw new Error('机器人没有群管理权限');await a.api('set_group_whole_ban',{group_id:Number(gid),enable})})
          }
          if(g.dailyEnabled&&p.time===g.dailyTime)await this.job(`daily:${bot}:${gid}`,p.day,async()=>a.sendGroup(gid,await this.daily(c)))
          if(c.autoQuitEnabled&&p.time===c.autoQuitTime)await this.job(`quit:${bot}:${gid}`,p.day,async()=>this.autoQuit(e,a,c))
        }
      }
      if(this.dirty)this.save()
    }finally{this.ticking=false}
  }
}
