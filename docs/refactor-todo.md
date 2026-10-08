# 重构待办

跟踪 2026-04-21 提出的重构事项。完成后将 `[ ]` 改为 `[x]`；开始处理时直接在事项下补充进展。

## 待处理与已完成事项

- [x] Tunnel/share 参数清理
  提交：`77e934f`、`d0eef25`
  范围：`src/shared/share.ts`、`src/server/cli-runtime.ts`、`src/server/share.ts`
  目标：
  - 将 `awaitQuickTunnelUrl` 和 `awaitNamedTunnelReady` 合并为统一的 `awaitTunnelReady(...)` helper。
  - 将 host/remote 冲突检查提取为 `assertNoHostOverride(...)`，供 `--share` 和 `--cloudflared` 共用。
  - 移除 `startShareTunnel` 中重复的 `isTokenShareMode` 分支。
  预期影响：减少重复的 tunnel 生命周期和 CLI 参数解析逻辑；不预期改变行为。
  状态：2026-04-21 已完成。

- [x] 简化 sidebar 项目顺序持久化
  提交：`1167a18`
  范围：`src/server/events.ts`、`src/server/event-store.ts`、`src/server/read-models.ts`、snapshot/compaction 流程
  目标：
  - 用小型独立偏好文件（例如 `sidebar-order.json`）替代 `sidebar_project_order_set` 事件溯源。
  - 从 replay、`StoreState` 和 compaction snapshot 处理中移除 sidebar 顺序。
  - 让重启/加载行为与 keybindings、LLM provider 配置等偏好存储方式一致。
  预期影响：减少事件处理流程，降低偏好文件损坏的影响范围。
  状态：2026-04-21 已完成。

- [x] 统一 Model ID 规范化逻辑
  提交：`db77356`
  范围：`src/shared/types.ts`、`src/client/stores/chatPreferencesStore.ts` 和相关服务端调用点
  目标：
  - 从共享 `PROVIDERS` catalog 推导 Claude model 规范化逻辑，替代单独的 switch 映射。
  - 将 Codex model 规范化逻辑与 Claude 一起移入 shared code。
  - 如可行，用声明式 model metadata 替代 `isClaudeOpusModelId` 的字符串前缀判断。
  预期影响：让 model 规范化和能力检查只有一个事实来源。
  状态：2026-04-21 已完成。

- [x] 拆分 WS router 命令处理器
  范围：`src/server/ws-router.ts`
  目标：
  - 提取重复的“解析 project、调用 diff store、ack、按需广播”流程。
  - 用该 helper 合并重复的 Git 命令分支。
  - 通过 `return` / `break` 明确并统一 broadcast 语义。
  预期影响：缩小 router，降低广播行为不一致的风险。
  状态：2026-07-18 已完成：`handleChatGitCommand` 合并了 14 个 Git case；skills 子系统已抽出到 `skills.ts`；每条命令的广播语义明确，不再依靠 fallthrough 广播。

- [x] 抽取共享 profiling/logging helper
  范围：`src/server/event-store.ts`、`src/server/ws-router.ts`
  目标：
  - 将重复的 `KANNA_PROFILE_SEND_TO_STARTING` 环境变量检查和日志格式化移入共享 profiling 模块。
  - 允许调用点传入 `traceId`、`startedAt` 等事件详情。
  预期影响：统一 profiling 格式和实现路径。
  状态：2026-07-18 已通过完全移除客户端和服务端的 send-to-starting profiling scaffolding 解决，没有再做合并。

- [ ] 重构 Tool call 类型注册表
  进度（2026-07-18）：`HydratedToolCall` 和 15 个按 kind 区分的 alias 已从 `NormalizedToolCall` 通过 `HydratedToolCallOf<K>` 推导；剩余工作是从 registry 推导 `NormalizedToolCall` 本身。
  提交：`3f50f10`、`f997856`
  范围：`src/shared/types.ts` 及受影响的渲染/类型消费者
  目标：
  - 用 registry/map 驱动的类型定义替代并行的 tool-call 类型层级。
  - 从 registry 推导 `ToolCallKind`、`NormalizedToolCall` 和 `HydratedToolCall`。
  - 新增 tool call kind 时减少需要改动的位置。
  预期影响：显著减少类型样板代码；存在中等重构风险。

- [x] 精简 `chatPreferencesStore` 的规范化代码
  范围：`src/client/stores/chatPreferencesStore.ts`
  目标：
  - 将一直运行的旧格式规范化改为一次性迁移到当前 schema。
  - 在迁移确保当前数据形状后，删除旧 persisted-state 分支。
  - 尽可能合并 provider preference 规范化路径。
  预期影响：显著缩小 store 逻辑，并让当前状态处理更清楚。
  状态：2026-07-18 已完成：通用 `PROVIDER_NORMALIZERS` 取代按 provider 重复的 clone/normalize/compare 逻辑（730 行缩至 484 行，测试未变）。后续也已完成：规范化器和 providerDefaults 深度合并移入 `src/shared/provider-preferences.ts`，由 `app-settings.ts`（服务端）、`chatPreferencesStore.ts` 和 `appSettingsStore.ts` 共用，服务端重复实现已移除。
