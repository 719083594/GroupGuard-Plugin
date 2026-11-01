import {timeParts,replace,textSegment} from '../utils.mjs'
export const automationMethods={
  async notice(e,a,c,g){
    const decrease=['group_decrease','group.decrease'].includes(e.notice_type),increase=['group_increase','group.increase'].includes(e.notice_type)
    if(!increase&&!decrease)return false
    if(e.user_id===e.self_id){if(increase)await this.autoQuit(e,a,c,{operator:e.operator_id,entryTime:e.time});return c.autoQuitEnabled}
    if(!g.enabled)return false
    if(increase&&g.welcomeEnabled||decrease&&g.leaveEnabled){await a.sendGroup(e.group_id,textSegment(replace(increase?g.welcomeMessage:g.leaveMessage,{userId:e.user_id,groupId:e.group_id,name:e.member?.card||e.member?.nickname||e.user_id})));return true}
    return false
  },
  async autoQuit(e,a,c,{operator,entryTime}={}){
    return this.withLock('exit:'+e.self_id+':'+e.group_id,async()=>{
    if(!c.autoQuitEnabled||c.whiteGroups.map(String).includes(e.group_id)||c.managementGroups.map(String).includes(e.group_id))return
    if(operator&&c.masters.map(String).includes(String(operator)))return
    if(operator&&c.allowAdminInvite){try{if(['owner','admin'].includes((await a.member(e.group_id,operator))?.role))return}catch{return}}
    const members=await a.api('get_group_member_list',{group_id:Number(e.group_id)})
    if(!Array.isArray(members)||members.some(m=>c.masters.map(String).includes(String(m.user_id))))return
    if(members.find(m=>String(m.user_id)===e.self_id)?.role==='owner')return
    if(!c.blackGroups.map(String).includes(e.group_id)&&members.length>=c.minGroupMember)return
    const key=e.self_id+':'+e.group_id,previous=this.state.exits[key],now=this.now(),day=timeParts(now,c.timezone).day
    const joined=Number(entryTime),newEntry=previous&&Number.isSafeInteger(joined)&&joined>Math.floor(previous.at/1000)&&joined>(previous.entryTime||0)&&joined*1000<=now+300000
    if(previous&&!newEntry&&!(previous.status==='failed'&&timeParts(previous.at,c.timezone).day!==day))return
    if(!previous&&Object.keys(this.state.exits).length>=5000)throw new Error('自动退群防重记录已满，请主人检查')
    const claim={at:now,entryTime:Number.isSafeInteger(joined)&&joined>0?joined:0,status:'preparing',promptStatus:'pending'}
    this.state.exits[key]=claim
    try{this.save()}catch(error){if(previous)this.state.exits[key]=previous;else delete this.state.exits[key];throw error}
    try{
      await a.sendGroup(e.group_id,textSegment(replace(c.autoQuitMessage,{memberCount:members.length,minMember:c.minGroupMember,groupIds:c.managementGroups.join('、')})))
      claim.promptStatus='success';claim.status='pending';this.save()
    }catch(error){
      claim.status='failed';if(claim.promptStatus!=='success')claim.promptStatus=error.outcome==='failed'?'failed':'unknown'
      this.audit(e,'auto-quit-stopped',error.message);this.trySave();this.onError(error);return
    }
    try{
      await a.api('set_group_leave',{group_id:Number(e.group_id),is_dismiss:false})
      claim.status='success';this.audit(e,'auto-quit',members.length)
    }catch(error){claim.status=error.outcome==='failed'?'failed':'unknown';this.audit(e,'auto-quit-'+claim.status,error.message);this.onError(error)}
    this.trySave()
    })
  },
  async job(key,day,fn){
    if(this.state.jobs[key]===day)return
    // Persist the claim before a side effect; a restart never duplicates a scheduled send.
    this.state.jobs[key]=day;this.save()
    try{await fn()}catch(error){this.audit({self_id:'',group_id:'',user_id:''},'job-failed',key+' '+error.message);this.trySave();this.onError(error)}
  },
  async tick(){
    if(this.ticking)return;this.ticking=true
    try{
      const c=this.config.read();this.currentConfig=c;this.expire(c);const p=timeParts(this.now(),c.timezone)
      for(const [k,day] of Object.entries(this.state.jobs))if(day!==p.day)delete this.state.jobs[k]
      for(const [bot,a] of this.adapters){
        const configured=[...new Set(c.groups.filter(g=>(!g.botId||g.botId==='*'||String(g.botId)===bot)&&g.enabled).map(g=>String(g.groupId)))]
        for(const gid of configured){
          const g=this.config.group(bot,gid,c),e={self_id:bot,group_id:gid,user_id:bot}
          if(!g.enabled)continue
          if(g.dailyEnabled&&p.time===g.dailyTime)await this.job(`daily:${bot}:${gid}`,p.day,async()=>a.sendGroup(gid,await this.daily(c,e)))
          if(c.autoQuitEnabled&&p.time===c.autoQuitTime)await this.job(`quit:${bot}:${gid}`,p.day,async()=>this.autoQuit(e,a,c))
        }
      }
      if(this.dirty)this.save()
    }finally{this.ticking=false}
  }
}
