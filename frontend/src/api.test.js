import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTrips, updateTrip, deleteTrip, updateItemStatus } from './api.js'

function mockFetch(status, body) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body ? JSON.stringify(body) : ''),
  })
}

beforeEach(() => { vi.restoreAllMocks() })

describe('getTrips', () => {
  it('calls GET /trips/', async () => {
    mockFetch(200, [{ id: 1, name: 'Trip A' }])
    const result = await getTrips()
    expect(fetch).toHaveBeenCalledWith('/trips/', expect.any(Object))
    expect(result[0].name).toBe('Trip A')
  })
})

describe('updateTrip', () => {
  it('sends PATCH with correct payload', async () => {
    mockFetch(200, { id: 1, name: 'New Name', start_date: '2026-06-01T00:00:00', end_date: null })
    await updateTrip(1, { name: 'New Name', start_date: '2026-06-01T00:00:00' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/trips/1')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toMatchObject({ name: 'New Name' })
  })
})

describe('deleteTrip', () => {
  it('sends DELETE and returns null on 204', async () => {
    mockFetch(204, null)
    const result = await deleteTrip(1)
    expect(fetch).toHaveBeenCalledWith('/trips/1', expect.objectContaining({ method: 'DELETE' }))
    expect(result).toBeNull()
  })
})

describe('updateItemStatus', () => {
  it('sends PATCH with status field', async () => {
    mockFetch(200, { id: 5, status: 'done' })
    await updateItemStatus(5, 'done')
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/items/5')
    expect(JSON.parse(opts.body)).toEqual({ status: 'done' })
  })
})

describe('error handling', () => {
  it('throws with detail message on 404', async () => {
    mockFetch(404, { detail: 'Trip not found' })
    await expect(getTrips()).rejects.toThrow('Trip not found')
  })

  it('throws generic message on non-JSON error response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: () => Promise.resolve('<html>Internal Server Error</html>'),
    })
    await expect(getTrips()).rejects.toThrow('Server error 500')
  })
})
