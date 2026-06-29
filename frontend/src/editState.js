/**
 * Global edit-modal state.
 *
 * Any ItemEditModal sets editing=true on mount and false on unmount.
 * TripTimeline's data-sync poller checks this before refreshing so it
 * never clobbers data the user is actively editing.
 */

let _editing = false
const _listeners = new Set()

export function setEditing(value) {
  _editing = value
  _listeners.forEach(l => l(value))
}

export function isEditing() { return _editing }

/** Subscribe to changes. Returns an unsubscribe function. */
export function onEditChange(cb) {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}
