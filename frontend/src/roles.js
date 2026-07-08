import { createContext, useContext } from 'react'

const RANK = { viewer: 1, editor: 2, owner: 3 }

export function canEdit(role)   { return (RANK[role] ?? 3) >= RANK.editor }   // editor or owner
export function canManage(role) { return role === 'owner' }

// The role the UI should act as right now: the trip role while online, viewer
// while offline. Every write path needs the network, so offline the whole app
// is read-only regardless of the user's actual role — cached data still
// renders, edit affordances hide (they'd only produce failed fetches).
export function effectiveRole(role, online) {
  return online ? (role ?? 'owner') : 'viewer'
}

// Default 'owner' so that without a provider (e.g. auth disabled / dev) the UI is
// fully editable, matching prior behaviour. TripTimeline overrides this per trip.
export const RoleContext = createContext('owner')

export const useRole      = () => useContext(RoleContext)
export const useCanEdit   = () => canEdit(useContext(RoleContext))
export const useCanManage = () => canManage(useContext(RoleContext))
