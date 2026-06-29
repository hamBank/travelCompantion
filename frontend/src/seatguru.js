/**
 * SeatGuru deep-link builder for flight seatmaps.
 *
 * SeatGuru URL format:
 *   https://www.seatguru.com/findseatmap/findseatmap.php?airline=QR&flight=40&date=2026-08-19
 */

const SEATGURU_BASE = 'https://www.seatguru.com/findseatmap/findseatmap.php'

/**
 * Build a SeatGuru URL for the given flight.
 *
 * @param {string|null} flightNumber  e.g. "QR 40", "AY132", "AZ 1620"
 * @param {string|null} departTime    ISO datetime "YYYY-MM-DDTHH:MM" or date only
 * @returns {string|null}             Full SeatGuru URL, or null if inputs are insufficient
 */
export function seatguruUrl(flightNumber, departTime) {
  if (!flightNumber) return null

  const m = String(flightNumber).replace(/\s/g, '').match(/^([A-Z]{2,3})(\d+)/i)
  if (!m) return null

  const airline = m[1].toUpperCase()
  const flight  = m[2]
  const date    = departTime ? String(departTime).slice(0, 10) : null

  const params = new URLSearchParams({ airline, flight })
  if (date) params.set('date', date)

  return `${SEATGURU_BASE}?${params}`
}
