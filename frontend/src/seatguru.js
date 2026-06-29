/**
 * Seatmap deep-link builder — uses AeroLOPA (aerolopa.com).
 *
 * SeatGuru was shut down by TripAdvisor in October 2025.
 * AeroLOPA is the leading replacement with the most comprehensive,
 * up-to-date aircraft seat maps.
 *
 * AeroLOPA URL: https://aerolopa.com/{AIRLINE_IATA}
 * e.g. QR → https://aerolopa.com/QR  (Qatar Airways cabin map)
 *      AY → https://aerolopa.com/AY  (Finnair)
 *
 * Note: unlike the old SeatGuru, no service currently supports
 * deep-linking directly to a specific flight number + date.
 */

const AEROLOPA_BASE = 'https://aerolopa.com'

/**
 * Build an AeroLOPA URL for the airline operating the given flight.
 *
 * @param {string|null} flightNumber  e.g. "QR 40", "AY132", "AZ 1620"
 * @param {string|null} _departTime   Unused — kept for API compatibility
 * @returns {string|null}             AeroLOPA airline URL, or null if inputs are insufficient
 */
export function seatguruUrl(flightNumber, _departTime) {
  if (!flightNumber) return null

  const m = String(flightNumber).replace(/\s/g, '').match(/^([A-Z]{2,3})\d+/i)
  if (!m) return null

  const airline = m[1].toUpperCase()
  return `${AEROLOPA_BASE}/${airline}`
}
