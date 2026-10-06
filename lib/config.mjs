import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'

export const groupDefaults = {
  botId:'*', groupId:'', enabled:false, statistics:true, recall:true, likes:false,
  rankLimit:10, recallLimit:20, recallWindowMinutes:10,
  welcomeEnabled:false, leaveEnabled:false,
  welcomeMessage:'欢迎 {userId} 加入本群！', leaveMessage:'{userId} 离开了本群。',
  dailyEnabled:false, dailyTime:'08:00', scheduledMute:false, muteTime:'00:00', unmuteTime:'08:00',
  joinMode:'off', question:'', answers:[], exactMatch:false, minLevel:0,
  blackUsers:[], whiteUsers:[], autoBlacklistOnLeave:false
}
export const id = value => {
  const s=String(value??'')
  if(!/^[1-9]\d{3,15}$/.test(s)||!Number.isSafeInteger(Number(s)))throw new Error('账号/群号必须是有效的数字 ID')
  return s
}
export function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const temp=file+'.'+randomUUID()+'.tmp'
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file)}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
}
function integer(x,min,max,key){if(!Number.isInteger(x)||x<min||x>max)throw new Error(`${key} 必须在 ${min}～${max} 之间`)}
function arrayIds(x,key){if(!Array.isArray(x)||x.length>5000)throw new Error(`${key} 应是 ID 数组（最多5000项）`);x.forEach(id)}
export function validate(config){
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('配置必须是对象')
  for(const k of ['masters','managementGroups','notifyUsers','blackGroups','whiteGroups'])arrayIds(config[k],k)
  if(!['off','manual','accept','reject'].includes(config.inviteMode))throw new Error('inviteMode 应为 off/manual/accept/reject')
  for(const k of ['allowInviterConfirm','allowAdminInvite','notifyInviter','autoQuitEnabled'])if(typeof config[k]!=='boolean')throw new Error(`${k} 应为开关`)
  integer(config.requestExpireMinutes,1,60,'requestExpireMinutes');integer(config.maxPendingRequests,1,100,'maxPendingRequests');integer(config.minGroupMember,1,10000,'minGroupMember')
  try{new Intl.DateTimeFormat('en',{timeZone:config.timezone})}catch{throw new Error('timezone 不是有效时区')}
  for(const k of ['autoQuitTime'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(config[k]))throw new Error(`${k} 应为 HH:mm`)
  if(typeof config.autoQuitMessage!=='string'||config.autoQuitMessage.length>2000)throw new Error('退群消息长度不合法')
  if(typeof config.dailyApi!=='string')throw new Error('dailyApi 应为网址字符串')
  if(config.dailyApi&&!/^https?:\/\//.test(config.dailyApi))throw new Error('日报 API 应为 HTTP(S) 网址')
  if(!Array.isArray(config.groups)||config.groups.length>1000)throw new Error('groups 应是群配置数组（最多1000项）')
  const keys=new Set()
  for(const raw of config.groups){
    const g={...groupDefaults,...raw}; id(g.groupId);if(g.botId!=='*')id(g.botId)
    const key=g.botId+':'+g.groupId;if(keys.has(key))throw new Error('重复的机器人/群配置');keys.add(key)
    for(const k of ['enabled','statistics','recall','likes','welcomeEnabled','leaveEnabled','dailyEnabled','scheduledMute','exactMatch','autoBlacklistOnLeave'])if(typeof g[k]!=='boolean')throw new Error(`${k} 应为开关`)
    for(const k of ['dailyTime','muteTime','unmuteTime'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(g[k]))throw new Error(`${k} 应为 HH:mm`)
    if(g.scheduledMute&&g.muteTime===g.unmuteTime)throw new Error('禁言和解禁时间不能相同')
    integer(g.rankLimit,1,50,'rankLimit');integer(g.recallLimit,1,50,'recallLimit');integer(g.recallWindowMinutes,1,120,'recallWindowMinutes');integer(g.minLevel,0,200,'minLevel')
    if(!['off','manual','answer','accept','reject'].includes(g.joinMode))throw new Error('joinMode 不合法')
    arrayIds(g.blackUsers,'blackUsers');arrayIds(g.whiteUsers,'whiteUsers')
    if(!Array.isArray(g.answers)||g.answers.length>100||g.answers.some(s=>typeof s!=='string'||!s.trim()||s.length>200))throw new Error('answers 应为非空答案字符串数组')
    if(g.joinMode==='answer'&&!g.answers.length)throw new Error('答案审核需要至少一个答案')
    for(const k of ['question','welcomeMessage','leaveMessage'])if(typeof g[k]!=='string'||g[k].length>2000)throw new Error(`${k} 文本长度不合法`)
  }
  return config
}
export class ConfigStore {
  constructor(root){this.root=root;this.file=path.join(root,'config/local.json');this.defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url)));if(!fs.existsSync(this.file))atomic(this.file,this.defaults)}
  read(){const c={...structuredClone(this.defaults),...JSON.parse(fs.readFileSync(this.file,'utf8'))};if(Array.isArray(c.groups))c.groups=c.groups.map(g=>({...structuredClone(groupDefaults),...g}));return validate(c)}
  update(fn){const c=this.read();fn(c);validate(c);atomic(this.file,c);return c}
  group(botId,groupId,c=this.read()){return {...groupDefaults,...(c.groups.find(g=>String(g.groupId)===String(groupId)&&String(g.botId)===String(botId))||c.groups.find(g=>String(g.groupId)===String(groupId)&&(!g.botId||g.botId==='*')))}}
  setGroup(botId,groupId,fn){this.update(c=>{let g=c.groups.find(g=>String(g.groupId)===String(groupId)&&String(g.botId)===String(botId));if(!g){g={...this.group(botId,groupId,c),botId:id(botId),groupId:id(groupId)};c.groups.push(g)}fn(g)})}
}
