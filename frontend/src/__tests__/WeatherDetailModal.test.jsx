import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({ getHourlyWeather: vi.fn() }))
import { getHourlyWeather } from '../api.js'
import WeatherDetailModal from '../components/WeatherDetailModal.jsx'

beforeEach(() => vi.clearAllMocks())

const HOURLY = {
  date: '2026-07-22',
  hourly: [
    { time: '00:00', temp: 18.0, feels_like: 17.0, precip_prob: 0, humidity: 60, wind: 8.0, uv: 0, icon: '☀', desc: 'Clear' },
    { time: '12:00', temp: 28.0, feels_like: 30.0, precip_prob: 40, humidity: 55, wind: 15.0, uv: 6.5, icon: '🌦', desc: 'Light showers' },
  ],
  sunrise: '06:12', sunset: '20:45', uv_max: 6.5, precip_sum: 1.2, precip_prob_max: 40,
}

describe('WeatherDetailModal', () => {
  it('fetches hourly weather for the given date and source, and renders it', async () => {
    getHourlyWeather.mockResolvedValue({ hourly: HOURLY })
    render(
      <WeatherDetailModal
        dateKey="2026-07-22"
        source={{ lat: 48.85, lng: 2.35, query: '' }}
        onClose={() => {}}
      />
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect(getHourlyWeather).toHaveBeenCalledWith(48.85, 2.35, '2026-07-22', ''))

    expect(await screen.findByText('06:12')).toBeInTheDocument()
    expect(screen.getByText('20:45')).toBeInTheDocument()
    expect(screen.getByText('UV max 6.5')).toBeInTheDocument()
    expect(screen.getByText('00:00')).toBeInTheDocument()
    expect(screen.getByText('12:00')).toBeInTheDocument()
    expect(screen.getByText('28°C')).toBeInTheDocument()
    expect(screen.getByText('feels 30°')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    getHourlyWeather.mockRejectedValue(new Error('Hourly forecast unavailable'))
    render(<WeatherDetailModal dateKey="2026-07-22" source={{}} onClose={() => {}} />)
    expect(await screen.findByText('Hourly forecast unavailable')).toBeInTheDocument()
  })

  it('closes on backdrop click and on the close button', () => {
    getHourlyWeather.mockResolvedValue({ hourly: HOURLY })
    const onClose = vi.fn()
    const { container } = render(<WeatherDetailModal dateKey="2026-07-22" source={{}} onClose={onClose} />)
    fireEvent.click(container.firstChild)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders a daily-detail card (not an hourly list) when the backend falls back', async () => {
    const DAILY = {
      date: '2026-07-22', granularity: 'daily',
      tmin: 24.0, tmax: 31.0, feels_min: 27.0, feels_max: 36.0, wind_max: 18.0,
      icon: '🌧', desc: 'Light rain',
      sunrise: '06:50', sunset: '19:05', uv_max: 9.1, precip_sum: 12.4, precip_prob_max: 80,
    }
    getHourlyWeather.mockResolvedValue({ hourly: DAILY })
    render(<WeatherDetailModal dateKey="2026-07-22" source={{ lat: 1.35, lng: 103.82, query: '' }} onClose={() => {}} />)

    expect(await screen.findByText('Light rain')).toBeInTheDocument()
    expect(screen.getByText('24–31°C')).toBeInTheDocument()
    expect(screen.getByText('feels 27–36°')).toBeInTheDocument()
    expect(screen.getByText(/up to 18km\/h/)).toBeInTheDocument()
    expect(screen.getByText(/isn't available for this location/)).toBeInTheDocument()
    // The hourly per-time-slot rows must not render for a daily fallback.
    expect(screen.queryByText('00:00')).not.toBeInTheDocument()
    // The shared sunrise/sunset/UV summary strip still renders.
    expect(screen.getByText('06:50')).toBeInTheDocument()
    expect(screen.getByText('UV max 9.1')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    getHourlyWeather.mockResolvedValue({ hourly: HOURLY })
    const onClose = vi.fn()
    render(<WeatherDetailModal dateKey="2026-07-22" source={{}} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
