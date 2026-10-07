// Fixed command descriptions only. No runtime configuration, IDs or account data.
export const helpTopics = {
  'groupguard-public': {
    title: '群管 · GroupGuard',
    subtitle: '成员管理、入群审核与发言统计 · 帮助公开可查，操作逐项核验权限',
    theme: 'dark',
    groups: [
      {title: '查看与群服务', items: [
        {command: '#群管帮助 / #群管版本', description: '查看指令指南与插件版本。'},
        {command: '#群管发言日榜 / #群管昨日榜', description: '查看本群今日、昨日发言排行；需已开启统计。'},
        {command: '#群管发言月榜', description: '查看本群当月发言排行；需已开启统计。'},
        {command: '#群管日报 / #群管赞我', description: '日报需要配置来源；点赞需要管理员先开启。'}
      ]},
      {title: '本群设置', items: [
        {command: '#群管开启 / #群管关闭', description: '开启或关闭本群功能。', permission: '群主或机器人主人'},
        {command: '#群管状态', description: '查看本群配置与机器人群权限。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管设置 字段 值', description: '布尔值使用 开/关；数组使用 JSON。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管黑名单 添加/删除 QQ', description: '用户白名单使用 #群管白名单；不带参数查看。', permission: '群管理员、群主或机器人主人'}
      ]},
      {title: '成员与消息管理', items: [
        {command: '禁言 @成员 [10分钟] / 解禁 @成员', description: '默认禁言10分钟；也支持 #群管禁言、#群管解禁。', permission: '操作人与机器人均需群管理权限'},
        {command: '#群管踢 @成员', description: '移出普通成员；保护群主、管理员、机器人与操作人。', permission: '操作人与机器人均需群管理权限'},
        {command: '#群管全体禁言 / #群管全体解禁', description: '设置本群全体禁言状态。', permission: '操作人与机器人均需群管理权限'},
        {command: '#群管撤回（引用） / #群管撤回 @成员 5', description: '引用撤回或批量撤回本群近期记录；返回实际成功数量。', permission: '群管理员、群主或机器人主人'}
      ]},
      {title: '群主与审核', items: [
        {command: '#群管设管理 @成员 / #群管撤管理 @成员', description: '任免本群管理员。', permission: '操作者群主或机器人主人；机器人需为群主'},
        {command: '#群管头衔 @成员 头衔', description: '设置专属头衔。', permission: '操作者群主或机器人主人；机器人需为群主'},
        {command: '#群管待审核', description: '查看当前允许审核的入群申请。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管同意 / #群管拒绝', description: '引用审核通知，或后接请求编号；兼容 #确认加群、#拒绝加群。', permission: '通知群管理、机器人主人或指定审核人'}
      ]},
      {title: '设置示例', items: [
        {command: '#群管设置 scheduledMute 开', description: '启用定时禁言；再设置 muteTime 与 unmuteTime。', permission: '群管理员、群主或机器人主人'},
        {command: '#群管设置 answers ["答案"]', description: '配置入群答案后，使用 #群管设置 joinMode answer。', permission: '群管理员、群主或机器人主人'}
      ]}
    ],
    footer: '支持 #群卫、/群管、＃群管。发送 #群管帮助 文字 可查看文字版。所有操作保留原权限核验，帮助图片本地保存、直接读取。'
  },
  'groupguard-master': {
    title: '群管 · 主人维护指南',
    subtitle: '仅机器人主人私聊附加显示 · 本页只有固定指令说明',
    theme: 'dark',
    groups: [
      {title: '全局配置', items: [
        {command: '#群管全局 字段 值', description: '修改全局配置；受保护字段仍须在本地维护。', permission: '仅机器人主人私聊'},
        {command: '#群管群黑名单 添加/删除 群号', description: '管理全局群黑名单。', permission: '仅机器人主人私聊'},
        {command: '#群管群白名单 添加/删除 群号', description: '管理全局群白名单。', permission: '仅机器人主人私聊'}
      ]},
      {title: '维护与日志', items: [
        {command: '#群管更新', description: '按插件更新流程检查并更新源码。', permission: '仅机器人主人私聊'},
        {command: '#群管更新日志 / #群管日志', description: '查看更新说明或最近操作日志。', permission: '仅机器人主人私聊'}
      ]}
    ],
    footer: '本页不包含真实账号、群号、配置值或日志内容。群内始终只发送公开帮助页。'
  }
}
