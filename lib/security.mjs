import {id} from './config.mjs'
export const securityMethods={
  master(e,c){return e.isMaster||c.masters.map(String).includes(e.user_id)},
  async permission(e,a,c,{owner=false,botOwner=false,botAdmin=false}={}){
    if(!e.group_id)throw new Error('请在群里使用这个命令')
    const actor=await a.member(e.group_id,e.user_id)
    if(!this.master(e,c)&&!['owner',...(owner?[]:['admin'])].includes(actor?.role))throw new Error(owner?'需要群主或机器人主人权限':'需要群管理员、群主或机器人主人权限')
    if(botOwner||botAdmin){const bot=await a.member(e.group_id,e.self_id);if(botOwner&&bot?.role!=='owner')throw new Error('这个操作需要机器人是群主');if(botAdmin&&!['owner','admin'].includes(bot?.role))throw new Error('请先给机器人群管理员权限')}
  },
  async target(e,a,args,{allowAdmin=false}={}){
    const t=id(e.at.find(value=>value!==e.self_id)||args.match(/^\s*(\d+)/)?.[1]||'')
    if(t===e.self_id||t===e.user_id)throw new Error('不能对机器人或操作人自己执行此操作')
    const member=await a.member(e.group_id,t)
    if(!member||!member.role)throw new Error('未能确认目标的群成员身份')
    if(!['member',...(allowAdmin?['admin']:[])].includes(member.role))throw new Error('不能对群主、管理员或身份不明成员执行此操作')
    return t
  }
}
