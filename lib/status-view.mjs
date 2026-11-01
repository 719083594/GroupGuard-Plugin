const roles={owner:'群主',admin:'管理员',member:'普通成员'}
const joins={off:'关闭',manual:'人工审核',answer:'答案审核',accept:'自动同意',reject:'自动拒绝'}
const invites={off:'不接管',manual:'人工审核',accept:'自动同意',reject:'自动拒绝'}
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const toggle=value=>value?'开启':'关闭'

// Select public status fields explicitly: never retain config, source URLs or credentials.
export function buildStatusSnapshot({version,config,group,role,newsConfigured,now=Date.now(),groupId=''}){
  const timezone=String(config.timezone)
  return Object.freeze({
    version:String(version??''),groupId:String(groupId),timezone,
    generatedAt:new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(now)),
    enabled:group.enabled===true,role:Object.hasOwn(roles,role)?roles[role]:'身份未确认',
    statistics:group.statistics===true,recall:group.recall===true,likes:group.likes===true,
    welcome:group.welcomeEnabled===true,leave:group.leaveEnabled===true,
    joinMode:Object.hasOwn(joins,group.joinMode)?joins[group.joinMode]:'未知',dailyEnabled:group.dailyEnabled===true,
    dailyTime:String(group.dailyTime),newsConfigured:newsConfigured===true,
    inviteMode:Object.hasOwn(invites,config.inviteMode)?invites[config.inviteMode]:'未知',autoQuit:config.autoQuitEnabled===true
  })
}

export function buildStatusText(s){
  return `群管 ${s.version}\n本群：${toggle(s.enabled)}；机器人：${s.role}\n统计：${toggle(s.statistics)}；撤回：${toggle(s.recall)}；点赞：${toggle(s.likes)}\n欢迎：${toggle(s.welcome)}；离群通知：${toggle(s.leave)}\n入群审核：${s.joinMode}\n日报：${toggle(s.dailyEnabled)} ${s.dailyTime}；来源：${s.newsConfigured?'已配置':'未配置'}\n邀请审核：${s.inviteMode}；自动退群：${toggle(s.autoQuit)}\n时区：${s.timezone}\n更新时间：${s.generatedAt}`
}

export function buildStatusHtml(s){
  const item=(name,value,on)=>`<div class="item"><span class="label">${escape(name)}</span><strong${typeof on==='boolean'?` class="${on?'active':'muted'}"`:''}>${escape(value)}</strong></div>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=920"><title>群管状态</title><style>
*{box-sizing:border-box}body{margin:0;width:920px;padding:24px;background:#edf2f7;color:#1f2a3d;font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}.card{overflow:hidden;border:1px solid #dce4ef;border-radius:26px;background:#fff;box-shadow:0 12px 36px #1e3a5f12}.header{padding:32px 36px 26px;background:linear-gradient(125deg,#102b53,#244b7d);color:#fff}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0;font-size:34px;letter-spacing:1px}.version{padding:7px 14px;border:1px solid #ffffff42;border-radius:20px;font-size:15px;color:#dcecff}.sub{margin-top:10px;color:#c3d4eb;font-size:17px;overflow-wrap:anywhere}.summary{margin:28px 32px 8px;padding:22px 24px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid ${s.enabled?'#bee6d5':'#dce3ed'};border-radius:16px;background:${s.enabled?'#effaf5':'#f4f6f9'}}.summary strong{font-size:26px;color:${s.enabled?'#18744f':'#576578'}}.summary small{display:block;margin-top:7px;font-size:15px;color:#69798d}.role{text-align:right;font-size:18px;font-weight:700;color:#3f536d}.section{padding:23px 32px 0}h2{margin:0 0 12px;font-size:18px;font-weight:700;color:#53647a}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.two{grid-template-columns:repeat(2,1fr)}.item{min-width:0;padding:18px 20px;border:1px solid #e4eaf2;border-radius:14px;background:#fbfcfe}.label{display:block;margin-bottom:9px;color:#718096;font-size:16px}.item strong{display:block;font-size:21px;font-weight:700;overflow-wrap:anywhere}.active{color:#19815c}.muted{color:#788596}.footer{margin-top:28px;padding:20px 32px;border-top:1px solid #e6ebf3;background:#f8fafc;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:#748398;font-size:14px}.footer span{overflow-wrap:anywhere}
</style></head><body id="container"><main class="card"><header class="header"><div class="heading"><h1>群管状态</h1><span class="version">v${escape(s.version)}</span></div><div class="sub">${s.groupId?'群 '+escape(s.groupId):'本群管理概览'}</div></header><div class="summary"><div><strong>群管已${toggle(s.enabled)}</strong><small>本群总开关</small></div><div class="role">机器人身份 · ${escape(s.role)}</div></div><section class="section"><h2>管理与互动</h2><div class="grid">${item('发言统计',toggle(s.statistics),s.statistics)}${item('消息撤回',toggle(s.recall),s.recall)}${item('QQ 点赞',toggle(s.likes),s.likes)}</div></section><section class="section"><h2>群事件通知</h2><div class="grid two">${item('入群欢迎',toggle(s.welcome),s.welcome)}${item('离群通知',toggle(s.leave),s.leave)}</div></section><section class="section"><h2>审核与自动化</h2><div class="grid">${item('入群审核',s.joinMode)}${item('邀请审核',s.inviteMode)}${item('自动退群',toggle(s.autoQuit),s.autoQuit)}</div></section><section class="section"><h2>每日日报</h2><div class="grid">${item('定时推送',toggle(s.dailyEnabled),s.dailyEnabled)}${item('推送时间',s.dailyTime)}${item('新闻来源',s.newsConfigured?'已配置':'未配置',s.newsConfigured)}</div></section><footer class="footer"><span>时区 · ${escape(s.timezone)}</span><span>更新于 ${escape(s.generatedAt)}</span></footer></main></body></html>`
}
