import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ExpenseQuickAdd from '../components/ExpenseQuickAdd.jsx'
import * as api from '../api.js'
import { HOME_CURRENCY_KEY } from '../currency.js'

vi.mock('../api.js')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem(HOME_CURRENCY_KEY, 'AUD')
  api.createExpense.mockResolvedValue({ id: 1 })
  api.updateExpense.mockResolvedValue({ id: 1 })
})

describe('ExpenseQuickAdd — create', () => {
  it('falls back to AUD (matching BudgetSummary\'s own fallback) when no home currency is set, rather than stamping an empty currency label', async () => {
    localStorage.removeItem(HOME_CURRENCY_KEY)
    global.fetch = vi.fn()
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '150 AUD' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Taxi' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.createExpense).toHaveBeenCalled())
    expect(api.createExpense.mock.calls[0][1].converted_currency).toBe('AUD')
  })

  it('saves an expense already in the home currency without calling convertCurrency (no fetch)', async () => {
    global.fetch = vi.fn()
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '120 AUD' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Taxi' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(api.createExpense).toHaveBeenCalled())
    const [tripId, body] = api.createExpense.mock.calls[0]
    expect(tripId).toBe(9)
    expect(body).toMatchObject({
      name: 'Taxi', amount: '120 AUD',
      converted_amount: 120, converted_currency: 'AUD',
      stop_id: null, item_id: null,
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('converts a foreign-currency amount via /currency/convert before saving', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ result: 21.5 }),
    })
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '500 THB' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Souvenirs' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(api.createExpense).toHaveBeenCalled())
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/currency/convert'))
    const [, body] = api.createExpense.mock.calls[0]
    expect(body.converted_amount).toBe(21.5)
    expect(body.converted_currency).toBe('AUD')
  })

  it('pre-fills stop_id from the stopId prop', async () => {
    global.fetch = vi.fn()
    render(<ExpenseQuickAdd tripId={9} stopId={3} onSaved={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '20 AUD' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Snack' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.createExpense).toHaveBeenCalled())
    expect(api.createExpense.mock.calls[0][1].stop_id).toBe(3)
  })

  it('shows an inline error and does not call the API for an unrecognizable amount', async () => {
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: 'lots' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Mystery' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText(/Couldn't recognize a currency amount/)).toBeTruthy()
    expect(api.createExpense).not.toHaveBeenCalled()
  })

  it('does not show the item-link select when no items are provided', () => {
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/Link to a planned item/)).toBeNull()
  })

  it('shows and wires the item-link select when items are provided', async () => {
    global.fetch = vi.fn()
    const items = [{ id: 42, name: 'Louvre tickets' }]
    render(<ExpenseQuickAdd tripId={9} items={items} onSaved={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '20 AUD' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'Tickets' } })
    fireEvent.change(screen.getByText(/Link to a planned item/).closest('label').querySelector('select'), { target: { value: '42' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.createExpense).toHaveBeenCalled())
    expect(api.createExpense.mock.calls[0][1].item_id).toBe(42)
  })

  it('surfaces the API error and re-enables the form on failure', async () => {
    global.fetch = vi.fn()
    api.createExpense.mockRejectedValue(new Error('Server exploded'))
    render(<ExpenseQuickAdd tripId={9} onSaved={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Amount (e.g. 500 THB)'), { target: { value: '20 AUD' } })
    fireEvent.change(screen.getByPlaceholderText('What was it for?'), { target: { value: 'X' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Server exploded')).toBeTruthy()
  })
})

describe('ExpenseQuickAdd — edit', () => {
  it('pre-fills fields from the expense prop and calls updateExpense on save', async () => {
    global.fetch = vi.fn()
    const expense = {
      id: 5, name: 'Taxi', amount: '100 AUD', occurred_at: '2026-08-01T00:00:00',
      item_id: null, notes: 'to the airport',
    }
    render(<ExpenseQuickAdd tripId={9} expense={expense} onSaved={() => {}} onClose={() => {}} />)
    expect(screen.getByDisplayValue('Taxi')).toBeTruthy()
    expect(screen.getByDisplayValue('100 AUD')).toBeTruthy()
    expect(screen.getByDisplayValue('to the airport')).toBeTruthy()

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.updateExpense).toHaveBeenCalledWith(5, expect.objectContaining({ name: 'Taxi' })))
    expect(api.createExpense).not.toHaveBeenCalled()
  })
})
