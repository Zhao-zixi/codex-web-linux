# 网关账号与模型连接

网关把 elim、zzx 两个既有远程工作区放在同一个网页入口后面：用户使用各自的用户名和原工作区密码登录；管理员在独立管理页维护账号和共享 API 连接。当前版本只管理这两个已配置工作区，不提供创建新容器或新工作区的功能。网页入口、端口和迁移步骤见[远程工作区指南](remote-workspace.md)。

## 登录与账号管理

网关统一入口为 `http://fnos.zixizhao.top:8444`。登录后，普通用户进入绑定给自己的工作区，只能查看分配给自己的 API 连接名称和状态；管理员进入管理页面，不会因此进入任一普通用户的工作区。账号密码仍由各自用户使用，管理员可停用/恢复用户账号和重置密码。停用或重置密码会立即撤销该账号现有网页登录会话；停用账号不会删除工作区文件和 HOME。

未发送的聊天草稿、聊天标签、差异选择和左右侧栏/终端布局保存在浏览器本机，并按网关用户隔离；同一用户刷新页面后会恢复自己的草稿和布局，不会读到另一个用户的数据。退出登录会清理当前用户在本机保存的这一组状态，不会删除其他用户的浏览器状态或服务器工作区。

首次启用网关时会创建 `admin` 管理员账号，并生成随机初始密码，保存在 `.remote-workspace/secrets/gateway-admin-password`（文件权限 `0600`）。管理员通过独立安全渠道获取该密码后登录。不要把密码内容复制到仓库、部署日志、聊天记录或工单。elim、zzx 的登录密码沿用启用网关前已有的 app 密码；迁移不得重新初始化或重建 manifest。

管理员页面可以启用、停用用户，重置用户密码，为每位用户单独授予或撤销连接。此版本没有动态创建用户的界面。离开团队的用户应先停用，再处理其连接授权；账号状态不会自动清除个人 HOME 或历史项目。

## 管理员 CLI 授权与共享 API 连接

管理员可在管理页面安装 Codex/Claude CLI、完成官方授权、查看授权状态或退出授权。CLI 的认证资料保存在网关专用 HOME 中；管理员目前没有可进入的 Kanna 工作区来运行这些 CLI。个人 ChatGPT/Claude 订阅授权标记为不可分配，不会让普通用户使用管理员个人订阅。多人共享请配置可分配的官方 API Key 连接。

共享连接目前接受 OpenAI API Key（Codex）或 Anthropic API Key（Claude）。创建后，密钥不会再次显示在管理页面；轮换时提交新 Key，用户看到连接名称与状态而不是密钥。管理员可停用、重新启用或删除连接，也可逐用户授予和撤销。停用、删除连接或撤销用户授权会中止该连接上正在进行的代理请求；删除连接同时移除所有用户的对应授权。Key 只用于官方 API 的 Responses 或 Messages 请求，不代表已购买额度、已开通组织权限或模型可用。

用户自己的凭据优先于网关分配的 API 连接。Codex 自配包括用户 HOME 中的 `OPENAI_API_KEY` 或 `.codex/auth.json` 凭据；Claude 自配包括 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、用户 HOME 的 Claude OAuth 凭据，以及用户 HOME 下 `.claude/settings.json`、`.claude/settings.local.json` 和项目中的 `.claude/settings.json`、`.claude/settings.local.json` 所配置的 `apiKeyHelper`、凭据环境变量或自定义服务商设置。系统只判断凭据是否存在，不保证其有效性：如果用户配置的凭据过期或无效，系统不会暗中改用管理员的 API 额度。用户需要自行修复或移除自己的凭据，才会使用已分配的共享连接。撤销分配不会删除用户自己的登录态或 API Key。

## 使用连接

管理员登录统一入口后，在管理页的“可分配 API 连接”区域选择 `OpenAI API`（供 Codex 使用）或 `Anthropic API`（供 Claude 使用），填写连接名称和对应 API Key，再点“添加连接”。之后在“用户”区域找到 `elim` 或 `zzx`，勾选要授予的连接并点“保存分配”。密钥创建后不会再次显示；需要换钥时使用该连接的轮换操作。

用户登录自己的账号，在 Settings 的 `Providers` 页面查看“管理员分配的连接”及其状态；然后打开聊天，在 provider 选择器中选择 `Codex` 或 `Claude`。管理员分配只提供对应官方 API 的连接，不会替用户完成个人账号登录。

### 用户使用自己的 Codex 或 Claude 登录

在用户自己的工作区打开 Settings → `Providers` → `Accounts`。在 `Codex` 或 `Claude Code` 对应行点 `Install`（尚未安装时）并等待完成，再点 `Log In`。按页面显示的官方授权 URL 和代码完成设备/代码授权，回到 Kanna 等待状态更新。Codex 登录凭据由官方 CLI 保存在该用户 HOME 的 `.codex/auth.json`；Claude Code OAuth 凭据保存在该用户 HOME 的 `.claude/.credentials.json` 或 `.claude/credentials.json`。这些文件属于该用户的隔离 HOME，不是管理员共享连接。

若 Codex 用户要配置自己的 API Key，可在该用户的终端运行官方 CLI 登录命令并通过标准输入交给 CLI；下面的交互式输入不会回显 Key，也不会把 Key 写进命令历史：

```sh
read -rsp "OpenAI API key: " OPENAI_API_KEY
printf '\n'
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
unset OPENAI_API_KEY
```

登录后凭据由 CLI 写入该用户的 `.codex/auth.json`。Claude Code 用户若使用自己的 Anthropic API Key，应把它放在该用户 HOME 的 `~/.claude/settings.json` 的 `env` 中，例如：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "YOUR_ANTHROPIC_API_KEY"
  }
}
```

如果 `settings.json` 已存在，请合并 `env.ANTHROPIC_API_KEY` 字段并保留其它设置，不要用示例覆盖整个文件。仅在某个终端执行 `export ANTHROPIC_API_KEY=...` 不会为之后由 Kanna 启动的代理进程持久配置凭据。

当用户自己的凭据存在时，Kanna 优先使用它，即使它失效也不会自动改用管理员连接。要改用管理员分配的连接，先清除该用户自己的凭据，再重新打开聊天：Codex 可删除该用户 HOME 的 `.codex/auth.json` 并移除 Kanna 进程环境中的 `OPENAI_API_KEY` / `CODEX_API_KEY`；Claude 可删除 `.claude/.credentials.json` 或 `.claude/credentials.json`，并从用户级及项目级 `.claude/settings*.json` 移除自己的 Key、`apiKeyHelper` 或自定义服务商配置，同时清除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 等注入给 Kanna 的环境变量。若设置文件还包含其它配置，只删凭据相关项并保留其余字段。管理员撤销分配不会删除用户自己的凭据；删除个人凭据也不会撤销管理员分配。

## 纯 HTTP 的限制

本次部署使用纯 HTTP。网页、密码、会话令牌、工作区数据和请求内容会以明文经过网络；只应在用户到服务器之间网络路径可信且入口访问范围受控时使用。浏览器会把网页登录令牌保存在当前 origin 的会话存储中；不要在共享设备上保留登录页面。HTTP 下浏览器媒体与大文件传输有额外限制，见远程工作区指南。

统一入口采用一个 hostname 和一个 HTTP 端口，避免同 hostname 下多个工作区端口共享 Cookie 的边界问题；fnOS 的 80、443、8443 与各账号 SSH 端口保持既有配置。公网 DNS、路由器 NAT 和真实模型调用状态须以部署环境实际结果为准；本指南不把它们描述为已验收。

## 数据保存与升级

网关用户、密码哈希、会话哈希、连接 API Key 和用户授权保存在 gateway 私有状态目录；管理员 Codex/Claude CLI 授权保存在单独的管理员 HOME。网关状态目录和凭据文件应按部署生成的权限限制保存，并纳入受控备份；不要把 `.remote-workspace/`、manifest、`.env`、gateway 状态或任何凭据提交到 Git。备份中包含共享 API Key 和管理员登录态，应限制读取并加密保存。

升级前备份整个远程工作区持久状态和生成配置，确认代码与配置对应后再重新生成并更新服务。恢复时还原原状态，不要重新运行 `init` 或清空 gateway 状态目录；否则会失去用户密码、连接授权、管理员 CLI 登录态和远程工作区数据。管理员初始密码文件为 `.remote-workspace/secrets/gateway-admin-password`。启用网关的迁移命令和回滚步骤见远程工作区指南。
