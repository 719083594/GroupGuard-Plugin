import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'

export const groupDefaults = {
  botId:'*', groupId:'', enabled:false, statistics:true, recall:true, likes:false,
  rankLimit:10, recallLimit:20, recallWindowMinutes:10,
  welcomeEnabled:false, leaveEnabled:false,
  welcomeMessage:'欢迎 {userId} 加入本群！', leaveMessage:'{userId} 离开了本群。',
  dailyEnabled:false, dailyTime:'08:00',
  joinMode:'off', question:'', answers:[], exactMatch:false, minLevel:0,
  blackUsers:[], whiteUsers:[]
}

export const GROUP_CHAT_FIELDS = new Set(Object.keys(groupDefaults).filter(k=>!['enabled','botId','groupId'].includes(k)))
export const GLOBAL_CHAT_FIELDS = new Set([
  'managementGroups','notifyUsers','inviteMode','allowInviterConfirm','allowAdminInvite',
  'notifyInviter','requestExpireMinutes','maxPendingRequests','blackGroups','whiteGroups',
  'autoQuitEnabled','minGroupMember','autoQuitTime','autoQuitMessage','timezone'
])
const REMOVED_GROUP_FIELDS = ['autoBlacklistOnLeave','scheduledMute','muteTime','unmuteTime']
const AUTH_TYPES = new Set(['none','bearer','header','query'])
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const own = (o,k)=>Object.hasOwn(o,k)
const object = x=>x!==null&&typeof x==='object'&&!Array.isArray(x)

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
function httpUrl(value){
  if(typeof value!=='string'||!value||value.length>8192||/[\r\n\u0000]/.test(value))throw new Error('新闻 API 应为 HTTP(S) 网址')
  let u
  try{u=new URL(value)}catch{throw new Error('新闻 API 应为 HTTP(S) 网址')}
  if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)throw new Error('新闻 API 应为不含用户密码的 HTTP(S) 网址')
  return value
}
function source(raw){
  if(!object(raw))throw new Error('新闻来源必须是对象')
  const s={url:raw.url,key:own(raw,'key')?raw.key:'',authType:own(raw,'authType')?raw.authType:'none',authName:own(raw,'authName')?raw.authName:''}
  httpUrl(s.url)
  if(typeof s.key!=='string'||s.key.length>8192||/[\r\n\u0000]/.test(s.key))throw new Error('新闻 Key 长度或格式不合法')
  if(!AUTH_TYPES.has(s.authType))throw new Error('新闻鉴权类型应为 none/bearer/header/query')
  if(typeof s.authName!=='string'||s.authName.length>128||/[\r\n\u0000]/.test(s.authName))throw new Error('新闻鉴权参数名不合法')
  if(s.authType==='header'&&!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(s.authName))throw new Error('新闻鉴权 Header 名不合法')
  if(s.authType==='query'&&!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s.authName))throw new Error('新闻鉴权查询参数名不合法')
  if(['none','bearer'].includes(s.authType)&&s.authName!=='')throw new Error('此新闻鉴权类型不使用参数名')
  return s
}

export function validate(config){
  if(!object(config))throw new Error('配置必须是对象')
  if(config.schemaVersion!==2)throw new Error('不支持的配置版本，需要 schemaVersion=2')
  if(!object(config.legacy))throw new Error('legacy 必须是对象')
  if(own(config,'dailyApi')||own(config,'standalone'))throw new Error('旧运行字段已移除，不能作为有效配置保存')
  for(const k of ['masters','managementGroups','notifyUsers','blackGroups','whiteGroups'])arrayIds(config[k],k)
  if(!['off','manual','accept','reject'].includes(config.inviteMode))throw new Error('inviteMode 应为 off/manual/accept/reject')
  for(const k of ['allowInviterConfirm','allowAdminInvite','notifyInviter','autoQuitEnabled'])if(typeof config[k]!=='boolean')throw new Error(`${k} 应为开关`)
  integer(config.requestExpireMinutes,1,60,'requestExpireMinutes');integer(config.maxPendingRequests,1,100,'maxPendingRequests');integer(config.minGroupMember,1,10000,'minGroupMember')
  if(typeof config.timezone!=='string'||!config.timezone)throw new Error('timezone 不是有效时区')
  try{new Intl.DateTimeFormat('en',{timeZone:config.timezone})}catch{throw new Error('timezone 不是有效时区')}
  if(!TIME.test(config.autoQuitTime))throw new Error('autoQuitTime 应为 HH:mm')
  if(typeof config.autoQuitMessage!=='string'||config.autoQuitMessage.length>2000)throw new Error('退群消息长度不合法')
  if(!Array.isArray(config.groups)||config.groups.length>1000)throw new Error('groups 应是群配置数组（最多1000项）')
  const keys=new Set()
  for(const raw of config.groups){
    if(!object(raw))throw new Error('群配置必须是对象')
    for(const k of REMOVED_GROUP_FIELDS)if(own(raw,k))throw new Error('旧自动策略字段已移除')
    const g={...groupDefaults,...raw};id(g.groupId);if(g.botId!=='*')id(g.botId)
    const key=g.botId+':'+g.groupId;if(keys.has(key))throw new Error('重复的机器人/群配置');keys.add(key)
    for(const k of ['enabled','statistics','recall','likes','welcomeEnabled','leaveEnabled','dailyEnabled','exactMatch'])if(typeof g[k]!=='boolean')throw new Error(`${k} 应为开关`)
    if(!TIME.test(g.dailyTime))throw new Error('dailyTime 应为 HH:mm')
    integer(g.rankLimit,1,50,'rankLimit');integer(g.recallLimit,1,50,'recallLimit');integer(g.recallWindowMinutes,1,120,'recallWindowMinutes');integer(g.minLevel,0,200,'minLevel')
    if(!['off','manual','answer','accept','reject'].includes(g.joinMode))throw new Error('joinMode 不合法')
    arrayIds(g.blackUsers,'blackUsers');arrayIds(g.whiteUsers,'whiteUsers')
    if(!Array.isArray(g.answers)||g.answers.length>100||g.answers.some(s=>typeof s!=='string'||!s.trim()||s.length>200))throw new Error('answers 应为非空答案字符串数组')
    if(g.joinMode==='answer'&&!g.answers.length)throw new Error('答案审核需要至少一个答案')
    for(const k of ['question','welcomeMessage','leaveMessage'])if(typeof g[k]!=='string'||g[k].length>2000)throw new Error(`${k} 文本长度不合法`)
  }
  if(!Array.isArray(config.newsSources)||config.newsSources.length>1000)throw new Error('newsSources 应是来源数组（最多1000项）')
  const sources=new Set()
  for(const s of config.newsSources){
    if(!object(s))throw new Error('新闻来源必须是对象')
    const key=id(s.botId)+':'+id(s.groupId)
    if(sources.has(key))throw new Error('重复的机器人/群新闻来源');sources.add(key)
    source(s)
  }
  return config
}

function normalize(raw,defaults){
  if(!object(raw))throw new Error('配置必须是对象')
  const version=own(raw,'schemaVersion')?raw.schemaVersion:1
  if(![1,2].includes(version))throw new Error('不支持的配置版本，未修改原文件')
  const c={...structuredClone(defaults),...structuredClone(raw)}
  if(!object(c.legacy))throw new Error('legacy 必须是对象')
  if(!Array.isArray(c.groups))throw new Error('groups 应是群配置数组')
  c.groups=c.groups.map(g=>{
    if(!object(g))throw new Error('群配置必须是对象')
    return {...structuredClone(groupDefaults),...g}
  })
  if(version===1){
    c.schemaVersion=2
    if(own(raw,'dailyApi')){
      if(typeof raw.dailyApi!=='string')throw new Error('旧 dailyApi 应为网址字符串，未修改原文件')
      if(raw.dailyApi)httpUrl(raw.dailyApi)
      c.legacy.dailyApi=raw.dailyApi
      delete c.dailyApi
    }
    if(own(raw,'standalone')){c.legacy.standalone=structuredClone(raw.standalone);delete c.standalone}
    const removed=[]
    c.groups.forEach(g=>{
      const fields={}
      for(const k of REMOVED_GROUP_FIELDS)if(own(g,k)){fields[k]=g[k];delete g[k]}
      if(Object.keys(fields).length)removed.push({botId:g.botId,groupId:g.groupId,fields})
    })
    if(removed.length){
      if(own(c.legacy,'removedGroupPolicies')&&!Array.isArray(c.legacy.removedGroupPolicies))throw new Error('旧策略恢复信息格式不合法，未修改原文件')
      c.legacy.removedGroupPolicies=[...(c.legacy.removedGroupPolicies??[]),...removed]
    }
    if(!Array.isArray(c.newsSources))throw new Error('newsSources 应是来源数组')
    if(raw.dailyApi){
      for(const g of c.groups){
        if(g.botId==='*')continue
        const botId=id(g.botId),groupId=id(g.groupId)
        if(!c.newsSources.some(s=>String(s.botId)===botId&&String(s.groupId)===groupId))c.newsSources.push({botId,groupId,url:raw.dailyApi,key:'',authType:'none',authName:''})
      }
    }
  }
  return validate(c)
}

export class ConfigStore {
  constructor(root){
    this.root=root;this.file=path.join(root,'config/local.json')
    this.defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
    validate(this.defaults)
    const existed=fs.existsSync(this.file)
    Object.defineProperty(this,'wasLegacy',{value:existed&&(JSON.parse(fs.readFileSync(this.file,'utf8')).schemaVersion??1)!==2,enumerable:true})
    if(!existed)atomic(this.file,this.defaults)
  }
  snapshot(){
    const text=fs.readFileSync(this.file,'utf8'),raw=JSON.parse(text)
    return {text,raw,config:normalize(raw,this.defaults)}
  }
  read(){return this.snapshot().config}
  backup(snapshot){
    if((snapshot.raw.schemaVersion??1)>=2)return
    const hash=createHash('sha256').update(snapshot.text).digest('hex')
    const file=path.join(this.root,'data/config-backups',`local.schema-v1.${hash}.json`)
    if(!fs.existsSync(file))atomic(file,snapshot.raw)
  }
  migrate(){
    const saved=this.snapshot()
    if((saved.raw.schemaVersion??1)<2){this.backup(saved);atomic(this.file,saved.config)}
    return saved.config
  }
  update(fn){
    const saved=this.snapshot(),c=saved.config
    fn(c);validate(c);this.backup(saved);atomic(this.file,c);return c
  }
  group(botId,groupId,c=this.read()){
    const raw=c.groups.find(g=>String(g.groupId)===String(groupId)&&String(g.botId)===String(botId))||c.groups.find(g=>String(g.groupId)===String(groupId)&&(!g.botId||g.botId==='*'))
    const g=structuredClone(groupDefaults)
    if(raw)for(const k of Object.keys(groupDefaults))if(own(raw,k))g[k]=structuredClone(raw[k])
    return g
  }
  setGroup(botId,groupId,fn){
    return this.update(c=>{
      let g=c.groups.find(g=>String(g.groupId)===String(groupId)&&String(g.botId)===String(botId))
      if(!g){g={...this.group(botId,groupId,c),botId:id(botId),groupId:id(groupId)};c.groups.push(g)}
      fn(g)
    })
  }
  getNews(botId,groupId,c=this.read()){
    const s=c.newsSources.find(s=>String(s.botId)===String(botId)&&String(s.groupId)===String(groupId))
    return s?source(s):null
  }
  getNewsForEditor(botId,groupId,c=this.read()){
    const s=this.getNews(botId,groupId,c)
    return s?{url:s.url,authType:s.authType,authName:s.authName,hasKey:!!s.key}:null
  }
  // The caller is a authenticated browser bridge, never a chat field setter.
  setNews(botId,groupId,patch){
    botId=id(botId);groupId=id(groupId)
    if(!object(patch))throw new Error('新闻保存内容必须是对象')
    for(const k of Object.keys(patch))if(!['url','authType','authName','keyAction','key'].includes(k))throw new Error('未知新闻配置字段')
    const action=patch.keyAction??'keep'
    if(!['keep','replace','clear'].includes(action))throw new Error('Key 操作应为 keep/replace/clear')
    if(action!=='replace'&&own(patch,'key'))throw new Error('替换 Key 必须显式选择 replace，遮掩值不得保存')
    if(action==='replace'&&(typeof patch.key!=='string'||!patch.key||/^[*•●]+$/.test(patch.key)))throw new Error('请提供新 Key，不能使用遮掩值')
    this.update(c=>{
      const old=this.getNews(botId,groupId,c)??{url:'',key:'',authType:'none',authName:''}
      const value={...old}
      for(const k of ['url','authType','authName'])if(own(patch,k))value[k]=patch[k]
      if(action==='replace')value.key=patch.key
      if(action==='clear')value.key=''
      const next={botId,groupId,...source(value)}
      const index=c.newsSources.findIndex(s=>String(s.botId)===botId&&String(s.groupId)===groupId)
      if(index<0)c.newsSources.push(next);else c.newsSources[index]=next
    })
    return this.getNewsForEditor(botId,groupId)
  }
}
