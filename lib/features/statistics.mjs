import {timeParts,shiftDay,shiftMonth} from '../utils.mjs'
export const statisticsMethods={
  getGroup(e){const key=e.self_id+':'+e.group_id;return this.state.groups[key]??= {days:{},months:{},history:[]}},
  record(e,g,c){
    if(!g.enabled||!e.group_id||!this.eventKey(e)||e.user_id===e.self_id)return
    const state=this.getGroup(e),now=this.now(),time=timeParts(now,c.timezone)
    if(state.history.some(x=>String(x.id)===String(e.message_id)))return
    state.history.push({id:String(e.message_id),user:e.user_id,time:now});state.history=state.history.filter(x=>now-x.time<=120*60000).slice(-500)
    if(g.statistics){
      const yesterday=shiftDay(time.day,-1)
      for(const d of Object.keys(state.days))if(d!==time.day&&d!==yesterday)delete state.days[d]
      const previousMonth=shiftMonth(time.month,-1)
      for(const m of Object.keys(state.months))if(m!==time.month&&m!==previousMonth)delete state.months[m]
      for(const table of [state.days[time.day]??= {},state.months[time.month]??= {}]){
        if(!Object.hasOwn(table,e.user_id)&&Object.keys(table).length>=5000)continue
        const row=table[e.user_id]??= {count:0,images:0,name:e.user_id}
        row.count++;row.images+=e.message.filter(s=>s.type==='image').length;row.name=String(e.sender?.card||e.sender?.nickname||e.user_id).slice(0,60)
      }
    }
    this.dirty=true
  },
  async showRank(e,a,c,g,cmd){
    if(!g.statistics)throw new Error('本群统计已关闭')
    const p=timeParts(this.now(),c.timezone),state=this.getGroup(e)
    if(cmd==='昨日榜')p.day=shiftDay(p.day,-1)
    const table=cmd==='月榜'?state.months[p.month]:state.days[p.day]
    const rows=Object.entries(table||{}).sort((a,b)=>b[1].count-a[1].count).slice(0,g.rankLimit)
    await this.notify(e,a,'群管·'+cmd+' '+(cmd==='月榜'?p.month:p.day)+'\n'+(rows.map(([u,r],i)=>(i+1)+'. '+r.name+' ('+u+')：'+r.count+'条 / '+r.images+'张图片').join('\n')||'暂无发言记录'))
  }
}
