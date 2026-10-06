import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ListHoverCard } from "../../ui/list-hover-card"
import { TURN_CARD_ROW_INSET, TurnCardMessage, TurnCardMetaRow, TurnCardTimingRow } from "../../ui/turn-card"
import { GitBranch, PencilLine } from "lucide-react"
import { getRepoUrlLabel } from "../../../../shared/git-url"
import { PROVIDERS, type ChatPreview, type ChatTouchedFilesResult, type SidebarChatRow } from "../../../../shared/types"
import { resolveDiffFilePath } from "../../../app/ChatPage/utils"
import { DiffFileStat } from "../git/shared"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { PROVIDER_ICONS } from "../../provider-icons"
import { toMessagePreview } from "../../../../shared/message-preview"
import type { ChatJumpRole } from "../../../lib/chat-navigation"
import { cn, normalizeChatId } from "../../../lib/utils"
import type { SidebarThread } from "../../../lib/thread-sections"
import { useChatDraft } from "../../../stores/chatInputStore"

/**
 * Reads the chat's draft from inside the open card.
 *
 * The draft belongs on the card — it is the card's last line — but subscribing
 * to it anywhere in the always-mounted part of a row would re-render that row on
 * every keystroke in the composer. Radix only mounts this while the card is
 * open, so the subscription lives exactly as long as something is displaying it.
 * `ChatHoverCardContent` stays a pure function of its props.
 */
function ChatHoverCardBody({
  thread,
  ...rest
}: Omit<Parameters<typeof ChatHoverCardContent>[0], "draft">) {
  return <ChatHoverCardContent thread={thread} draft={useChatDraft(thread.row.chatId)} {...rest} />
}

/**
 * The card that appears beside a sidebar chat row on hover — the transcript
 * minimap's hover card, applied to the other list of turns you scan.
 *
 * A sidebar row can only afford a title and one glyph, so everything that says
 * *which* chat this is and *where it got to* has been squeezed out of it: the
 * branch, the harness, how long the turn has been running, what you asked and
 * what came back. The card is where that goes, on the one interaction that
 * costs nothing to attempt and nothing to dismiss.
 *
 * The two messages it shows are also the two places in the chat you most often
 * want to be, so both are clickable: the prompt lands you on the question, the
 * reply on the answer. It stays instant despite now being a target — the peek
 * is the point, and the cost is real but small: a cursor crossing the sidebar
 * raises cards it doesn't want, and briefly puts one over the transcript.
 *
 * Desktop only — hover is not a gesture touch has, and a tap-to-reveal card
 * would fight the row's tap.
 */

/** Harness names, from the catalog the provider picker reads. */
const PROVIDER_LABELS = new Map(PROVIDERS.map((provider) => [provider.id, provider.label]))

/**
 * A turn that has started and not yet ended. Read off timestamps rather than
 * `status` because it's the timestamps that have to agree with the duration:
 * a status of `running` with no start time can't be timed, and a start time
 * newer than the last end is a live turn whatever the status says.
 */
function getActiveTurnStartedAt(row: SidebarChatRow): number | null {
  if (row.lastTurnStartedAt == null) return null
  if (row.lastTurnEndedAt != null && row.lastTurnEndedAt >= row.lastTurnStartedAt) return null
  return row.lastTurnStartedAt
}

/**
 * The agent's last words, but only if they answer the prompt shown above them.
 *
 * A chat you just sent to still carries the *previous* turn's preview, and
 * pairing your new question with the old answer reads as though it had already
 * been answered. Once the prompt is newer than the reply, the card shows the
 * prompt alone until something comes back.
 *
 * Dated by `lastAgentMessagePreviewAt` where it exists, falling back to
 * `lastAgentMessageAt` for chats whose last text predates that field — a
 * slightly generous fallback (tool calls advance it) but never a wrong pairing
 * for anything written since.
 */
function getCurrentTurnReply(row: SidebarChatRow, preview: ChatPreview): string | null {
  if (!preview.lastAgentMessagePreview) return null
  const repliedAt = preview.lastAgentMessagePreviewAt ?? row.lastAgentMessageAt
  if (repliedAt == null) return null
  return repliedAt >= (row.lastMessageAt ?? 0) ? preview.lastAgentMessagePreview : null
}

/**
 * How much conversation is in this chat — "1 turn", "24 turns".
 *
 * The size of the whole thing, not the length of its last turn: the two
 * messages above this line are already the latest turn, and a chat you're
 * deciding whether to open is better described by how far it has gone than by
 * how long its most recent run took (which the minimap reports per turn
 * anyway, where it's about a turn you can actually see).
 *
 * Null on chats whose turns all predate the counter — the line drops the fact
 * rather than claiming a chat with history has run none.
 */
function formatTurnCount(row: SidebarChatRow): string | null {
  if (!row.turnCount) return null
  return `${row.turnCount} turn${row.turnCount === 1 ? "" : "s"}`
}

/**
 * Why this chat is in Relevant: the files it changed that are still sitting
 * uncommitted, and how much of each is its doing.
 *
 * The sidebar can only assert the claim — a dot, a section — and "relevant to
 * your uncommitted work" is a conclusion you otherwise have to take on trust.
 * This is where it's shown its working, so the list is the same set the flag is
 * computed from: present exactly when the chat is in Relevant, empty the moment
 * its files are committed.
 *
 * Rows are the git panel's file rows (`DiffFileStat`, same path treatment), so
 * "a file and how much changed in it" looks the same wherever you meet it here.
 * Clicking one opens it in your editor: the file is the thing you'd go to next,
 * and the card is already under the pointer.
 */
function ChatTouchedFileList({
  result,
  onOpenFile,
}: {
  result: ChatTouchedFilesResult
  onOpenFile?: (path: string) => void
}) {
  if (result.files.length === 0) return null
  const hidden = result.totalCount - result.files.length

  return (
    <>
      {/* Edge to edge: the card's padding is `px-1.5`, so the rule cancels it
          to span the full width and read as a section break rather than as
          another indented row. */}
      <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
      <div className="mt-1.5">
        {result.files.map((file) => (
          <button
            key={file.path}
            type="button"
            // Named by path rather than "open file": down a list of eight, the
            // path is the only thing distinguishing one control from the next.
            aria-label={`Open ${file.path}`}
            onClick={onOpenFile ? () => onOpenFile(file.path) : undefined}
            disabled={!onOpenFile}
            className={cn(
              "flex w-full items-center gap-2 rounded text-left text-[12px] text-muted-foreground",
              TURN_CARD_ROW_INSET,
              onOpenFile
                ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                : "cursor-default",
            )}
          >
            {/* Plain truncation, as in the git panel — the same path in the two
                places you read it should break the same way. The full path is on
                the title, since this is the one row here that routinely won't
                fit. */}
            <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
            <DiffFileStat additions={file.additions} deletions={file.deletions} className="shrink-0" />
          </button>
        ))}
        {hidden > 0 ? (
          // Says what it left out rather than trailing off: a card that shows
          // eight of 291 files without saying so reads as the whole answer.
          <div className={cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET)}>
            {hidden} more file{hidden === 1 ? "" : "s"}
          </div>
        ) : null}
      </div>
    </>
  )
}

/**
 * Fetched lists, keyed by chat *and* by what would change one — its turn count,
 * when its last turn landed, and whether it still has uncommitted work. Hovering
 * back along a row you already visited is then free, while a chat that has since
 * run or had its work committed refetches rather than showing you the list from
 * before.
 */
const touchedFilesCache = new Map<string, ChatTouchedFilesResult>()
/** Enough for a long hover session; the whole point is to survive re-hovers, not to persist. */
const TOUCHED_FILES_CACHE_LIMIT = 64

function getTouchedFilesCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.turnCount ?? 0, row.lastTurnEndedAt ?? 0, row.uncommittedWork ? 1 : 0].join(" ")
}

/**
 * Loads a chat's file list while its card is open, or `null` while there is
 * nothing (yet) to show.
 *
 * Only ever asks for the row under the pointer — a sidebar of 500 chats can't
 * carry this on its snapshot, and a card you never opened costs nothing. A
 * failed fetch stays `null`: the card is a peek, and an error line in it would
 * be louder than the fact it failed to load an appendix.
 */
function useChatTouchedFiles(
  row: SidebarChatRow | null,
  load?: (chatId: string) => Promise<ChatTouchedFilesResult>
): ChatTouchedFilesResult | null {
  const cacheKey = row ? getTouchedFilesCacheKey(row) : null
  const [result, setResult] = useState<ChatTouchedFilesResult | null>(
    () => (cacheKey ? touchedFilesCache.get(cacheKey) ?? null : null)
  )
  /** The chat `result` was fetched for. */
  const heldForChatIdRef = useRef(row?.chatId ?? null)

  useEffect(() => {
    if (!row || !cacheKey || !load) return
    const cached = touchedFilesCache.get(cacheKey)
    if (cached) {
      heldForChatIdRef.current = row.chatId
      setResult(cached)
      return
    }
    // Cleared rather than left showing the previous chat's files: cards are
    // reused as the pointer runs down the list, and one row's list under
    // another row's title is worse than no list at all. Kept when it is the
    // same chat with newer work in it: the list it had stands until the new
    // one lands, so a card that stays up on one chat (a node in the graph
    // view) does not empty and refill each time its chat moves.
    if (heldForChatIdRef.current !== row.chatId) setResult(null)
    heldForChatIdRef.current = row.chatId
    let cancelled = false
    void load(row.chatId).then((next) => {
      if (touchedFilesCache.size >= TOUCHED_FILES_CACHE_LIMIT) {
        touchedFilesCache.delete(touchedFilesCache.keys().next().value as string)
      }
      touchedFilesCache.set(cacheKey, next)
      if (!cancelled) setResult(next)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cacheKey, load, row])

  return result
}

const previewCache = new Map<string, ChatPreview>()

function getPreviewCacheKey(row: SidebarChatRow) {
  return [row.chatId, row.lastMessageAt ?? 0, row.lastAgentMessageAt ?? 0].join("^")
}

/**
 * The prompt and reply text for the card under the pointer.
 *
 * Fetched here rather than carried on the sidebar row: the reply changes on
 * every assistant message, and having it on the row made every one of those
 * a sidebar push that re-derived the whole list. Keyed by the row's activity
 * fields so a re-hover on an unchanged chat is served from memory.
 */
function useChatPreview(
  row: SidebarChatRow | null,
  load?: (chatId: string) => Promise<ChatPreview>
): ChatPreview | null {
  const cacheKey = row ? getPreviewCacheKey(row) : null
  const [result, setResult] = useState<ChatPreview | null>(
    () => (cacheKey ? previewCache.get(cacheKey) ?? null : null)
  )
  const heldForChatIdRef = useRef(row?.chatId ?? null)

  useEffect(() => {
    if (!row || !cacheKey || !load) return
    const cached = previewCache.get(cacheKey)
    if (cached) {
      heldForChatIdRef.current = row.chatId
      setResult(cached)
      return
    }
    // As in `useChatTouchedFiles`: cleared for another chat, kept for this one.
    if (heldForChatIdRef.current !== row.chatId) setResult(null)
    heldForChatIdRef.current = row.chatId
    let cancelled = false
    void load(row.chatId).then((next) => {
      if (previewCache.size >= TOUCHED_FILES_CACHE_LIMIT) {
        previewCache.delete(previewCache.keys().next().value as string)
      }
      previewCache.set(cacheKey, next)
      if (!cancelled) setResult(next)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cacheKey, load, row])

  return result
}

/** Exported for tests: the card body, without the hover-card machinery around it. */
export function ChatHoverCardContent({
  thread,
  draft = "",
  touchedFiles,
  preview,
  onSelectMessage,
  onSelectChat,
  onOpenRepo,
  onOpenFile,
  onSetupGit,
}: {
  thread: SidebarThread
  draft?: string
  /** What this chat changed; absent until the fetch lands (or if it fails). */
  touchedFiles?: ChatTouchedFilesResult | null
  /** The prompt and reply text; absent until fetched. Falls back to the row. */
  preview?: ChatPreview | null
  /** Absent when the card is read-only (archived rows). */
  onSelectMessage?: (role: ChatJumpRole) => void
  /** Opens the chat without aiming at a message — what the draft does. */
  onSelectChat?: () => void
  /** Opens the project's forge page. Ignored when the repo has no URL. */
  onOpenRepo?: () => void
  /** Opens one of the chat's files in the user's editor, by repo-relative path. */
  onOpenFile?: (path: string) => void
  /** Offers to `git init` the project. Ignored unless it's known not to be a repo. */
  onSetupGit?: () => void
}) {
  const row = thread.row
  const label = thread.projectLabel
  const HarnessIcon = row.provider ? PROVIDER_ICONS[row.provider] : null
  const turns = formatTurnCount(row)
  // The row's own fields are the pre-fetch shape, kept so older servers and
  // the export viewer still show something.
  const effectivePreview: ChatPreview = preview ?? row
  const reply = getCurrentTurnReply(row, effectivePreview)
  // When the turn landed, in the transcript's own format — "3:42 PM" today,
  // "Mon 3:42 PM" this week, the full date beyond that. Suppressed while a turn
  // is live: the only end time on hand then belongs to the *previous* turn.
  const endedAt = getActiveTurnStartedAt(row) != null || row.lastTurnEndedAt == null
    ? null
    // A turn has landed, but the chat has not: saying when would read as the
    // time it finished. The slot says what it is waiting on instead.
    : row.status === "waiting_on_subagent"
      ? "Waiting on a subagent"
      : formatPromptTimestamp(new Date(row.lastTurnEndedAt).toISOString())
  // Both blocks are clickable whenever the surface offers the jump at all. The
  // card doesn't identify the messages and doesn't need to: it shows a chat's
  // latest prompt and latest reply by definition, and the transcript resolves
  // those from its own rows the way the minimap does.
  const canJump = Boolean(onSelectMessage)


  return (
    <>
      {/* Branch leads, repo trails. Down a list of chats it's the branch that
          differs — the repo is usually the same one over and over — so the
          varying fact reads down the left edge and the constant one anchors
          right, the same shape as the footer's harness and time. */}
      <TurnCardMetaRow>
        {/* Named even when it's `main`: the card has the room, and a branch you
            have to infer from the *absence* of a glyph is a worse answer than
            the word. Absent only on a detached HEAD, where the repo simply
            slides over. */}
        {label.currentBranch ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
            <span className="truncate">{label.currentBranch}</span>
          </span>
        ) : label.hasGitRepo === false && onSetupGit ? (
          // A project with no repo has no branch to name, so the slot the
          // branch would have taken says what's missing instead — and offers
          // the same one-click fix the chat navbar's "Setup Git" does, since
          // the card is where you're already looking when you notice.
          //
          // Only on a definite `false`: while the server hasn't looked yet,
          // every row would briefly claim its repo didn't exist.
          <button
            type="button"
            onClick={onSetupGit}
            // Underlined-on-hover like the repo link opposite it, not filled
            // like the message rows: both are inline words in a meta line.
            className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
            <span className="truncate">Setup Git</span>
          </button>
        ) : null}
        {/* `owner/repo` when the origin owner is known, the bare repo otherwise;
            a renamed project has neither, and shows the name you gave it. Both
            sides may truncate rather than either being pinned: flexbox takes it
            out of the longer one first, which is nearly always the branch. */}
        <span className="ml-auto flex min-w-0 items-center gap-1 pl-2">
          {/* When the repo has a page, the name *is* the link to it — one
              click, one destination, the convention a repo path already
              carries on the web. Opening it in an app is the row's right-click
              menu's job; a second menu here would only duplicate it. */}
          {onOpenRepo && label.repoUrl ? (
            <button
              type="button"
              aria-label={`Open on ${getRepoUrlLabel(label.repoUrl)}`}
              onClick={onOpenRepo}
              // No padding of its own: it sits inline in a row that already
              // carries the inset, and a fill here would push the repo name out
              // of line with the two messages below it. Underline does the work
              // a hover fill does elsewhere — it's a link, not a menu row.
              className="truncate cursor-pointer rounded-sm transition-colors hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {label.repoPath ?? label.name}
            </button>
          ) : (
            <span className="truncate">{label.repoPath ?? label.name}</span>
          )}
        </span>
      </TurnCardMetaRow>
      {/* The exchange, as one block with matched margins above and below so it
          sits between the two meta lines rather than joining either. */}
      <div className="mt-1 space-y-1">
        {/* The prompt leads, as in the minimap card: it's the question the reply
            under it is the answer to. Falls back to the chat's title so a chat
            with no messages yet still says what it is. A draft displaces it —
            see below. */}
        {draft ? null : (
          <TurnCardMessage
            className="line-clamp-2 text-sm font-medium text-popover-foreground"
            label="Jump to this prompt"
            onSelect={canJump ? () => onSelectMessage?.("prompt") : undefined}
          >
            {toMessagePreview(effectivePreview.lastUserMessagePreview || thread.title)}
          </TurnCardMessage>
        )}
        {/* Cut to a single line once a draft is here: what you were about to
            say outranks how the last answer began, and three lines of reply
            would push it to the bottom of a card you opened for the draft. */}
        {reply ? (
          <TurnCardMessage
            className={cn("text-sm text-muted-foreground", draft ? "line-clamp-1" : "line-clamp-3")}
            label="Jump to this reply"
            onSelect={canJump ? () => onSelectMessage?.("reply") : undefined}
          >
            {toMessagePreview(reply)}
          </TurnCardMessage>
        ) : null}
        {/* An unsent draft ends the card, in the prompt's own weight but
            italic and pencilled: it is the next thing said in this chat, not
            the last. It takes the sent prompt's place rather than sitting
            alongside it — the prompt is already answered by the reply above,
            and what you want back is the sentence you walked away from.
            The glyph is inline rather than a flex sibling, so a wrapped second
            line runs the full width instead of indenting to clear it. */}
        {draft ? (
          // Unlike the two messages, a draft has no entry to land on — it was
          // never sent. So it just opens the chat, where the composer is
          // already holding it.
          <TurnCardMessage
            className="line-clamp-2 text-sm font-medium italic text-popover-foreground"
            label="Open this chat"
            onSelect={onSelectChat}
          >
            <PencilLine className="mr-1 inline size-3 shrink-0 -translate-y-px" strokeWidth={2.5} />
            {toMessagePreview(draft)}
          </TurnCardMessage>
        ) : null}
      </div>
      {/* The harness on the left, the chat's size and when it last landed on
          the right. Turns rather than the last turn's duration, which the
          minimap already reports per turn and which said nothing about the
          chat: how much conversation is in here is the thing a sidebar row
          can't show and you'd want before opening it. */}
      <TurnCardTimingRow
        detail={turns}
        timestamp={endedAt}
        leading={row.provider ? (
          // Glyph and name are one fact, so nothing separates them.
          <>
            {HarnessIcon ? <HarnessIcon className="size-3 shrink-0" /> : null}
            <span className="truncate">{PROVIDER_LABELS.get(row.provider) ?? row.provider}</span>
          </>
        ) : null}
      />
      {/* Below the footer, not above it: the exchange and the harness line are
          what the card has always said, and the file list is an appendix to
          them — long, scannable, and the thing you drop to when the summary
          above didn't settle it. Nothing renders at all until the fetch lands,
          so the card doesn't resize under a pointer that's already reading it
          unless there's something to show. */}
      {touchedFiles ? (
        <ChatTouchedFileList result={touchedFiles} onOpenFile={onOpenFile} />
      ) : null}
    </>
  )
}

/**
 * The sidebar's chat hover card: the app's list hover card (`ListHoverCard`),
 * showing a chat. One for the whole list, not one per row; rows mark
 * themselves with `data-chat-id`.
 *
 * The same card serves any list of chat rows that carries that marker: the
 * sidebar's own, and the chats listed inside a channel's card.
 */
function SidebarChatHoverCardImpl({
  containerRef,
  threads,
  side = "right",
  sideOffset,
  holdRowUnderPointerOnMount,
  ...actions
}: {
  /** See `ListHoverCard`. */
  holdRowUnderPointerOnMount?: boolean
  /**
   * Beside a list down the sidebar; beneath for chats along a bar (the tabs)
   * and for a chat's card in the transcript; to the left of the widget
   * column, which sits at the window's right edge.
   */
  side?: "right" | "bottom" | "left"
  /** The list's element; every chat row is somewhere beneath it. */
  containerRef: RefObject<HTMLDivElement | null>
  /** Every row the list can show, from `useStableSidebarThreads`. */
  threads: SidebarThread[]
  /** See `ListHoverCard`. Omitted beside the sidebar; set where the rows sit inside a card. */
  sideOffset?: number
} & SidebarChatCardActions) {
  // Keyed as the rows write it, so resolving a hovered row is a map lookup.
  const threadByRowId = useMemo(
    () => new Map(threads.map((thread) => [normalizeChatId(thread.chatId), thread])),
    [threads]
  )

  return (
    <ListHoverCard containerRef={containerRef} rowAttribute="data-chat-id" side={side} sideOffset={sideOffset} holdRowUnderPointerOnMount={holdRowUnderPointerOnMount}>
      {(rowChatId, dismiss) => {
        // Null once the hovered chat leaves the list (archived from elsewhere,
        // filtered out by focus mode), which closes the card rather than
        // stranding it on a row that is no longer there.
        const thread = threadByRowId.get(rowChatId)
        return thread ? <SidebarChatCard thread={thread} dismiss={dismiss} {...actions} /> : null
      }}
    </ListHoverCard>
  )
}

export interface SidebarChatCardActions {
  /** Opens the chat plainly: the draft's action, and the row's. */
  onSelectChat: (chatId: string) => void
  /** Opens a chat at one end of its last exchange: the clickable previews. */
  onSelectMessage: (chatId: string, role: ChatJumpRole) => void
  /** Archived chats open by their own route; their cards offer nothing else. */
  onOpenArchivedChat: (chatId: string) => void
  /** Prompts to `git init` a chat's project: the navbar's "Setup Git". */
  onSetupGit: (chatId: string) => void
  /** Fetches what a chat changed. Omitted = the card shows no file list. */
  onLoadTouchedFiles?: (chatId: string) => Promise<ChatTouchedFilesResult>
  onLoadPreview?: (chatId: string) => Promise<ChatPreview>
  /** The row's own opener, reused to send a file to the editor. */
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
}

/**
 * The open card for one chat: what it fetches, and what its actions do.
 *
 * Mounted only while a card is up, and reused as the pointer runs down the
 * list, so the fetches are for the row you are actually on. Every action
 * dismisses first: each takes you somewhere, and a card left standing would
 * hang over wherever that is.
 */
export function SidebarChatCard({
  thread,
  dismiss,
  onSelectChat,
  onSelectMessage,
  onOpenArchivedChat,
  onSetupGit,
  onLoadTouchedFiles,
  onLoadPreview,
  onOpenExternalPath,
}: { thread: SidebarThread; dismiss: () => void } & SidebarChatCardActions) {
  const archived = thread.archived
  const chatId = thread.chatId
  const localPath = thread.row.localPath
  const repoUrl = thread.projectLabel.repoUrl
  const touchedFiles = useChatTouchedFiles(thread.row, onLoadTouchedFiles)
  const preview = useChatPreview(thread.row, onLoadPreview)

  const handleSelectChat = useCallback(() => {
    dismiss()
    if (archived) onOpenArchivedChat(chatId)
    else onSelectChat(chatId)
  }, [archived, chatId, dismiss, onOpenArchivedChat, onSelectChat])

  const handleSelectMessage = useCallback((role: ChatJumpRole) => {
    dismiss()
    onSelectMessage(chatId, role)
  }, [chatId, dismiss, onSelectMessage])

  const handleSetupGit = useCallback(() => {
    dismiss()
    onSetupGit(chatId)
  }, [chatId, dismiss, onSetupGit])

  // Opened by this browser, not through `system.openExternal`: that command
  // opens things on the machine the project lives on, which is the wrong
  // screen whenever that machine isn't this one.
  const handleOpenRepo = useCallback(() => {
    if (!repoUrl) return
    dismiss()
    window.open(repoUrl, "_blank", "noopener,noreferrer")
  }, [dismiss, repoUrl])

  // Repo-relative, as the server records them, so the project path goes back
  // on before the machine is asked to open anything.
  const handleOpenFile = useCallback((filePath: string) => {
    dismiss()
    onOpenExternalPath("open_editor", resolveDiffFilePath(localPath, filePath))
  }, [dismiss, localPath, onOpenExternalPath])

  return (
    // File rows carry their own `py-0.5`, so the card's full `pb-2` under the
    // last one reads as a wider gap than the one above the list. Taken back
    // only when the list is there: without it the footer is plain text that
    // wants the full padding.
    <div className={touchedFiles?.files.length ? "-mb-0.5" : undefined}>
      <ChatHoverCardBody
        thread={thread}
        touchedFiles={touchedFiles}
        preview={preview}
        // An archived chat has nowhere to jump to and nothing to set up; its
        // card reads, and its one action reopens it.
        onSelectMessage={archived ? undefined : handleSelectMessage}
        onSelectChat={handleSelectChat}
        onOpenRepo={handleOpenRepo}
        onOpenFile={handleOpenFile}
        onSetupGit={archived ? undefined : handleSetupGit}
      />
    </div>
  )
}

/**
 * Memoized because the sidebar re-renders on every snapshot push, several a
 * second through a turn, and this holds the one live card body.
 */
export const SidebarChatHoverCard = memo(SidebarChatHoverCardImpl)
