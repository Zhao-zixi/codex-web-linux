import { useCallback, useEffect, useState } from "react"
import { KeyRound, LogOut, Plus, RefreshCw, Shield, Users } from "lucide-react"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { useAppDialog } from "../components/ui/app-dialog"
import { kannaFetch } from "./auth-client"
import { clearGatewayUserLocalState } from "./gateway-user-state"
import type { AdminGatewayStateResponse, AdminProviderAuthStatus, GatewayUserSummary, ManagedConnectionSummary } from "../../shared/gateway-api"

type UserRow = GatewayUserSummary
type Connection = ManagedConnectionSummary
type ProviderAuth = AdminProviderAuthStatus
type State = AdminGatewayStateResponse

export function AdminPage() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [provider, setProvider] = useState<"codex" | "claude">("codex")
  const [apiKey, setApiKey] = useState("")
  const [adminPassword, setAdminPassword] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const response = await kannaFetch("/api/admin/state", { cache: "no-store" })
    if (!response.ok) throw new Error("无法读取管理数据，请重新登录后重试。")
    setState(await response.json() as State)
  }, [])
  useEffect(() => { void refresh().catch((e) => setError(e.message)) }, [refresh])
  useEffect(() => {
    if (!state?.providerAuth.some((auth) => auth.flow && !["idle", "error"].includes(auth.flow.phase))) return
    const timer = window.setInterval(() => { void refresh().catch(() => undefined) }, 1500)
    return () => window.clearInterval(timer)
  }, [state, refresh])

  async function request(url: string, method = "POST", body?: unknown): Promise<boolean> {
    setBusy(true); setError("")
    try {
      const response = await kannaFetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "操作失败，请重试。")
      await refresh().catch(() => undefined)
      return true
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }

  async function addConnection(event: React.FormEvent) {
    event.preventDefault()
    if (await request("/api/admin/connections", "POST", { name, provider, apiKey })) { setName(""); setApiKey("") }
  }

  async function signOut() {
    await kannaFetch("/auth/logout", { method: "POST" }).catch(() => undefined)
    await clearGatewayUserLocalState({ clearAuth: true })
    window.location.assign("/")
  }

  async function changeAdminPassword(event: React.FormEvent) {
    event.preventDefault()
    const admin = state?.users.find((user) => user.role === "admin")
    if (!admin || adminPassword.length < 12 || busy) return
    setBusy(true)
    setError("")
    try {
      const response = await kannaFetch(`/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      })
      if (!response.ok) {
        throw new Error((await response.json().catch(() => null))?.error ?? "密码修改失败，请重试。")
      }
      setAdminPassword("")
      await clearGatewayUserLocalState({ clearAuth: true })
      window.location.assign("/")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return <main className="min-h-[100dvh] bg-background px-5 py-8 md:px-10">
    <div className="mx-auto max-w-6xl space-y-7">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm font-medium text-primary">Kanna · 管理后台</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">连接与用户</h1><p className="mt-2 text-sm text-muted-foreground">管理用户访问权限和可分配的官方 API 连接。</p></div>
        <Button variant="outline" onClick={() => void signOut()}><LogOut className="mr-2 h-4 w-4"/>退出登录</Button>
      </header>
      {error && <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">{error}</div>}
      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-3xl border border-border shadow-sm"><CardHeader><CardTitle className="flex items-center gap-2 text-xl"><Users className="h-5 w-5"/>用户</CardTitle><CardDescription>为每位用户分配可用连接，停用后该账号无法登录。</CardDescription></CardHeader><CardContent className="space-y-3">
          {state?.users.map((user) => <UserControl key={user.id} user={user} connections={state.connections} busy={busy} onChange={(url, method, body) => void request(url, method, body)}/>)}
          {!state && <p className="text-sm text-muted-foreground">正在读取…</p>}
        </CardContent></Card>
        <Card className="rounded-3xl border border-border shadow-sm"><CardHeader><CardTitle className="flex items-center gap-2 text-xl"><KeyRound className="h-5 w-5"/>可分配 API 连接</CardTitle><CardDescription>API key 仅在保存时提交，之后不会再次显示。官方个人订阅登录不属于共享连接。</CardDescription></CardHeader><CardContent className="space-y-4">
          <form onSubmit={(e) => void addConnection(e)} className="grid gap-3 sm:grid-cols-2">
            <Input aria-label="连接名称" placeholder="连接名称" value={name} onChange={(e) => setName(e.target.value)} required />
            <select aria-label="服务商" className="h-10 rounded-xl border border-input bg-background px-3 text-sm" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}><option value="codex">OpenAI API</option><option value="claude">Anthropic API</option></select>
            <Input aria-label="API key" type="password" autoComplete="new-password" placeholder="API key / 组织凭据" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required className="sm:col-span-2" />
            <Button disabled={busy || !name || !apiKey} className="sm:col-span-2"><Plus className="mr-2 h-4 w-4"/>添加连接</Button>
          </form>
          <div className="space-y-2">{state?.connections.map((connection) => <ConnectionControl key={connection.id} connection={connection} busy={busy} onChange={(url, method, body) => void request(url, method, body)}/>)}</div>
        </CardContent></Card>
      </section>
      <Card className="rounded-3xl border border-border shadow-sm"><CardHeader><CardTitle className="flex items-center gap-2 text-xl"><Shield className="h-5 w-5"/>管理员本人登录</CardTitle><CardDescription>这里是本机 Codex / Claude CLI 官方授权，仅供管理员本人使用，不能分配给其他用户。</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">{state?.providerAuth.map((auth) => <ProviderControl key={auth.id} auth={auth} busy={busy} onAction={(action, body) => void request(`/api/admin/provider-auth/${auth.id}/${action}`, "POST", body)}/>)}</CardContent></Card>
      <Card className="rounded-3xl border border-border shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">管理员密码</CardTitle>
          <CardDescription>修改后当前登录会立即失效，需要使用新密码重新登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => void changeAdminPassword(event)}>
            <Input
              aria-label="新的管理员密码"
              type="password"
              autoComplete="new-password"
              placeholder="新密码至少 12 位"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
            />
            <Button type="submit" disabled={busy || adminPassword.length < 12}>修改密码并退出</Button>
          </form>
        </CardContent>
      </Card>
      <div className="flex justify-end"><Button variant="ghost" onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4"/>刷新状态</Button></div>
    </div>
  </main>
}

function UserControl({ user, connections, busy, onChange }: { user: UserRow; connections: Connection[]; busy: boolean; onChange: (url: string, method?: string, body?: unknown) => void }) {
  const [password, setPassword] = useState("")
  const [selectedIds, setSelectedIds] = useState(user.connectionIds)
  useEffect(() => setSelectedIds(user.connectionIds), [user.id, user.connectionIds])
  const selected = new Set(selectedIds)
  function toggle(id: string) {
    setSelectedIds(selected.has(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])
  }
  return <div className="rounded-2xl border border-border p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-medium">{user.username} <span className="text-xs text-muted-foreground">{user.role === "admin" ? "管理员" : "用户"}</span></p></div><Button size="sm" variant="outline" disabled={busy || user.role === "admin"} onClick={() => onChange(`/api/admin/users/${user.id}`, "PATCH", { enabled: !user.enabled })}>{user.enabled ? "停用" : "启用"}</Button></div>
    <div className="mt-3 space-y-2">{connections.map((connection) => <label key={connection.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.has(connection.id)} onChange={() => toggle(connection.id)} disabled={busy || user.role === "admin"}/>{connection.name}</label>)}</div>
    {user.role !== "admin" && <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" disabled={busy || selectedIds.length === user.connectionIds.length && selectedIds.every((id) => user.connectionIds.includes(id))} onClick={() => onChange(`/api/admin/users/${user.id}/grants`, "PUT", { connectionIds: selectedIds })}>保存分配</Button></div>}
    {user.role !== "admin" && <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (password) { onChange(`/api/admin/users/${user.id}`, "PATCH", { password }); setPassword("") } }}><Input aria-label={`${user.username} 新密码`} type="password" autoComplete="new-password" placeholder="新密码至少 12 位" value={password} onChange={(e) => setPassword(e.target.value)}/><Button size="sm" variant="outline" disabled={busy || password.length < 12}>重置</Button></form>}
  </div>
}

function ConnectionControl({ connection, busy, onChange }: { connection: Connection; busy: boolean; onChange: (url: string, method?: string, body?: unknown) => void }) {
  const dialog = useAppDialog()
  const [rotating, setRotating] = useState(false)
  const [apiKey, setApiKey] = useState("")
  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{connection.name}</p>
          <p className="text-xs text-muted-foreground">
            {connection.provider === "codex" ? "OpenAI API" : "Anthropic API"} · {connection.enabled ? "可用" : "已停用"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setRotating((value) => !value); setApiKey("") }}>
            {rotating ? "取消轮换" : "轮换密钥"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onChange(`/api/admin/connections/${connection.id}`, "PATCH", { enabled: !connection.enabled })}>
            {connection.enabled ? "停用" : "启用"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const confirmed = await dialog.confirm({
                title: "删除 API 连接？",
                description: `删除“${connection.name}”后会撤销所有用户的分配。`,
                confirmLabel: "删除连接",
                confirmVariant: "destructive",
              })
              if (confirmed) onChange(`/api/admin/connections/${connection.id}`, "DELETE")
            }}
          >删除</Button>
        </div>
      </div>
      {rotating && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (apiKey.length > 0) {
              onChange(`/api/admin/connections/${connection.id}`, "PATCH", { apiKey })
              setApiKey("")
              setRotating(false)
            }
          }}
        >
          <Input aria-label={`${connection.name} 新 API key`} type="password" autoComplete="new-password" placeholder="输入新的 API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <Button size="sm" disabled={busy || !apiKey}>保存新密钥</Button>
        </form>
      )}
    </div>
  )
}

function ProviderControl({ auth, busy, onAction }: { auth: ProviderAuth; busy: boolean; onAction: (action: string, body?: unknown) => void }) {
  const [code, setCode] = useState("")
  const phase = auth.flow?.phase
  return <div className="rounded-2xl border border-border p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{auth.id === "codex" ? "Codex" : "Claude Code"}</p><p className="mt-1 text-xs text-muted-foreground">{auth.installed ? `CLI 已安装 · ${auth.authStatus}` : "CLI 尚未安装"} · 管理员本人</p></div><span className="rounded-full bg-muted px-2.5 py-1 text-xs">不可分配</span></div>
    {phase === "waiting_for_approval" && <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm">{auth.flow?.verificationUrl && <a className="text-primary underline" href={auth.flow.verificationUrl} target="_blank" rel="noreferrer">打开官方授权页面</a>}{auth.flow?.userCode && <p className="mt-1 font-mono text-base">{auth.flow.userCode}</p>}</div>}
    {phase === "waiting_for_code_entry" && <div className="mt-3 space-y-2 rounded-xl bg-muted/60 p-3">{auth.flow.verificationUrl && <a className="text-sm text-primary underline" href={auth.flow.verificationUrl} target="_blank" rel="noreferrer">打开官方授权页面</a>}<form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onAction("submit", { code }); setCode("") }}><Input aria-label="授权回调码" placeholder="粘贴授权码" value={code} onChange={(e) => setCode(e.target.value)}/><Button size="sm" disabled={busy || !code}>提交</Button></form></div>}
    {auth.flow?.phase === "error" && <p className="mt-2 text-sm text-destructive">{auth.flow.message}</p>}
    <div className="mt-3 flex flex-wrap gap-2">{!auth.installed ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("install")}>安装 CLI</Button> : <><Button size="sm" disabled={busy || phase === "starting" || phase === "finishing"} onClick={() => onAction("start")}>{phase && phase !== "idle" && phase !== "error" ? "授权进行中" : "开始官方授权"}</Button><Button size="sm" variant="outline" disabled={busy || !phase || phase === "idle"} onClick={() => onAction("cancel")}>取消</Button><Button size="sm" variant="outline" disabled={busy || auth.authStatus !== "signed_in"} onClick={() => onAction("logout")}>退出授权</Button></>}</div>
  </div>
}
