import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { getNextMeasuredInputHeight, getTranscriptPaddingBottom } from "../kannaStateHelpers"

/**
 * The room a transcript leaves at its end for the composer docked over it:
 * the dock's measured height, kept current as the composer grows. Shared by
 * the chat page and the previewer's chat, which dock a composer the same way.
 */
export function useTranscriptPaddingBottom() {
  const inputRef = useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = useState(148)

  const syncInputHeight = useCallback(() => {
    const element = inputRef.current
    if (!element) return
    const measuredHeight = element.getBoundingClientRect().height
    setInputHeight((current) => getNextMeasuredInputHeight(current, measuredHeight))
  }, [])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      syncInputHeight()
    })
    observer.observe(element)
    syncInputHeight()
    return () => observer.disconnect()
  }, [syncInputHeight])

  return {
    inputRef,
    syncInputHeight,
    transcriptPaddingBottom: getTranscriptPaddingBottom(inputHeight),
  }
}
