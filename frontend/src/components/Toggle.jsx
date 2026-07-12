export default function Toggle({ label, on, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
    >
      <span style={{ color: 'var(--text)' }} className="text-sm text-left">{label}</span>
      <span
        style={{
          width: '2.5rem', height: '1.4rem', borderRadius: '9999px', flexShrink: 0, position: 'relative',
          background: on ? 'var(--accent)' : 'var(--border)', transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: '0.15rem', left: on ? '1.25rem' : '0.15rem',
          width: '1.1rem', height: '1.1rem', borderRadius: '9999px', background: '#fff',
          transition: 'left 0.15s',
        }} />
      </span>
    </button>
  )
}
