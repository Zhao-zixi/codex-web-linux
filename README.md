<p align="center">
  <img src="assets/icon.png" alt="Kanna 图标" width="80" />
</p>

<h1 align="center">Kanna</h1>

<p align="center">
  <strong>面向 Claude Code 与 Codex CLI 的精美 Web 界面</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kanna-code"><img src="https://img.shields.io/npm/v/kanna-code.svg?style=flat&colorA=18181b&colorB=f472b6" alt="npm 版本" /></a>
</p>

<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/screenshot-light.png" />
    <img src="assets/screenshot.png" alt="Kanna 界面截图" width="800" />
  </picture>
</p>

<br />

## 快速开始

```bash
bun install -g kanna-code
```

如果尚未安装 Bun，请先安装：

```bash
curl -fsSL https://bun.sh/install | bash
```

然后在任意项目目录中运行：

```bash
kanna
```

完成。Kanna 会在浏览器中打开 [`localhost:3210`](http://localhost:3210)。

## 功能

- **多 provider 支持**：在聊天输入区切换 Claude、Codex（OpenAI）、Cursor、Grok Build 和 Pi；每个 provider 可独立选择模型、推理强度，也支持 Codex fast mode。
- **内置 Pi agent**：[pi coding agent](https://github.com/badlogic/pi-mono) 作为依赖随 Kanna 提供，通过 Model Registry（Settings）在进程内运行。可连接 OpenRouter、OpenAI 或自定义 OpenAI-compatible endpoint，为 picker 固定常用模型，并使用带标准化推理强度的任意 model ID；无需单独安装 pi。
- **以项目为中心的 sidebar**：按项目归类聊天，并显示实时状态（空闲、运行中、等待处理、失败）。
- **拖动调整项目顺序**：在 sidebar 中重排项目组，并持久保存顺序。
- **发现本地项目**：自动从 Claude 和 Codex 本地历史中发现项目。
- **丰富的 transcript 渲染**：完整显示解析后的 tool call、可折叠 tool 组、plan mode 对话框和交互式提示结果。
- **快速响应**：通过 Haiku 执行轻量结构化查询（例如生成标题），并在需要时自动回退到 Codex。
- **Plan mode**：执行前审阅并批准 agent 计划。
- **持久化本地历史**：刷新后仍可访问路由；历史由 JSONL 事件日志和压缩 snapshot 保存。
- **自动生成标题**：在后台通过 Claude Haiku 生成聊天标题。
- **恢复会话**：完整保留上下文并恢复 agent session。
- **WebSocket 驱动**：通过实时订阅和响应式状态广播更新界面。

## 架构

```text
浏览器（React + Zustand）
    ↕  WebSocket
Bun Server（HTTP + WS）
    ├── WSRouter ─── 订阅和命令路由
    ├── AgentCoordinator ─── 多 provider turn 管理
    ├── ProviderCatalog ─── provider/model/effort 规范化
    ├── QuickResponseAdapter ─── 带 provider fallback 的结构化查询
    ├── EventStore ─── JSONL 持久化 + snapshot 压缩
    └── ReadModels ─── 派生视图（sidebar、chat、projects）
    ↕  stdio
Claude Agent SDK / Codex App Server / cursor-agent / grok CLI（本机进程）
    ↕
本地文件系统（~/.kanna/data/、项目目录）
```

**主要模式：**所有状态变更都使用 event sourcing。通过 CQRS 将写入（事件日志）和读取（派生 snapshot）分开。状态变化时向订阅者推送新 snapshot。多 provider agent 协调器负责用户审批流程中的工具权限。Transcript hydration 与 provider 无关，统一界面显示。

## 系统要求

- [Bun](https://bun.sh) v1.3.5 或更高版本。
- 可正常使用的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 环境。
- （可选）[Codex CLI](https://github.com/openai/codex)，用于 Codex provider。

内嵌终端使用 Bun 原生 PTY API，目前支持 macOS/Linux。

## 安装

全局安装 Kanna：

```bash
bun install -g kanna-code
```

若尚未安装 Bun，请先运行：

```bash
curl -fsSL https://bun.sh/install | bash
```

也可以克隆仓库并从源码构建：

```bash
git clone https://github.com/jakemor/kanna.git
cd kanna
bun install
bun run build
```

## 使用

```bash
kanna                              # 使用默认设置启动（仅监听 localhost）
kanna --port 4000                  # 自定义端口
kanna --no-open                    # 不自动打开浏览器
kanna --password <secret>          # 打开应用前要求输入口令
kanna --password-file <path>       # 从文件读取应用口令
kanna --share                      # 创建公开临时隧道并显示终端二维码
kanna --cloudflared <token>        # 使用命名 Cloudflare tunnel
```

默认地址：`http://localhost:3210`

### 自建远程工作区

Kanna 首版远程工作区通过每账号独立容器、SSH 和用户本机 Mutagen 同步项目。请先阅读[自建远程工作区指南](docs/remote-workspace.md)。其中公网 HTTPS 和真实 Codex 执行状态以指南中的验收记录为准。

### 网络访问（Tailscale / LAN）

默认情况下 Kanna 只绑定 `127.0.0.1`（仅本机）。使用 `--host` 绑定指定接口，或用 `--remote` 简写为 `0.0.0.0`：

```bash
kanna --remote                     # 绑定所有接口；浏览器打开 localhost:3210
kanna --host dev-box               # 绑定指定主机名；浏览器打开 http://dev-box:3210
kanna --host 192.168.1.x           # 绑定指定 LAN IP
kanna --host 100.64.x.x            # 绑定指定 Tailscale IP
```

使用 `--host <hostname>` 时，浏览器会自动打开 `http://<hostname>:3210`。网络中的其他设备也可访问同一地址。

### 口令保护

使用 `--password` 要求输入启动口令，之后应用和 WebSocket 才能连接：

```bash
kanna --password my-secret
bun run dev --password my-secret
kanna --password-file /run/secrets/kanna-password
```

也可通过环境变量 `KANNA_PASSWORD_FILE` 指定口令文件。Kanna 验证口令后设置浏览器会话 cookie，不会把口令存进浏览器。开启口令保护后，后端会为 API 路由和 `/ws` 要求认证。SPA 页面仍可加载；`/health` 保持公开，供重启检测使用；开发和生产环境使用同一个应用内口令页面。

若通过可信 TLS 反向代理访问，可使用 `--trust-proxy` 或 `KANNA_TRUST_PROXY=1`，让登录逻辑信任代理提供的 `X-Forwarded-Proto`，并为 HTTPS cookie 添加 `Secure` 标记。只有服务确实位于可信代理之后时才应启用。

### 公共分享链接

使用 `--share` 创建临时 `trycloudflare.com` 公网地址，并在终端显示二维码：

```bash
kanna --share
kanna --share --port 4000
kanna --cloudflared <token>
```

`--share` 不能和 `--host` 或 `--remote` 同时使用，也不会自动打开浏览器。

不带 token 时会显示：

```text
QR Code:
...

Public URL:
https://<random>.trycloudflare.com

Local URL:
http://localhost:3210
```

使用 `--cloudflared <token>` 时，Kanna 会运行 `cloudflared tunnel run --token <token> --url <local-url>`。如果能从 cloudflared 输出中识别公网主机名，就会显示相同的二维码/公网/本地地址信息；否则会让 tunnel 保持运行，提示未能识别公网主机名，并打印本地地址，供你与 Cloudflare 中已配置的 tunnel 主机名配合使用。

## 开发

```bash
bun run dev
```

`bun run dev` 同样支持 `--remote` 和 `--host`，可用于远程开发。开发模式也支持 `--share`，公开暴露 Vite 客户端地址：

```bash
bun run dev --share
bun run dev --cloudflared <token>
bun run dev --port 3333 --share
```

在开发模式下，`--port` 指定 Vite 客户端端口，后端端口为其加一。因此 `bun run dev --port 3333 --share` 会公开 `http://localhost:3333`。`--share` 仍不能和 `--host` 或 `--remote` 同用。使用 `bun run dev --port 4000` 时，Vite 客户端运行在 `4000`，后端运行在 `4001`。

也可以分别运行客户端和服务端：

```bash
bun run dev:client   # http://localhost:5174
bun run dev:server   # http://localhost:5175
```

## 脚本

| 命令 | 说明 |
| --- | --- |
| `bun run build` | 生产构建 |
| `bun run check` | TypeScript 检查 + 构建 |
| `bun run dev` | 同时运行客户端和服务端 |
| `bun run dev:client` | 仅运行 Vite 开发服务 |
| `bun run dev:server` | 仅运行 Bun 后端 |
| `bun run start` | 启动生产服务 |
| `bun test` | 单元/集成测试 |
| `bun run test:e2e` | Playwright 浏览器冒烟测试 |

## 项目结构

```text
src/
├── client/          React UI 层
│   ├── app/         路由、页面、socket 客户端、useKannaState 与功能 hooks
│   │                （useChatCommands、useSendMessage、useAppSettingsSync、
│   │                 useUpdateRestart、useShareExport、snapshotEquality）
│   ├── components/  消息、聊天界面（含 chat-ui/git/ 面板模块）、
│   │                对话框、按钮和输入控件
│   ├── hooks/       主题、standalone 模式检测
│   ├── stores/      Zustand stores（聊天输入、偏好、项目顺序）
│   └── lib/         格式化、路径工具、transcript 解析、存储 key
├── server/          Bun 后端
│   ├── cli.ts       CLI 入口和浏览器启动器
│   ├── server.ts    HTTP/WS 服务配置和静态文件服务
│   ├── agent.ts     AgentCoordinator（多 provider turn 管理）
│   ├── codex-app-server.ts  Codex App Server JSON-RPC client
│   ├── cursor-cli.ts / pi-agent.ts  Cursor 和 Pi provider adapter
│   ├── provider-catalog.ts  Provider/model/effort 规范化
│   ├── quick-response.ts    带 provider fallback 的结构化查询
│   ├── ws-router.ts WebSocket 命令路由和 snapshot 订阅
│   ├── skills.ts    Skill 搜索/安装/卸载
│   ├── event-store.ts  JSONL 持久化、replay 和 compaction
│   ├── discovery.ts 从 Claude 和 Codex 本地状态发现项目
│   ├── read-models.ts  从事件状态派生 view model
│   └── events.ts    事件类型定义
└── shared/          客户端和服务端共用
    ├── types.ts     核心数据类型、provider catalog、transcript entries
    ├── tools.ts     Tool call 规范化和 hydration
    ├── protocol.ts  WebSocket 消息协议
    ├── ports.ts     端口配置
    └── branding.ts  应用名、数据目录路径

e2e/                 Playwright 冒烟测试（启动真实服务）
```

## 数据存储

所有状态默认保存在本机 `~/.kanna/data/`：

| 文件 | 用途 |
| --- | --- |
| `projects.jsonl` | 项目打开/移除事件 |
| `chats.jsonl` | 聊天创建/重命名/删除事件 |
| `messages.jsonl` | Transcript 消息条目 |
| `turns.jsonl` | Agent turn 开始/完成/取消事件 |
| `snapshot.json` | 用于快速启动的压缩状态 snapshot |

事件日志以追加方式写入 JSONL。启动时，Kanna 会从最近的 snapshot 之后重放日志尾部；日志超过 2 MB 时会压缩。

## Star History

<a href="https://www.star-history.com/?repos=jakemor%2Fkanna&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=jakemor/kanna&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=jakemor/kanna&type=date&legend=top-left" />
   <img alt="Star 历史图表" src="https://api.star-history.com/image?repos=jakemor/kanna&type=date&legend=top-left" />
 </picture>
</a>

## 贡献

欢迎贡献！你可以提交 PR。

## 许可证

[MIT](LICENSE)
