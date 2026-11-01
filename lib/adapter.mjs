// The core calls the standard OneBot v11 API. No QQ protocol library is imported.
export class OneBotError extends Error {
  constructor(message,outcome='unknown'){super(message);this.name='OneBotError';this.outcome=outcome}
}
export function unwrap(response){
  if(!response||typeof response!=='object')throw new OneBotError('接口未返回有效结果')
  if(Object.hasOwn(response,'status')&&!['ok','failed'].includes(response.status))throw new OneBotError('接口未返回明确成功状态，无法确认执行结果')
  if(response.retcode!==undefined&&(!/^-?\d+$/.test(String(response.retcode))||!Number.isSafeInteger(Number(response.retcode))))throw new OneBotError('接口返回状态无效，无法确认执行结果')
  if(response.status==='failed'||response.retcode!==undefined&&Number(response.retcode)!==0)throw new OneBotError(response.message||response.wording||`接口返回错误 ${response.retcode??response.status}`,'failed')
  if(response.status&&response.status!=='ok')throw new OneBotError('接口尚未返回明确执行结果')
  if(!('retcode' in response)&&!('status' in response))throw new OneBotError('接口返回缺少成功状态，无法确认执行结果')
  return response.data
}
export class OneBotAdapter {
  constructor(call){this.call=call}
  async api(action,params={}){
    try{return unwrap(await this.call(action,params))}
    catch(error){if(error instanceof OneBotError)throw error;throw new OneBotError(String(error?.message||error))}
  }
  member(groupId,userId){return this.api('get_group_member_info',{group_id:Number(groupId),user_id:Number(userId),no_cache:true})}
  sendGroup(groupId,message){return this.api('send_group_msg',{group_id:Number(groupId),message})}
  sendPrivate(userId,message){return this.api('send_private_msg',{user_id:Number(userId),message})}
}
export function normalize(e){
  const message=Array.isArray(e.message)?e.message:[]
  const value=(s,k)=>s?.data?.[k]??s?.[k]
  const text=typeof e.msg==='string'?e.msg:message.filter(s=>s.type==='text').map(s=>value(s,'text')||'').join('')||e.raw_message||''
  const at=message.filter(s=>s.type==='at').map(s=>value(s,'qq')).filter(s=>s&&s!=='all').map(String)
  const reply=message.find(s=>s.type==='reply')
  return {...e,self_id:String(e.self_id||e.bot?.uin||''),group_id:e.group_id?String(e.group_id):'',user_id:String(e.user_id||''),msg:text.trim(),at,replyId:reply?String(value(reply,'id')):e.source?.message_id?String(e.source.message_id):'',isMaster:e.isMaster===true,message,
    post_type:e.post_type||'message',notice_type:e.notice_type?.replace(/^group\./,'group_')}
}
