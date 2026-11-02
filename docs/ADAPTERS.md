# 框架接入接口

群管核心使用 Node.js 20+，不导入 TRSS、NapCat SDK 或其他机器人框架。`api.mjs` 是公开 JavaScript/ESM 接口；内置的 TRSS 适配在 `index.js` 中，它也是通过同一公开入口使用核心与操作适配器。

这不是 HTTP 服务，也不是新的 QQ 协议实现。其他框架完成适配后可以不安装 TRSS；需要运行该框架及其账号连接层。当前随包已完成的框架适配只有 TRSS。接口可复用不等于已经适配所有框架；Python 等不能直接导入 ESM 的框架还需要自己的跨进程桥接。

导入接口不会创建实例、监听端口或注册退出事件。实例创建后也不自动启动定时器或网页；由宿主管理运行周期。业务功能不通过这个接口关闭，是否使用其他框架适配由部署者选择。

## 创建实例与宿主回调

```js
import {createGroupGuard} from './api.mjs'

// frameworkCall 由你的框架适配器提供；不是 NapCat 地址。
export function createForMyFramework(frameworkCall, pluginRoot) {
  return createGroupGuard({
    root: pluginRoot,
    framework: '我的机器人框架',
    call: frameworkCall,
    onError: message => console.error('[群管]', message)
  })
}
```

`root` 默认是下载的群管插件目录；传入其他目录时，必须具有完整插件源码与 `resources/`。核心配置在 `config/local.json`，数据和单实例锁在 `data/`。与 TRSS 运行时使用同样的结构；配置、数据和管理密码不进 Git。

| 参数 | 约定 |
|---|---|
| `call(botId, action, params)` | 必填。由宿主选择机器人，翻译并执行操作，返回 Promise；群管不直接连接 NapCat |
| `framework` | 版本回复中的框架名称；默认“自定义框架” |
| `statusImage(html)` | 可选。宿主把固定状态 HTML 渲染为 PNG/JPEG Buffer；缺失、超时、失败时回退文字 |
| `helpImages` | 默认读取本插件固定 JPEG，不依赖 AI 或框架渲染；可设为 `null` 使用文字帮助 |
| `statusTimeoutMs` | 可选图片等待时间，默认 8000 毫秒，上限 30000 |
| `now`、`fetcher`、`updater` | 可选时钟、新闻请求和源码更新适配；默认使用现有实现 |

宿主操作回调使用 **OneBot v11 形状的内部约定**，不要求宿主自己使用 OneBot 或 NapCat。其他框架的 SDK 操作名和返回值不同，就在适配层转换：

```js
// call 的返回契约；下面只是返回格式示例。
return {status: 'ok', retcode: 0, data: actualResult}
```

不能把未经核验的 SDK 返回值随意包装成成功。明确失败返回 `{status:'failed', retcode:1, message:'可公开的失败原因'}`，也可抛出公开导出的 `OneBotError('可公开的原因', 'failed')`；普通异常表示执行结果未知，群管不会自动重新提交管理操作。不要把 Token、完整 SDK 请求或私密地址放进错误信息。

## 事件输入

调用 `guard.handle(event)`，返回 `Promise<boolean>`，表示是否被群管处理。适配器负责把框架事件转换成以下结构：

| 字段 | 约定 |
|---|---|
| `self_id`、`user_id` | 机器人与操作者 QQ；数字或数字字符串 |
| `group_id` | 群事件必填；私聊不填 |
| `post_type` | `message`、`request`、`notice` |
| `message_id` | 消息的稳定平台 ID；没有可靠 ID 时管理操作会拒绝执行 |
| `message` | OneBot v11 消息段数组；文本、@、引用分别用 `text`、`at`、`reply` |
| `sender` | 可选昵称与群名片；权限仍通过成员查询核验，不信任消息附带角色 |
| `isMaster` | 只能由可信宿主确认并设置为布尔值 `true`；也可省略，使用插件 `masters` |

群申请需 `request_type:'group'`、`sub_type:'add'/'invite'`、`flag`、可选 `comment`。成员变动需 `notice_type:'group_increase'/'group_decrease'`，并保留平台提供的 `operator_id`、`time`。同一条事件的稳定 ID 不应在转换时重新生成，否则无法可靠防重。

`msg`、`source.message_id` 是为 TRSS 保留的兼容字段，其他适配器推荐使用标准消息段。这个接口是可信宿主调用接口，没有内置 HTTP 身份认证；如果另写网络桥接，认证与事件可信化由该桥接负责，不能把网络 JSON 中的 `isMaster` 直接传进来。

## 宿主需要实现的操作

| 类别 | `action` 与关键参数 |
|---|---|
| 发消息 | `send_group_msg(group_id,message)`、`send_private_msg(user_id,message)`；返回 `message_id` |
| 查成员和消息 | `get_group_member_info(group_id,user_id,no_cache)`、`get_group_member_list(group_id)`、`get_msg(message_id)` |
| 管理 | `set_group_ban`、`set_group_kick`、`set_group_whole_ban`、`set_group_admin`、`set_group_special_title` |
| 撤回 | `delete_msg(message_id)` |
| 申请审核 | `set_group_add_request(flag,sub_type,approve,reason)` |
| 自动退群、等级与点赞 | `set_group_leave`、`get_stranger_info`、`send_like` |

成员角色需归一为 `owner`、`admin`、`member`。`get_msg` 应能提供消息所在群及发送人，供撤回做跨群与目标身份核验；保留核心实际传入参数，字段语义以 OneBot v11 和对应功能源码为准。宿主不支持某操作时明确失败，不能空返回成功。不同协议可能不支持 QQ 等级或点赞，适配完成后仍需按功能实测。

## 运行周期、网页与开关

```js
guard.registerBot('123456789') // 使用真实机器人 ID；供定时任务在没有新消息时调用
guard.start()                 // 启动本插件定时器，不监听事件端口
await guard.handle(normalizedEvent)
// 按需开启同一套网页配置；默认不会启动。
const admin = await guard.openAdmin({host: '127.0.0.1', port: 15083})
// 宿主停止接收事件后：
await guard.close()
```

调用 `removeBot(botId)` 移除下线账号的后续定时操作适配。`close()` 拒绝新事件，等待已接收消息完成，关闭可选网页并释放数据锁；宿主应在 SIGTERM 等退出流程中等待它，不在请求未完成时强制退出。网页沿用原认证、CSRF、revision、配置和密码规则，不会增加一套账号。

启用适配：由宿主调用创建、注册和启动方法。关闭适配：宿主取消订阅并 `await guard.close()`，不调用便不运行。完整订阅与取消订阅模板见 [framework-adapter.mjs](../examples/framework-adapter.mjs)，它是通用模板，不是宣称某个具体框架已完成适配。

同一源码目录的实例锁会拒绝 TRSS 与其他适配器同时写同一 `data/`。切换前停止旧群管加载，保留现有配置、数据与密码。不同目录不能靠本地锁协调；同一机器人不要重复订阅同一批事件。

## 验证边界

`tests/framework-api.test.mjs` 在无 TRSS 的 Node 进程导入公共接口，以合成宿主验证收发、权限、防重、错误语义、帮助图、宿主状态图、网页启停及模板订阅。TRSS 入口另有原集成测试。新增接口不代表 Koishi、NoneBot、其他协议端或 Python 桥接已经完成真实适配与联调。
