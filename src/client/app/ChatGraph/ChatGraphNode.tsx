import { createContext, memo, useCallback, useContext, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"
import { useChatReferenceActions, useSidebarThread, type ChatReferenceActions } from "../../components/chat-ui/chat-reference"
import { SidebarChatCard, type SidebarChatCardActions } from "../../components/chat-ui/sidebar/ChatHoverCard"
import { ThreadRowBody, ThreadRowMenu } from "../../components/chat-ui/sidebar/ThreadRow"
import { describeChatGraphStatus, type ChatGraphTone } from "../../lib/chat-graph"
import type { ChatJumpRole } from "../../lib/chat-navigation"
import type { SidebarThread } from "../../lib/thread-sections"
import { cn } from "../../lib/utils"


/** Every node is this wide: the hover card's width, since a node is that card with a row on top. */
export const CHAT_GRAPH_NODE_WIDTH = 320
/**
 * How far down a node its edges meet it: the middle of its title row. A fixed
 * distance from the top and not the middle of the card, so an edge stays on
 * the title as the card under it grows and shrinks with what the chat says.
 */
export const CHAT_GRAPH_HANDLE_TOP = 26

/**
 * How far along a node's foot its children's edges leave it, in an outline:
 * half the indent, so the trunk runs down the middle of the gutter the
 * children are set in by.
 */
export const CHAT_GRAPH_OUTLINE_STEM_LEFT = 16

/**
 * What the canvas tells React Flow its nodes are not: draggable (the layout
 * places them) or selectable (a click opens a chat; nothing is "selected").
 *
 * Kept beside the node because the node pays for it. With both off and no
 * click handler of React Flow's own, React Flow sets `pointer-events: none`
 * on every node, and the card has to turn them back on for itself (see its
 * `pointer-events-auto`). The test beside this file renders a node under
 * exactly these and checks that it does.
 */
export const CHAT_GRAPH_NODE_INTERACTION = { nodesDraggable: false, elementsSelectable: false } as const

/** The two places an edge can leave a node from; see `ChatGraphDirection`. */
export const CHAT_GRAPH_SOURCE_HANDLE = { columns: "side", outline: "foot" } as const

export interface ChatGraphNodeData extends Record<string, unknown> {
  /**
   * Ringed, as the one to find: on the graph's page, the chat the URL named
   * when the graph shown is its root's; in the pane, the chat in the main
   * view.
   */
  marked: boolean
  /** Arrived after the graph was first drawn, so it gets an entrance. */
  entering: boolean
}

/**
 * What the place a graph is shown in decides for its nodes. The canvas, the
 * node and the layout are the same on the graph's own page and in the
 * previewer's pane; this is where the two differ.
 */
export interface ChatGraphHost {
  /**
   * Opens a chat from its node. Every click on a node that opens its chat
   * comes through here: the row, the card around it, the prompt, the reply
   * and the draft. `jump` lands on one end of the chat's last exchange.
   */
  openChat: (chatId: string, jump?: ChatJumpRole) => void
  /**
   * The chat already open beside the graph, if the graph is beside one. Its
   * node is drawn as the sidebar draws the open chat's row, and selecting it
   * opens nothing: it is right there.
   */
  currentChatId: string | null
}

export const ChatGraphHostContext = createContext<ChatGraphHost | null>(null)

export type ChatGraphFlowNode = Node<ChatGraphNodeData, "chat">

/** The slow clock the age labels read, one for the whole canvas. */
export const ChatGraphNowContext = createContext(0)

const TONE_LABEL_CLASS: Record<ChatGraphTone, string | undefined> = {
  working: undefined,
  waiting: undefined,
  // The colours the status glyphs already use for the same two things.
  "needs-user": "text-blue-500 dark:text-blue-400",
  unread: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  idle: undefined,
}

/**
 * The card's edge says the two things worth seeing from across the canvas:
 * this chat is waiting on you, and this chat failed. Working chats are left
 * plain. Their spinner says it, and most of a live graph is working: an edge
 * on every one of them would mark nothing.
 */
const TONE_BORDER_CLASS: Record<ChatGraphTone, string> = {
  working: "border-border",
  waiting: "border-border",
  "needs-user": "border-blue-400/70",
  unread: "border-border",
  failed: "border-destructive/60",
  idle: "border-border",
}

const noop = () => {}

/**
 * One chat in the graph: its sidebar row, and under it what the row's hover
 * card says, as one card.
 *
 * Both halves are the sidebar's own components (`ThreadRowBody`,
 * `SidebarChatCard`), under the sidebar's own right-click menu
 * (`ThreadRowMenu`). So a node shows a chat's status, draft, branch, last
 * exchange and changed files exactly as the sidebar does, and stays that way
 * when the sidebar's change.
 *
 * Apart from the React Flow node below so it can be drawn, and tested, with
 * no canvas around it. `handles` is where the node puts React Flow's.
 */
export function ChatGraphNodeCard({ thread, actions, data, handles }: {
  thread: SidebarThread
  actions: ChatReferenceActions
  data: ChatGraphNodeData
  handles?: ReactNode
}) {
  const id = thread.chatId
  const nowMs = useContext(ChatGraphNowContext)
  const host = useContext(ChatGraphHostContext)
  const current = host?.currentChatId === id
  const open = useCallback((jump?: ChatJumpRole) => {
    if (!current) host?.openChat(id, jump)
  }, [current, host, id])
  const handleSelect = useCallback(() => open(), [open])
  // The card under the row takes the sidebar card's actions, with its ways
  // into the chat sent the way every other click on the node goes.
  const cardActions = useMemo<SidebarChatCardActions>(() => ({
    ...actions.card,
    onSelectChat: () => open(),
    onOpenArchivedChat: () => open(),
    onSelectMessage: (_chatId, role) => open(role),
  }), [actions.card, open])

  // The card is one target for its chat, with smaller targets inside it (the
  // row, the two messages, the repo, each file). Those answer for themselves.
  const handleCardClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, a, [data-chat-id]")) return
    open()
  }, [open])
  // Middle-click is "in a tab", as on a link. It is not a click, so it needs
  // its own way in; what it does is the host's to say, like any open.
  const handleCardAuxClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) open()
  }, [open])

  const status = describeChatGraphStatus(thread.row)

  return (
    <ThreadRowMenu thread={thread} archived={thread.archived} editorLabel={actions.editorLabel} {...actions.menu}>
      <div
        data-chat-graph-node={id}
        data-status={thread.row.status}
        onClick={handleCardClick}
        onAuxClick={handleCardAuxClick}
        style={{ width: CHAT_GRAPH_NODE_WIDTH, "--chat-graph-handle-top": `${CHAT_GRAPH_HANDLE_TOP}px` } as CSSProperties}
        className={cn(
          // Solid, where the hover card it borrows from is glass: there can be
          // dozens of these on screen at once, moving, and a blur behind each
          // is paid for on every frame of a pan.
          //
          // `pointer-events-auto` is what makes a node clickable at all.
          // React Flow turns pointer events off on a node that can be neither
          // dragged nor selected and has no click handler of React Flow's
          // own, and these are that (`CHAT_GRAPH_NODE_INTERACTION`): the
          // layout places them, and their clicks are the card's. Off on the
          // wrapper means off for everything in it, hover and right-click
          // included, unless the card says otherwise. It does, here, and not
          // by handing React Flow a handler it has no use for.
          "pointer-events-auto relative rounded-xl border bg-popover p-1.5 text-xs text-popover-foreground shadow-sm",
          current ? "cursor-default" : "cursor-pointer",
          // For a status changing under the reader. The card has no hover of
          // its own: the row and the messages inside it each have theirs.
          "transition-[border-color] duration-200",
          TONE_BORDER_CLASS[status.tone],
          data.marked && "ring-2 ring-foreground/25",
          thread.archived && "opacity-60",
          data.entering && "chat-graph-node-enter",
        )}
      >
        {handles}
        <ThreadRowBody
          thread={thread}
          // As the sidebar draws the row of the chat that is open.
          isActive={current}
          archived={thread.archived}
          // A graph is one conversation's chats, so the slot holds the age, as
          // it does down a project's list; the card below names the branch.
          detailScope="project-scoped"
          nowMs={nowMs}
          // While a chat is in a state, the state is the detail. Its age comes
          // back when it is at rest and read.
          detailLabelOverride={status.label
            ? <span className={TONE_LABEL_CLASS[status.tone]}>{status.label}</span>
            : undefined}
          // Lines its glyph up with the card's text below, which sits 12px in.
          className="px-1.5"
          onSelect={handleSelect}
          onForkChat={actions.menu.onForkChat}
          onArchiveChat={actions.menu.onArchiveChat}
          onRestoreChat={actions.menu.onRestoreChat}
        />
        <div className="pt-1 pb-0.5">
          <SidebarChatCard thread={thread} dismiss={noop} {...cardActions} />
        </div>
      </div>
    </ThreadRowMenu>
  )
}

/** A chat's card as a node of the canvas: found in the sidebar's snapshot, with React Flow's handles on it. */
function ChatGraphNodeImpl({ id, data }: NodeProps<ChatGraphFlowNode>) {
  const thread = useSidebarThread(id)
  const actions = useChatReferenceActions()

  // One way in, at the title row. Two ways out, since the tree can grow
  // either way (`ChatGraphDirection`); an edge names the one it leaves by.
  const handles = (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ top: CHAT_GRAPH_HANDLE_TOP }} />
      <Handle id={CHAT_GRAPH_SOURCE_HANDLE.columns} type="source" position={Position.Right} isConnectable={false} style={{ top: CHAT_GRAPH_HANDLE_TOP }} />
      <Handle id={CHAT_GRAPH_SOURCE_HANDLE.outline} type="source" position={Position.Bottom} isConnectable={false} style={{ left: CHAT_GRAPH_OUTLINE_STEM_LEFT }} />
    </>
  )

  // Between the push that drops a chat and the one that redraws the tree
  // without it. The node keeps its place, so nothing below it moves twice.
  if (!thread || !actions) {
    return <div className="relative h-10" style={{ width: CHAT_GRAPH_NODE_WIDTH }}>{handles}</div>
  }
  return <ChatGraphNodeCard thread={thread} actions={actions} data={data} handles={handles} />
}

/**
 * Memoized on the chat and its flags alone. React Flow hands a node its
 * position too, and a node on its way to a new place gets a new one every
 * frame; the card does not draw it.
 */
export const ChatGraphNode = memo(ChatGraphNodeImpl, (previous, next) => (
  previous.id === next.id && previous.data === next.data
))
