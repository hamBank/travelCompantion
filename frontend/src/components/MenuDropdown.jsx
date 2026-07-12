import { useState, useRef, useEffect } from 'react'

// Generic trigger-button + dropdown-panel wrapper with outside-click and
// Escape-to-close, used for the app's hamburger menu (no prior pattern for
// this in the codebase, confirmed via grep before writing this).
export default function MenuDropdown({ trigger, children, align = 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hover:opacity-70 transition-opacity"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className={`absolute top-full mt-2 ${align === 'right' ? 'right-0' : 'left-0'} z-30 min-w-[13rem] rounded-xl overflow-hidden py-1.5`}
          style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
