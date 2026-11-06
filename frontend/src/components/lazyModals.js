// Modals and detail views that only open on a tap. Importing them from here
// instead of directly keeps their code (ItemEditModal alone is ~100 kB of source)
// out of the initial bundle. Each is a drop-in replacement for the eager import.
import { lazyComponent } from '../lazyWithReload.jsx'

export const ItemEditModal = lazyComponent(() => import('./ItemEditModal.jsx'))
export const ItemDetailModal = lazyComponent(() => import('./ItemDetailModal.jsx'))
export const FlightDetailModal = lazyComponent(() => import('./FlightDetailModal.jsx'))
export const RailDetailModal = lazyComponent(() => import('./RailDetailModal.jsx'))
export const PendingReview = lazyComponent(() => import('./PendingReview.jsx'))
