import {duration} from '../utils.mjs'
import {id} from '../config.mjs'
export const membersMethods={
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
    let success=0,failed=0,unknown=0
    for(const message of messages){try{await this.effect(e,a,'delete_msg',{message_id:message});success++;state.history=state.history.filter(x=>x.id!==message)}catch(error){if(error.outcome==='unknown')unknown++;else failed++}if(messages.length>1)await new Promise(r=>setTimeout(r,150))}
    this.audit(e,'recall',`${success}/${messages.length};unknown=${unknown}`);this.trySave()
    await this.notify(e,a,`撤回完成：成功${success}条，失败${failed}条${unknown?'；结果待核验'+unknown+'条，请先核验，不重复操作':''}${messages.length?'':'（没有可撤回记录）'}`)
  },
  async memberAction(e,a,c,cmd,args){
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
    const result=await this.effect(e,a,action,params)
    if(result?.alreadyCompleted){await this.notify(e,a,'此消息的管理操作已经完成，不重复执行');return}
    this.audit(e,cmd,target||'全群');this.trySave()
    await this.notify(e,a,'群管：'+cmd+'成功'+(target?' · '+target:''))
  }
}
