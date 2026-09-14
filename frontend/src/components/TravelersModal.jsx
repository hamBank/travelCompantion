import { useState, useEffect } from 'react'
import { Users, Link as LinkIcon, Pencil, X } from 'lucide-react'
import {
  getTravelers, createTraveler, updateTraveler, deleteTraveler,
  getTravelerProfile, putTravelerProfile, deleteTravelerProfile,
  getTripMembers, listDocuments, getDocumentHolder, getDocumentNumber,
} from '../api.js'
import { useOnline } from '../online.js'

// Mirrors backend/validation.py's PASSPORT_VALIDITY_MONTHS (D8) — duplicated
// on purpose so the list's expiry chip appears immediately from the clear
// `passport_expiry` field, before any save round-trip through the real
// date-warnings check. Keep this in sync with that constant.
const PASSPORT_VALIDITY_MONTHS = 6

const AGE_BAND_LABEL = { infant: 'Infant', child: 'Child' } // adults get no chip

// Calendar-month addition with day clamping, same as backend/validation.py's
// _add_months (e.g. 2026-08-31 + 6 -> 2027-02-28, not an overflow).
function addMonths(date, months) {
  const day = date.getDate()
  const monthIndex = date.getMonth() + months
  const year = date.getFullYear() + Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(day, daysInMonth))
}

function toDateOnly(iso) {
  if (!iso) return null
  return new Date(iso.slice(0, 10) + 'T00:00:00')
}

function passportExpiresTooSoon(passportExpiry, tripEndDate) {
  const expiry = toDateOnly(passportExpiry)
  const lastDay = toDateOnly(tripEndDate)
  if (!expiry || !lastDay) return false
  return expiry < addMonths(lastDay, PASSPORT_VALIDITY_MONTHS)
}

function emptyProfileForm() {
  return {
    full_name: '', date_of_birth: '', sex: '', nationality: '',
    passport_number: '', passport_issuing_country: '', passport_expiry: '',
    email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
  }
}

function profileToForm(p) {
  return {
    full_name: p.full_name || '', date_of_birth: p.date_of_birth || '', sex: p.sex || '',
    nationality: p.nationality || '', passport_number: p.passport_number || '',
    passport_issuing_country: p.passport_issuing_country || '',
    passport_expiry: p.passport_expiry ? p.passport_expiry.slice(0, 10) : '',
    email: p.email || '', phone: p.phone || '',
    frequent_flyer: p.frequent_flyer || [], meal_preference: p.meal_preference || '',
    seat_preference: p.seat_preference || '', notes: p.notes || '',
  }
}

// Only the keys that actually changed vs. the loaded baseline go in the PUT
// body — the backend merges (a PUT with one field keeps the rest), and this
// keeps that merge honest instead of resending untouched fields.
function diffProfile(form, baseline) {
  const base = baseline || {}
  const body = {}
  if (JSON.stringify(form.frequent_flyer) !== JSON.stringify(base.frequent_flyer || [])) {
    body.frequent_flyer = form.frequent_flyer
  }
  const baseExpiry = base.passport_expiry ? base.passport_expiry.slice(0, 10) : ''
  if (form.passport_expiry !== baseExpiry) {
    body.passport_expiry = form.passport_expiry ? `${form.passport_expiry}T00:00:00` : null
  }
  const textKeys = [
    'full_name', 'date_of_birth', 'sex', 'nationality', 'passport_number',
    'passport_issuing_country', 'email', 'phone', 'meal_preference', 'seat_preference', 'notes',
  ]
  for (const key of textKeys) {
    const baseVal = base[key] || ''
    if (form[key] !== baseVal) body[key] = form[key] || null
  }
  return body
}

const inputStyle = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }
const labelStyle = { color: 'var(--text-faint)' }

function Field({ label, children }) {
  return (
    <label className="block text-xs" style={labelStyle}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

function TravelerProfilePanel({ trip, traveler, userEmail, canWrite, isOwn, online, onProfileChanged, onForbidden }) {
  const [passportShown, setPassportShown] = useState(false)
  const [loading, setLoading] = useState(false)
  const [profile, setProfile] = useState(null)   // loaded baseline (or {} once "shown" with nothing stored)
  const [form, setForm] = useState(emptyProfileForm())
  const [notConfigured, setNotConfigured] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [vaultDocs, setVaultDocs] = useState(null)
  const [vaultDocId, setVaultDocId] = useState('')
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultError, setVaultError] = useState(null)

  useEffect(() => {
    if (!isOwn || !passportShown || vaultDocs !== null) return
    listDocuments()
      .then(docs => setVaultDocs(docs.filter(d => d.doc_type === 'passport')))
      .catch(() => setVaultDocs([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwn, passportShown])

  async function showPassportDetails() {
    if (passportShown || loading) return
    setLoading(true); setLoadError(null)
    try {
      const p = await getTravelerProfile(trip.id, traveler.id)
      setProfile(p)
      setForm(profileToForm(p))
      setPassportShown(true)
    } catch (e) {
      if (e.status === 403) { onForbidden(); return }
      if (e.status === 404) {
        setProfile({}); setForm(emptyProfileForm()); setPassportShown(true)
      } else if (e.status === 503) {
        setNotConfigured(true); setProfile({}); setForm(emptyProfileForm()); setPassportShown(true)
      } else {
        setLoadError(e.message)
      }
    } finally {
      setLoading(false)
    }
  }

  function set(key, val) { setForm(f => ({ ...f, [key]: val })) }
  function setFF(i, key, val) {
    setForm(f => ({ ...f, frequent_flyer: f.frequent_flyer.map((r, idx) => idx === i ? { ...r, [key]: val } : r) }))
  }
  function addFF() { setForm(f => ({ ...f, frequent_flyer: [...f.frequent_flyer, { airline: '', number: '' }] })) }
  function removeFF(i) { setForm(f => ({ ...f, frequent_flyer: f.frequent_flyer.filter((_, idx) => idx !== i) })) }

  async function save() {
    setSaving(true); setSaveError(null)
    try {
      const body = diffProfile(form, profile)
      const updated = await putTravelerProfile(trip.id, traveler.id, body)
      setProfile(updated)
      onProfileChanged()
    } catch (e) {
      if (e.status === 403) onForbidden()
      else if (e.status === 503) setNotConfigured(true)
      else setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function clearProfile() {
    if (!window.confirm(`Clear ${traveler.display_name}'s saved passport/booking details?`)) return
    setClearing(true); setSaveError(null)
    try {
      await deleteTravelerProfile(trip.id, traveler.id)
      setProfile({}); setForm(emptyProfileForm())
      onProfileChanged()
    } catch (e) {
      if (e.status === 403) onForbidden()
      else if (e.status === 503) setNotConfigured(true)
      else setSaveError(e.message)
    } finally {
      setClearing(false)
    }
  }

  async function fillFromVault() {
    if (!vaultDocId || vaultBusy) return
    setVaultBusy(true); setVaultError(null)
    try {
      const doc = vaultDocs.find(d => String(d.id) === String(vaultDocId))
      const [holder, numberResp] = await Promise.all([
        getDocumentHolder(vaultDocId).catch(e => (e.status === 404 ? {} : Promise.reject(e))),
        getDocumentNumber(vaultDocId).catch(e => (e.status === 404 ? {} : Promise.reject(e))),
      ])
      setForm(f => ({
        ...f,
        full_name: holder.holder_name || f.full_name,
        date_of_birth: holder.date_of_birth ? holder.date_of_birth.slice(0, 10) : f.date_of_birth,
        sex: holder.sex || f.sex,
        nationality: holder.nationality || f.nationality,
        passport_number: numberResp.document_number || f.passport_number,
        passport_issuing_country: doc?.country || f.passport_issuing_country,
        passport_expiry: doc?.expiry_date ? doc.expiry_date.slice(0, 10) : f.passport_expiry,
      }))
    } catch (e) {
      setVaultError(e.message)
    } finally {
      setVaultBusy(false)
    }
  }

  const disabled = !canWrite || !online

  return (
    <div className="mt-2 p-3 rounded-lg space-y-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      {notConfigured && (
        <p style={{ color: 'var(--warning)' }} className="text-xs">
          Passport storage isn't configured on this server (DOCUMENT_ENCRYPTION_KEY).
        </p>
      )}
      {loadError && <p style={{ color: 'var(--error)' }} className="text-xs">{loadError}</p>}

      {!passportShown ? (
        <button
          onClick={showPassportDetails}
          disabled={loading || !online}
          style={{ color: 'var(--accent)' }}
          className="text-sm hover:underline disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Show passport details'}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Full name (as on passport)">
              <input value={form.full_name} disabled={disabled} onChange={e => set('full_name', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label={`Date of birth${profile?.age_at_trip_start != null ? ` — ${profile.age_at_trip_start} at trip start` : ''}`}>
              <input type="date" value={form.date_of_birth} disabled={disabled} onChange={e => set('date_of_birth', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label="Sex">
              <select value={form.sex} disabled={disabled} onChange={e => set('sex', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60">
                <option value="">—</option>
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
            </Field>
            <Field label="Nationality">
              <input value={form.nationality} disabled={disabled} onChange={e => set('nationality', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label="Contact email">
              <input value={form.email} disabled={disabled} onChange={e => set('email', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label="Phone">
              <input value={form.phone} disabled={disabled} onChange={e => set('phone', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label="Meal preference">
              <input value={form.meal_preference} disabled={disabled} onChange={e => set('meal_preference', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
            <Field label="Seat preference">
              <input value={form.seat_preference} disabled={disabled} onChange={e => set('seat_preference', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
            </Field>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide mb-1" style={labelStyle}>Frequent flyer</p>
            <div className="space-y-1.5">
              {form.frequent_flyer.map((ff, i) => (
                <div key={i} className="flex gap-1.5">
                  <input placeholder="Airline" value={ff.airline || ''} disabled={disabled} onChange={e => setFF(i, 'airline', e.target.value)} style={inputStyle} className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
                  <input placeholder="Number" value={ff.number || ''} disabled={disabled} onChange={e => setFF(i, 'number', e.target.value)} style={inputStyle} className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
                  {!disabled && (
                    <button onClick={() => removeFF(i)} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70 shrink-0" aria-label="Remove frequent flyer number">✕</button>
                  )}
                </div>
              ))}
              {!disabled && (
                <button onClick={addFF} style={{ color: 'var(--accent)' }} className="text-xs hover:underline">+ Add frequent flyer number</button>
              )}
            </div>
          </div>

          <textarea
            placeholder="Notes" value={form.notes} disabled={disabled} onChange={e => set('notes', e.target.value)}
            style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none resize-none disabled:opacity-60" rows={2}
          />

          <div className="pt-1" style={{ borderTop: '1px solid var(--border)' }}>
            <p className="text-xs uppercase tracking-wide mb-2 pt-2" style={labelStyle}>Passport</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Passport number">
                <input value={form.passport_number} disabled={disabled} onChange={e => set('passport_number', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
              </Field>
              <Field label="Issuing country">
                <input value={form.passport_issuing_country} disabled={disabled} onChange={e => set('passport_issuing_country', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
              </Field>
              <Field label="Expiry">
                <input type="date" value={form.passport_expiry} disabled={disabled} onChange={e => set('passport_expiry', e.target.value)} style={inputStyle} className="w-full rounded-lg px-2 py-1.5 text-sm outline-none disabled:opacity-60" />
              </Field>
            </div>
          </div>

          {isOwn && !disabled && vaultDocs && vaultDocs.length > 0 && (
            <div className="pt-1" style={{ borderTop: '1px solid var(--border)' }}>
              <p className="text-xs uppercase tracking-wide mb-2 pt-2" style={labelStyle}>Fill from my vault</p>
              <div className="flex gap-2 flex-wrap items-center">
                <select value={vaultDocId} onChange={e => setVaultDocId(e.target.value)} style={inputStyle} className="rounded-lg px-2 py-1.5 text-sm outline-none">
                  <option value="">Choose a passport document…</option>
                  {vaultDocs.map(d => <option key={d.id} value={d.id}>{d.label || 'Passport'}</option>)}
                </select>
                <button
                  onClick={fillFromVault}
                  disabled={!vaultDocId || vaultBusy}
                  style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
                  className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-50 hover:opacity-80 transition-opacity"
                >
                  {vaultBusy ? 'Filling…' : 'Fill from my vault'}
                </button>
              </div>
              {vaultError && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{vaultError}</p>}
            </div>
          )}

          {saveError && <p style={{ color: 'var(--error)' }} className="text-xs">{saveError}</p>}

          {!disabled && (
            <div className="flex justify-between items-center pt-1">
              <button onClick={clearProfile} disabled={clearing} style={{ color: 'var(--error)' }} className="text-xs hover:opacity-70 disabled:opacity-50">
                {clearing ? 'Clearing…' : 'Clear profile'}
              </button>
              <button
                onClick={save}
                disabled={saving}
                style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TravelerRow({ trip, traveler, userEmail, role, online, members, onChanged, onForbidden, forceOpenDetails }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameForm, setNameForm] = useState({ display_name: traveler.display_name, user_email: traveler.user_email || '' })
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => { if (forceOpenDetails) setDetailsOpen(true) }, [forceOpenDetails])

  const isOwn = !!traveler.user_email && traveler.user_email === userEmail
  const canRead = online && (role === 'owner' || isOwn)
  const canWrite = online && (role === 'owner' || (role === 'editor' && isOwn))
  const expiryWarning = passportExpiresTooSoon(traveler.passport_expiry, trip.end_date)

  function startEditName() {
    setNameForm({ display_name: traveler.display_name, user_email: traveler.user_email || '' })
    setNameError(null)
    setEditingName(true)
  }

  async function saveName() {
    const name = nameForm.display_name.trim()
    if (!name || savingName) return
    setSavingName(true); setNameError(null)
    try {
      const body = { display_name: name }
      if (role === 'owner') body.user_email = nameForm.user_email.trim() || null
      await updateTraveler(trip.id, traveler.id, body)
      setEditingName(false)
      onChanged()
    } catch (e) {
      if (e.status === 403) onForbidden()
      else setNameError(e.message)
    } finally {
      setSavingName(false)
    }
  }

  async function remove() {
    if (removing) return
    setRemoving(true)
    try {
      await deleteTraveler(trip.id, traveler.id)
      onChanged()
    } catch (e) {
      if (e.status === 403) onForbidden()
      setRemoving(false)
    }
  }

  return (
    <div className="py-2 group" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span style={{ color: 'var(--text)' }} className="text-sm truncate">{traveler.display_name}</span>
            {AGE_BAND_LABEL[traveler.age_band] && (
              <span style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-xs px-1.5 py-0.5 rounded-full shrink-0">
                {AGE_BAND_LABEL[traveler.age_band]}
              </span>
            )}
            {isOwn && (
              <span style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }} className="text-xs px-1.5 py-0.5 rounded-full shrink-0">
                you
              </span>
            )}
            {traveler.user_email && (
              <span title={traveler.user_email} style={{ color: 'var(--text-faint)' }} className="shrink-0 inline-flex">
                <LinkIcon size={12} aria-hidden="true" />
              </span>
            )}
            {expiryWarning && (
              <span style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)' }} className="text-xs px-1.5 py-0.5 rounded-full shrink-0">
                Passport expires soon
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canRead && (
            <button
              onClick={() => setDetailsOpen(v => !v)}
              style={{ color: 'var(--accent)' }}
              className="edit-btn text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 hover:underline transition-opacity"
            >
              {detailsOpen ? 'Hide' : 'Details'}
            </button>
          )}
          {canWrite && !editingName && (
            <button
              onClick={startEditName}
              style={{ color: 'var(--text-faint)' }}
              className="edit-btn opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
              aria-label="Edit name/link" title="Edit name/link"
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          {canWrite && (
            <button
              onClick={remove}
              disabled={removing}
              style={{ color: 'var(--text-faint)' }}
              className="edit-btn opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity disabled:opacity-50"
              aria-label="Remove" title="Remove"
              onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {editingName && (
        <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <input
            value={nameForm.display_name}
            onChange={e => setNameForm(f => ({ ...f, display_name: e.target.value }))}
            placeholder="Name"
            style={inputStyle}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          />
          {role === 'owner' && (
            <>
              <input
                value={nameForm.user_email}
                onChange={e => setNameForm(f => ({ ...f, user_email: e.target.value }))}
                placeholder="Link to email (optional)"
                list={`travelers-members-${traveler.id}`}
                style={inputStyle}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              />
              <datalist id={`travelers-members-${traveler.id}`}>
                {members.map(m => <option key={m.user_email} value={m.user_email} />)}
              </datalist>
            </>
          )}
          {nameError && <p style={{ color: 'var(--error)' }} className="text-xs">{nameError}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditingName(false)} disabled={savingName} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">
              Never mind
            </button>
            <button
              onClick={saveName}
              disabled={savingName || !nameForm.display_name.trim()}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {savingName ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {detailsOpen && canRead && (
        <TravelerProfilePanel
          trip={trip} traveler={traveler} userEmail={userEmail}
          canWrite={canWrite} isOwn={isOwn} online={online}
          onProfileChanged={onChanged} onForbidden={onForbidden}
        />
      )}
    </div>
  )
}

export default function TravelersModal({ trip, userEmail, onClose }) {
  const online = useOnline()
  const role = trip.role || 'owner'
  const [travelers, setTravelers] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [members, setMembers] = useState([])
  const [toast, setToast] = useState(null)

  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  const [addingSelf, setAddingSelf] = useState(false)
  const [addSelfError, setAddSelfError] = useState(null)
  const [ownDetailsOpenId, setOwnDetailsOpenId] = useState(null)

  function load() {
    return getTravelers(trip.id).then(setTravelers).catch(e => setLoadError(e.message))
  }
  useEffect(() => { load() }, [trip.id])

  useEffect(() => {
    if (role === 'owner' && online) {
      getTripMembers(trip.id).then(setMembers).catch(() => {})
    }
  }, [trip.id, role, online])

  function handleForbidden() {
    setToast("You don't have permission for that anymore — refreshing the list.")
    load()
  }

  async function addTraveler() {
    const name = newName.trim()
    if (!name || adding) return
    setAdding(true); setAddError(null)
    try {
      const body = { display_name: name }
      const email = newEmail.trim()
      if (email) body.user_email = email
      await createTraveler(trip.id, body)
      setNewName(''); setNewEmail('')
      await load()
    } catch (e) {
      setAddError(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function addSelf() {
    if (addingSelf) return
    setAddingSelf(true); setAddSelfError(null)
    try {
      const name = userEmail ? userEmail.split('@')[0] : 'Me'
      await createTraveler(trip.id, { display_name: name })
      await load()
    } catch (e) {
      setAddSelfError(e.message)
    } finally {
      setAddingSelf(false)
    }
  }

  const ownTraveler = travelers?.find(t => t.user_email && t.user_email === userEmail)

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '85vh' }}
        className="w-full max-w-lg rounded-2xl flex flex-col overflow-hidden"
      >
        <div style={{ borderBottom: '1px solid var(--border)' }} className="px-5 py-4">
          <div className="flex items-center justify-between">
            <div style={{ color: 'var(--text)' }} className="font-medium text-sm flex items-center gap-1.5">
              <Users size={15} aria-hidden="true" />
              Travelers
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
          </div>
          <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-1">
            People going on this trip. Access is managed under Share.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {toast && (
            <p style={{ color: 'var(--warning)' }} className="text-xs">{toast}</p>
          )}
          {!online && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">
              Offline — showing the last known list. Reconnect to add, edit, or view details.
            </p>
          )}
          {loadError && <p style={{ color: 'var(--error)' }} className="text-xs">{loadError}</p>}

          <div>
            {travelers === null ? (
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">Loading…</p>
            ) : travelers.length === 0 ? (
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">No travelers yet.</p>
            ) : (
              travelers.map(t => (
                <TravelerRow
                  key={t.id}
                  trip={trip} traveler={t} userEmail={userEmail} role={role} online={online} members={members}
                  onChanged={load} onForbidden={handleForbidden}
                  forceOpenDetails={ownDetailsOpenId === t.id}
                />
              ))
            )}
          </div>

          {online && role !== 'viewer' && (
            <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
              {role === 'owner' ? (
                <div className="space-y-2 pt-2">
                  <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Add a traveler</p>
                  <div className="flex gap-2 flex-wrap">
                    <input
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addTraveler()}
                      placeholder="Name"
                      style={inputStyle}
                      className="flex-1 min-w-[8rem] rounded-lg px-3 py-2 text-sm outline-none"
                    />
                    <input
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addTraveler()}
                      placeholder="Link to email (optional)"
                      list="travelers-add-members"
                      style={inputStyle}
                      className="flex-1 min-w-[10rem] rounded-lg px-3 py-2 text-sm outline-none"
                    />
                    <datalist id="travelers-add-members">
                      {members.map(m => <option key={m.user_email} value={m.user_email} />)}
                    </datalist>
                    <button
                      onClick={addTraveler}
                      disabled={adding || !newName.trim()}
                      style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                      className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                    >
                      Add
                    </button>
                  </div>
                  {addError && <p style={{ color: 'var(--error)' }} className="text-xs">{addError}</p>}
                </div>
              ) : (
                <div className="pt-2">
                  {ownTraveler ? (
                    <button
                      onClick={() => setOwnDetailsOpenId(ownTraveler.id)}
                      style={{ color: 'var(--accent)' }}
                      className="text-sm hover:underline"
                    >
                      Edit my details
                    </button>
                  ) : (
                    <button
                      onClick={addSelf}
                      disabled={addingSelf}
                      style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                      className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                    >
                      {addingSelf ? 'Adding…' : 'Add me as a traveler'}
                    </button>
                  )}
                  {addSelfError && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{addSelfError}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex justify-end px-5 py-4">
          <button
            onClick={onClose}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
