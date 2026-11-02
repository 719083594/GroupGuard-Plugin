import fs from 'node:fs'
import {groupDefaults,GROUP_CHAT_FIELDS,GLOBAL_CHAT_FIELDS} from '../lib/config.mjs'
import {MAIN_COMMANDS,COMMAND_DEFINITIONS} from '../lib/command.mjs'

const defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'))
const labels={
  masters:'插件主人 QQ（只手动修改）',managementGroups:'审核管理群',notifyUsers:'私聊通知与审核用户',
  inviteMode:'机器人邀请审核模式',allowInviterConfirm:'邀请者自行确认',allowAdminInvite:'管理员邀请免审',notifyInviter:'通知邀请人',
  requestExpireMinutes:'请求过期分钟数',maxPendingRequests:'实例共用待审上限',blackGroups:'群黑名单',whiteGroups:'群白名单',
  autoQuitEnabled:'自动退群',minGroupMember:'最低群人数',autoQuitTime:'退群巡检时间',autoQuitMessage:'退群提示模板',
  timezone:'日期与任务时区',groups:'本群设置',botId:'机器人 QQ',groupId:'群号',enabled:'启用本群',statistics:'发言统计',
  recall:'消息撤回',likes:'QQ 点赞',rankLimit:'排行人数',recallLimit:'最大批量撤回条数',recallWindowMinutes:'批量撤回窗口（分钟）',
  welcomeEnabled:'入群欢迎',leaveEnabled:'离群通知',welcomeMessage:'欢迎模板',leaveMessage:'离群模板',
  dailyEnabled:'定时新闻',dailyTime:'新闻时间',joinMode:'成员申请审核模式',question:'入群问题提示',answers:'可接受答案',
  exactMatch:'答案精确匹配',minLevel:'最低 QQ 等级（0 关闭）',blackUsers:'成员黑名单',whiteUsers:'成员白名单',
  schemaVersion:'配置结构版本',newsSources:'按机器人与群隔离的新闻来源',legacy:'受保护的迁移信息'
}
const limits={rankLimit:[1,50],recallLimit:[1,50],recallWindowMinutes:[1,120],minLevel:[0,200],requestExpireMinutes:[1,60],maxPendingRequests:[1,100],minGroupMember:[1,10000]}
const idArrays=new Set(['masters','managementGroups','notifyUsers','blackGroups','whiteGroups','blackUsers','whiteUsers'])
function field(key,value,scope) {
  const type=Array.isArray(value)?'array':value!==null&&typeof value==='object'?'object':typeof value==='number'?'integer':typeof value
  const writable=scope==='group'?GROUP_CHAT_FIELDS:GLOBAL_CHAT_FIELDS
  const out={path:(scope==='group'?'groups.*.':'')+key,label:labels[key]||key,type,scope,chatWritable:writable.has(key),sensitive:false}
  if(limits[key])[out.min,out.max]=limits[key]
  if(key==='inviteMode')out.enum=['off','manual','accept','reject']
  if(key==='joinMode')out.enum=['off','manual','answer','accept','reject']
  if(idArrays.has(key)){out.items={type:'string',format:'qq-or-group-id'};out.maxItems=5000}
  if(key==='answers'){out.items={type:'string',minLength:1,maxLength:200};out.maxItems=100}
  if(['question','welcomeMessage','leaveMessage','autoQuitMessage'].includes(key))out.maxLength=2000
  if(['dailyTime','autoQuitTime'].includes(key))out.format='HH:mm'
  if(key==='timezone')out.format='iana-timezone'
  if(key==='masters'){out.editPolicy='manual-file-only';out.description='只手动编辑 config/local.json；普通命令识别 isMaster 或 masters，自动退群豁免只读 masters。'}
  if(key==='enabled'){out.editPolicy='dedicated-command-or-manager';out.description='聊天仅通过 #群管开启 / #群管关闭调整。'}
  if(key==='botId'||key==='groupId')out.editPolicy='identity-not-chat-writable'
  if(key==='groups'){out.editPolicy='structured-manager';out.maxItems=1000}
  if(key==='schemaVersion'||key==='legacy'){out.editPolicy='internal';out.hidden=true}
  if(key==='legacy')out.sensitive=true
  if(key==='newsSources'){
    out.editPolicy='browser-only';out.sensitive=true;out.maxItems=1000
    out.description='浏览器管理界面按精确机器人与群维护；不允许聊天 setter 或通配来源。'
    out.keyWriteContract={actions:['keep','replace','clear'],defaultAction:'keep',readView:'hasKey only'}
    out.fields=[
      {name:'botId',type:'string',format:'qq-id',sensitive:false},
      {name:'groupId',type:'string',format:'group-id',sensitive:false},
      {name:'url',type:'string',format:'http-or-https-url',sensitive:true},
      {name:'key',type:'string',sensitive:true,writeOnly:true},
      {name:'authType',type:'string',enum:['none','bearer','header','query'],sensitive:false},
      {name:'authName',type:'string',sensitive:false,description:'header/query 时必须提供合法名称；none/bearer 为空'}
    ]
  }
  if(key==='autoQuitEnabled')out.description='入群事件由全局开关控制；每日巡检只处理已配置并启用的群。'
  return out
}
const syntax={
  '状态':'#群管状态 [文字]',
  '帮助':'#群管帮助 [文字]','设置':'#群管设置 <字段> <值>','禁言':'#群管禁言 @成员 [时长]','解禁':'#群管解禁 @成员',
  '踢':'#群管踢 @成员','撤回':'#群管撤回（引用）或 #群管撤回 @成员 [条数]',
  '黑名单':'#群管黑名单 [添加|删除 <QQ>]','白名单':'#群管白名单 [添加|删除 <QQ>]',
  '群黑名单':'#群管群黑名单 [添加|删除 <群号>]','群白名单':'#群管群白名单 [添加|删除 <群号>]',
  '设管理':'#群管设管理 @成员','撤管理':'#群管撤管理 @成员','头衔':'#群管头衔 @成员 <头衔>',
  '同意':'#群管同意 [请求编号]（也可引用通知）','拒绝':'#群管拒绝 [请求编号]（也可引用通知）',
  '全局':'#群管全局 <字段> <值>'
}
const withoutEnabled=new Set(['帮助','版本','登录','状态','开启','关闭','同意','拒绝','全局','群黑名单','群白名单','更新日志','更新','日志'])
const commandTable=MAIN_COMMANDS.map(name=>{
  const metadata=COMMAND_DEFINITIONS.find(row=>row.names.includes(name))
  return {name,command:syntax[name]||'#群管'+name,aliases:['/群管'+name],permission:metadata.access,contexts:name==='待审核'?['group']:metadata.contexts,requiresEnabled:!withoutEnabled.has(name),description:metadata.description}
})
commandTable.push(
  {name:'赞我',command:'赞我',aliases:[],permission:'all',contexts:['group'],requiresEnabled:true,requiresFeature:'likes',description:'裸词精确匹配；每机器人每天最多调用10次，每次 times:10，跨群共用并持久化。'},
  {name:'撤回简写',command:'撤回',aliases:[],permission:'admin-or-master',contexts:['group'],requiresEnabled:true,requiresReply:true,description:'仅有效群消息引用，复用正式引用撤回。'},
  {name:'禁言简写',command:'禁言 @成员 [时长]',aliases:['#禁言','/禁言'],permission:'admin-or-master',contexts:['group'],requiresEnabled:true},
  {name:'解禁简写',command:'解禁 @成员',aliases:['#解禁','/解禁'],permission:'admin-or-master',contexts:['group'],requiresEnabled:true}
)
const manifest={
  schemaVersion:2,id:'groupguard',title:'GroupGuard-Plugin 群管',version:pkg.version,
  description:pkg.description,runtime:{framework:'TRSS',adapter:'OneBot v11',provider:'NapCat',entry:'index.js',node:pkg.engines.node,independentHttp:false,integrationApi:'api.mjs',integrationContract:'docs/ADAPTERS.md',integrationExample:'examples/framework-adapter.mjs',frameworksBundled:['TRSS'],frameworkApiAutoStart:false},
  permissions:{master:'TRSS isMaster === true 或手动配置的 masters；自动退群主人豁免只读取 masters',enforcement:'core-and-entry'},
  commands:commandTable.map(row=>row.command),commandTable,
  configs:[{id:'groupguard',file:'config/local.json',reload:'hot',defaults,fields:[
    ...Object.entries(defaults).map(([key,value])=>field(key,value,'global')),
    ...Object.entries(groupDefaults).map(([key,value])=>field(key,value,'group'))
  ]}],
  management:{manifestOnly:false,browserStatus:'implemented',serverProvided:true,embeddedIn:'TRSS plugin process',defaultHost:'127.0.0.1',defaultPort:15083,authentication:'password-or-one-time-qq-ticket; session-csrf',loginLink:{command:'#群管登录',context:'master-private',ttlSeconds:180,singleUse:true,fragmentCredential:true},environment:{enabled:'GROUPGUARD_ADMIN_ENABLED',host:'GROUPGUARD_ADMIN_HOST',port:'GROUPGUARD_ADMIN_PORT',publicUrl:'GROUPGUARD_ADMIN_PUBLIC_URL'},description:'插件内置配置页面；无额外系统服务，不接收OneBot事件；Docker只映射宿主回环地址。'},
  privacy:{instanceConfigPublished:false,instanceDataPublished:false,secretFields:['newsSources.*.key','newsSources.*.url','legacy']}
}
const output=JSON.stringify(manifest,null,2)+'\n'
const target=new URL('../plugin.manifest.json',import.meta.url)
if(process.argv.includes('--check')){
  if(!fs.existsSync(target)||fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n')!==output){console.error('plugin.manifest.json 与命令/配置定义不一致，请运行 npm run manifest');process.exitCode=1}
}else fs.writeFileSync(target,output)
