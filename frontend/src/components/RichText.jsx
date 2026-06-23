import { Fragment } from 'react'

// Lightweight, XSS-safe rich text for free-text fields (descriptions, notes).
// Honors line breaks, **bold**, and auto-links http(s) URLs. Renders pure React
// elements — never dangerouslySetInnerHTML — so user text can't inject markup.
// Links are spans (not <a>) so they're valid inside the card <button>s and don't
// trigger the card's own click.

const URL_RE = /(https?:\/\/[^\s]+)/g

function linkify(text, keyBase) {
  const out = []
  let last = 0, m, i = 0
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    let url = m[0], trail = ''
    while (/[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1) }
    out.push(
      <span
        key={`${keyBase}-l${i++}`}
        onClick={e => { e.stopPropagation(); window.open(url, '_blank', 'noopener') }}
        style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
      >{url}</span>
    )
    if (trail) out.push(trail)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderLine(line, keyBase) {
  return line.split(/(\*\*[^*]+?\*\*)/g).map((part, i) =>
    /^\*\*[^*]+?\*\*$/.test(part)
      ? <strong key={`${keyBase}-b${i}`}>{linkify(part.slice(2, -2), `${keyBase}-b${i}`)}</strong>
      : <Fragment key={`${keyBase}-t${i}`}>{linkify(part, `${keyBase}-t${i}`)}</Fragment>
  )
}

const BULLET_RE = /^\s*-\s+(.*)$/  // "- item" → bullet line

export default function RichText({ children, className, style }) {
  const text = children == null ? '' : String(children)
  const lines = text.split('\n')
  // Each line is its own block span (valid inside both <div> and <span> parents),
  // so bullets and line breaks render without needing <ul>/<li>.
  return (
    <span className={className} style={style}>
      {lines.map((line, i) => {
        const b = line.match(BULLET_RE)
        if (b) {
          return (
            <span key={i} style={{ display: 'flex', gap: '0.5em', paddingLeft: '0.25em' }}>
              <span aria-hidden="true" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>•</span>
              <span style={{ flex: 1, minWidth: 0 }}>{renderLine(b[1], `b${i}`)}</span>
            </span>
          )
        }
        return (
          <span key={i} style={{ display: 'block' }}>
            {line.trim() === '' ? ' ' : renderLine(line, `l${i}`)}
          </span>
        )
      })}
    </span>
  )
}
