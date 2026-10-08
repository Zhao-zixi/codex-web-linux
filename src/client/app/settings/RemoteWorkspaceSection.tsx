import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card"
import { Input } from "../../components/ui/input"
import {
  buildKnownHostsEntry,
  buildMutagenCreateCommand,
  buildSshConfigSnippet,
  hostedSshAlias,
  hostedSessionName,
  isValidLocalPath,
  isValidPrivateKeyPath,
  isValidProjectName,
} from "./remote-workspace-command"

interface HostedWorkspace {
  displayName: string
  sshHost: string
  sshPort: number
  sshUser: string
  workspaceRoot: string
  publicHostKey?: string
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value)
}

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  async function copy() {
    try {
      await copyText(command)
      setCopyFailed(false)
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopyFailed(true)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
        <code className="block break-all whitespace-pre-wrap text-xs text-foreground">{command}</code>
      </div>
      <Button type="button" size="sm" variant="outline" className="shrink-0 self-start sm:self-center" onClick={() => { void copy() }}>
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        {copied ? "已复制" : copyFailed ? "复制失败，请手动选择" : "复制"}
      </Button>
    </div>
  )
}

export function RemoteWorkspaceSection() {
  const [workspace, setWorkspace] = useState<HostedWorkspace | null>(null)
  const [localPath, setLocalPath] = useState("")
  const [projectName, setProjectName] = useState("project")
  const [privateKeyPath, setPrivateKeyPath] = useState("")

  useEffect(() => {
    let cancelled = false
    void fetch("/api/hosted-workspace", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to read hosted workspace settings")
        return response.json() as Promise<HostedWorkspace | { enabled: false }>
      })
      .then((value) => {
        if (!cancelled && "enabled" in value && value.enabled === false) setWorkspace(null)
        else if (!cancelled) setWorkspace(value as HostedWorkspace)
      })
      .catch(() => {
        if (!cancelled) setWorkspace(null)
      })
    return () => { cancelled = true }
  }, [])

  const sshConfig = useMemo(() => workspace?.publicHostKey && isValidPrivateKeyPath(privateKeyPath)
    ? buildSshConfigSnippet({ ...workspace, publicHostKey: workspace.publicHostKey, privateKeyPath })
    : null, [workspace, privateKeyPath])
  const createCommand = useMemo(() => workspace && sshConfig && isValidLocalPath(localPath) && isValidProjectName(projectName)
    ? buildMutagenCreateCommand({ ...workspace, localPath, projectName })
    : null, [workspace, sshConfig, localPath, projectName])
  if (!workspace) return null

  const session = sshConfig && isValidProjectName(projectName) ? hostedSessionName(workspace.sshHost, workspace.sshPort, projectName) : null
  const knownHostsPath = `~/.ssh/${hostedSshAlias(workspace.sshHost, workspace.sshPort)}_known_hosts`

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>远程工作区</CardTitle>
        <CardDescription>在本机编辑项目，由远程 Kanna 容器中的 Codex 处理文件。Mutagen 在你的电脑上运行，网页不会报告它是否在线。</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-5">
        <div className="grid min-w-0 gap-3 rounded-lg border border-border/60 p-3 text-sm sm:grid-cols-2">
          <div><div className="text-xs text-muted-foreground">远程主机</div><div className="break-all">{workspace.displayName} · {workspace.sshHost}:{workspace.sshPort}</div></div>
          <div><div className="text-xs text-muted-foreground">远程目录</div><code className="break-all">{workspace.workspaceRoot}</code></div>
        </div>

        <p className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
          请先在远程 Kanna 的“设置 → 常规”中确认“新项目目录”为 <code>{workspace.workspaceRoot}</code>，并从
          <code className="break-all"> {workspace.workspaceRoot}/项目名</code> 新建或打开项目。Mutagen 同步的目录必须与 Kanna 项目目录对应；本机终端目录不会自动成为远程 Kanna 的项目。
        </p>

        <div className="flex flex-col gap-2 text-sm">
          <div className="font-medium">1. 在本机安装 Mutagen</div>
          <p className="text-muted-foreground">只需安装官方客户端并确保 mutagen 命令可在终端运行；此页面不会安装软件或授予本机目录访问权限。</p>
          <a className="w-fit text-primary underline underline-offset-4" href="https://mutagen.io/documentation/introduction/installation" target="_blank" rel="noreferrer">Mutagen 官方安装说明</a>
        </div>

        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <div className="font-medium">2. 固定 SSH 主机身份</div>
          {workspace.publicHostKey
            ? <>
              <p className="text-muted-foreground">此公钥由已登录的 HTTPS 服务提供。请将复制的这一行保存到 <code className="break-all">{knownHostsPath}</code>，再追加下方 SSH 配置片段；不要用 ssh-keyscan 的结果替代此值。</p>
              <CopyCommand label="专用 known_hosts 文件内容" command={buildKnownHostsEntry({ sshHost: workspace.sshHost, sshPort: workspace.sshPort, publicHostKey: workspace.publicHostKey })} />
            </>
            : <p className="text-muted-foreground">管理员尚未提供 SSH 主机公钥。请先联系管理员完成主机密钥配置；在拿到可信公钥前不会生成连接命令。</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <label className="font-medium" htmlFor="hosted-workspace-private-key-path">3. 本机 SSH 私钥文件路径</label>
          <span className="text-muted-foreground">只填写本机私钥文件路径，不要粘贴私钥内容。页面不会读取此文件。Windows 请在 WSL 终端与 WSL 可读路径中使用。</span>
          <Input id="hosted-workspace-private-key-path" value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} placeholder="~/.ssh/id_ed25519" autoComplete="off" spellCheck={false} />
          {privateKeyPath && !isValidPrivateKeyPath(privateKeyPath) ? <span className="text-destructive">请输入本机绝对路径（/ 开头）或 ~/ 开头的路径，不能包含控制字符。</span> : null}
          {sshConfig ? <CopyCommand label="SSH 配置片段（追加到 ~/.ssh/config）" command={sshConfig.text} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <label className="font-medium" htmlFor="hosted-workspace-local-path">4. 选择本机项目目录</label>
          <span className="text-muted-foreground">输入本机绝对路径（例如 /Users/你/项目 或 WSL 的 /mnt/c/项目），并选择远程 /workspace 下的单层目录名。路径与名称会分别转义。</span>
          <Input id="hosted-workspace-local-path" value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="/Users/你/项目" autoComplete="off" spellCheck={false} />
          <label className="font-medium" htmlFor="hosted-workspace-project-name">远程项目目录名</label>
          <Input id="hosted-workspace-project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="project" autoComplete="off" spellCheck={false} />
          {!isValidProjectName(projectName) ? <span className="text-destructive">请输入单层目录名，不能是 .、..、斜线、冒号或控制字符。</span> : null}
          {localPath && !isValidLocalPath(localPath) ? <span className="text-destructive">请输入以 / 开头的绝对路径，不能包含控制字符。</span> : null}
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <div className="font-medium">5. 在本机终端创建并管理同步</div>
          {createCommand ? <CopyCommand label="创建双向同步会话" command={createCommand} /> : <p className="text-muted-foreground">需提供可信主机公钥、本机私钥路径、绝对项目路径和有效的远程目录名，才会生成连接命令。</p>}
          <p className="text-xs text-muted-foreground">Mutagen 使用双向安全模式；忽略 Git 元数据、依赖、构建缓存与常见凭据文件。Git 元数据仅保留在本机，请在本机提交和管理分支。</p>
          {session ? <>
            <CopyCommand label="查看会话状态" command={`mutagen sync list ${session}`} />
            <CopyCommand label="刷新同步" command={`mutagen sync flush ${session}`} />
            <CopyCommand label="暂停同步" command={`mutagen sync pause ${session}`} />
            <CopyCommand label="恢复同步" command={`mutagen sync resume ${session}`} />
          </> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border/60 pt-4 text-sm">
          <div className="font-medium">冲突或同步暂停时</div>
          <p className="text-muted-foreground">先检查 Mutagen 报告的冲突文件，打开双方副本并手动合并或选定要保留的一份；确认目录内容后再恢复会话。停止同步不会替你决定覆盖哪一侧。</p>
          {session ? <>
            <CopyCommand label="重新查看会话状态" command={`mutagen sync list ${session}`} />
            <CopyCommand label="确认处理后恢复同步" command={`mutagen sync resume ${session}`} />
          </> : null}
        </div>

        <div className="text-xs text-muted-foreground">SSH 用户：{workspace.sshUser}。网页不会访问或授权你的本机目录；粘贴配置与创建命令由你在本机终端执行。</div>
      </CardContent>
    </Card>
  )
}
