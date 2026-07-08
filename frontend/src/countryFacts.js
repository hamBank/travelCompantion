/**
 * Static per-country travel facts, keyed by ISO 3166-1 alpha-2 code
 * (case-insensitive lookup — stored uppercase, matched against countryCode()'s
 * lowercase output from countryFlag.js).
 *
 * Each entry: { plug, voltage, emergency, driving, currency, tipping }.
 * Accuracy over coverage — only countries we're confident about are included;
 * everything else falls back to no facts row rather than a guess.
 */

const FACTS = {
  // ── Europe ─────────────────────────────────────────────────────────────
  GB: { plug: 'Type G', voltage: '230V', emergency: '999', driving: 'left', currency: 'GBP', tipping: 'Not expected, 10-12% if service not included' },
  IE: { plug: 'Type G', voltage: '230V', emergency: '112', driving: 'left', currency: 'EUR', tipping: 'Not expected, round up or 10%' },
  FR: { plug: 'Type E', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Included by law, small extra for good service' },
  DE: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Round up or 5-10%' },
  IT: { plug: 'Type F/L', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Not expected, round up' },
  ES: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Not expected, round up' },
  PT: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Not expected, round up' },
  NL: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Round up or 5-10%' },
  BE: { plug: 'Type E', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Included, round up' },
  CH: { plug: 'Type J', voltage: '230V', emergency: '112', driving: 'right', currency: 'CHF', tipping: 'Included, round up' },
  AT: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Round up or 5-10%' },
  LU: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Round up' },
  GR: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '5-10% if not included' },
  FI: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: 'Not expected, round up' },
  SE: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'SEK', tipping: 'Not expected, round up' },
  NO: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'NOK', tipping: 'Not expected, round up' },
  DK: { plug: 'Type F/K', voltage: '230V', emergency: '112', driving: 'right', currency: 'DKK', tipping: 'Included, round up' },
  IS: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'ISK', tipping: 'Not expected, included' },
  PL: { plug: 'Type E', voltage: '230V', emergency: '112', driving: 'right', currency: 'PLN', tipping: '10% customary' },
  CZ: { plug: 'Type E', voltage: '230V', emergency: '112', driving: 'right', currency: 'CZK', tipping: '10% customary' },
  SK: { plug: 'Type E', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  HU: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'HUF', tipping: '10% customary' },
  RO: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'RON', tipping: '10% customary' },
  BG: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'BGN', tipping: '10% customary' },
  HR: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% if not included' },
  SI: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  RS: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'RSD', tipping: '10% customary' },
  AL: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'ALL', tipping: '10% appreciated' },
  ME: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  MK: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'MKD', tipping: '10% customary' },
  BA: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'BAM', tipping: '10% appreciated' },
  MT: { plug: 'Type G', voltage: '230V', emergency: '112', driving: 'left', currency: 'EUR', tipping: '10% if not included' },
  CY: { plug: 'Type G', voltage: '230V', emergency: '112', driving: 'left', currency: 'EUR', tipping: '10% if not included' },
  LV: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  LT: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  EE: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'EUR', tipping: '10% customary' },
  UA: { plug: 'Type C/F', voltage: '230V', emergency: '112', driving: 'right', currency: 'UAH', tipping: '10% appreciated' },

  // ── Americas ───────────────────────────────────────────────────────────
  US: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'USD', tipping: '15-20% expected' },
  CA: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'CAD', tipping: '15-20% expected' },
  MX: { plug: 'Type A/B', voltage: '127V', emergency: '911', driving: 'right', currency: 'MXN', tipping: '10-15% expected' },
  BR: { plug: 'Type N', voltage: '127V/220V', emergency: '190', driving: 'right', currency: 'BRL', tipping: '10% often included' },
  AR: { plug: 'Type C/I', voltage: '220V', emergency: '911', driving: 'right', currency: 'ARS', tipping: '10% customary' },
  CL: { plug: 'Type C/L', voltage: '220V', emergency: '133', driving: 'right', currency: 'CLP', tipping: '10% customary' },
  CO: { plug: 'Type A/B', voltage: '110V', emergency: '123', driving: 'right', currency: 'COP', tipping: '10% often included' },
  PE: { plug: 'Type A/B/C', voltage: '220V', emergency: '105', driving: 'right', currency: 'PEN', tipping: '10% customary' },
  EC: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'USD', tipping: '10% often included' },
  UY: { plug: 'Type C/L', voltage: '220V', emergency: '911', driving: 'right', currency: 'UYU', tipping: '10% often included' },
  PA: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'USD', tipping: '10% often included' },
  CR: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'CRC', tipping: '10% often included' },
  GT: { plug: 'Type A/B', voltage: '120V', emergency: '110', driving: 'right', currency: 'GTQ', tipping: '10% customary' },
  DO: { plug: 'Type A/B', voltage: '120V', emergency: '911', driving: 'right', currency: 'DOP', tipping: '10% often included' },
  JM: { plug: 'Type A/B', voltage: '110V', emergency: '119', driving: 'left', currency: 'JMD', tipping: '10-15% expected' },

  // ── Asia-Pacific ───────────────────────────────────────────────────────
  SG: { plug: 'Type G', voltage: '230V', emergency: '999', driving: 'left', currency: 'SGD', tipping: 'Not expected' },
  JP: { plug: 'Type A/B', voltage: '100V', emergency: '110', driving: 'left', currency: 'JPY', tipping: 'Not expected, can offend' },
  TH: { plug: 'Type A/C/O', voltage: '220V', emergency: '191', driving: 'left', currency: 'THB', tipping: '10% appreciated' },
  VN: { plug: 'Type A/C', voltage: '220V', emergency: '113', driving: 'right', currency: 'VND', tipping: 'Not required, appreciated' },
  MY: { plug: 'Type G', voltage: '230V', emergency: '999', driving: 'left', currency: 'MYR', tipping: 'Not expected, round up' },
  ID: { plug: 'Type C/F', voltage: '230V', emergency: '112', driving: 'left', currency: 'IDR', tipping: '10% appreciated' },
  AU: { plug: 'Type I', voltage: '230V', emergency: '000', driving: 'left', currency: 'AUD', tipping: 'Not expected' },
  NZ: { plug: 'Type I', voltage: '230V', emergency: '111', driving: 'left', currency: 'NZD', tipping: 'Not expected' },
  KR: { plug: 'Type C/F', voltage: '220V', emergency: '112', driving: 'right', currency: 'KRW', tipping: 'Not expected, can offend' },
  CN: { plug: 'Type A/C/I', voltage: '220V', emergency: '110', driving: 'right', currency: 'CNY', tipping: 'Not customary' },
  TW: { plug: 'Type A/B', voltage: '110V', emergency: '110', driving: 'right', currency: 'TWD', tipping: 'Not expected' },
  HK: { plug: 'Type G', voltage: '220V', emergency: '999', driving: 'left', currency: 'HKD', tipping: '10% often included' },
  PH: { plug: 'Type A/B/C', voltage: '220V', emergency: '911', driving: 'right', currency: 'PHP', tipping: '10% appreciated' },
  IN: { plug: 'Type C/D/M', voltage: '230V', emergency: '112', driving: 'left', currency: 'INR', tipping: '10% appreciated' },
  LK: { plug: 'Type D/G/M', voltage: '230V', emergency: '119', driving: 'left', currency: 'LKR', tipping: '10% appreciated' },
  KH: { plug: 'Type A/C/G', voltage: '230V', emergency: '117', driving: 'right', currency: 'KHR', tipping: 'Appreciated, not required' },
  LA: { plug: 'Type A/B/C', voltage: '230V', emergency: '191', driving: 'right', currency: 'LAK', tipping: 'Appreciated, not required' },
  MO: { plug: 'Type G', voltage: '220V', emergency: '999', driving: 'left', currency: 'MOP', tipping: '10% often included' },

  // ── Middle East ────────────────────────────────────────────────────────
  AE: { plug: 'Type G', voltage: '230V', emergency: '999', driving: 'right', currency: 'AED', tipping: '10-15% often included' },
  QA: { plug: 'Type G', voltage: '240V', emergency: '999', driving: 'right', currency: 'QAR', tipping: '10% appreciated' },
  SA: { plug: 'Type G', voltage: '230V', emergency: '911', driving: 'right', currency: 'SAR', tipping: '10% appreciated' },
  IL: { plug: 'Type C/H/M', voltage: '230V', emergency: '100', driving: 'right', currency: 'ILS', tipping: '10-12% customary' },
  TR: { plug: 'Type F', voltage: '230V', emergency: '112', driving: 'right', currency: 'TRY', tipping: '10% customary' },
  JO: { plug: 'Type B/C/D/F/G/J', voltage: '230V', emergency: '911', driving: 'right', currency: 'JOD', tipping: '10% customary' },
  OM: { plug: 'Type G', voltage: '240V', emergency: '9999', driving: 'right', currency: 'OMR', tipping: '10% appreciated' },
  KW: { plug: 'Type G', voltage: '240V', emergency: '112', driving: 'right', currency: 'KWD', tipping: '10% appreciated' },
  BH: { plug: 'Type G', voltage: '230V', emergency: '999', driving: 'right', currency: 'BHD', tipping: '10% appreciated' },

  // ── Africa ─────────────────────────────────────────────────────────────
  ZA: { plug: 'Type M', voltage: '230V', emergency: '10111', driving: 'left', currency: 'ZAR', tipping: '10% customary' },
  EG: { plug: 'Type C/F', voltage: '220V', emergency: '122', driving: 'right', currency: 'EGP', tipping: '10% often expected' },
  MA: { plug: 'Type C/E', voltage: '220V', emergency: '19', driving: 'right', currency: 'MAD', tipping: '10% customary' },
  KE: { plug: 'Type G', voltage: '240V', emergency: '999', driving: 'left', currency: 'KES', tipping: '10% appreciated' },
  TZ: { plug: 'Type D/G', voltage: '230V', emergency: '112', driving: 'left', currency: 'TZS', tipping: '10% appreciated' },
  NG: { plug: 'Type D/G', voltage: '230V', emergency: '112', driving: 'right', currency: 'NGN', tipping: '10% appreciated' },
  GH: { plug: 'Type D/G', voltage: '230V', emergency: '112', driving: 'right', currency: 'GHS', tipping: '10% appreciated' },
  TN: { plug: 'Type C/E', voltage: '230V', emergency: '197', driving: 'right', currency: 'TND', tipping: '10% customary' },
  NA: { plug: 'Type D/M', voltage: '220V', emergency: '10111', driving: 'left', currency: 'NAD', tipping: '10% customary' },
}

/** Facts for a country by ISO alpha-2 code (case-insensitive), or null if unknown. */
export function countryFacts(code) {
  if (!code) return null
  return FACTS[String(code).toUpperCase().trim()] ?? null
}
