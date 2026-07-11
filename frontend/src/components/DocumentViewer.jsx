import { useEffect, useState } from 'react'
import { fetchDocumentFileBlob } from '../api.js'
import { vaultOfflineStore } from '../vaultOfflineStore.js'

// Full-screen viewer for one file of a document vault entry. Checks the
// offline cache first (vaultOfflineStore) — this ordering is the actual
// offline-usefulness of the feature; only falls back to a network fetch
// when the bytes aren't cached (see plan-12c).
export default function DocumentViewer({ doc, files, initialFileId, onClose, store = vaultOfflineStore }) {
  const [index, setIndex] = useState(() => Math.max(0, files.findIndex(f => f.id === initialFileId)))
  const [url, setUrl] = useState(null)
  const [contentType, setContentType] = useState(null)
  const [error, setError] = useState(null)
  const file = files[index]

  useEffect(() => {
    let cancelled = false
    let objectUrl = null
    setUrl(null); setError(null)

    async function load() {
      if (!file) return
      const cached = await store.get(file.id)
      if (cached) {
        if (cancelled) return
        objectUrl = URL.createObjectURL(cached.blob)
        setUrl(objectUrl)
        setContentType(cached.contentType)
        return
      }
      const blob = await fetchDocumentFileBlob(doc.id, file.id)
      if (cancelled) return
      if (!blob) { setError('Not available offline'); return }
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
      setContentType(file.content_type)
    }
    load()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [doc.id, file])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setIndex(i => Math.min(files.length - 1, i + 1))
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, files.length])

  const isImage = (contentType || '').startsWith('image/')

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--overlay)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span style={{ color: '#fff' }} className="text-sm font-medium truncate">
          {doc.label || doc.doc_type} — {file?.filename}
          {files.length > 1 ? ` (${index + 1}/${files.length})` : ''}
        </span>
        <button onClick={onClose} style={{ color: '#fff' }} className="text-xl leading-none hover:opacity-70 shrink-0 ml-3">✕</button>
      </div>

      <div className="flex-1 flex items-center justify-center gap-3 px-4 pb-4 overflow-auto">
        {files.length > 1 && (
          <button
            onClick={() => setIndex(i => Math.max(0, i - 1))}
            disabled={index === 0}
            style={{ color: '#fff' }}
            className="text-2xl px-2 disabled:opacity-30"
          >
            ‹
          </button>
        )}

        {error && <p style={{ color: '#fff' }} className="text-sm">{error}</p>}
        {!error && !url && <p style={{ color: '#fff' }} className="text-sm">Loading…</p>}
        {!error && url && isImage && (
          <img src={url} alt={file?.filename} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: '0.5rem' }} />
        )}
        {!error && url && !isImage && (
          <div className="flex flex-col items-center gap-3">
            <p style={{ color: '#fff' }} className="text-sm">Preview not available for this file type.</p>
            <a href={url} download={file?.filename} style={{ color: 'var(--accent)' }} className="text-sm underline">
              Download {file?.filename}
            </a>
          </div>
        )}

        {files.length > 1 && (
          <button
            onClick={() => setIndex(i => Math.min(files.length - 1, i + 1))}
            disabled={index === files.length - 1}
            style={{ color: '#fff' }}
            className="text-2xl px-2 disabled:opacity-30"
          >
            ›
          </button>
        )}
      </div>
    </div>
  )
}
