import { useState, useEffect } from 'react'
import {
  listDocuments, createDocument, updateDocument, deleteDocument,
  listDocumentFiles, uploadDocumentFile, deleteDocumentFile, fetchDocumentFileBlob,
  scanPassportFile, getDocumentHolder,
} from '../api.js'
import { vaultOfflineStore } from '../vaultOfflineStore.js'
import DocumentViewer from './DocumentViewer.jsx'
import Toggle from './Toggle.jsx'

const DOC_TYPE_ICON = { passport: '🛂', drivers_license: '🪪', visa: '🛃', other: '📄' }
const DOC_TYPE_LABEL = { passport: 'Passport', drivers_license: "Driver's licence", visa: 'Visa', other: 'Other' }
const EXPIRY_WARNING_DAYS = 183   // matches the backend expiry-reminder lookahead (plan-12b)

function isExpiringSoon(expiryDate) {
  if (!expiryDate) return false
  const days = (new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24)
  return days <= EXPIRY_WARNING_DAYS
}

function emptyDocForm() {
  return {
    doc_type: 'passport', label: '', country: '', issued_date: '', expiry_date: '', notes: '',
    holder_name: '', nationality: '', date_of_birth: '', sex: '',
  }
}

function DocumentForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial)
  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }
  return (
    <div className="space-y-2 mt-2 p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <select
        value={form.doc_type}
        onChange={e => set('doc_type', e.target.value)}
        style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
      >
        {Object.entries(DOC_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <input
        value={form.label} onChange={e => set('label', e.target.value)} placeholder="Label (e.g. US Passport)"
        style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
      />
      <input
        value={form.country} onChange={e => set('country', e.target.value)} placeholder="Issuing country"
        style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
      />
      <div className="flex gap-2">
        <label className="flex-1 text-xs" style={{ color: 'var(--text-faint)' }}>
          Issued
          <input
            type="date" value={form.issued_date?.slice(0, 10) || ''} onChange={e => set('issued_date', e.target.value)}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="w-full rounded-lg px-2 py-1.5 text-sm outline-none mt-1"
          />
        </label>
        <label className="flex-1 text-xs" style={{ color: 'var(--text-faint)' }}>
          Expires
          <input
            type="date" value={form.expiry_date?.slice(0, 10) || ''} onChange={e => set('expiry_date', e.target.value)}
            style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="w-full rounded-lg px-2 py-1.5 text-sm outline-none mt-1"
          />
        </label>
      </div>
      <textarea
        value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Notes"
        style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none resize-none"
        rows={2}
      />

      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide pt-1">
        Holder details {'(from "Scan passport" or entered manually)'}
      </p>
      <input
        value={form.holder_name} onChange={e => set('holder_name', e.target.value)} placeholder="Holder name"
        style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
      />
      <div className="flex gap-2">
        <input
          value={form.nationality} onChange={e => set('nationality', e.target.value)} placeholder="Nationality"
          style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
          className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm outline-none"
        />
        <select
          value={form.sex} onChange={e => set('sex', e.target.value)}
          style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
          className="rounded-lg px-2 py-2 text-sm outline-none"
        >
          <option value="">Sex</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
      </div>
      <label className="block text-xs" style={{ color: 'var(--text-faint)' }}>
        Date of birth
        <input
          type="date" value={form.date_of_birth?.slice(0, 10) || ''} onChange={e => set('date_of_birth', e.target.value)}
          style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
          className="w-full rounded-lg px-2 py-1.5 text-sm outline-none mt-1"
        />
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">
          Never mind
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.doc_type}
          style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save document'}
        </button>
      </div>
    </div>
  )
}

// Maps a passport OCR extraction result onto UserDocumentPatch field names.
// validKey (when present) is the extraction's own check-digit validity flag
// (backend/passport_ocr.py) — used to default that field's review checkbox
// to unchecked, since a failed check digit means "verify before applying,"
// not "definitely wrong."
const SCAN_FIELD_DEFS = [
  { key: 'document_number', patchKey: 'document_number', label: 'Document number', validKey: 'document_number_valid', warning: "Check digit didn't match — verify before applying." },
  { key: 'holder_name', patchKey: 'holder_name', label: 'Holder name' },
  { key: 'nationality', patchKey: 'nationality', label: 'Nationality', validKey: 'nationality_valid', warning: "Not a recognized country code — verify before applying." },
  { key: 'date_of_birth', patchKey: 'date_of_birth', label: 'Date of birth', validKey: 'date_of_birth_valid', warning: "Check digit didn't match — verify before applying." },
  { key: 'sex', patchKey: 'sex', label: 'Sex' },
  { key: 'issuing_country', patchKey: 'country', label: 'Issuing country', validKey: 'issuing_country_valid', warning: "Not a recognized country code — verify before applying." },
  { key: 'expiry_date', patchKey: 'expiry_date', label: 'Expiry date', validKey: 'expiry_date_valid', warning: "Check digit didn't match — verify before applying." },
]

function ScanReview({ result, onApply, onDismiss, applying }) {
  const [checked, setChecked] = useState(() => {
    const init = {}
    for (const { key, validKey } of SCAN_FIELD_DEFS) {
      init[key] = !!result[key] && (validKey ? result[validKey] !== false : true)
    }
    return init
  })
  const [values, setValues] = useState(() => {
    const init = {}
    for (const { key } of SCAN_FIELD_DEFS) init[key] = result[key] || ''
    return init
  })

  function apply() {
    const patch = {}
    for (const { key, patchKey } of SCAN_FIELD_DEFS) {
      if (checked[key]) patch[patchKey] = values[key]
    }
    onApply(patch)
  }

  return (
    <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Scanned fields — review before applying</p>
      {SCAN_FIELD_DEFS.map(({ key, label, validKey, warning }) => {
        if (!result[key]) return null
        const invalid = validKey && result[validKey] === false
        return (
          <div key={key} className="text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!checked[key]}
                onChange={e => setChecked(c => ({ ...c, [key]: e.target.checked }))}
              />
              <span style={{ color: 'var(--text-faint)' }} className="shrink-0 w-28">{label}</span>
              <input
                value={values[key]}
                onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="flex-1 min-w-0 rounded px-2 py-1 text-xs outline-none"
              />
            </label>
            {invalid && (
              <p style={{ color: 'var(--warning)' }} className="ml-6 mt-0.5">
                {warning}
              </p>
            )}
          </div>
        )
      })}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onDismiss} disabled={applying} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">
          Discard
        </button>
        <button
          onClick={apply}
          disabled={applying}
          style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50"
        >
          {applying ? 'Applying…' : 'Apply selected'}
        </button>
      </div>
    </div>
  )
}

function DocumentRow({ doc, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [files, setFiles] = useState([])
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [offline, setOffline] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [viewerFile, setViewerFile] = useState(null)
  const [error, setError] = useState(null)
  const [scanningFileId, setScanningFileId] = useState(null)
  const [scanResult, setScanResult] = useState(null)   // { fileId, data }
  const [applyingScan, setApplyingScan] = useState(false)
  const [holder, setHolder] = useState(null)   // null = loading; {} | {holder_name, nationality, date_of_birth, sex}
  const [holderVersion, setHolderVersion] = useState(0)   // bumped after a scan is applied, to force a refetch + form remount

  useEffect(() => {
    if (!editing) return
    getDocumentHolder(doc.id)
      .then(h => setHolder(h))
      .catch(e => {
        if (e.status !== 404) setError(e.message)
        setHolder({})
      })
  }, [editing, doc.id, holderVersion])

  useEffect(() => {
    listDocumentFiles(doc.id).then(async fs => {
      setFiles(fs)
      setFilesLoaded(true)
      if (fs.length) {
        const cached = await Promise.all(fs.map(f => vaultOfflineStore.has(f.id)))
        setOffline(cached.every(Boolean))
      }
    }).catch(e => { setError(e.message); setFilesLoaded(true) })
  }, [doc.id])

  async function save(form) {
    setSaving(true); setError(null)
    try {
      await updateDocument(doc.id, form)
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setSaving(true); setError(null)
    try {
      await deleteDocument(doc.id)
      await Promise.all(files.map(f => vaultOfflineStore.delete(f.id)))
      onChanged()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true); setError(null)
    try {
      const uploaded = await uploadDocumentFile(doc.id, file)
      setFiles(prev => [...prev, uploaded])
    } catch (e2) {
      setError(e2.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteFile(fileId) {
    setError(null)
    try {
      await deleteDocumentFile(doc.id, fileId)
      await vaultOfflineStore.delete(fileId)
      setFiles(prev => prev.filter(f => f.id !== fileId))
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleScan(fileId) {
    setScanningFileId(fileId); setError(null); setScanResult(null)
    try {
      const data = await scanPassportFile(doc.id, fileId)
      setScanResult({ fileId, data })
    } catch (e) {
      setError(e.message)
    } finally {
      setScanningFileId(null)
    }
  }

  async function applyScan(patch) {
    setApplyingScan(true); setError(null)
    try {
      await updateDocument(doc.id, patch)
      setScanResult(null)
      // Unmount the form (via the holder !== null gate below) until the
      // refetch resolves, so it remounts with the freshly saved values
      // instead of keeping stale ones from before the scan was applied.
      setHolder(null)
      setHolderVersion(v => v + 1)
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setApplyingScan(false)
    }
  }

  async function toggleOffline() {
    if (!files.length) return
    setOfflineBusy(true); setError(null)
    try {
      if (offline) {
        await Promise.all(files.map(f => vaultOfflineStore.delete(f.id)))
        setOffline(false)
      } else {
        await Promise.all(files.map(async f => {
          const blob = await fetchDocumentFileBlob(doc.id, f.id)
          if (blob) await vaultOfflineStore.put(f.id, blob, f.content_type)
        }))
        setOffline(true)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setOfflineBusy(false)
    }
  }

  const expiringSoon = isExpiringSoon(doc.expiry_date)

  return (
    <div className="py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0">{DOC_TYPE_ICON[doc.doc_type] || '📄'}</span>
        <button onClick={() => setEditing(v => !v)} className="flex-1 min-w-0 text-left">
          <div style={{ color: 'var(--text)' }} className="text-sm truncate">{doc.label || DOC_TYPE_LABEL[doc.doc_type]}</div>
          <div className="text-xs flex gap-2">
            {doc.country && <span style={{ color: 'var(--text-faint)' }}>{doc.country}</span>}
            {doc.expiry_date && (
              <span style={{ color: expiringSoon ? 'var(--warning)' : 'var(--text-faint)' }}>
                Expires {doc.expiry_date.slice(0, 10)}
              </span>
            )}
          </div>
        </button>
        {confirmingDelete ? (
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setConfirmingDelete(false)} disabled={saving} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">
              Never mind
            </button>
            <button onClick={handleDelete} disabled={saving} style={{ color: 'var(--error)' }} className="text-xs hover:opacity-70">
              Confirm
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmingDelete(true)} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70 shrink-0">
            ✕
          </button>
        )}
      </div>

      {editing && (
        <>
          {holder !== null && (
            <DocumentForm
              initial={{
                doc_type: doc.doc_type, label: doc.label, country: doc.country,
                issued_date: doc.issued_date || '', expiry_date: doc.expiry_date || '', notes: doc.notes,
                holder_name: holder.holder_name || '', nationality: holder.nationality || '',
                date_of_birth: holder.date_of_birth || '', sex: holder.sex || '',
              }}
              onSave={save}
              onCancel={() => setEditing(false)}
              saving={saving}
            />
          )}

          <div className="mt-2 pl-1">
            {filesLoaded && files.map(f => (
              <div key={f.id}>
                <div className="flex items-center gap-2 py-1">
                  <button
                    onClick={() => setViewerFile(f.id)}
                    style={{ color: 'var(--accent)' }}
                    className="hover:underline text-left text-sm flex-1 min-w-0 truncate"
                  >
                    📎 {f.filename}
                  </button>
                  {f.content_type?.startsWith('image/') && (
                    <button
                      onClick={() => handleScan(f.id)}
                      disabled={scanningFileId === f.id}
                      style={{ color: 'var(--accent)' }}
                      className="text-xs hover:underline shrink-0 disabled:opacity-50"
                    >
                      {scanningFileId === f.id ? 'Scanning…' : 'Scan passport'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteFile(f.id)}
                    style={{ color: 'var(--text-faint)' }}
                    className="text-xs hover:opacity-70 shrink-0"
                  >
                    ✕
                  </button>
                </div>
                {scanResult?.fileId === f.id && (
                  <ScanReview
                    result={scanResult.data}
                    onApply={applyScan}
                    onDismiss={() => setScanResult(null)}
                    applying={applyingScan}
                  />
                )}
              </div>
            ))}
            <input
              id={`vault-file-${doc.id}`}
              type="file" onChange={handleFileChange} style={{ display: 'none' }}
            />
            <label
              htmlFor={`vault-file-${doc.id}`}
              style={{ color: 'var(--accent)' }}
              className="text-sm hover:underline cursor-pointer inline-block mt-1"
            >
              {uploading ? 'Uploading…' : '+ Add file'}
            </label>

            {files.length > 0 && (
              <div className="mt-2">
                <Toggle
                  label={offlineBusy ? 'Working…' : (offline ? 'Available offline' : 'Not available offline')}
                  on={offline}
                  onToggle={toggleOffline}
                />
              </div>
            )}
          </div>
        </>
      )}

      {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{error}</p>}

      {viewerFile && (
        <DocumentViewer doc={doc} files={files} initialFileId={viewerFile} onClose={() => setViewerFile(null)} />
      )}
    </div>
  )
}

export default function DocumentsModal({ onClose }) {
  const [documents, setDocuments] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function refresh() {
    return listDocuments().then(setDocuments).catch(e => setError(e.message)).finally(() => setLoaded(true))
  }

  useEffect(() => { refresh() }, [])

  async function addDocument(form) {
    setSaving(true); setError(null)
    try {
      await createDocument(form)
      setAdding(false)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '80vh' }}
        className="w-full max-w-md rounded-2xl flex flex-col overflow-hidden"
      >
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center justify-between px-5 py-4">
          <span style={{ color: 'var(--text)' }} className="font-medium text-sm">Documents</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!loaded ? null : (
            <>
              <p style={{ color: 'var(--text-muted)' }} className="text-xs mb-2">
                Passport, licence, and visa scans — encrypted on the server. Toggle "Available offline" per document to view it without a network connection.
              </p>

              {documents.map(doc => <DocumentRow key={doc.id} doc={doc} onChanged={refresh} />)}

              {adding ? (
                <DocumentForm initial={emptyDocForm()} onSave={addDocument} onCancel={() => setAdding(false)} saving={saving} />
              ) : (
                <button onClick={() => setAdding(true)} style={{ color: 'var(--accent)' }} className="text-sm hover:underline mt-2">
                  + Add document
                </button>
              )}

              {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
