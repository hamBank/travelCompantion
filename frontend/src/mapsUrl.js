// Pure helper, kept out of ItemEditModal.jsx so importing it (StopCard) does not drag
// that ~100 kB modal into the initial bundle.
export function buildMapsUrl(points, mode = 'w', embed = false) {
  const pts = (points || []).filter(Boolean)
  if (!pts.length) return null
  const base = 'https://maps.google.com/maps?'
  const suffix = embed ? '&output=embed' : ''
  if (pts.length === 1) return base + new URLSearchParams({ q: pts[0] }).toString() + suffix
  // Keep the literal "to:" keyword Google uses for multi-stop routes.
  const saddr = encodeURIComponent(pts[0])
  const daddr = pts.slice(1).map(encodeURIComponent).join('+to:')
  return `${base}saddr=${saddr}&daddr=${daddr}&dirflg=${mode}${suffix}`
}
