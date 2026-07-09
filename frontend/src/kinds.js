export const KIND_VAR = {
  activity:      'var(--kind-activity)',
  walk:          'var(--kind-walk)',
  transfer:      'var(--kind-transfer)',
  cycling:       'var(--kind-cycling)',
  tour:          'var(--kind-tour)',
  rail:          'var(--kind-rail)',
  restaurant:    'var(--kind-restaurant)',
  food:          'var(--kind-food)',
  purchase:      'var(--kind-purchase)',
  note:          'var(--kind-note)',
  accommodation: 'var(--kind-accommodation)',
  flight:        'var(--kind-flight)',
  show:          'var(--kind-show)',
  hire:          'var(--kind-hire)',
  river_transfer:'var(--kind-river_transfer)',
}

// Same icon each kind's card uses for its CardIcon (StopCard.jsx) — kept
// here too so the day map's legend (DayMap) can label pins without
// duplicating the mapping or importing the whole card component tree.
export const KIND_ICON = {
  activity:      '⭐',
  walk:          '🥾',
  transfer:      '🚗',
  cycling:       '🚴',
  tour:          '🎟️',
  rail:          '🚄',
  restaurant:    '🍽',
  food:          '🍴',
  purchase:      '🛍️',
  note:          '📝',
  accommodation: '🛏',
  flight:        '✈',
  show:          '🎭',
  hire:          '🚐',
  river_transfer:'⛴',
}

export const KIND_LABEL = {
  activity:      'Activity',
  walk:          'Walk / Hike',
  transfer:      'Road Transfer',
  cycling:       'Cycling',
  tour:          'Guided Tour',
  rail:          'Rail',
  restaurant:    'Restaurant',
  food:          'Food & Drink',
  purchase:      'Purchase',
  note:          'Note',
  accommodation: 'Accommodation',
  flight:        'Flight',
  show:          'Show',
  hire:          'Vehicle Hire',
  river_transfer:'River Transfer',
}

// Kind keys ordered alphabetically by their display label (for selection dropdowns).
export const KIND_OPTIONS = Object.keys(KIND_VAR)
  .sort((a, b) => KIND_LABEL[a].localeCompare(KIND_LABEL[b]))
