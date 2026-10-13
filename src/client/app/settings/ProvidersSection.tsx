import { useEffect, useState } from "react"
import { History, Loader2, LogOut } from "lucide-react"
import {
  chatModeFromFlags,
  chatModeToFlags,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  PROVIDERS,
  type AgentProvider,
  type ChatMode,
  type GrokReasoningEffort,
  type LlmProviderKind,
} from "../../../shared/types"
import { AuthCard } from "../../components/auth/AuthCard"
import { ChatPreferenceControls } from "../../components/chat-ui/ChatPreferenceControls"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { PROVIDER_ICONS } from "../../components/provider-icons"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SelectItem } from "../../components/ui/select"
import { applyModelToComposerState } from "../../lib/composer"
import { cn } from "../../lib/utils"
import { kannaFetch } from "../auth-client"
import { clearGatewayUserLocalState } from "../gateway-user-state"
import { useChatPreferencesStore, type ComposerState } from "../../stores/chatPreferencesStore"
import { useProviderAuthStore } from "../../stores/providerAuthStore"
import type { KannaState } from "../useKannaState"
import {
  handleSettingsInputKeyDown,
  SETTINGS_CONTROL_CLASS,
  SettingsActionButton,
  SettingsErrorBanner,
  SettingsGroup,
  SettingsGroups,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
} from "./shared"
import { SETTINGS_ROWS } from "./registry"

function ProviderLogo({ provider }: { provider: AgentProvider }) {
  const Icon = PROVIDER_ICONS[provider]
  return <Icon className="h-4 w-4 shrink-0" />
}

function ManagedConnectionsSection() {
  const [connections, setConnections] = useState<Array<{ id: string; name: string; provider: "codex" | "claude"; enabled: boolean }>>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    let active = true
    void kannaFetch("/api/provider-access", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Unable to load managed provider access")
      const payload = await response.json() as { assigned?: typeof connections }
      if (active) setConnections(Array.isArray(payload.assigned) ? payload.assigned : [])
    }).catch(() => {
      if (active) setLoadError(true)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  async function signOut() {
    await kannaFetch("/auth/logout", { method: "POST" }).catch(() => undefined)
    await clearGatewayUserLocalState({ clearAuth: true })
    window.location.assign("/")
  }
  return <SettingsGroup title="管理员分配的连接">
    {loading ? <div className="px-4 py-3 text-sm text-muted-foreground">正在读取可用连接…</div> : loadError ? <div role="status" className="px-4 py-3 text-sm text-muted-foreground">暂时无法读取管理员分配的连接，请稍后重试。</div> : connections.length ? <>
      {connections.map((connection) => <SettingsRow key={connection.id} title={connection.name} description={connection.provider === "codex" ? "OpenAI API · 管理员提供" : "Anthropic API · 管理员提供"}>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{connection.enabled ? "可用" : "已停用"}</span>
      </SettingsRow>)}
      <SettingsNotice tone="warning" className="mx-4 mb-4">本人配置的凭据始终优先使用。如果本人凭据失效，Kanna 不会自动改用管理员连接；请先修复或移除本人凭据。</SettingsNotice>
    </> : <div className="px-4 py-3 text-sm text-muted-foreground">目前没有分配给此账号的共享 API 连接。</div>}
    <div className="flex justify-end border-t border-border px-4 py-3">
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        <LogOut className="mr-2 h-4 w-4" />退出登录
      </Button>
    </div>
  </SettingsGroup>
}

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
]

export function ProvidersSection({
  state,
}: {
  state: Pick<
    KannaState,
    | "socket"
    | "availableProviders"
    | "llmProvider"
    | "handleReadLlmProvider"
    | "handleWriteLlmProvider"
    | "handleValidateLlmProvider"
    | "handleWriteFaveModels"
    | "handleWriteAppSettings"
  >
}) {
  const llmProvider = state.llmProvider
  const handleReadLlmProvider = state.handleReadLlmProvider
  const handleWriteLlmProvider = state.handleWriteLlmProvider
  const handleValidateLlmProvider = state.handleValidateLlmProvider
  const handleWriteAppSettings = state.handleWriteAppSettings

  const providerAuthSnapshot = useProviderAuthStore((store) => store.snapshot)
  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultMode = useChatPreferencesStore((store) => store.setProviderDefaultMode)

  const [providersError, setProvidersError] = useState<string | null>(null)
  const [llmProviderDraft, setLlmProviderDraft] = useState({
    provider: "openai" as LlmProviderKind,
    apiKey: "",
    model: "",
    baseUrl: "",
  })
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null)
  const [llmValidationStatus, setLlmValidationStatus] = useState<"idle" | "valid" | "invalid">("idle")
  const [llmValidationError, setLlmValidationError] = useState<unknown | null>(null)
  const [llmValidationDialogOpen, setLlmValidationDialogOpen] = useState(false)
  const [defaultModelsDialogOpen, setDefaultModelsDialogOpen] = useState(false)

  // The section only mounts while its tab is selected and the socket is
  // connected, so a plain mount effect matches the old page-gated read.
  useEffect(() => {
    void handleReadLlmProvider()
  }, [handleReadLlmProvider])

  useEffect(() => {
    if (!llmProvider) return
    setLlmProviderDraft({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
    })
  }, [llmProvider])

  useEffect(() => {
    setLlmValidationStatus("idle")
    setLlmValidationError(null)
  }, [llmProviderDraft.provider, llmProviderDraft.apiKey, llmProviderDraft.model, llmProviderDraft.baseUrl])

  function handleDefaultProviderChange(nextValue: "last_used" | AgentProvider) {
    setDefaultProvider(nextValue)
    void handleWriteAppSettings({ defaultProvider: nextValue }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelChange(provider: AgentProvider, model: string) {
    // The step the chat composer takes when a model is picked: options that
    // depend on the model are checked against the live catalog entry, so a
    // Codex effort the new model does not offer moves to one it does. The
    // store's own normalizer knows only the static list, which has no row for
    // a model the account gained at runtime.
    const next = applyModelToComposerState(
      { provider, ...providerDefaults[provider] } as ComposerState,
      model,
      state.availableProviders.find((entry) => entry.id === provider),
    )
    setProviderDefaultModel(provider, next.model)
    setProviderDefaultModelOptions(provider, next.modelOptions)
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { model: next.model, modelOptions: next.modelOptions } },
    }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelOptionsChange(
    provider: AgentProvider,
    modelOptions: Partial<typeof providerDefaults[typeof provider]["modelOptions"]>
  ) {
    setProviderDefaultModelOptions(provider, modelOptions)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { modelOptions } } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModeChange(provider: AgentProvider, mode: ChatMode) {
    setProviderDefaultMode(provider, mode)
    const flags = chatModeToFlags(mode, providerDefaults[provider].autoPlan)
    void handleWriteAppSettings({ providerDefaults: { [provider]: flags } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  async function commitLlmProvider(nextValue = llmProviderDraft) {
    try {
      setLlmProviderError(null)
      await handleWriteLlmProvider(nextValue)
      const validation = await handleValidateLlmProvider(nextValue)
      setLlmValidationStatus(validation.ok ? "valid" : "invalid")
      setLlmValidationError(validation.error)
    } catch (error) {
      const fallbackError = error instanceof Error
        ? { name: error.name, message: error.message }
        : error
      setLlmValidationStatus("invalid")
      setLlmValidationError(fallbackError)
      setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
    }
  }

  function handleLlmProviderSelection(nextProvider: LlmProviderKind) {
    const nextDraft = {
      ...llmProviderDraft,
      provider: nextProvider,
      model: nextProvider === "openai"
        ? DEFAULT_OPENAI_SDK_MODEL
        : nextProvider === "openrouter"
          ? DEFAULT_OPENROUTER_SDK_MODEL
          : llmProviderDraft.model,
      baseUrl: nextProvider === "custom" ? llmProviderDraft.baseUrl : "",
    }
    setLlmProviderDraft(nextDraft)
    void commitLlmProvider(nextDraft)
  }

  const llmValidationErrorText = llmValidationError ? JSON.stringify(llmValidationError, null, 2) : ""
  // No subtitle, only the result of checking the credentials once there is one.
  const llmValidationDescription = llmValidationStatus === "valid" ? (
    <span className="font-medium text-emerald-600 dark:text-emerald-400">Credentials valid & saved</span>
  ) : llmValidationStatus === "invalid" ? (
    <span className="font-medium text-destructive">
      Credentials invalid.
      {llmValidationError ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() => setLlmValidationDialogOpen(true)}
            className="underline underline-offset-2 transition-colors hover:opacity-70"
          >
            See error
          </button>
        </>
      ) : null}
    </span>
  ) : null

  return (
    <>
      {providersError ? <SettingsErrorBanner message={providersError} /> : null}
      <SettingsGroups>
        <SettingsGroup title="Accounts">
          {providerAuthSnapshot ? (
            providerAuthSnapshot.services.map((service) => (
              // One surface for every account: each card drops its own
              // box and becomes a row of the group's card, with its actions
              // drawn as text like every other row's.
              <AuthCard
                key={service.service}
                row
                textActions
                service={service}
                socket={state.socket}
              />
            ))
          ) : (
            <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Checking provider sign-in status…
            </div>
          )}
        </SettingsGroup>
        <ManagedConnectionsSection />
        <SettingsGroup title="Defaults">
          <SettingsRow def={SETTINGS_ROWS.defaultProvider} description={null}>
            <SettingsSelect
              value={defaultProvider}
              onValueChange={(value) => handleDefaultProviderChange(value as "last_used" | AgentProvider)}
            >
              <SelectItem value="last_used">
                <span className="flex items-center gap-2">
                  <History className="h-4 w-4 shrink-0" />
                  Last Used
                </span>
              </SelectItem>
              {PROVIDERS.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  <span className="flex items-center gap-2">
                    <ProviderLogo provider={provider.id} />
                    {provider.label}
                  </span>
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.claudeDefaults} description={null} icon={<ProviderLogo provider="claude" />} wideControl>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="claude"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.claude.model}
              modelOptions={providerDefaults.claude.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("claude", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "claudeReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("claude", { reasoningEffort: change.effort })
                } else if (change.type === "contextWindow") {
                  handleProviderDefaultModelOptionsChange("claude", { contextWindow: change.contextWindow })
                } else if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("claude", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.claude.planMode, providerDefaults.claude.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("claude", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.codexDefaults} description={null} icon={<ProviderLogo provider="codex" />} wideControl>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="codex"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.codex.model}
              modelOptions={providerDefaults.codex.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("codex", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "codexReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("codex", { reasoningEffort: change.effort })
                } else if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("codex", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.codex.planMode, providerDefaults.codex.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("codex", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.cursorDefaults} description={null} icon={<ProviderLogo provider="cursor" />} wideControl>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="cursor"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.cursor.model}
              modelOptions={providerDefaults.cursor.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("cursor", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("cursor", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.cursor.planMode, providerDefaults.cursor.autoPlan)}
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.grokDefaults} description={null} icon={<ProviderLogo provider="grok" />} wideControl>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="grok"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.grok.model}
              modelOptions={providerDefaults.grok.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("grok", model)
              }}
              onModelOptionChange={(change) => {
                // Grok's effort picker reports through the codex change type
                // (see reasoningChangeFor in ChatPreferenceControls).
                if (change.type === "codexReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("grok", {
                    reasoningEffort: change.effort as GrokReasoningEffort,
                  })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.grok.planMode, providerDefaults.grok.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("grok", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.piDefaults} description={null} icon={<ProviderLogo provider="pi" />} wideControl>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="pi"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.pi.model}
              modelOptions={providerDefaults.pi.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("pi", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "piReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("pi", { reasoningEffort: change.effort })
                }
              }}
              onEditModels={() => setDefaultModelsDialogOpen(true)}
              mode={chatModeFromFlags(providerDefaults.pi.planMode, providerDefaults.pi.autoPlan)}
              className="justify-start flex-wrap"
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Model Registry">
          {llmProviderError || llmProvider?.warning ? (
            <div className="space-y-3 p-4">
              {llmProviderError ? <SettingsNotice>{llmProviderError}</SettingsNotice> : null}
              {llmProvider?.warning ? <SettingsNotice tone="warning">{llmProvider.warning}</SettingsNotice> : null}
            </div>
          ) : null}
          {/* Provider, endpoint, key and model each get a titled row, as in
              iOS Settings: with no field frames, a stack of bare inputs in
              one row left nothing to say which was which once filled. */}
          <SettingsRow def={SETTINGS_ROWS.modelRegistry} description={llmValidationDescription}>
            <SettingsSelect
              value={llmProviderDraft.provider}
              onValueChange={(value) => handleLlmProviderSelection(value as LlmProviderKind)}
            >
              {QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
          {llmProviderDraft.provider === "custom" ? (
            <SettingsRow nested wideControl title="Base URL">
              <Input
                value={llmProviderDraft.baseUrl}
                onChange={(event) => setLlmProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                onBlur={() => void commitLlmProvider()}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                placeholder="https://your-provider.example/v1"
                spellCheck={false}
                autoComplete="off"
                className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow nested wideControl title="API Key">
            <Input
              type="password"
              value={llmProviderDraft.apiKey}
              onChange={(event) => setLlmProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
              onBlur={() => void commitLlmProvider()}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
              placeholder="Required"
              autoComplete="off"
              className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
            />
          </SettingsRow>
          <SettingsRow
            nested
            wideControl
            title="Quick Response Model"
          >
            <Input
              value={llmProviderDraft.model}
              onChange={(event) => setLlmProviderDraft((current) => ({ ...current, model: event.target.value }))}
              onBlur={() => void commitLlmProvider()}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
              placeholder="Model id"
              spellCheck={false}
              autoComplete="off"
              className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
            />
          </SettingsRow>

          <SettingsRow
            def={SETTINGS_ROWS.defaultModels}
            description={null}
          >
            <SettingsActionButton onClick={() => setDefaultModelsDialogOpen(true)}>
              Edit models
            </SettingsActionButton>
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
      <Dialog open={llmValidationDialogOpen} onOpenChange={setLlmValidationDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Validation Error</DialogTitle>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {llmValidationErrorText}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setLlmValidationDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DefaultModelsDialog
        open={defaultModelsDialogOpen}
        onOpenChange={setDefaultModelsDialogOpen}
        faveModels={llmProvider?.faveModels ?? []}
        onSave={(faveModels) => {
          void state.handleWriteFaveModels(faveModels).catch((error) => {
            setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
          })
        }}
      />
    </>
  )
}
