import fs from 'node:fs'
import {groupDefaults} from '../lib/config.mjs'
const defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url)))
const labels={masters:'主人QQ列表（TRSS同时继承框架主人）',managementGroups:'审核通知管理群',notifyUsers:'通知与审核管理用户',inviteMode:'机器人邀请审核模式',allowInviterConfirm:'允许邀请者自审',allowAdminInvite:'允许管理员邀请免审',notifyInviter:'私聊通知邀请人',requestExpireMinutes:'请求过期分钟数',maxPendingRequests:'最大待审核请求',blackGroups:'群黑名单',whiteGroups:'群白名单',autoQuitEnabled:'自动退群',minGroupMember:'最低群人数',autoQuitTime:'退群巡检时间',autoQuitMessage:'退群通知模板',dailyApi:'日报API网址',timezone:'定时任务与统计时区',groups:'逐群设置',botId:'机器人QQ（*表示所有）',groupId:'群号',enabled:'启用本群',statistics:'发言统计',recall:'单条与批量撤回',likes:'QQ点赞',rankLimit:'排行榜人数',recallLimit:'最大撤回条数',recallWindowMinutes:'撤回记录窗口分钟数',welcomeEnabled:'入群欢迎',leaveEnabled:'退群通知',welcomeMessage:'欢迎模板',leaveMessage:'退群模板',dailyEnabled:'定时日报',dailyTime:'日报时间',scheduledMute:'定时全体禁言',muteTime:'全体禁言时间',unmuteTime:'全体解禁时间',joinMode:'成员加群审核模式',question:'入群问题提示',answers:'正确答案列表',exactMatch:'答案精确匹配',minLevel:'最低QQ等级（0关闭）',blackUsers:'成员黑名单',whiteUsers:'成员白名单',autoBlacklistOnLeave:'离群自动拉黑'}
const limits={rankLimit:[1,50],recallLimit:[1,50],recallWindowMinutes:[1,120],minLevel:[0,200],requestExpireMinutes:[1,60],maxPendingRequests:[1,100],minGroupMember:[1,10000]}
function field(key,value,prefix=''){
  const out={path:prefix+key,label:labels[key],type:Array.isArray(value)?'array':typeof value==='number'?'integer':typeof value==='boolean'?'boolean':'string'}
  if(limits[key])[out.min,out.max]=limits[key]
  if(key==='inviteMode')out.enum=['off','manual','accept','reject']
  if(key==='joinMode')out.enum=['off','manual','answer','accept','reject']
  if(['managementGroups','notifyUsers','masters','blackGroups','whiteGroups','blackUsers','whiteUsers','answers'].includes(key))out.description='JSON数组，例如 ["123456789"]'
  if(key==='groups'){out.itemDefaults=groupDefaults;out.description='每项设置一个群，支持多机器人；默认不启用。'}
  if(key==='autoQuitEnabled')out.description='开启后仅检查已启用群；管理群、白名单、主人所在群、机器人群主的群豁免。'
  if(key==='minLevel')out.description='NapCat需要返回真实QQ等级；未知等级转人工审核。'
  return out
}
const commandTable=[
  {title:'群卫帮助与版本',command:'#群管帮助 / #群管版本',description:'无游戏依赖的独立群管理；#群卫为别名。',permission:'all',category:'群管理'},
  {title:'群卫发言排行',command:'#群管发言日榜 / #群管昨日榜 / #群管发言月榜',description:'按本群、本机器人与配置时区统计发言和图片。',permission:'all',category:'群管理'},
  {title:'群卫群服务',command:'#群管日报 / #群管赞我',description:'日报需设置API；点赞需在本群开启。',permission:'all',category:'群管理'},
  {title:'群卫设置与名单',command:'#群管状态 / #群管设置 字段 值 / #群管黑名单 添加/删除 QQ / #群管白名单 添加/删除 QQ',description:'群管理权限；开启/关闭需要群主或主人。',permission:'admin',category:'群管理'},
  {title:'启用群卫',command:'#群管开启 / #群管关闭',description:'仅群主或主人；只更改本群。',permission:'owner',category:'群管理'},
  {title:'群卫禁言与踢人',command:'#群管禁言 @成员 10分钟 / #群管解禁 @成员 / #群管踢 @成员 / #群管全体禁言 / #群管全体解禁',description:'操作人和机器人均需管理权限，保护群主和管理员。',permission:'admin',category:'群管理'},
  {title:'群卫撤回',command:'#群管撤回（引用） / #群管撤回 @成员 5',description:'只撤回本群；批量受条数和时间限制，准确显示失败数。',permission:'admin',category:'群管理'},
  {title:'群卫管理任免与头衔',command:'#群管设管理 @成员 / #群管撤管理 @成员 / #群管头衔 @成员 头衔',description:'操作人需群主或主人，机器人必须为群主。',permission:'owner',category:'群管理'},
  {title:'群卫审核',command:'#群管待审核 / #群管同意 请求编号 / #群管拒绝 请求编号 / #确认加群 / #拒绝加群',description:'可引用群卫审核通知；请求绑定账号和通知群，过期不可操作。',permission:'admin',category:'群管理'},
  {title:'群卫全局设置与维护',command:'#群管全局 字段 值 / #群管群黑名单 添加/删除 群号 / #群管群白名单 添加/删除 群号 / #群管更新 / #群管更新日志 / #群管日志',description:'仅主人私聊。全局设置、源码更新和审计；不覆盖本地源码改动。',permission:'master',category:'群管理'}
]
const manifest={schemaVersion:1,title:'GroupGuard-Plugin 群卫',description:'独立通用群管理：权限、审核、撤回、统计、通知与定时任务，无游戏依赖。',version:'1.0.0',commands:commandTable.flatMap(x=>x.command.split(' / ')),commandTable,configs:[{id:'groupguard',title:'群卫设置',file:'config/local.json',defaults,reload:'hot',fields:[...Object.entries(defaults).map(([k,v])=>field(k,v)),...Object.entries(groupDefaults).map(([k,v])=>field(k,v,'groups.*.'))]}]}
fs.writeFileSync(new URL('../orangejuice.plugin.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n')
