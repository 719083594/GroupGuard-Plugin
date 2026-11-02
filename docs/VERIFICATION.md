# GroupGuard 验证说明

## 2.3.0：QQ 一次性登录

新增后台与前端测试覆盖凭据期限、防重放、并发兑换、重新获取、改密与重启失效、主人撤权、同源校验、Secure Cookie、首次设置密码、地址栏清理和原密码登录。TRSS 路由验证主人私聊、普通成员和群聊边界。手机 HTTPS 入口与真实 QQ 点击需另做部署验收，不能用本机 HTTP 测试代替。

## 2.2.0：通用框架接口

本次增加 `api.mjs` 和适配模板。测试覆盖无 TRSS 进程导入、合成框架的事件收发、主人与群权限、操作防重、宿主异常、帮助图、图片回调与文字降级、网页显式启停及模板订阅。原 TRSS 路由、状态图片和安装工具测试继续执行。当前接口未附带其他具体框架适配，合成测试不代表那些框架已经完成实机联调。

每次提交在 Node 20、22、24、26 的 Linux/Windows 八项任务中运行完整测试，实际结论见 [GitHub Actions](https://github.com/719083594/GroupGuard-Plugin/actions/workflows/test.yml)。东京继续使用 TRSS 适配，部署与运行结果单独记录；下面保留此前版本的验证证据。

## 2.1.0 历史验证记录

验证日期：2026-11-03，Asia/Shanghai。功能代码提交为 [fbf512b](https://github.com/719083594/GroupGuard-Plugin/commit/fbf512b31328c97f6301cd3e552ceeff6ed1bf61)，八项 [GitHub CI](https://github.com/719083594/GroupGuard-Plugin/actions/runs/41498755156) 均实际成功。最后仅文档改动的发布提交仍由相同八项 CI 再次检查，发布包以对应 Release 和 SHA256SUMS 为准。

## GitHub CI 实际结果

每项任务均执行完整 Node 测试、声明一致性和 Python 安装测试；Linux 另检查 Bash 语法，实际调用 Compose CLI 解析合成配置，不连接 Docker 服务。

| 操作系统 | 实际 Node | Node 测试 | Python 安装测试 |
|---|---|---|---|
| Linux | 20.20.2 | 192 通过，0 失败 | 35 通过 |
| Linux | 22.23.4 | 192 通过，0 失败 | 35 通过 |
| Linux | 24.22.1 | 192 通过，0 失败 | 35 通过 |
| Linux | 26.13.0 | 192 通过，0 失败 | 35 通过 |
| Windows | 20.20.2 | 191 通过，0 失败，1 跳过 | 29 通过，6 跳过 |
| Windows | 22.23.4 | 191 通过，0 失败，1 跳过 | 29 通过，6 跳过 |
| Windows | 24.22.1 | 191 通过，0 失败，1 跳过 | 29 通过，6 跳过 |
| Windows | 26.13.0 | 191 通过，0 失败，1 跳过 | 29 通过，6 跳过 |

Windows 的 Node 跳过项是 POSIX 信号测试，同一项在 Linux 实际运行。Python 的六项跳过是 Linux Docker 宿主机专用的真实 Compose 解析；Windows 仍运行原生安装、配置保留、编码、路径、失败处理和模拟 Docker 操作检查，未宣称支持 Windows Docker Desktop 自动配置。

首轮 CI 发现并修复了英文 Windows 重定向输出的中文编码、UTF-8 文件读取、临时目录短路径及不适用的 Windows Docker CLI 探测问题。真实宿主机预检查另发现 depends_on 中的同名服务被误认，已在本地修复为只识别 services 直接子项，并添加单元和真实 Compose 回归。没有删除权限检查或把未完成任务称为通过。

## 本地验证

- Windows / Python 3.13.15：设置 PYTHONUTF8=0、PYTHONIOENCODING=cp1252，35 项中 29 通过、6 项 Linux 专项跳过，覆盖英文系统场景。
- Ubuntu 24.04 / WSL2 / Python 3.12.3 / Docker Compose 5.6.1：35 项全部通过，包括实际解析映射/列表环境变量、缺省字段、变量引用、已有端口、长端口、其他服务不变与同名依赖。
- 本地 Windows 的 Node 24.19.0、26.13.0 完整回归均为 191 通过、1 POSIX 项跳过；Linux Node 24 完整回归 192 通过。其余正式版本范围由上表八项 CI 覆盖。
- 两张帮助 JPEG 以 2.1.0 重生成，读取清单、哈希和尺寸验证通过，已目视核对文字、布局和完整页尾；公开页与主人页分开。
- Git ZIP 含 71 个公开文件和完整安装工具，不含实例配置、data、私有参考、账号凭据或 Python 缓存。npm 包使用测试源码白名单，避免带入 __pycache__。

## Linux Docker Compose 实机安装

在已有 TRSS＋NapCat 的宿主机，从 GitHub 克隆上述精确提交，备份并完整替换旧源码，保留原配置和 data，运行 README 命令：

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/719083594/GroupGuard-Plugin/main/scripts/install.sh)
```

该次首次执行成功，退出码 0；自动找到 TRSS、验证原 Compose，只配置群管专用环境变量和宿主机回环端口，仅重新创建 Yunzai。未安装其他插件、修改防火墙、拉取镜像、构建或重新启动 NapCat/Redis。

| 项目 | 实际结果 |
|---|---|
| 运行环境 | TRSS＋NapCat、Linux Docker Compose；容器 Node 24.22.2 |
| 源码 | 71 个公开文件匹配下载提交，Git 工作树干净，旧源码仅在私有恢复目录备份 |
| 配置与密码 | config/local.json 和 data/admin-auth.json 哈希完全一致，主人不自动导入、更改或公开 |
| 数据 | 旧数据完整复制；pending/jobs/likes/requests/schemaVersion/operations/exits 保持一致，统计与审计仅有正常测试增量 |
| 服务 | 三个服务全部 healthy；NapCat/Redis 容器 ID 和启动时间未变 |
| 网页与鉴权 | 管理页 HTTP 200，未登录配置接口 HTTP 401，只绑定宿主机 127.0.0.1 |
| 电脑访问 | 原 SSH 管理入口实际访问通过，未读取或重置原密码 |

这些结果证明上述布局，不能泛指所有 Docker、命名卷、镜像内源码、host 网络或其他框架；其他布局按安装指南手动处理。

## 运行中的插件与 QQ 输出

在已加载的真实 TRSS 插件入口注入维护者受控事件，身份仍由原 masters 和权限逻辑检查；没有另起群管实例或修改源码。实际调用原 OneBot 连接向预先指定的测试群输出，QQ 平台历史确认两张图片、三条文字。

| 指令 | 实际结果 | 处理至发送接口完成 |
|---|---|---|
| #群管开启 | 成功；幂等操作后配置文件字节未变 | 592 ms |
| #群管帮助 | 公开帮助 JPEG，平台历史包含图片 | 2337 ms |
| #群管状态 | 状态图片，平台历史包含图片 | 2235 ms |
| #群管状态 文字 | 文字状态 | 613 ms |
| #群管今日榜 | 文字榜单 | 306 ms |

这是受控事件测试，**不是本次真人从 QQ 键盘输入的验证，也不是手机端完整收图耗时**。临时容器内回环诊断及本次 NapCat 调试通道已关闭，未留下公开调试端口。没有对真实成员测试禁言、踢人、审批、退群或点赞，这些行为以自动化权限、模拟平台和持久化检查为依据。

## 复现开发检查

在插件目录执行，无需额外 npm 包：

```sh
npm test
npm run check:manifest
python -m unittest discover -s tests -p 'installer*_test.py' -v
```

Linux 可另执行 bash -n scripts/install.sh。Windows 临时目录受限时，可将本次 TEMP/TMP 指向自己有写权限的 .test-tmp/，该目录不进入发布包。Python 仅安装工具需要，日常运行不需要。

测试覆盖命令、权限、成员保护、审核、未知结果防重、统计时区、新闻隔离、点赞额度、TRSS 接入、管理 HTTP/界面、帮助与状态、Git 更新及安装工具。使用合成账号、模拟 OneBot/时钟、隔离 Git 仓库和临时服务；构建成功不能代替 QQ 送达或安装验收。历史 2.0.0、2.0.1 的结果不代替本次证据；后续改动需重新验证，最终发布仍要求对应提交八项 CI 全通过。
