import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("renders codex-specific controls and can omit plan mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.5"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.5")
    expect(html).toContain("Extra High")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("hides the fast mode toggle for codex models without fast mode support", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.3-codex"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: false }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("GPT-5.3 Codex")
    expect(html).not.toContain("Fast Mode")
  })

  test("renders Ultra as a reasoning level for supported GPT-5.6 models", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.6-sol"
        modelOptions={{ reasoningEffort: "ultra", fastMode: false }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("GPT-5.6 Sol")
    expect(html).toContain("Ultra")
  })

  test("renders claude plan mode controls when enabled", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="opus"
        modelOptions={{ reasoningEffort: "max", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        mode="plan"
        onModeChange={() => {}}
        includeMode
      />
    )

    expect(html).toContain("Claude")
    expect(html).not.toContain("Claude Code")
    expect(html).toContain("Opus")
    expect(html).toContain("Max")
    expect(html).toContain("1M")
    expect(html).toContain("Plan Mode")
  })

  test("hideDefaults drops the context window and mode pills at 1M / Full Access", () => {
    const render = (contextWindow: "1m" | "200k", mode: "full-access" | "plan") => renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="opus"
        modelOptions={{ reasoningEffort: "high", contextWindow }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        mode={mode}
        onModeChange={() => {}}
        includeMode
        hideDefaults
      />
    )

    const atDefaults = render("1m", "full-access")
    expect(atDefaults).not.toContain("1M")
    expect(atDefaults).not.toContain("Full Access")

    // Off the default, the pill is back so the state is never invisible.
    const offDefaults = render("200k", "plan")
    expect(offDefaults).toContain("200k")
    expect(offDefaults).toContain("Plan Mode")
  })

  test("renders Fable as a Claude model option", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="fable"
        modelOptions={{ reasoningEffort: "high", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("Fable")
    expect(html).toContain("High")
  })
})
