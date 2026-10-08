# Kanna 包拆分方案

状态：提议中，尚未开始。编写日期：2026-07-30。

计划将 Kanna 从单体应用拆成一组可独立运行的包和一个精简产品层，仍保留在同一个仓库。**Kanna 的现有行为必须保持不变。**成功标准是：将客户端托管在 Cloudflare Worker、把聊天记录迁移到 Durable Object，并在 sandbox 中运行 harness 时，只需替换四个注入实现，无须修改包内部代码。

## 非目标

- 不改产品行为：不加功能、不改 UI，也不做边界本身不要求的协议变更。
- 初期不向 npm 发布独立包。它们先作为 workspace package；`kanna-code` tarball 仍是单一可安装 CLI。
- 不在本计划内构建 Cloudflare 部署。本计划只是让它可行且成本较低；驱动实现仍需另行开发。

## 1. 当前代码已经说明的事实

下面四项实测事实决定了后续边界：

1. `src/shared/types.ts`（2011 行）被 113 个客户端文件和 44 个服务端文件导入，是关键基础文件。它把 transcript/tool 模型、provider catalog、session read model、Git snapshot 以及 Kanna 自己的 settings/auth/update 类型等互不相关的词汇放在一起。
2. `src/server/diff-store.ts`（2580 行）没有任何 `chatId`、`EventStore` 或 `StoreState` 引用。Git client 已经是独立库，只是放在 server 目录里；这是成本最低、把握最高的拆分，适合早期完成以验证模式。
3. `src/shared/` 没有 `node:` 导入，客户端也没有从 `src/server/` 导入文件。isomorphic 边界已由约定维持，只是尚未包装成独立 package。
4. `src/export-viewer/main.tsx` 能通过 `ChatTranscriptViewport`、`processTranscriptMessages` 和 `TranscriptRenderOptionsProvider` 从 JSON blob 渲染完整 transcript，不依赖 socket、store 或 server。因此 chat UI package 的边界已有运行证明。

实际耦合集中在以下位置：

- `src/shared/branding.ts` 被各层 28 个文件导入，硬编码 `~/.kanna`、应用名，并从 `package.json` 读取版本。任何 package 只要依赖 Kanna 身份就无法独立运行；移除品牌依赖是最大的一次机械改动，也是其他拆分的前置条件。
- `src/server/agent.ts`（2297 行）将 Claude SDK adapter 与 session bookkeeping 混在一起，streaming loop 中约有 60 处 `this.store.*` 调用。这是唯一真正困难的拆分。Codex、Cursor、Pi 已能返回干净的 `HarnessTurn`。
- `src/server/ws-router.ts`（1619 行）把 socket 全部定为 Bun 的 `ServerWebSocket<ClientState>`；`SnapshotBroadcastFilter`（第 89 行）则用 `includeSidebar` 等命名 boolean 固定了 broadcaster 的 topic 集合。

## 2. 边界原则

**Package 边界承诺两侧可以独立演进。**如果两侧必须一起修改，边界就只会增加间接层、发布协调和类型负担，没有实际收益。

| 独立变化的维度 | 变化示例 | Package |
| --- | --- | --- |
| 运行哪个 agent | claude/codex/cursor/pi，或新增 harness | `harness` |
| 聊天状态存在哪里 | JSONL 文件 → Durable Object → Postgres | `session` |
| repo 存在哪里 | 本地文件系统 → sandbox → 远程 | `git` |
| 产品外观 | Kanna → 其他产品 UI | `chat-ui` |
| 运行环境 | 本地 Bun → Worker + DO + Sandbox | `server` / app |

各 package 共享的 transcript entries、规范化 tool call 和 wire schema 不能归属其中任何一个，因此组成最底层 package。

最终为六个 package 加应用：`protocol`、`harness`、`session`、`git`、`chat-ui`、`server` 与 `kanna` 产品应用。

## 3. Package 职责

### `@kanna/protocol` — 所有端共享的语言

通俗地说：这里放名词（tool call 的形状）、动词（发送消息、提交文件）和承载协议的线路。它是唯一同时在浏览器 tab 和 server 运行的 package，双方必须逐字节一致。该包 isomorphic、没有 runtime dependency，预计约 3.6k 行。

包含：`TranscriptEntry` union、`NormalizedToolCall` 及规范化/hydration、provider/model catalog 数据、上下文窗口计算、消息预览；`HarnessEvent`、`HarnessTurn`、`HarnessToolRequest` 合约；核心 wire topic（`chat`、`sidebar`、`project-git`、`terminal`）、commands/snapshots、envelope 类型和 guards；subscription registry、按签名去重推送、ack 关联、重连/heartbeat/backoff 等传输机制。

迁入来源：`src/shared/types.ts` 中除约 327 行 app-only 类型外的部分、`src/shared/tools.ts`、`src/shared/{json,message-preview,provider-preferences,assert}.ts`、`src/shared/protocol.ts`、`src/server/harness-types.ts`、`src/client/lib/parseTranscript.ts`、`src/client/app/derived.ts`、`src/client/app/socket.ts`，以及 `src/server/ws-router.ts` 中约 300/1619 行的 broadcast/subscription 部分。`parseTranscript.ts` 会从客户端下沉，因为 export 路径也需要纯 hydration 逻辑。

Schema 和 transport mechanics 放在一起，而不是拆成三个包：新增一条命令现在就会同时改 command union、snapshot union、handler 和 client method，这些是同一项改动，实际版本永远不能独立。将它们拆开会造成 client/server wire 版本错配。

Snapshot 类型也放这里：`ChatSnapshot`、`SidebarData`、`ChatDiffSnapshot` 是 wire type，不是 session/git 的实现类型；它们现在也已经位于 `shared/types.ts`。`session` 负责派生 `ChatSnapshot`，因此依赖 protocol 合约而不反向依赖。主要改造是将 `SnapshotBroadcastFilter` 从命名 boolean struct 改为 topic predicate。

### `@kanna/harness` — 多 provider 适配层

通俗地说：把多个不同“摄像机”的接口统一成一份录制带。运行于 Node/Bun，只依赖 `protocol`。

内容包括四个 provider adapter、skill discovery、provider CLI auth/install、usage limit 解析、attribution、handoff context，以及生成标题、commit message、quick response 的小模型调用。

迁入：`agent.ts` 中 Claude 部分约 900 行（`normalizeClaudeStreamMessage`、`query()` loop、`claudeToolset`）、`codex-app-server.ts`、`codex-app-server-protocol.ts`、`cursor-cli.ts`、`pi-agent.ts`、`harness-skills.ts`、`provider-auth.ts`、`usage-limits.ts`、`attribution.ts`、`handoff.ts`、`session-artifacts.ts`、`provider-catalog.ts`、`async-queue.ts`、`llm-provider.ts`、`quick-response.ts`、`generate-title.ts`、`generate-commit-message.ts`。

Harness 必须是纯 producer：只发出 `HarnessEvent`，不写 session 状态，这样才能单独使用：

```ts
for await (const e of runTurn({ provider: "codex", cwd, prompt })) { … }
```

LLM utility 总共约 733 行/4 个文件，放在此处而不另拆 package，因为这些文件唯一需要分离的原因是避免 `git` 为 commit message 依赖 `harness`。使用依赖倒置更便宜，见下文。

### `@kanna/session` — 对话记录库

通俗地说：负责保存并检索所有 chat、turn 和 message；不关心记录落在文件柜还是数据库中。与存储方式无关，只依赖 `protocol`。

包含 event-sourced chats/projects/turns/queue/read-state、transcript 追加与压缩、read-model 派生，以及把 `HarnessTurn` 和 store 写入关联起来的 turn coordinator。

迁入：`event-store.ts`、`events.ts`、`read-models.ts`、`transcript.ts`、`touched-file-backfill.ts`，以及 `AgentCoordinator` 中写入 store 的部分（turn 生命周期、queue、steer、fork、cancel）。

所有文件系统访问必须经 `StorageDriver`。默认 `JsonlFileDriver` 应原样保留现有 `~/.kanna/data` 目录布局，这条接口使切换到 Durable Object 成为配置变更。

### `@kanna/git` — 仓库操作工具

通俗地说：负责 diff、分支、提交、merge、push 和 GitHub，不了解 chat 或 AI；也可以在其上构建普通 Git GUI。与具体进程管理无关，只依赖 `protocol`。

迁入：`diff-store.ts`、`github.ts`、`worktree-snapshot.ts`、`shared/git-url.ts`。

需要三项改动：

- `Bun.spawn` 经 `CommandRunner` 执行，以便在 sandbox 中调用命令。
- 将 `projectId` 改为不透明的 `repoKey`（目前它本来就只是 cache key）。
- `generateCommitMessage` 改为接收注入的 `CommitMessageWriter = (diff, ctx) => Promise<string>`，不直接导入 LLM client；由应用接线调用 harness 实现。独立用户可用几行代码实现，或不提供此能力。

不迁入 `worktree-probe.ts`：它根据 chat 活动决定何时重扫 repo，属于应用调度策略而非 Git，并且依赖 `StoreState`。

### `@kanna/chat-ui` — 纯呈现组件

通俗地说：接收 transcript 和用户输入并渲染界面，本身不发起网络请求。使用 React，依赖 `protocol`，不依赖 socket、全局 store 或品牌信息，只接收 props/context。

迁入：`components/messages/*`、作为 `@kanna/chat-ui/primitives` 的 `components/ui/*`、`KannaTranscript.tsx`、`ChatPage/ChatTranscriptViewport.tsx`、`ChatInput.tsx`、`widgets/GitWidgets.tsx`、`chat-ui/git/*`、`ContextWindowMeter.tsx`、`TranscriptMinimap.tsx`、`lib/thread-sections.ts`、`lib/contextWindow.ts`、`lib/formatters.ts`。

需要倒置两个依赖：`components/messages/` 目前导入 `chat-ui/ChatPreferenceControls` 和 `ChatPage/toolPayloadStore`。`src/export-viewer` 可作为 package 自带示例/fixture，因为它已经验证了这条边界。

### `@kanna/server` — 服务端接线层

通俗地说：接受连接、认证、将请求路由给其他库，再推送更新；它是 plumbing，不是产品。

包括 HTTP 路由（`/ws`、`/health`、`/auth/*`、`/api/*`、static）、认证、上传、终端，以及组合 harness/session/git 并接入 protocol handler 的代码。

迁入：`server.ts`、`auth.ts`、`uploads.ts`、`terminal-manager.ts`、`ws-router.ts` 的 handler 部分、`local-http-servers.ts`、`external-open.ts`、`paths.ts`。

保持边界的规则：`@kanna/server` 不得导入 `kanna`，也不得知道应用名、版本或 data directory。若改动必须打破规则，应放回 app。若需要增加第三条例外，就删掉这条边界，将 server 并回 app；Cloudflare 方案仍然成立，只是改成“用相同的五个 package 重写约 800 行接线代码”。

`terminal-manager.ts` 约 414 行，不单独拆包：PTY multiplexer 不是人们会单独采用的产品，而且它很可能在 sandbox 部署中被整体替换。Wire type 在 `protocol`，实现属于 host。

### `kanna` — 产品层

CLI、updater、nightly、instance lock、cloud tunnel/pairing、onboarding、setup wizard、settings、keybindings、analytics、machine name、share/export、command palette、sidebar 组合、`worktree-probe` 调度、project discovery 及 React app shell 都属于 Kanna 产品本身。

保留：`cli.ts`、`cli-runtime.ts`、`cli-supervisor.ts`、`restart.ts`、`nightly.ts`、`instance.ts`、`update-manager.ts`、`machine-name.ts`、`analytics.ts`、`app-settings.ts`、`keybindings.ts`、`discovery.ts`、`worktree-probe.ts`、`skills.ts`、`share.ts`、`standalone-export.ts`、`project-quick-actions.ts`、`cloud/*`，以及客户端 `app/`、`settings/`、`auth/`、`cloud/`、`command-palette/`、`KannaSidebar.tsx`、stores 和 hooks。

## 4. App 自有 protocol topic

`protocol` 拥有核心 topic：`chat`、`sidebar`、`project-git`、`terminal`。

Kanna 自有 topic——`app-settings`、`update`、`keybindings`、`provider-auth`、`usage-limits`、`llm-provider`、`skills`——约占 `shared/types.ts` 327 行（第 1064–1390 行），留在 app 中并组合进交给 broker 的 union。

Broker 是不会按 topic type 做 switch 的 registry，只有 handler 会分发，而 handler 留在 `server`/`kanna`。因此不需要另建 package，也能保证“onboarding/settings 仅属于 Kanna”。

## 5. 仓库布局

```text
kanna/
├── package.json            # workspace 根目录
├── packages/
│   ├── protocol/
│   ├── harness/
│   ├── session/
│   ├── git/
│   ├── chat-ui/
│   └── server/
└── apps/
    └── kanna/              # 发布为 kanna-code
        ├── bin/kanna
        ├── src/server/
        ├── src/client/
        └── src/export-viewer/
```

使用 Bun workspaces。Package 名称为私有的 `@kanna/*`；开发时直接消费 TypeScript 源码，不为每个 package 单独构建。

## 6. 四个替换接口

第 8 节的部署形态最终都只替换以下接口：

| 接口 | 归属 | 当前本地实现 | Worker / DO / Sandbox 实现 |
| --- | --- | --- | --- |
| `StorageDriver` | `session` | `~/.kanna/data` 中的 JSONL + compaction | DO SQLite |
| `Socket` | `protocol` | Bun `ServerWebSocket` | 支持 hibernation 的 DO WebSocket |
| `CommandRunner` | `git`、`harness` | `Bun.spawn` | sandbox exec RPC |
| `AppConfig` | 全部 | `~/.kanna`、`kanna-code@x.y.z` | 按部署注入 |

`AppConfig` 取代 `src/shared/branding.ts`，由构造函数注入，不能直接 import。它是第一阶段，也是所有拆分的前置条件。

## 7. 各 package 可运行的位置

此表描述能力要求，而非偏好；它决定了可选托管架构。

| Package | 依赖能力 | 浏览器 | CF Worker | Durable Object | Container/VM | 本机 Node/Bun |
| --- | --- | --- | --- | --- | --- | --- |
| `protocol` | 无 | ✅ | ✅ | ✅ | ✅ | ✅ |
| `chat-ui` | DOM | ✅ | ❌ | ❌ | ❌ | ❌ |
| `session` | storage driver | ~ | ~ | ✅ SQLite | ✅ files | ✅ files |
| `git` | 运行 `git` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `harness` | spawn CLI | ❌ | ❌ | ❌ | ✅ | ✅ |
| `server` | HTTP + WS | ❌ | ✅ | ✅ | ✅ | ✅ |
| `kanna` CLI | machine | ❌ | ❌ | ❌ | ✅ | ✅ |

关键限制：`harness` 和 `git` 会调用真实二进制程序，任何拆分都不会让它们运行在 Worker 中。任何 serverless 架构仍需一个 container。

## 8. 部署形态

### A. 本地单体 — 当前交付形态

```text
用户笔记本：浏览器 tab ↔ chat-ui/protocol ↔ Bun server
                                      ├─ session → ~/.kanna
                                      ├─ harness → spawn CLI
                                      └─ git → spawn git
```

四个接口都不替换。必须保持行为一致，因为它就是产品。Electron/Tauri 只是把浏览器 tab 换成应用窗口。

### B. 本地服务 + tunnel — 当前 Kanna Cloud

```text
手机/其他笔记本 → 托管 proxy（kanna-site control plane）→ 用户笔记本上的 server
客户端的 WebSocket 直接连接 tunnel；proxy 看不到 WS frame。
```

仍没有替换任何接口，只改变可达性，不改变架构。

### C. 全托管 — Worker + Durable Object + Sandbox

```text
浏览器 chat-ui/protocol ↔ Cloudflare Worker（server handler / protocol / 静态资源）
                               ↕ Durable Object（session、protocol、SQLite transcript）
                               ↕ RPC
                         Container/Sandbox（harness、git、protocol、repo checkout）
```

四个接口都替换。诚实的范围说明：该重构能让此形态无需改动六个 package，但并不代表自动完成。仍要编写 DO storage driver（约 300 行）、sandbox exec runner（约 200 行）、真正的多租户认证，并决定 turn 之间 repo 如何保存（sandbox 文件系统临时存在，需要每 chat 保持 warm sandbox 或重新 clone）。预计是数周而非数天；这些工作不进入 `harness`、`session` 或 `git`。

### D. 团队服务器 — VPS 或 Docker

```text
多个浏览器 ↔ 单台 docker/EC2/fly.io 主机上的 server
                         session → /data volume
                         harness → spawn CLIs
                         git → /workspaces/*
```

这相当于使用不同 `AppConfig` data dir 的形态 A。新增工作是多租户；当前一台机器对应一个用户。这是 app 层问题，不是 package 问题。

### E. 混合架构 — 云端历史，本机执行

```text
浏览器 ↔ hosted Worker + DO（server routing、所有 chat session、protocol）
                    ↔ 本机 agent daemon（harness、git、protocol、本机 repo）
```

`session` 不接触 repo，`harness`/`git` 不接触 chat state，因此代码中已经存在这条边界。用户关掉笔记本后，历史仍在云端。它可能是商业价值较高的形态之一，同时避免替别人运行代码所带来的责任。

### F. 无头模式 — 不带 UI

```text
CI job / Slack bot / cron
  harness ← 执行 turn
  git     ← branch、commit、PR
  session ← 可选记录
  protocol
```

这是检验 package 是否真正独立的极限测试。如果 `harness` 必须依赖 `server` 才能启动，边界就是假的。

### 各形态实际差别

| | A 本地 | B tunnel | C 全托管 | D 团队主机 | E 混合 | F 无头 |
| --- | --- | --- | --- | --- | --- | --- |
| `StorageDriver` | files | files | **DO SQLite** | files | **DO SQLite** | files / none |
| `Socket` | Bun WS | Bun WS | **DO WS** | Bun WS | Bun WS ×2 | — |
| `CommandRunner` | spawn | spawn | **sandbox RPC** | spawn | spawn | spawn |
| `AppConfig` | `~/.kanna` | `~/.kanna` | **per-tenant** | `/data` | mixed | 调用方提供 |
| **改动的 packages** | — | — | **无** | — | **无** | **无** |

最后一行就是整个拆分方案的核心论点。

## 9. 系统关系图

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ kanna（产品层，行为不变）：CLI · updater · cloud tunnel/pair · onboarding│
│ settings · keybindings · analytics · command palette · sidebar · share   │
│ worktree-probe 调度 · project discovery                                 │
└──────┬────────────────────────────────────────────────────┬──────────────┘
       ▼                                                    ▼
┌─────────────────────┐                        ┌─────────────────────────────┐
│ @kanna/chat-ui      │                        │ @kanna/server               │
│ transcript·composer │                        │ HTTP·auth·static·terminals  │
│ tools·diffs·Git 面板│                        │ handlers · 接线              │
└──────────┬──────────┘                        └──┬─────────┬─────────┬──────┘
           │             ┌─────────────────────────┘         │         │
           ▼             ▼                                   ▼         ▼
     @kanna/git     @kanna/session                      @kanna/harness
     状态/diff/branch chats/turns/queue                  claude/codex/cursor/pi
     commit/merge    transcripts/read-models             skills/auth/usage
           │ CommandRunner │ StorageDriver                  │ CommandRunner
           └───────────────┴───────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ @kanna/protocol：TranscriptEntry · tool normalize/hydrate · provider catalog│
│ HarnessEvent/HarnessTurn · topics · commands · snapshots · envelopes      │
│ subscription broker · reconnecting client · ISOMORPHIC · ZERO RUNTIME DEPS│
└──────────────────────────────────────────────────────────────────────────┘
```

## 10. 迁移阶段

每个阶段都应可独立交付，且不得改变行为。每个阶段结束时必须通过 `bun run check` 和 `bun test`。

- [ ] **阶段 0 — workspace 骨架。**配置 Bun workspaces、`packages/*`、`apps/kanna` 和 tsconfig path alias，不移动文件。在改变风险前确认 Vite、Bun test、tsc 工具链正常。
- [ ] **阶段 1 — 去品牌依赖。**将 `src/shared/branding.ts` 改为注入 `AppConfig`（`appName`、`cliCommand`、`packageName`、`version`、`dataRoot`、`logPrefix`）。涉及 28 个文件。没有完成前任何 package 都无法独立运行，因此必须先做。这是纯机械改动，解锁收益/风险比最高。
- [ ] **阶段 2 — `@kanna/protocol`。**迁移 `shared/*`、`harness-types.ts`、`parseTranscript.ts`、`derived.ts`、`socket.ts` 和 `ws-router.ts` 的 broadcast/subscription 部分。将 Kanna app-only topic（`types.ts:1064–1390`）留在 app 并组合到 union。把 `SnapshotBroadcastFilter` 泛化为 topic predicate；将 `ServerWebSocket` 抽象为最小 `Socket` interface。
- [ ] **阶段 3 — `@kanna/git`。**此阶段接近机械迁移（无 chat 耦合且已经核实）。引入 `CommandRunner`，将 `projectId` 改为 `repoKey`，把 `generateCommitMessage` 改为注入 `CommitMessageWriter`。建议早做，以最低成本验证模型。
- [ ] **阶段 4 — `@kanna/session`。**迁移 `event-store.ts`、`events.ts`、`read-models.ts`、`transcript.ts`、`touched-file-backfill.ts`。引入 `StorageDriver` 和 `JsonlFileDriver`，逐字节保留当前磁盘布局。此阶段最重要的是迁移安全：现有 `~/.kanna/data` 必须原样加载。
- [ ] **阶段 5 — `@kanna/harness`。**迁移三个干净 adapter、skills、provider auth、usage、attribution、handoff 和 LLM utilities。然后处理难点：拆分 `agent.ts`，让 Claude adapter 只发出 `HarnessEvent`，将约 60 个 store write 移到 turn coordinator（属于 `session`）。为此阶段预留最多时间。
- [ ] **阶段 6 — `@kanna/chat-ui`。**迁移 `components/messages/*`、`components/ui/*`、transcript viewport、composer 和 Git 面板；倒置两个 `messages/` 到 app 的依赖；让 `src/export-viewer` 使用此 package 作为示例。
- [ ] **阶段 7 — `@kanna/server`。**迁移所有不属于产品层的剩余内容：HTTP route、auth、uploads、terminals 和 handler wiring。通过 lint rule 或测试强制执行“不能导入 `kanna`”的规则。

## 11. 测试

测试现在与模块并列，随代码迁移。当前 116 个测试文件预计按以下方式分布：

| Package | 约文件数 | 重点 |
| --- | ---: | --- |
| `protocol` | 12 | `types.test.ts`、`tools.test.ts`、`parseTranscript.test.ts`、`socket.test.ts` |
| `harness` | 22 | `agent.test.ts`（2483 行）拆分：adapter 测试留此处，coordinator 测试迁往 session |
| `session` | 16 | `event-store.test.ts`、`read-models.test.ts` |
| `git` | 12 | `diff-store.test.ts`、`github.test.ts` |
| `chat-ui` | 14 | `KannaTranscript.test.tsx`、message 组件测试 |
| `server` | 8 | terminal、auth、routes |
| `kanna`（app） | 32 | cloud、cli-runtime、update、settings、integration |

`ws-router.test.ts`（2322 行）继续留在 app，作为端到端合约测试，验证 Kanna 各层组合后的行为。每个 package 都有自己的 `bun test` target，根目录运行全部测试。

## 12. 风险

**发布。**当前 `package.json#files` 发布原始 `src/server/`，并由 Bun 直接执行 TypeScript。import 一旦跨 workspace 边界，这种方式就会失效。发布前 app build 必须先用 `bun build --target=bun` 把 workspace 依赖打入 `dist/`。这应在阶段 0 决定，而非阶段 7，因为它会改变 `prepublishOnly`。

**`agent.ts`。**这是唯一真正困难的拆分：Claude SDK adapter 和 store 写入交错在 streaming loop 中。其他工作大多是移动文件和调整 import；这一部分需谨慎利用其 2483 行测试作为保障。

**磁盘兼容性。**阶段 4 不得改变 `~/.kanna/data` 布局。现有用户的聊天必须继续加载；snapshot compaction 和 JSONL 格式都属于关键兼容面。

**`server` / `kanna` 边界退化。**这是最松散的接口。应以 lint rule 或测试机械强制 `@kanna/server` 不导入 `kanna`，否则边界会在一个月内消失。

**范围膨胀。**每个阶段都会发现值得顺手改进的地方，不要扩大范围。“行为完全不变”能让回归清楚地归因于重构错误。

## 13. 尚待决定

1. **独立 package 发布 npm，还是只保留私有 workspace 依赖？**建议先保持私有。过早发布会让六个尚未稳定的接口都承担 semver 兼容承诺；拆分完成后再讨论。
2. **`@kanna/server` 是否作为独立 package 保留，还是并回 app？**先保留并严格执行第 3 节规则。如果“不得导入 `kanna`”需要第三条例外，就并回 app；Cloudflare 方案仍成立。
3. **实际目标部署形态是哪种？**只做 A 本地形态也有重构价值，因为代码更清楚。但若目标是 E（云端历史、本地执行），就会影响 `session` driver 接口：session 在远端，而 harness 在本机。建议在阶段 4 前作出决定。
