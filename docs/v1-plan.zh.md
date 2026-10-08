# 首版自建远程工作区方案

状态：首版方案。以下验收项目初始均为**待验证**；在实际部署与运行完成前，不得宣称公网 HTTPS、隔离、双向同步或真实 Codex 执行已通过。

## 目标与边界

首版面向少量已知用户，在一台由管理员维护的服务器上运行互相隔离的 Kanna 工作区。每个账号使用独立容器和凭据，用户仍在自己的电脑上编辑文件；Mutagen 客户端在用户本机把所选目录同步到该账号容器中的 `/workspace`。

首版不建设 SaaS 账号库、多租户服务端状态、中央 credential broker 或自研文件同步协议。应用继续使用现有 Kanna 口令登录；部署层为每账号生成独立口令和实例资料。同步由用户本机上的 Mutagen 发起，服务端只提供静态连接说明，不能声称客户端同步在线或已成功同步。

## 部署结构

```text
浏览器 ── HTTPS / WebSocket ── Caddy ── 账号专属 Kanna 容器
                                      ├─ 独立 HOME 与 ~/.kanna/data
                                      ├─ 独立 Codex 配置/凭据
                                      └─ /workspace

用户电脑上的 Mutagen ── SSH ── 账号专属 SSH sidecar ── 同一个 /workspace
```

- 每个账号有独立 Kanna 容器、HOME、data、workspace、SSH sidecar、SSH host key 和账号凭据。账号之间不得共享可写 volume。
- Caddy 通过专属子域名将 HTTPS 和 WebSocket 路由到对应 Kanna 容器；Kanna 不直接发布宿主端口。TLS 终止后仅在可信反代配置下启用 `KANNA_TRUST_PROXY=1`，以使用 `X-Forwarded-Proto` 设置安全 cookie。
- SSH sidecar 只挂载该账号的 `/workspace` 与 sidecar 自身 SSH 状态；禁止挂载宿主根目录、Docker socket、其他账号数据、Kanna HOME 或凭据。禁用 root 登录和端口转发。必须保留 sidecar host key，避免重启后客户端身份变化。
- SSH 必须支持 OpenSSH `ssh`/`scp` 与远端执行，因为 Mutagen 通过 OpenSSH 启动远端代理；不能仅提供 `internal-sftp`。
- 容器以普通用户运行，配置合理的 CPU、内存和进程限制。镜像中的 Bun、Codex CLI、Git 和运行工具应固定版本。
- 管理员必须为每位用户明确提供账号凭据；严禁自动复制当前宿主机的模型凭据或登录状态。

## 应用侧改动

- CLI 支持通过 `KANNA_PASSWORD_FILE` 或 `--password-file` 从文件读取启动口令；原有 `--password` 和本地默认行为继续兼容。空文件或读取失败时应安全失败，报错不得泄漏口令。
- 可信 TLS 反代配置只有在明确开启时才信任 `X-Forwarded-Proto`；HTTPS 登录 cookie 使用 `Secure`。保留 WebSocket Origin 校验。
- 新增受现有口令认证保护的只读 `GET /api/hosted-workspace`。部署配置来自 `KANNA_HOSTED_WORKSPACE_CONFIG`，API 只允许返回 `{displayName, sshHost, sshPort, sshUser, workspaceRoot, publicHostKey?}`，或 `{enabled:false}`。不得返回口令、私钥、模型凭据或宿主路径。首版 `workspaceRoot` 固定为 `/workspace`，host、port、用户名和可选公钥均需校验；配置不可读取或无效时应安全失败。
- 不新增账号数据库，不增加 WebSocket 命令，也不修改 `src/shared/cloud-api.ts`。
- 部署模式默认 Codex；已有用户明确选择的 provider 必须保留。本地模式默认保持不变。配置在首个 app-settings snapshot 前进入服务端设置初始化，不得让用户首条消息因异步读取部署信息而落到错误 provider。
- Settings 中的中文“远程工作区”引导仅在部署配置启用时出现。内容包括目录映射、SSH 资料与 host key 验证、Mutagen 官方安装链接、可复制的创建/查看/暂停/恢复和冲突处理命令。
- 可复制命令需安全转义用户输入；网页不会安装 Mutagen、替用户授权本机目录，也不探测本机同步状态。同步客户端主要面向 macOS/Linux shell；Windows 首版以 WSL 为目标，原生 PowerShell 命令须另行设计和验证。

## 文件与 Git 同步约定

- 用户选择本机目录，同步到该账号的 `/workspace`；首版创建双向安全（`two-way-safe`）Mutagen 会话。`.git`、依赖目录和常见构建缓存不随默认会话同步。
- Git 元数据保留在用户本机。用户在本机管理分支、提交和远端仓库；远端工作区是否能在没有 `.git` 时直接运行 Codex，必须通过实际首版验收确认。若应用要求 Git 仓库，应提供不会访问其他账号的远端初始化流程。
- SSH host key 必须在首次连接前通过可信渠道核对。`ssh-keyscan` 只能读取服务器给出的公钥，不能独立证明服务器身份。
- 出现文件冲突时，先检查并保留两侧内容，再按 Mutagen 报告选择要保留的一侧、合并文件并恢复会话。不得把自动覆盖一侧作为默认解决方案。

## 实施阶段

1. **配置与代码**：完成口令文件、可信反代、只读配置 API、部署默认 provider、中文 Settings 引导及聚焦测试。
2. **部署生成器**：准备每账号独立的 Kanna/SSH 镜像和网络、子域路由、secret/state 模板、账号初始化/管理/诊断流程；生成文件和 secret 必须加入忽略规则。具体 CLI 接口以部署实现审定后的指南为准。
3. **本机验证**：验证容器构建、口令登录、API/WS、TLS 代理行为、账号间数据与 SSH 隔离、配置失败安全行为，以及窄屏设置 UI。
4. **文件同步验证**：用两个测试账号和本机 Mutagen 检查新增/修改/删除、目录、二进制文件、空格和中文路径、双端同文件冲突、SSH 断线恢复与 sidecar 重启后的 host key 持久性。
5. **真实部署与 Codex 验收**：按部署指南在目标服务器配置 DNS、防火墙和有效证书；使用管理员明确提供的测试账号凭据进行真实 Codex 修改，并验证改动同步回本机。未完成此阶段前不得标记公网部署或真实 Codex 成功。

## 验收矩阵

所有项目初始状态为**待验证**。每项应记录实际命令、环境、观察结果；本地容器或自签证书测试不能代替真实公网域名和有效证书验收。

| 项目 | 通过证据 | 状态 |
| --- | --- | --- |
| 构建与检查 | 聚焦测试、`bun test`、`bun run check` 通过；部署配置校验通过；两个镜像成功构建 | 待验证 |
| 安装启动 | 从干净目录按中文部署指南启动至少两个账号；均能登录、创建项目并打开终端 | 待验证 |
| HTTPS | 目标域名 DNS 正确、证书有效、HTTP 跳转 HTTPS、WebSocket 正常；内部测试证书不计为公网通过 | 待验证 |
| Web 隔离 | A 的口令和 session cookie 在 B 无效；未登录 API/WS 被拒；项目和历史互不可见 | 待验证 |
| 文件与 SSH 隔离 | A 的 key 不能登录 B；A 的 SSH 和 Kanna 不能访问 B 的 workspace、HOME、data 和凭据；SSH 不能读取自身 Kanna HOME | 待验证 |
| 双向同步 | 两方向的新增、修改、删除、目录和二进制文件均校验一致；包含空格和中文路径 | 待验证 |
| 冲突保护 | 两端同时修改同一文件时冲突可观察，双方内容保留；按指南处理后恢复收敛 | 待验证 |
| 断线恢复 | 中断 SSH 后两边分别修改不同文件；恢复连接后自动收敛；容器重启后 data 和 host key 保留 | 待验证 |
| 终端 job control | Kanna PTY 可运行命令、工作目录正确、marker 跨重启持久；Ctrl-C 能中断长命令并返回 shell；raw mode 保留 `0x03` 字节 | 本地 Docker E2E 已验证 sleep/pipeline 在 3 秒内中断、raw byte、resize、中文工作目录、active close 后 PID 清理，以及相邻 Alice terminal/Bob shell 不受影响；公网和浏览器环境仍待验收 |
| Codex 实际执行 | 使用明确提供的账号凭据发起真实任务；Codex 在服务器工作区改文件，改动同步回本机；记录结果，不能用 mock 代替 | 待验证 |
| UI | 桌面和窄屏下入口均可用；沿用现有界面风格并保存截图 | 待验证 |

## 上线条件

- 所有适用的构建、回归、隔离、同步和真实目标环境验收都有可审阅证据。
- 检查 Compose/Docker 实际挂载、网络与容器权限；不能仅凭 UI 结果推断隔离成立。
- 审查配置生成文件、secret/state 是否被 Git 忽略；审查镜像、端口和宿主挂载，确认不暴露共享凭据或其他账号数据。
- 公网 HTTPS、跨账号隔离、Mutagen 冲突恢复和真实 Codex 写入回传均未完成时，必须明确列为未验收，不能以架构设计或本地 mock 代替。
