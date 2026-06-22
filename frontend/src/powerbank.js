// Airline power bank (portable battery / spare lithium battery) policies.
//
// These are SAFETY RULES that change frequently — always verify with the
// airline before travel. Watt-hour limits below follow IATA/ICAO dangerous
// goods guidance; many carriers added in-flight usage/charging bans in 2025.
//
// Fields per policy:
//   maxWh    — maximum capacity allowed in carry-on
//   number   — how many spare batteries / power banks permitted
//   storage  — where it must be carried during the flight
//   usage    — whether it may be used/charged in flight

// IATA/ICAO general baseline — applies when an airline isn't in the table.
const DEFAULT_POLICY = {
  maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, airline approval required. >160 Wh: prohibited.',
  number:  'Up to 20 spare batteries / power banks (≤100 Wh) for personal use.',
  storage: 'Carry-on only — never in checked baggage. Protect terminals against short circuit.',
  usage:   'Generally permitted to power personal devices; charging from aircraft USB may be restricted.',
  source:  'IATA/ICAO general guidance',
}

// Airline-specific overrides. Keys are lowercase substrings matched against
// the stored airline name (so "Singapore Airlines" matches "singapore").
const AIRLINE_POLICIES = {
  singapore: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Reasonable quantity for personal use (≤100 Wh).',
    storage: 'Carry-on only. Must be kept in the seat pocket or under the seat — not in overhead bins.',
    usage:   'Use and charging of power banks PROHIBITED during the flight (since Apr 2025).',
    source:  'Singapore Airlines',
  },
  thai: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Reasonable quantity for personal use (≤100 Wh).',
    storage: 'Carry-on only. Keep accessible, not in overhead bins.',
    usage:   'Use and charging of power banks PROHIBITED in flight (since Mar 2025).',
    source:  'Thai Airways',
  },
  'eva air': {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Reasonable quantity for personal use.',
    storage: 'Carry-on only. Not permitted in overhead bins.',
    usage:   'Using or charging power banks PROHIBITED throughout the flight (since Mar 2025).',
    source:  'EVA Air',
  },
  'korean air': {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Max 5 spare batteries / power banks per person.',
    storage: 'Carry-on only. Must be kept on your person or in the seat pocket, not overhead bins.',
    usage:   'Charging power banks via aircraft power and charging devices FROM power banks prohibited (since Mar 2025).',
    source:  'Korean Air',
  },
  qantas: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Up to 20 spare batteries / power banks for personal use.',
    storage: 'Carry-on only. Keep within reach; do not store in overhead lockers.',
    usage:   'Power banks should not be used to charge devices in flight; keep monitored.',
    source:  'Qantas',
  },
  emirates: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 1 spare, with approval. >160 Wh: prohibited.',
    number:  'One power bank (≤100 Wh) per passenger, for personal use.',
    storage: 'Carry-on only. Must remain accessible during the flight.',
    usage:   'Power banks must NOT be used to charge devices on board.',
    source:  'Emirates',
  },
  qatar: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Reasonable quantity for personal use.',
    storage: 'Carry-on only. Keep terminals protected.',
    usage:   'Use of power banks to charge devices not permitted in flight.',
    source:  'Qatar Airways',
  },
  cathay: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Reasonable quantity for personal use.',
    storage: 'Carry-on only. Not in overhead bins.',
    usage:   'Using or charging power banks PROHIBITED during the flight (since 2025).',
    source:  'Cathay Pacific',
  },
}

/**
 * Look up the power bank policy for a given airline name.
 * Returns the matched airline policy, or the IATA default.
 */
export function getPowerbankPolicy(airline) {
  if (!airline) return DEFAULT_POLICY
  const key = airline.toLowerCase()
  for (const [needle, policy] of Object.entries(AIRLINE_POLICIES)) {
    if (key.includes(needle)) return policy
  }
  return DEFAULT_POLICY
}
