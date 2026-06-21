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
  return isNaN(num) || num <= 0 ? null : num
}

/**
 * Convert `amount` from `fromCode` to `toCode` using the Frankfurter API.
 * Returns the converted number rounded to 2dp, or null on failure.
 */
export async function convertCurrency(amount, fromCode, toCode) {
  if (!fromCode || !toCode || fromCode === toCode) return amount
  try {
    const url = `https://api.frankfurter.app/latest?amount=${amount}&from=${fromCode}&to=${toCode}`
    const r = await fetch(url)
    if (!r.ok) return null
    const data = await r.json()
    const result = data.rates?.[toCode]
    return result != null ? Math.round(result * 100) / 100 : null
  } catch {
    return null
  }
}

/** Format a numeric amount in a given ISO currency code for display. */
export function formatAmount(amount, code) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${code} ${amount}`
  }
}

export const HOME_CURRENCY_KEY = 'tc-home-currency'
export const getHomeCurrency = () => localStorage.getItem(HOME_CURRENCY_KEY) || ''
export const setHomeCurrency = (code) => localStorage.setItem(HOME_CURRENCY_KEY, code)
