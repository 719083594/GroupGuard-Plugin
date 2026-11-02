// Public, fixed descriptions only. Never read account configuration here.
export const helpTopics = {
  'groupguard-public': {
    title: '群管 · GroupGuard', subtitle: '群秩序、成员准入与群内辅助功能',
    groups: [
      {title: '查看与群内服务', items: [
        {command: '#群管帮助 / #群管帮助 文字 / #群管版本', description: '所有人可查；图片不可用时自动提供文字帮助。'},
        {command: '#群管今日榜 / #群管昨日榜 / #群管月榜', description: '本群发言与图片数量排行；需要本群统计开启。'},
        {command: '#群管日报', description: '手动查看本群新闻；来源与可选 Key 在浏览器界面按机器人、群配置。'},
        {command: '赞我', description: '整条正文仅发送“赞我”。每次提交 10 赞，每机器人每日最多 100 赞、10 人；跨群共用，失败或未决也占额度。'}
      ]},
      {title: '本群配置与成员名单', items: [
        {command: '#群管开启 / #群管关闭', description: '只更改当前机器人所在本群。', permission: '群主或机器人主人'},
        {command: '#群管状态 / #群管状态 文字', description: '默认 PNG 状态卡片；图片失败退文字，后接“文字”直接纯文字；本群关闭时仍可查看。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管设置 字段 值', description: '修改本群可写字段；布尔用 开/关，数组用 JSON。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管黑名单 [添加/删除 QQ]', description: '成员白名单用 #群管白名单；不带参数查看。名单用于入群审核，不自动踢人或禁言。', permission: '群管理员、群主或机器人主人'}
      ]},
      {title: '成员与消息管理', items: [
        {command: '禁言 @成员 [时长] / 解禁 @成员', description: '默认禁言 10 分钟；支持秒、分钟、小时、天，范围 1 秒至 30 天。也支持 #禁言、#解禁及正式群管写法。', permission: '操作者需群管理员、群主或主人；机器人需群管理权限'},
        {command: '#群管踢 @成员', description: '移出普通成员，不设置永久拒绝再次申请；保护群主、管理员、机器人与操作人。', permission: '操作者需群管理员、群主或主人；机器人需群管理权限'},
        {command: '#群管全体禁言 / #群管全体解禁', description: '手动修改本群全体禁言状态。', permission: '操作者需群管理员、群主或主人；机器人需群管理权限'},
        {command: '引用后发送 撤回 或 #群管撤回', description: '只处理被引用的本群消息；撤回他人消息需机器人管理权限且目标是普通成员。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管撤回 @成员 [条数]', description: '默认 1 条；从近期记录逐条撤回并汇总成功/失败，受条数、时间窗和平台限制。', permission: '群管理员、群主或机器人主人；机器人需管理权限'}
      ]},
      {title: '群主能力与审核', items: [
        {command: '#群管设管理 @成员 / #群管撤管理 @成员', description: '设置或撤销本群管理员。', permission: '操作者需群主或机器人主人；机器人必须是群主'},
        {command: '#群管头衔 @成员 头衔', description: '设置 1—30 字符的永久专属头衔。', permission: '操作者需群主或机器人主人；机器人必须是群主'},
        {command: '#群管待审核', description: '查看本群或管理群允许查看的待审申请。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管同意 / #群管拒绝 [请求编号]', description: '引用真实审核通知或填写请求编号；绑定机器人与通知位置，过期不可处理。', permission: '按通知群管理、主人、指定审核用户或获准邀请人规则核查'}
      ]},
      {title: '可选功能与设置示例', items: [
        {command: '#群管设置 welcomeEnabled 开', description: '入群欢迎、离群通知和定时新闻均可选，默认关闭。'},
        {command: '#群管设置 answers ["答案"]', description: '配置答案后用 #群管设置 joinMode answer；等级未知转人工审核。'},
        {command: '#群管设置 likes 开', description: '开启本群点赞；总开关也必须开启。同一用户当天发出请求后不再重发。'}
      ]}
    ],
    footer: '正式 #群管… 指令均支持半角 /群管…；禁言/解禁简写同样支持 # 和 /。群服务需本群开启；帮助与版本不受总开关限制。'
  },
  'groupguard-master': {
    title: '群管 · 主人维护指南', subtitle: '仅机器人主人私聊附加显示',
    groups: [
      {title: '首次配置与主人身份', items: [
        {command: '#群管登录', description: '主人私聊获取一次性配置链接，3分钟有效；手机访问需先配置公网 HTTPS 地址。', permission: '仅机器人主人私聊'},
        {command: '手动编辑 config/local.json → masters', description: '填写负责人的 QQ 字符串数组，可配置多人；默认空名单。没有添加、更换主人的聊天指令。'},
        {command: '框架 isMaster 或插件 masters', description: '普通命令均认可；自动退群的主人豁免只读取插件 masters，不自动合并 TRSS 主人名单。'}
      ]},
      {title: '全局策略与群名单', items: [
        {command: '#群管全局 字段 值', description: '修改允许的全局审核、通知、退群和时区字段；masters 与 groups 不能通过聊天整体修改。', permission: '仅机器人主人私聊'},
        {command: '#群管群黑名单 [添加/删除 群号]', description: '不带参数查看；邀请审核黑名单优先。', permission: '仅机器人主人私聊'},
        {command: '#群管群白名单 [添加/删除 群号]', description: '不带参数查看；自动退群先判断白名单、管理群等豁免。', permission: '仅机器人主人私聊'},
        {command: '新闻 API / Key：浏览器管理界面', description: '按机器人、群隔离；不提供聊天配置入口。修改其他字段不能清空已有 Key，日志与状态不显示密钥。'}
      ]},
      {title: '源码维护与日志', items: [
        {command: '#群管更新', description: '只支持官方 origin/main 的 Git 克隆安装、干净工作树与快进更新；保留实例配置和 data。更新后手动重启，不自动安装依赖。', permission: '仅机器人主人私聊'},
        {command: '#群管更新日志 / #群管日志', description: '查看变更说明或最近 20 条操作日志；ZIP 安装请手动替换发布包并保留配置与数据。', permission: '仅机器人主人私聊'}
      ]}
    ],
    footer: '本页只有固定说明，不含真实账号、群号、配置值或日志。群内始终只发送公开页。新闻错过定时不补发，失败当天不自动重试。'
  }
}

function text(topic, version) {
  const page=helpTopics[topic]
  return [`${page.title} ${version}`,page.subtitle,...page.groups.flatMap(group=>[`【${group.title}】`,...group.items.map(item=>`${item.command}\n${item.description}${item.permission?'\n权限：'+item.permission:''}`)]),page.footer].join('\n')
}
export const publicHelpText=(version='2.3.0')=>text('groupguard-public',version)
export const masterHelpText=(version='2.3.0')=>text('groupguard-master',version)
