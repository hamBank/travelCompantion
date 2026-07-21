import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  updateStopStatus: vi.fn(), updateItemStatus: vi.fn(), getWeather: vi.fn(),
  fetchRiverMapBlob: vi.fn(), fetchGpxMapBlob: vi.fn(), fetchDayMapBlob: vi.fn(),
  getHourlyWeather: vi.fn(),
  // Unused by these tests — stubbed only because StopCard.jsx (via
  // offlineQueue.js) imports these named exports at module load time.
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))
import { getHourlyWeather } from '../api.js'
import { DayBanner } from '../components/StopCard.jsx'

describe('DayBanner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the formatted date', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.textContent).toContain('Jul')
    expect(container.textContent).toContain('22')
  })

  it('appends the weather icon and rounded min–max when provided', () => {
    const wx = { icon: '☀', tmin: 20.6, tmax: 30.4, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).toContain('☀')
    expect(container.textContent).toContain('21–30°C')  // rounded, with unit
  })

  it('shows rounded wind with a wind icon and km/h unit when present', () => {
    const wx = { icon: '☀', tmin: 20, tmax: 30, wind: 14.6, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).toContain('15km/h')
    // Wind glyph is now a lucide SVG (theme-tinted), not the 💨 emoji.
    expect(container.querySelector('svg.lucide-wind')).toBeTruthy()
  })

  it('omits wind when not provided', () => {
    const wx = { icon: '☀', tmin: 20, tmax: 30, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).not.toContain('💨')
  })

  it('flags climatology data with "avg" but not live forecasts', () => {
    const climo = { icon: '⛅', tmin: 19, tmax: 32, desc: 'Partly cloudy', source: 'climatology' }
    const { container: c1 } = render(<DayBanner dateKey="2026-07-22" weather={climo} />)
    expect(c1.textContent).toContain('avg')

    const live = { icon: '☀', tmin: 15, tmax: 25, desc: 'Clear', source: 'forecast' }
    const { container: c2 } = render(<DayBanner dateKey="2026-07-02" weather={live} />)
    expect(c2.textContent).not.toContain('avg')
  })

  it('shows no weather span when weather is absent', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.textContent).not.toContain('°')
  })

  it('is clickable (and opens the hourly detail modal) only for a live forecast', async () => {
    getHourlyWeather.mockResolvedValue({ hourly: { date: '2026-07-22', hourly: [] } })
    const live = { icon: '☀', tmin: 20, tmax: 30, desc: 'Clear', source: 'forecast' }
    const { container } = render(
      <DayBanner dateKey="2026-07-22" weather={live} weatherSource={{ lat: 1, lng: 2, query: '' }} />
    )
    const banner = container.firstChild
    expect(banner).toHaveAttribute('role', 'button')
    fireEvent.click(banner)
    await waitFor(() => expect(getHourlyWeather).toHaveBeenCalledWith(1, 2, '2026-07-22', ''))
  })

  it('is not clickable for a climatology day', () => {
    const climo = { icon: '⛅', tmin: 19, tmax: 32, desc: 'Partly cloudy', source: 'climatology' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={climo} />)
    expect(container.firstChild).not.toHaveAttribute('role', 'button')
    fireEvent.click(container.firstChild)
    expect(getHourlyWeather).not.toHaveBeenCalled()
  })

  it('is not clickable when there is no weather at all', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.firstChild).not.toHaveAttribute('role', 'button')
  })
})
