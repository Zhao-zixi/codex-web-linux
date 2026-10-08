# Repository Guidelines

## 项目结构与模块组织

Kanna 是面向编程代理的 Web 界面，使用 Bun 后端和 React 前端。

- `src/client/`：应用路由、React 组件、hooks、Zustand stores 与工具模块。
- `src/server/`：HTTP/WebSocket 服务、provider 适配器、事件持久化、终端和云集成。
- `src/shared/`：浏览器与服务端共用的类型、协议定义和工具函数。
- `src/demo/` 与 `src/export-viewer/`：演示版和独立 transcript 查看器入口。
- `macos/`：带独立 package manifest 的 Electron 桌面包装程序。
- `scripts/`：开发、打包、发布和包检查脚本。`assets/` 与 `public/` 保存视觉资源和静态文件。

## 构建、测试和开发命令

使用 Bun 1.3.5 或更高版本，并使用仓库提交的 `bun.lock`。

- `bun install`：安装依赖。
- `bun run dev`：同时运行 Vite 前端和 Bun 后端。
- `bun run build`：构建客户端、export viewer 和服务端。
- `bun run start`：构建后启动生产服务。
- `bun run check`：运行 TypeScript 检查，以及客户端、export viewer、demo 和服务端构建。
- `bun test`：运行默认测试套件。
- `bun run test:cloud`：运行云端 wire 集成测试；需要同级目录的 `../kanna-site` 仓库，不存在时会跳过。

## 代码风格与命名约定

遵循周围的 TypeScript/TSX 代码：两个空格缩进、双引号、不写分号。React 组件使用 PascalCase，hooks 使用 `useX`，函数使用 camelCase，服务端模块使用 kebab-case。TypeScript 启用了严格检查；仓库没有专用 formatter 或 linter。

## 测试约定

使用 `bun:test`，测试文件与模块并列，命名为 `*.test.ts` 或 `*.test.tsx`，例如 `chat-commands.test.ts`。使用 `bun test ./src/server/chat-commands.test.ts` 运行聚焦测试。涉及 Git 时创建临时目录和一次性仓库；外部 provider 使用 mock。显式的 `.e2e.ts` 套件单独运行。没有数值覆盖率要求；应覆盖改动行为和有意义的回归。

## 提交与 Pull Request 约定

提交标题简短并以动词开头，参照 “Persist pinned channels on the server.”。发布提交使用版本号。保持提交范围集中。PR 应说明问题、最终行为、相关 issue 和验证命令；可见 UI 改动应附截图。

## 架构与配置

`src/shared/` 不得导入 Bun/Node 专用模块。新增 WebSocket 命令时，在 `src/shared/protocol.ts` 定义，并在 `ws-router.ts` 处理；只广播受影响的 snapshot。`src/shared/cloud-api.ts` 只允许追加字段；改动时与外部镜像协调。不得把凭据或本机 `~/.kanna/data/` 历史提交到仓库。

## Agent 模型路由

仓库工作遵循以下层级；允许通过子代理委派：

- `gpt-6.1-sol`，`xhigh`：顶层规划、架构决策、验收标准和最终审查。
- `gpt-6-sol`，`medium`：问题诊断、需求拆分；梳理证据、受影响文件、依赖和验证步骤。
- `gpt-6-luna`：代码编辑、shell 命令和聚焦验证。除非明确要求，否则使用运行时默认推理强度。

规划者确定范围；诊断者把具体任务交给执行者。执行者回报改动、命令结果和阻碍。诊断问题升级给诊断者；范围或架构变化升级给规划者。创建子代理时应选择实际模型和推理强度，不能只写角色名称。只并行处理互相独立且文件所有权分离的任务。模型不可用时应明确报告，不得静默替换。此规则不会改变已经运行中的会话模型。
