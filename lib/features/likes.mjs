import {timeParts} from '../utils.mjs'
export const likesMethods={
  async like(e,a,c,g){
    if(!g.likes)throw new Error('本群点赞功能未开启：#群管设置 likes 开')
    return this.withLock('like:'+e.self_id,async()=>{
      const day=timeParts(this.now(),c.timezone).day
      if(this.state.likeMigrationBlockedDay===day)throw new Error('旧版今日提交次数无法完整确认，点赞额度将于次日启用')
      const days=this.state.likes[e.self_id]??={}
      for(const key of Object.keys(days))if(key<timeParts(this.now()-7*86400000,c.timezone).day)delete days[key]
      const budget=days[day]??={used:0,users:{}}
      if(budget.users[e.user_id])throw new Error('今天已向你提交过点赞或结果待确认，不重复发送')
      if(budget.used>=100)throw new Error('今天的点赞额度已用完')
      budget.used+=10
      budget.users[e.user_id]={status:'reserved',time:this.now(),count:10}
      this.save()
      const record=budget.users[e.user_id]
      try{
        record.status='sent';this.save()
        await a.api('send_like',{user_id:Number(e.user_id),times:10})
        record.status='success';this.audit(e,'like','10');this.trySave()
        await this.notify(e,a,'已提交10个赞（最终到账以 QQ 为准）')
      }catch(error){
        record.status=error.outcome==='failed'?'failed':'unknown'
        this.audit(e,'like-'+record.status,'10');this.trySave()
        if(record.status==='unknown')throw new Error('点赞提交结果无法确认，已保留额度，今天不重复发送')
        throw new Error('点赞未成功，本次提交额度已保留，今天不重复发送')
      }
    })
  }
}
