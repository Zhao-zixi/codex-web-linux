# Kanna — 开发说明

Kanna 是本地编程代理 Web 界面（Claude Code、Codex、Cursor、Grok Build、Pi）。使用 Bun 服务端 + React 19 客户端，通过一个 WebSocket 通信。

## 命令

- `bun run dev`：同时运行客户端（Vite）和服务端（Bun）。
- `bun test`：运行单元/集成测试。
- `bun run check`：TypeScript 检查和生产构建。
- `bun run build`：构建客户端和 export viewer。

## 架构概览

```text
React 客户端（src/client）
  socket.ts ── 一个 WebSocket ──► WSRouter（src/server/ws-router.ts）
                                  ├─ 命令：按 shared/protocol.ts 中的 ClientCommand 分发
                                  ├─ snapshots：按 topic 推送，并基于签名去重
                                  ├─ AgentCoordinator（agent.ts）── provider adapters：
                                  │    Claude Agent SDK（直接在 agent.ts 中运行）· codex-app-server.ts
                                  │    cursor-cli.ts · grok-cli.ts · pi-agent.ts
                                  └─ EventStore（event-store.ts）：JSONL 日志 + snapshot 压缩
                                     + 每聊天 transcript（~/.kanna/data）
```

- **客户端显示的内容都来自服务端 snapshot。** 服务端按订阅 topic 推送：`sidebar`、`chat`、`project-git`、`local-projects`、`update`、`keybindings`、`app-settings`、`terminal`。客户端发送命令；除乐观显示用户 prompt（之后按内容签名校准）外，不会在本地修改服务端状态。
- Snapshot 推送按签名去重：sidebar/chat 直接使用序列化后的 snapshot（每次广播只构建一次，供多个 socket 复用），project-git 使用版本计数器。新增 topic 时保留这种特性。
- Chat 订阅只持有 transcript 的一个窗口，而不是完整内容：最后 N 条 assistant 消息（`transcript.windowAssistantMessages`，默认 50 条），并扩展到覆盖阅读锚点。`chat.loadOlder` 会向前移动窗口，较旧片段以增量推送形式插入前方。snapshot 中的 `outline` 记录所有 user prompt，因此 minimap 能覆盖整段聊天。逻辑位于 `src/shared/transcript-window.ts`。
- Provider adapter 将三种不同的 wire protocol 规范化为 `HarnessEvent`（`harness-types.ts`）。Claude 直接通过 `agent.ts` 中的 Agent SDK 运行；codex/cursor/pi 产出 `HarnessTurn`。
- 关闭服务时会取消所有正在运行的 turn，并在对应 chat 上标记 `resumePending`（`agent.interruptForShutdown`）；下次启动会用仅供 wire 使用的“继续” prompt 恢复这些 turn（`resume-turns.ts`）。用户主动取消不会设置标记；恢复尝试前会清除标记，因此一次关闭最多恢复一次。
- Transcript 按 chat 以追加方式写入 JSONL（`transcripts/<chatId>.jsonl`），EventStore 使用小型 LRU cache。`debugRaw`（原始 provider JSON）只写入 `system_init`——这是唯一含原始 JSON 视图的 entry。Tool 结果则单独保留为 `structuredResult` 中的 `tool_use_result`，且仅用于 `ask_user_question` / `exit_plan_mode`。
- Transcript 文件以 header 形式保存 entries。Tool body（文件内容、编辑、命令输出）放在 `transcripts/<chatId>.payloads.jsonl`，打开对应行时通过字节偏移读取（`transcript-payloads.ts`）。Tool 结果里的图片存放在 `media/<chatId>/`，由 URL 引用（`transcript-media.ts`）。`getMessages()` 会为导出、handoff 和 fork 重新合并完整内容。`slimTranscripts` 每个 data dir 只重写一次旧 transcript；`kanna slim-transcripts` 可强制执行。传给 agent 的 transcript 路径只包含 headers。

## 约定

- `src/shared/` 同时供客户端和服务端导入，不得导入 Bun/Node 专用模块。
- 新增 WS 命令：在 `shared/protocol.ts` 添加，在 `ws-router.ts` 处理。优先使用精确声明受影响 topic 的 `broadcastFilteredSnapshots({...})`，不要无差别广播。
- 测试与模块并列（`foo.ts` / `foo.test.ts`），使用 Bun 运行。`.e2e.ts` 后缀会让文件避开 `bun test` 默认扫描，用于 cloud wire e2e。
- 测试依赖 Git 时创建一次性仓库；在沙盒中设置干净的 `GIT_CONFIG_GLOBAL`，避免 URL rewrite 或身份配置泄露到测试中。

## iOS 应用（`ios/`）

- `ios/` 是独立 Git 仓库（被本仓库忽略）。iOS 改动应在那个仓库中提交。
- Web 客户端与 iOS 应用共用大部分界面（composer、sidebar、chat）。如果问题没有说明针对哪个平台，先确认再改代码；改错平台会导致工作无效。

## Cloud 合约

- `src/shared/cloud-api.ts` 是与托管 control plane/proxy（kanna-site，独立且单独部署的私有仓库）之间的 wire contract。它**只允许追加**：不得删除或重命名字段/常量，只能添加可选字段，以兼容已部署机器。该文件逐字镜像到 `kanna-site/src/shared/cloud-api.ts`；修改任一副本时都要保持一致。
- 机器端逻辑位于 `src/server/cloud/`（identity 文件、control-plane client、tunnel supervisor、request guard）。托管 proxy 能看到代理的 HTTP 请求，但看不到 WebSocket frame；浏览器的 WS 直接连接机器 tunnel。
- `bun run test:cloud` 会对 `../kanna-site` 中的本地 `wrangler dev` 运行跨仓 wire e2e；缺少同级仓库时会跳过。
