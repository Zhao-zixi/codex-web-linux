import { useCallback, useEffect, useState } from "react"
import { Download, ExternalLink, Loader2, RotateCw, ShieldCheck, Trash2 } from "lucide-react"
import { kannaFetch } from "../auth-client"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card"
import { SettingsNotice } from "./shared"
import { LegacyRemoteWorkspaceManual } from "./LegacyRemoteWorkspaceManual"

interface HostedWorkspace {
  displayName: string
  sshHost: string
  sshPort: number
  sshUser: string
  workspaceRoot: string
  publicHostKey?: string
}

type DownloadTarget = "windows-x64" | "linux-x64"
interface ClientDownload {
  target: DownloadTarget
  label: string
  filename: string
  url: string
}
interface AuthorizedDevice {
  id: string
  label: string
  fingerprint: string
  createdAt: string
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export function RemoteWorkspaceSection() {
  const [workspace, setWorkspace] = useState<HostedWorkspace | null>(null)
  const [downloads, setDownloads] = useState<ClientDownload[]>([])
  const [devices, setDevices] = useState<AuthorizedDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [deviceFeatureAvailable, setDeviceFeatureAvailable] = useState(true)
  const [downloadBusy, setDownloadBusy] = useState<DownloadTarget | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const workspaceResponse = await kannaFetch("/api/hosted-workspace", { cache: "no-store" })
      if (!workspaceResponse.ok) throw new Error("workspace")
      const workspacePayload = await workspaceResponse.json() as HostedWorkspace | { enabled: false }
      if ("enabled" in workspacePayload && workspacePayload.enabled === false) {
        setWorkspace(null)
        setLoading(false)
        return
      }
      setWorkspace(workspacePayload as HostedWorkspace)

      const [clientResult, devicesResult] = await Promise.allSettled([
        kannaFetch("/api/hosted-workspace/client", { cache: "no-store" }),
        kannaFetch("/api/hosted-workspace/devices", { cache: "no-store" }),
      ])
      if (clientResult.status === "rejected" || devicesResult.status === "rejected") throw new Error("details")
      if (!clientResult.value.ok && clientResult.value.status !== 404) throw new Error("downloads")
      if (clientResult.value.ok) {
        const payload = await clientResult.value.json() as { downloads?: ClientDownload[] }
        setDownloads(Array.isArray(payload.downloads) ? payload.downloads.filter((item) => item && (item.target === "windows-x64" || item.target === "linux-x64") && typeof item.url === "string") : [])
      } else {
        setDownloads([])
      }
      if (devicesResult.value.status === 404) {
        setDeviceFeatureAvailable(false)
        setDevices([])
      } else if (!devicesResult.value.ok) {
        throw new Error("devices")
      } else {
        const payload = await devicesResult.value.json() as { devices?: AuthorizedDevice[] }
        setDeviceFeatureAvailable(true)
        setDevices(Array.isArray(payload.devices) ? payload.devices : [])
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function downloadClient(item: ClientDownload) {
    setDownloadBusy(item.target)
    setDownloadError(null)
    try {
      const response = await kannaFetch(item.url, { cache: "no-store" })
      if (!response.ok) throw new Error("download")
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = objectUrl
      anchor.download = item.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
    } catch {
      setDownloadError("下载暂时失败。请检查网络后重试；如果问题持续，请联系管理员确认客户端包已发布。")
    } finally {
      setDownloadBusy(null)
    }
  }

  async function revokeDevice(device: AuthorizedDevice) {
    if (!window.confirm(`撤销“${device.label}”的授权？撤销后会阻止新连接；正在进行的同步可能继续，请先在本地助手中暂停同步。`)) return
    setRevokingId(device.id)
    setDeviceError(null)
    try {
      const response = await kannaFetch(`/api/hosted-workspace/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" })
      if (response.status !== 204 && response.status !== 404) throw new Error("revoke")
      setDevices((current) => current.filter((entry) => entry.id !== device.id))
    } catch {
      setDeviceError("撤销失败，请检查网络后重试。")
    } finally {
      setRevokingId(null)
    }
  }

  if (!workspace && !loading && !loadError) return null

  return (
    <Card data-testid="sync-assistant-card" className="min-w-0 rounded-2xl border-border bg-card/40">
      <CardHeader className="gap-2 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck /></div>
          <div className="min-w-0">
            <CardTitle className="text-base">同步助手</CardTitle>
            <CardDescription className="mt-1">请在需要同步文件的 Windows 或 Linux 电脑上安装；手机可查看授权设备和连接说明。</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-5 px-4 pb-4 sm:px-5 sm:pb-5">
        {loading ? <div role="status" className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取同步助手设置…</div> : null}
        {loadError ? <SettingsNotice>暂时无法读取同步助手设置。请检查网络和登录状态后重试。 <button type="button" className="ml-1 font-medium underline underline-offset-4" onClick={() => void load()}>重试</button></SettingsNotice> : null}
        {workspace ? <>
          <ol className="grid gap-3 text-sm sm:grid-cols-3">
            <li className="rounded-xl border border-border/70 bg-background/50 p-3"><span className="mb-1 block text-xs font-medium text-muted-foreground">1 · 选择系统并下载</span>选择你的电脑系统，下载压缩包。</li>
            <li className="rounded-xl border border-border/70 bg-background/50 p-3"><span className="mb-1 block text-xs font-medium text-muted-foreground">2 · 解压并启动</span>解压后双击“同步助手”启动。</li>
            <li className="rounded-xl border border-border/70 bg-background/50 p-3"><span className="mb-1 block text-xs font-medium text-muted-foreground">3 · 登录并选目录</span>首次输入一次 Kanna 用户名和密码，再选择项目文件夹。</li>
          </ol>

          <section className="flex flex-col gap-3" aria-label="下载同步助手">
            <div className="text-sm font-medium">下载同步助手</div>
            {downloads.length ? <div className="grid gap-2 sm:grid-cols-2">
              {downloads.map((item) => <Button key={item.target} type="button" variant="outline" className="h-auto min-h-12 justify-start gap-3 rounded-xl px-4 py-3" disabled={downloadBusy !== null} onClick={() => void downloadClient(item)}>
                {downloadBusy === item.target ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Download className="size-4" data-icon="inline-start" />}
                <span className="flex min-w-0 flex-col items-start text-left"><span className="font-medium">{item.label}</span><span className="truncate text-xs text-muted-foreground">{item.filename}</span></span>
              </Button>)}
            </div> : <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">同步助手安装包暂不可用，请稍后重试或联系管理员。此处只会显示已发布的 Windows 和 Linux 版本。</p>}
            {downloadError ? <SettingsNotice>{downloadError}</SettingsNotice> : null}
          </section>

          <section className="flex min-w-0 flex-col gap-3 border-t border-border/70 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-sm font-medium">已授权设备</h3><p className="mt-1 text-xs text-muted-foreground">这里显示授权记录，不代表设备当前在线。</p></div>
              <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading}><RotateCw data-icon="inline-start" />刷新</Button>
            </div>
            {!deviceFeatureAvailable ? <p className="text-sm text-muted-foreground">此工作区尚未启用设备授权管理。</p> : devices.length ? <ul className="flex flex-col divide-y divide-border rounded-xl border border-border/70">
              {devices.map((device) => <li key={device.id} className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><div className="break-words text-sm font-medium">{device.label}</div><code className="mt-1 block break-all text-xs text-muted-foreground">{device.fingerprint}</code><div className="mt-1 text-xs text-muted-foreground">授权于 {formatDate(device.createdAt)}</div></div>
                <Button type="button" variant="outline" size="sm" className="self-start text-destructive hover:text-destructive sm:self-auto" disabled={revokingId !== null} onClick={() => void revokeDevice(device)}><Trash2 data-icon="inline-start" />撤销</Button>
              </li>)}
            </ul> : <p className="rounded-xl border border-border/70 px-3 py-4 text-sm text-muted-foreground">还没有授权设备。第一次在同步助手登录时会登记这台电脑。</p>}
            {deviceError ? <SettingsNotice>{deviceError}</SettingsNotice> : null}
            <p className="text-xs leading-relaxed text-muted-foreground">撤销后会阻止新连接；正在进行的同步可能继续，请先在本地助手中暂停同步。</p>
          </section>

          <details className="group border-t border-border/70 pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">高级手动连接设置 <ExternalLink className="size-3.5 transition-transform group-open:rotate-90" /></summary>
            <p className="mb-3 mt-2 text-xs text-muted-foreground">供需要手工配置 SSH 与 Mutagen 的用户使用；日常连接请使用上方同步助手。</p>
            <div className="mt-4"><LegacyRemoteWorkspaceManual /></div>
          </details>
        </> : null}
      </CardContent>
    </Card>
  )
}
