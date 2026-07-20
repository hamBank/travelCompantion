import { useState, useRef, useEffect } from 'react'

/** Click-to-copy wrapper for detail-row values (booking refs especially —
 * the whole point is pasting them into an airline's "manage booking" form).
 * Clicking copies `value` and flashes a ✓ confirmation. Clicks that land on
 * an inner link are unaffected (RichText links stopPropagation), and a click
 * that's actually a text-selection drag doesn't copy over the selection.
 */
export default function CopyText({ value, children, className = '', style }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    // Don't hijack a deliberate text selection within the value.
    const sel = typeof window !== 'undefined' && window.getSelection?.()
    if (sel && !sel.isCollapsed) return
    try {
      await navigator.clipboard.writeText(String(value))
    } catch {
      return // clipboard unavailable (permissions/insecure context) — do nothing
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span
      onClick={copy}
      title="Click to copy"
      className={`cursor-pointer ${className}`}
      style={style}
    >
      {children ?? value}
      {copied && (
        <span style={{ color: 'var(--success)' }} className="ml-1.5 text-xs whitespace-nowrap">✓ Copied</span>
      )}
    </span>
  )
}
