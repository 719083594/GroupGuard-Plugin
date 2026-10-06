# 参考项目与原创实现

本插件按公开功能文档和行为重新实现，核心、适配器、界面声明、帮助文本及测试为新编写，未复制上游代码或资产。以下引用用来说明功能来源，不代表上游为本项目提供维护或背书。

- [A1Panda/GroupEntry_Plugin](https://github.com/A1Panda/GroupEntry_Plugin)，参考提交 `a88d448a14ddc21477f6320c6e29c9eee4da6e27`：机器人邀请审核、通知群/用户、引用确认、黑白名单、入群答案和等级检查、人数门槛退群。该快照没有根 LICENSE，部分文件有作者和禁止商用声明，未将这些文件纳入本项目分发。
- [Clarlotte/group-plugin](https://gitee.com/clarlotte/group-plugin)，参考提交 `d43bf2c34130225fd8c367a2d2604652e8923a2f`，GPL-3.0：群禁言、管理任免、批量撤回、发言统计、定时全体禁言、日报和点赞。按功能独立实现，未复制 GPL 源码或网页模板。
- [yoimiya-kokomi/miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)，参考提交 `b01d77483268eb2236876ad0995fab27052c09ad`，MIT：分类帮助、设置与版本维护的交互思路。该插件并无独立群禁言/入群管理模块；所有游戏命令、面板、资源下载、CK/UID/API管理均未纳入。

群卫的原创实现使用 MIT 许可证。参考源码只保留在开发目录 `.reference/`，被 Git 和发布打包排除。
