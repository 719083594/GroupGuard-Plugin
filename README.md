# GroupGuard-Plugin · 群卫

独立、无游戏依赖的通用 QQ 群管理插件。管理逻辑直接调用标准 OneBot v11 API，支持 TRSS/Yunzai 插件安装，也支持脱离框架的独立 HTTP 服务。Node.js 20+，核心零 npm 依赖、零数据库依赖。

## 安装到 TRSS/Yunzai

在机器人根目录执行：

```sh
git clone https://github.com/719083594/GroupGuard-Plugin.git plugins/GroupGuard-Plugin
# 使用原来的启动方式重启机器人
```

或者解压发布包至 `plugins/GroupGuard-Plugin`，使该目录直接包含 `index.js`、`package.json`、`lib`。ZIP 安装不支持 Git 在线更新，更新时替换源码、保留 `config/local.json` 和 `data/`。

插件加载后创建本地配置；默认所有群均未启用。由群主或机器人主人在目标群发送 `#群管开启`，然后发送 `#群管帮助`。`#群卫` 和 `/群管` 也是入口。所有群操作都独立核查操作者、机器人、目标成员的真实群权限。

只依赖适配器提供的 `bot.sendApi(action, params)`；已验证 TRSS + OneBotv11 + NapCat。其他 Yunzai 适配器必须提供此接口及明确的 OneBot 成功/失败状态，不将缺少状态的返回值当作成功。非 OneBot 平台可复用 `lib/core.mjs`，自行实现 adapter，但平台功能需要逐项映射。

## 指令

| 操作 | 指令 | 权限 |
|---|---|---|
| 帮助/版本 | `#群管帮助`、`#群管版本` | 所有人 |
| 开启/关闭本群 | `#群管开启`、`#群管关闭` | 群主或机器人主人 |
| 状态/配置 | `#群管状态`、`#群管设置 字段 值` | 群管理或主人 |
| 用户黑白名单 | `#群管黑名单 添加/删除 QQ`、`#群管白名单 添加/删除 QQ`；不带参数查看 | 群管理或主人 |
| 禁言/解禁 | `#群管禁言 @成员 10分钟`、`#群管解禁 @成员`；支持数字QQ、中文时长 | 群管理或主人，机器人管理 |
| 踢人 | `#群管踢 @成员` | 群管理或主人，机器人管理 |
| 全体禁言 | `#群管全体禁言`、`#群管全体解禁` | 群管理或主人，机器人管理 |
| 管理任免 | `#群管设管理 @成员`、`#群管撤管理 @成员` | 操作者群主或主人，**机器人群主** |
| 专属头衔 | `#群管头衔 @成员 头衔` | 操作者群主或主人，**机器人群主** |
| 撤回 | 引用后 `#群管撤回`；`#群管撤回 @成员 5` | 群管理或主人，机器人管理 |
| 统计 | `#群管发言日榜`、`#群管昨日榜`、`#群管发言月榜` | 已开启群，统计开启 |
| 日报/点赞 | `#群管日报`、`#群管赞我` | 日报需API；点赞需本群开启 |
| 审核 | `#群管待审核`；引用通知 `#群管同意`/`#群管拒绝`，或后接请求编号 | 通知群管理/主人，或指定审核用户 |
| 兼容审核 | 引用后 `#确认加群`、`#拒绝加群` | 同上 |
| 全局配置 | `#群管全局 字段 值` | 仅主人私聊 |
| 群名单 | `#群管群黑名单 添加/删除 群号`、`#群管群白名单 添加/删除 群号` | 仅主人私聊 |
| 维护 | `#群管更新`、`#群管更新日志`、`#群管日志` | 仅主人私聊 |

机器人和操作人自己、群主、管理员不能作为普通禁言/踢人目标。引用撤回必须属于当前群，不能通过引用撤回外群消息。批量撤回仅覆盖安装并开启后收到的本群记录；最多50条、最多120分钟记录窗口，QQ另有撤回时限，失败条数会真实返回。撤回自己的机器人消息允许，管理员消息不予撤回。

原插件的无前缀命令不自动注册，统一使用 `#群管` 避免与已有插件冲突。如需旧命令，可在 OrangeJuice 自定义指令中配置别名，权限仍由群卫核查。

## 设置（热更新，无须重启）

全部配置在 `config/local.json`，不提交 GitHub、不进入发布包；`data/state.json` 保存统计、待审核、调度记录及最近500条审计，不保存聊天正文。可在 OrangeJuice 插件管理中直接编辑，也可使用指令。配置错误会停止相应功能并提示错误，不覆盖已有有效文件；请在编辑前保留备份。

群配置 `groups` 是数组，每项 `botId` 为机器人QQ（或 `*` 匹配全部），`groupId` 为群号。具体机器人配置优先于 `*`；从群命令保存会创建该机器人专用配置，不影响另一账号。

| 群字段 | 默认/含义 |
|---|---|
| `enabled` | false；本群功能总开关 |
| `statistics` / `recall` / `likes` | true / true / false |
| `rankLimit` | 10，范围1～50 |
| `recallLimit` / `recallWindowMinutes` | 20条 / 10分钟 |
| `welcomeEnabled` / `leaveEnabled` | false / false |
| `welcomeMessage` / `leaveMessage` | 模板，支持 `{userId}`、`{groupId}`、`{name}` |
| `scheduledMute` / `muteTime` / `unmuteTime` | false / `00:00` / `08:00` |
| `dailyEnabled` / `dailyTime` | false / `08:00` |
| `joinMode` | `off`不接管；`manual`人工；`answer`答案；`accept`全同意；`reject`全拒绝 |
| `question` / `answers` / `exactMatch` | 问题提示 / 答案字符串数组 / false（忽略大小写包含匹配） |
| `minLevel` | 0关闭；>0检查真实 QQ 等级，不是群等级；无法获取时转人工 |
| `blackUsers` / `whiteUsers` | 用户QQ数组；黑名单优先 |
| `autoBlacklistOnLeave` | false；开启后普通成员离群加入黑名单 |

例如：

```text
#群管设置 welcomeMessage 欢迎 {userId}！
#群管设置 welcomeEnabled 开
#群管设置 scheduledMute 开
#群管设置 muteTime 23:00
#群管设置 unmuteTime 08:00
#群管设置 answers ["正确答案","另一个答案"]
#群管设置 joinMode answer
```

| 全局字段 | 默认/含义 |
|---|---|
| `masters` | []；独立运行必须设置；TRSS 同时识别框架的 `isMaster`。自动退群豁免检查此列表 |
| `managementGroups` / `notifyUsers` | [] / []；管理群、额外私聊审核员 |
| `inviteMode` | `off`不接管、`manual`审核、`accept`自动同意、`reject`自动拒绝 |
| `allowInviterConfirm` / `allowAdminInvite` / `notifyInviter` | 默认均 false |
| `requestExpireMinutes` / `maxPendingRequests` | 5分钟 / 20项；队列满不自动操作 |
| `blackGroups` / `whiteGroups` | 群号数组；黑名单优先，白名单/主人邀请免审 |
| `autoQuitEnabled` / `minGroupMember` / `autoQuitTime` | false / 10人 / `00:00`；新入群检查及每日巡检已启用群 |
| `autoQuitMessage` | 支持 `{memberCount}`、`{minMember}`、`{groupIds}` |
| `dailyApi` | 空；由你选择日报服务，支持 `imageUrl`、`data.image`、`text`、`data.news` |
| `timezone` | `Asia/Shanghai`；统一统计和定时任务时区 |

开启人工邀请审核前，先配置至少一个管理群或通知管理用户。成员申请通知同时发到目标群和管理群。申请按机器人、通知消息ID、通知群绑定；不通过引用内容里的群号推断身份。请求操作失败保留待审核记录；过期仅清除插件待审记录，不擅自拒绝平台申请。

自动退群默认关闭；管理群、白名单、主人所在群和机器人为群主的群豁免。定时任务正常运行时按分钟触发，执行前持久化防重记录，失败写审计，避免重启后重复发日报。**停机期间不追补定时任务**，失败任务不在同一天反复尝试；请根据日志手工处理。

群卫欢迎/退群通知开启时优先处理对应事件，避免 TRSS 示例通知重复。邀请审核关闭时不接管框架邀请行为；开启时拦截原框架审批。如果另装同类群管插件，应关闭对应重叠事件功能。

## 脱离框架独立运行

```sh
cp config/standalone.example.json config/standalone.json
# 修改里面的 botId 和 OneBot HTTP API 地址
export GROUPGUARD_EVENT_SECRET='与OneBot HTTP上报设置一致的secret'
export GROUPGUARD_API_TOKEN='OneBot HTTP API 的 access_token'
npm start
```

Windows PowerShell 用 `$env:GROUPGUARD_EVENT_SECRET='...'`。将 NapCat/其他 OneBot 的 HTTP 上报地址设为 `http://127.0.0.1:15083/onebot`，开启上报签名，并设置相同的 secret；事件请求使用 OneBot `X-Signature: sha1=...`。群卫通过配置的 HTTP API 发动作。`/healthz` 只提供服务存活检查，不代表 QQ 在线。默认仅监听本机。密钥从环境变量读取，不进源码。此方式需要 OneBot 同时启用 HTTP API 和 HTTP 事件上报；当前现网 TRSS 仍使用原来的反向 WebSocket，无须改 NapCat 网络配置。

## 功能来源与覆盖

详见 [功能对照](docs/FEATURES.md) 和 [参考说明](NOTICE.md)。本项目按照上游公开功能重新实现，未复制上游源码、图片、字体、配置中的群号/黑名单或游戏模块。

## 检查和打包

```sh
npm test
node scripts/manifest.mjs
```

开发仓库的 OrangeJuice 集成测试需要同级 `OrangeJuice-Plugin` 源码；缺少时只跳过该外部管理面板检查，核心和独立服务检查照常执行。发布包包含源码、默认配置、说明和测试，不包含参考克隆、本地账号配置、运行数据或 Git 凭据。
