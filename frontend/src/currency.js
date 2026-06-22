// Maps common symbols/prefixes to ISO 4217 currency codes.
// Order matters — longer matches must come first.
const SYMBOL_MAP = [
  ['A$',  'AUD'], ['C$',  'CAD'], ['NZ$', 'NZD'], ['HK$', 'HKD'],
  ['S$',  'SGD'], ['MX$', 'MXN'], ['R$',  'BRL'],
  ['CHF', 'CHF'], ['SEK', 'SEK'], ['NOK', 'NOK'], ['DKK', 'DKK'],
  ['PLN', 'PLN'], ['CZK', 'CZK'], ['HUF', 'HUF'], ['RON', 'RON'],
  ['AED', 'AED'], ['SAR', 'SAR'], ['QAR', 'QAR'], ['KWD', 'KWD'],
  ['MYR', 'MYR'], ['PHP', 'PHP'], ['IDR', 'IDR'], ['VND', 'VND'],
  ['TWD', 'TWD'], ['KRW', 'KRW'], ['INR', 'INR'], ['PKR', 'PKR'],
  ['BDT', 'BDT'], ['LKR', 'LKR'], ['NPR', 'NPR'],
  ['ZAR', 'ZAR'], ['NGN', 'NGN'], ['EGP', 'EGP'], ['KES', 'KES'],
  ['GHS', 'GHS'], ['TZS', 'TZS'],
  ['USD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['JPY', 'JPY'],
  ['THB', 'THB'], ['SGD', 'SGD'], ['CNY', 'CNY'], ['RUB', 'RUB'],
  ['TRY', 'TRY'], ['MXN', 'MXN'], ['ARS', 'ARS'], ['CLP', 'CLP'],
  ['COP', 'COP'], ['PEN', 'PEN'], ['UAH', 'UAH'],
  ['RM',  'MYR'], ['Rp',  'IDR'], ['Rs',  'INR'],
  ['kr',  'SEK'],
  ['$',   'USD'], ['€',   'EUR'], ['£',   'GBP'],
  ['¥',   'JPY'], ['₹',   'INR'], ['₩',   'KRW'],
  ['฿',   'THB'], ['₺',   'TRY'], ['₫',   'VND'],
  ['₽',   'RUB'], ['₴',   'UAH'], ['₦',   'NGN'],
  ['zł',  'PLN'], ['R',   'ZAR'],
]

/**
 * Parse a free-text cost string into { amount, code }.
 * Returns null if no recognisable currency + numeric amount is found.
 */
export function parseCost(str) {
  if (!str) return null
  const s = str.trim()

  // Try symbol/code prefix (longest first)
  for (const [sym, code] of SYMBOL_MAP) {
    if (s.startsWith(sym)) {
      const rest = s.slice(sym.length).trim()
      const num = extractNumber(rest)
      if (num !== null) return { amount: num, code }
    }
  }

  // Try ISO code suffix: "120 USD", "450EUR"
  const isoSuffix = s.match(/^([\d,.\s]+)\s*([A-Z]{3})$/i)
  if (isoSuffix) {
    const num = extractNumber(isoSuffix[1])
    if (num !== null) return { amount: num, code: isoSuffix[2].toUpperCase() }
  }

  // Try ISO code prefix: "USD 120"
  const isoPrefix = s.match(/^([A-Z]{3})\s*([\d,.]+)/i)
  if (isoPrefix) {
    const num = extractNumber(isoPrefix[2])
    if (num !== null) return { amount: num, code: isoPrefix[1].toUpperCase() }
  }

  return null
}

function extractNumber(str) {
  // Strip anything that isn't a digit, comma, or dot; remove commas used as thousands separators
  const cleaned = str.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}(?:[^\d]|$))/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) || num < 0 ? null : num
}

/**
 * Convert `amount` from `fromCode` to `toCode` via the backend proxy.
 * Returns the converted number rounded to 2dp, or throws on failure.
 */
export async function convertCurrency(amount, fromCode, toCode) {
  if (!fromCode || !toCode || fromCode === toCode) return amount
  const url = `/currency/convert?amount=${amount}&from_currency=${encodeURIComponent(fromCode)}&to_currency=${encodeURIComponent(toCode)}`
  const r = await fetch(url)
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.detail ?? `Currency conversion failed (${r.status})`)
  }
  const data = await r.json()
  return data.result
}

// Currencies with unambiguous globally-recognised symbols
const UNIQUE_SYMBOLS = {
  EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', INR: '₹',
  THB: '฿', TRY: '₺', VND: '₫', RUB: '₽', UAH: '₴',
  NGN: '₦', ILS: '₪', BRL: 'R$', MYR: 'RM', IDR: 'Rp',
  PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
}

// Currencies that share "$" — [natural symbol, disambiguating prefix]
const DOLLAR_CURRENCIES = {
  USD: ['$', 'US$'], AUD: ['$', 'A$'], CAD: ['$', 'C$'],
  NZD: ['$', 'NZ$'], SGD: ['$', 'S$'], HKD: ['$', 'HK$'],
  MXN: ['$', 'Mex$'], TWD: ['$', 'NT$'],
}

// Currencies that share "kr"
const KR_CURRENCIES = {
  SEK: 'kr', NOK: 'kr', DKK: 'kr',
}

// Currencies with no known symbol — zero-decimal
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'GNF', 'ISK', 'PYG', 'RWF', 'UGX', 'XAF', 'XOF'])

/**
 * Format amount in `code`, disambiguating against `homeCode` where symbols conflict.
 * When `code === homeCode`, always uses the natural/short symbol.
 */
export function formatCurrencyAmount(amount, code, homeCode = '') {
  if (!code) return amount.toFixed(2)
  const decimals = ZERO_DECIMAL.has(code) ? 0 : 2
  const n = amount.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

  // Unique symbol — no ambiguity possible
  if (UNIQUE_SYMBOLS[code]) {
    const sym = UNIQUE_SYMBOLS[code]
    // suffix symbols (zł, Kč, Ft, kr)
    return sym.length > 2 || sym === 'zł' || sym === 'Kč' || sym === 'Ft'
      ? `${n} ${sym}` : `${sym}${n}`
  }

  // Dollar-family — use prefix when foreign vs home
  if (DOLLAR_CURRENCIES[code]) {
    const [natural, prefix] = DOLLAR_CURRENCIES[code]
    const ambiguous = homeCode && DOLLAR_CURRENCIES[homeCode] && code !== homeCode
    return `${ambiguous ? prefix : natural}${n}`
  }

  // Kr-family — disambiguate with ISO code when foreign vs home
  if (KR_CURRENCIES[code]) {
    const ambiguous = homeCode && KR_CURRENCIES[homeCode] && code !== homeCode
    return ambiguous ? `${n} ${code}` : `${n} kr`
  }

  // Fallback: Intl then bare ISO code
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code, maximumFractionDigits: decimals,
    }).format(amount)
  } catch {
    return `${code} ${n}`
  }
}

/** @deprecated Use formatCurrencyAmount instead */
export function formatAmount(amount, code) {
  return formatCurrencyAmount(amount, code)
}

export const HOME_CURRENCY_KEY = 'tc-home-currency'
export const getHomeCurrency = () => localStorage.getItem(HOME_CURRENCY_KEY) || ''
export const setHomeCurrency = (code) => localStorage.setItem(HOME_CURRENCY_KEY, code)
