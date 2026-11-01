import {randomUUID} from 'node:crypto'
import {textSegment} from '../utils.mjs'
export const reviewMethods={
  expire(c){const n=this.state.pending.length;this.state.pending=this.state.pending.filter(x=>this.now()-x.time<c.requestExpireMinutes*60000);if(n!==this.state.pending.length){this.dirty=true;this.save()}},
  async approve(p,a,approve,reason=''){
    const key=this.requestKey(p),known=this.state.requests[key]
    if(known&&known.status!=='failed')throw new Error('该申请已提交或结果待核验，不重复执行')
    if(!known&&Object.keys(this.state.requests).length>=5000)throw new Error('审核防重记录已满，请手动核对平台申请')
    this.state.requests[key]={status:'pending',time:this.now(),bot:p.bot}
    try{this.save()}catch(error){
      if(known)this.state.requests[key]=known;else delete this.state.requests[key]
      this.onError(error)
      throw new Error('审核状态保存失败，尚未向平台提交，请存储恢复后重试')
    }
    try{
      await a.api('set_group_add_request',{flag:p.flag,sub_type:p.type,approve,reason})
      this.state.requests[key]={status:'success',time:this.now(),bot:p.bot};this.trySave()
    }catch(error){
      this.state.requests[key]={status:error.outcome==='failed'?'failed':'unknown',time:this.now(),bot:p.bot};this.trySave()
      if(error.outcome!=='failed')throw new Error('审核已提交但结果无法确认，请先核验，不能重复处理')
      throw error
    }
  },
  async request(e,a,c,g){
    if(e.request_type!=='group')return false
    const type=e.sub_type
    if(type!=='invite'&&type!=='add')return false
    if(type==='invite'&&c.inviteMode==='off'||type==='add'&&(!g.enabled||g.joinMode==='off'))return false
    if(!e.flag)throw new Error('申请缺少 OneBot flag，无法处理')
    const p={id:randomUUID().slice(0,8),bot:e.self_id,group:e.group_id,user:e.user_id,type,flag:e.flag,time:this.now(),comment:String(e.comment||'').slice(0,1000),notices:[]}
    if(this.state.pending.some(x=>x.bot===p.bot&&x.flag===p.flag&&x.type===p.type)||this.state.requests[this.requestKey(p)])return true
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
    if(decision!==null){await this.approve(p,a,decision,reason);this.audit(e,'request',`${type} ${decision} ${reason}`);this.trySave();await this.notifyResult(p,a,c,decision,reason);return true}
    if(this.state.pending.length>=c.maxPendingRequests){this.audit(e,'request-full',p.group);this.save();await this.notifyManagers(p,a,c,`群管：待审核队列已满，群${p.group}申请未自动处理，请手动审核。`);return true}
    this.state.pending.push(p);this.save()
    await this.notifyManagers(p,a,c,`群管·${type==='invite'?'机器人入群邀请':'成员加群申请'}\n编号：${p.id}\n群号：${p.group}\n用户：${p.user}\n${g.question?'配置问题：'+g.question+'\n':''}留言：${p.comment||'无'}\n${reason}\n引用此条 #群管同意 / #群管拒绝；或发送 #群管同意/拒绝 ${p.id}\n${c.requestExpireMinutes}分钟内有效`)
    if(c.notifyInviter&&type==='invite')await a.sendPrivate(p.user,`群管：邀请已进入审核，编号 ${p.id}，有效期${c.requestExpireMinutes}分钟。`).catch(this.onError)
    this.save();return true
  },
  async notifyManagers(p,a,c,text){
    const groups=p.type==='add'?[...new Set([p.group,...c.managementGroups.map(String)])]:c.managementGroups.map(String)
    for(const gid of groups){try{const r=await a.sendGroup(gid,textSegment(text));if(r?.message_id)p.notices.push({group:gid,id:String(r.message_id)})}catch(error){this.onError(error)}}
    for(const user of c.notifyUsers){try{const r=await a.sendPrivate(user,textSegment(text));if(r?.message_id)p.notices.push({user:String(user),id:String(r.message_id)})}catch(error){this.onError(error)}}
  },
  async notifyResult(p,a,c,approve,reason){
    const text=`群管：群${p.group} / 用户${p.user} ${approve?'已同意':'已拒绝'} · ${reason}`
    await this.notifyManagers({...p,notices:[]},a,c,text)
    if(c.notifyInviter&&p.type==='invite')await a.sendPrivate(p.user,textSegment(text)).catch(this.onError)
  },
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
      await this.approve(p,a,approve,'群管人工审核');this.state.pending=this.state.pending.filter(x=>x.id!==p.id);this.audit(e,'review',`${p.id} ${approve}`);this.trySave();await this.notifyResult(p,a,c,approve,'人工审核');await this.notify(e,a,`审核成功：${p.id} ${approve?'同意':'拒绝'}`)
    }finally{this.reviewing.delete(p.id)}
  }
}
