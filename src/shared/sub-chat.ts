/**
 * Whether a chat is one the lists of chats leave out.
 *
 * That is a chat another chat's agent started as its sub-chat: it is shown
 * with its parent (the Tasks widget, the card where it was started), the way
 * a subagent is. A chat that got its parent by being adopted is not one. It
 * had a place in the lists before an agent took it on, often because the
 * user started it, and adopting it must not make it vanish. That holds for a
 * chat that was started as a sub-chat and adopted later, too: `adopted` says
 * where the parent it has now came from.
 *
 * The one rule for the server's sidebar lists and every client list, so they
 * cannot disagree. A chat's unread mark follows it: see `isUnreadForUser`.
 */
export function isSubChat(chat: { parentChatId?: string | null; adopted?: boolean }): boolean {
  return chat.parentChatId != null && !chat.adopted
}
