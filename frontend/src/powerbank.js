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

// ICAO global standard — effective 27 March 2026, adopted by all 193 member
// states. Applies when an airline isn't in the table below.
const DEFAULT_POLICY = {
  maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, airline approval required. >160 Wh: prohibited.',
  number:  'Maximum 2 power banks per passenger.',
  storage: 'Carry-on only — overhead bins forbidden. Keep accessible; protect terminals.',
  usage:   'PROHIBITED in flight — no charging power banks, and no using them to charge devices.',
  source:  'ICAO global standard (27 Mar 2026)',
}

// Airline-specific overrides. Keys are lowercase substrings matched against
// the stored airline name (so "Singapore Airlines" matches "singapore").
const AIRLINE_POLICIES = {
  singapore: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger (since 15 Apr 2026).',
    storage: 'Carry-on only. Must be kept in the seat pocket or under the seat — not in overhead bins.',
    usage:   'Use and charging of power banks PROHIBITED during the flight.',
    source:  'Singapore Airlines',
  },
  thai: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger (enforced 27 Mar 2026).',
    storage: 'Carry-on only. Keep accessible, not in overhead bins.',
    usage:   'Use and charging PROHIBITED in flight — non-compliance risks denied boarding.',
    source:  'Thai Airways',
  },
  'eva air': {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger.',
    storage: 'Carry-on only. Not permitted in overhead bins.',
    usage:   'Using or charging power banks PROHIBITED throughout the flight.',
    source:  'EVA Air',
  },
  'korean air': {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger.',
    storage: 'Carry-on only. Must be kept on your person or in the seat pocket, not overhead bins.',
    usage:   'In-flight use and charging of power banks PROHIBITED (since 26 Jan 2026).',
    source:  'Korean Air',
  },
  qantas: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger (since Dec 2025).',
    storage: 'Carry-on only. Keep within reach; do not store in overhead lockers.',
    usage:   'In-flight use of power banks PROHIBITED.',
    source:  'Qantas',
  },
  emirates: {
    maxWh:   '≤100 Wh only. >100 Wh: prohibited.',
    number:  'One power bank (≤100 Wh) per passenger — stricter than ICAO.',
    storage: 'Carry-on only. Must remain accessible during the flight.',
    usage:   'In-flight use of power banks PROHIBITED (since Oct 2025).',
    source:  'Emirates',
  },
  qatar: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: max 2, with prior approval. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger.',
    storage: 'Carry-on only. Keep terminals protected; not in overhead bins.',
    usage:   'In-flight use and charging PROHIBITED (ICAO global standard).',
    source:  'Qatar Airways',
  },
  cathay: {
    maxWh:   '≤100 Wh: allowed. 100–160 Wh: needs clearance ≥48 h before departure. >160 Wh: prohibited.',
    number:  'Maximum 2 power banks per passenger.',
    storage: 'Carry-on only. Not in overhead bins.',
    usage:   'Using or charging power banks PROHIBITED during the flight.',
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
