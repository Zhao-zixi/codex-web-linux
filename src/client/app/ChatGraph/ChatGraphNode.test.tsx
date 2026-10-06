import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow, SidebarData } from "../../../shared/types"
import type { ChatReferenceActions } from "../../components/chat-ui/chat-reference"
import { TooltipProvider } from "../../components/ui/tooltip"
import { flattenSidebarThreads } from "../../lib/thread-sections"
import {
  CHAT_GRAPH_NODE_INTERACTION,
  ChatGraphHostContext,
  ChatGraphNodeCard,
  type ChatGraphHost,
  type ChatGraphNodeData,
} from "./ChatGraphNode"

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: `Chat ${chatId}`,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function threadOf(chat: SidebarChatRow) {
  const data: SidebarData = {
    projectGroups: [{
      groupKey: "project",
      title: "project",
      realTitle: "project",
      localPath: "/tmp/project",
      chats: [chat],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }],
  }
  return flattenSidebarThreads(data)[0]!
}

const noop = () => {}
const ACTIONS: ChatReferenceActions = {
  editorLabel: "Editor",
  menu: {
    onCreateChat: noop,
    onRenameChat: noop,
    onShareChat: noop,
    onCopyPath: noop,
    onOpenExternalPath: noop,
    onForkChat: noop,
    onArchiveChat: noop,
    onRestoreChat: noop,
    onDeleteChat: noop,
  },
  card: {
    onSelectChat: noop,
    onSelectMessage: noop,
    onOpenArchivedChat: noop,
    onSetupGit: noop,
    onOpenExternalPath: noop,
  },
  onOpenChat: noop,
  onOpenChatInTab: noop,
}

const HOST: ChatGraphHost = { openChat: noop, currentChatId: null }
const PLAIN: ChatGraphNodeData = { marked: false, entering: false }

function renderCard(chat: SidebarChatRow, host: ChatGraphHost = HOST, data: ChatGraphNodeData = PLAIN) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ChatGraphHostContext.Provider value={host}>
        <ChatGraphNodeCard thread={threadOf(chat)} actions={ACTIONS} data={data} />
      </ChatGraphHostContext.Provider>
    </TooltipProvider>,
  )
}

/** The opening tag of the card itself. */
function cardTag(html: string) {
  const at = html.indexOf("data-chat-graph-node=")
  expect(at).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1)
}

describe("ChatGraphNodeCard", () => {
  const KID = row("kid", { parentChatId: "root", status: "waiting_on_subagent" })

  test("takes pointer events for itself, because React Flow gives its node none", () => {
    // What the canvas tells React Flow about its nodes. Under these, and with
    // no click handler of React Flow's own, React Flow sets
    // `pointer-events: none` on the element around every node, which
    // everything in the node inherits. Shipped without the class below, no
    // node could be clicked, hovered or right-clicked.
    expect(CHAT_GRAPH_NODE_INTERACTION).toEqual({ nodesDraggable: false, elementsSelectable: false })
    expect(cardTag(renderCard(KID)).split(/[\s"]/)).toContain("pointer-events-auto")
  })

  test("is the sidebar's row over the sidebar's card", () => {
    const html = renderCard(KID)
    // The row, by the marker the sidebar's own rows carry.
    expect(html).toContain('data-chat-id="kid"')
    expect(html).toContain("Chat kid")
    // The card's harness line.
    expect(html).toContain("Claude")
  })

  test("says each status in a word", () => {
    expect(renderCard(row("a", { status: "starting" }))).toContain(">Starting<")
    expect(renderCard(row("a", { status: "running" }))).toContain(">Running<")
    expect(renderCard(KID)).toContain(">Waiting<")
    expect(renderCard(row("a", { status: "waiting_for_user" }))).toContain(">Needs you<")
    expect(renderCard(row("a", { status: "failed" }))).toContain(">Failed<")
    expect(renderCard(row("a", { unread: true }))).toContain(">Unread<")
  })

  test("the chat open beside the graph does not offer to open", () => {
    expect(cardTag(renderCard(KID, { ...HOST, currentChatId: "kid" }))).toContain("cursor-default")
    expect(cardTag(renderCard(KID))).toContain("cursor-pointer")
  })

  test("rings the chat the reader came for", () => {
    expect(cardTag(renderCard(KID, HOST, { marked: true, entering: false }))).toContain("ring-2")
    expect(cardTag(renderCard(KID))).not.toContain("ring-2")
  })

  test("only a chat that arrived after the graph was drawn gets an entrance", () => {
    expect(cardTag(renderCard(KID, HOST, { marked: false, entering: true }))).toContain("chat-graph-node-enter")
    expect(cardTag(renderCard(KID))).not.toContain("chat-graph-node-enter")
  })
})
