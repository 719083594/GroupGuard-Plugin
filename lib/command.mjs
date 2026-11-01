// A single command allowlist is shared by the core, TRSS entry and manifest.
export const MAIN_COMMANDS = Object.freeze([
  '帮助','版本','状态','开启','关闭','设置','黑名单','白名单',
  '禁言','解禁','踢','全体禁言','全体解禁','撤回','设管理','撤管理','头衔',
  '今日榜','昨日榜','月榜','日报','待审核','同意','拒绝',
  '全局','群黑名单','群白名单','更新日志','更新','日志'
])

const names = new Set(MAIN_COMMANDS)
export const COMMAND_DEFINITIONS = Object.freeze([
  {names:['帮助','版本'],title:'帮助与版本',access:'all',contexts:['group','private'],description:'#群管帮助 / #群管帮助 文字 / #群管版本'},
  {names:['今日榜','昨日榜','月榜','日报'],title:'群内统计与新闻',access:'all',contexts:['group'],description:'#群管今日榜 / #群管昨日榜 / #群管月榜 / #群管日报'},
  {names:['开启','关闭'],title:'本群开关',access:'owner-or-master',contexts:['group'],description:'#群管开启 / #群管关闭'},
  {names:['状态','设置','黑名单','白名单'],title:'本群设置与名单',access:'admin-or-master',contexts:['group'],description:'#群管状态 / #群管设置 字段 值 / #群管黑名单 / #群管白名单'},
  {names:['禁言','解禁','踢','全体禁言','全体解禁','撤回'],title:'成员与消息管理',access:'admin-or-master',contexts:['group'],description:'禁言 @成员 [时长] / 解禁 @成员 / #群管踢 @成员 / #群管撤回'},
  {names:['设管理','撤管理','头衔'],title:'管理员与头衔',access:'owner-or-master',contexts:['group'],description:'#群管设管理 @成员 / #群管撤管理 @成员 / #群管头衔 @成员 头衔（机器人须群主）'},
  {names:['待审核','同意','拒绝'],title:'人工审核',access:'request-context',contexts:['group','private'],description:'#群管待审核 / 引用通知后 #群管同意 或 #群管拒绝 / 指定请求编号'},
  {names:['全局','群黑名单','群白名单','更新日志','更新','日志'],title:'主人私聊配置与维护',access:'master',contexts:['private'],description:'#群管全局 字段 值 / #群管群黑名单 / #群管群白名单 / #群管更新 / #群管更新日志 / #群管日志'}
])

export function parseCommand(text,{replyId='',groupId=''}={}) {
  const source=String(text??'').trim()
  if(source==='赞我')return {name:'赞我',args:''}
  if(source==='撤回')return replyId&&groupId?{name:'撤回',args:''}:null
  const short=source.match(/^[#/]?(禁言|解禁)(?:\s+([\s\S]*))?$/)
  if(short)return {name:short[1],args:(short[2]||'').trim()}
  const full=source.match(/^[#/]群管([^\s]+)(?:\s+([\s\S]*))?$/)
  if(!full||!names.has(full[1]))return null
  return {name:full[1],args:(full[2]||'').trim()}
}

export function commandMessage(text) {
  const source=String(text??'')
  const command=parseCommand(source)
  if(!command)return source
  if(command.name==='赞我')return '赞我'
  return '#群管'+command.name+(command.args?' '+command.args:'')
}

export function commandRules() {
  const rules=COMMAND_DEFINITIONS.map(({names,title,description})=>({
    reg:new RegExp('^\\s*[#/]群管(?:'+names.join('|')+')(?:\\s[\\s\\S]*)?$'),
    fnc:'dispatchCommand',title:'群管 '+title,description
  }))
  rules.push({reg:/^\s*[#/]?(?:禁言|解禁)(?:\s[\s\S]*)?$/,fnc:'dispatchCommand',title:'群管禁言与解禁简写',description:'禁言 @成员 [时长] / 解禁 @成员，保留 # 和 / 简写'})
  rules.push({reg:/^\s*(?:赞我|撤回)\s*$/,fnc:'dispatchCommand',title:'群管点赞与引用撤回',description:'群内裸 赞我；引用消息后裸 撤回（无引用不执行）'})
  return rules
}
