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

export default function RichText({ children, className, style }) {
  const text = children == null ? '' : String(children)
  const lines = text.split('\n')
  return (
    <span className={className} style={style}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderLine(line, `l${i}`)}
        </Fragment>
      ))}
    </span>
  )
}
