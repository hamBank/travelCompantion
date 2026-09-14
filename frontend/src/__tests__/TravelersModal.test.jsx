import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../api.js', () => ({
  getTravelers: vi.fn(),
  createTraveler: vi.fn(),
  updateTraveler: vi.fn(),
  deleteTraveler: vi.fn(),
  getTravelerProfile: vi.fn(),
  putTravelerProfile: vi.fn(),
  deleteTravelerProfile: vi.fn(),
  getTripMembers: vi.fn(),
  listDocuments: vi.fn(),
  getDocumentHolder: vi.fn(),
  getDocumentNumber: vi.fn(),
}))

vi.mock('../online.js', () => ({ useOnline: vi.fn(() => true) }))

import {
  getTravelers, createTraveler, updateTraveler, deleteTraveler,
  getTravelerProfile, putTravelerProfile, deleteTravelerProfile,
  getTripMembers, listDocuments, getDocumentHolder, getDocumentNumber,
} from '../api.js'
import { useOnline } from '../online.js'
import TravelersModal from '../components/TravelersModal.jsx'

const TRIP = { id: 1, name: 'Family Trip', role: 'owner', start_date: '2026-09-01', end_date: '2026-09-20T00:00:00' }

function traveler(overrides = {}) {
  return {
    id: 1, trip_id: 1, user_email: null, display_name: 'Traveler',
    age_band: 'adult', passport_expiry: null, has_profile: false,
    created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useOnline.mockReturnValue(true)
  getTripMembers.mockResolvedValue([])
  listDocuments.mockResolvedValue([])
})

describe('TravelersModal — owner', () => {
  it('renders names and age-band chips, and the you chip for the owner\'s own linked row', async () => {
    getTravelers.mockResolvedValue([
      traveler({ id: 1, display_name: 'Kiddo', age_band: 'child' }),
      traveler({ id: 2, display_name: 'Me', age_band: 'adult', user_email: 'owner@example.com' }),
    ])
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    expect(await screen.findByText('Kiddo')).toBeInTheDocument()
    expect(screen.getByText('Child')).toBeInTheDocument()
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('you')).toBeInTheDocument()
  })

  it('adds a traveler with a link email, and without one', async () => {
    getTravelers.mockResolvedValue([])
    getTripMembers.mockResolvedValue([{ user_email: 'a@x.com', role: 'editor' }])
    createTraveler.mockResolvedValue(traveler({ id: 9 }))
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('No travelers yet.')

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Jamie' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(createTraveler).toHaveBeenCalledWith(1, { display_name: 'Jamie' }))

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Jo' } })
    fireEvent.change(screen.getByPlaceholderText('Link to email (optional)'), { target: { value: 'a@x.com' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(createTraveler).toHaveBeenCalledWith(1, { display_name: 'Jo', user_email: 'a@x.com' }))
  })

  it('edits a traveler\'s name via updateTraveler', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Old Name' })])
    updateTraveler.mockResolvedValue(traveler({ id: 1, display_name: 'New Name' }))
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Old Name')

    fireEvent.click(screen.getByLabelText('Edit name/link'))
    const nameInput = screen.getAllByPlaceholderText('Name')[0]
    fireEvent.change(nameInput, { target: { value: 'New Name' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateTraveler).toHaveBeenCalledWith(1, 1, { display_name: 'New Name', user_email: null }))
  })

  it('removes a traveler via deleteTraveler', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Gone Soon' })])
    deleteTraveler.mockResolvedValue(null)
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Gone Soon')

    fireEvent.click(screen.getByLabelText('Remove'))
    await waitFor(() => expect(deleteTraveler).toHaveBeenCalledWith(1, 1))
  })

  it('Details fetches and shows the profile only after "Show passport details"', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Jamie Smith', has_profile: true })])
    getTravelerProfile.mockResolvedValue({
      full_name: 'JAMIE SMITH', date_of_birth: '1990-04-02', sex: 'F', nationality: 'AUS',
      passport_number: 'PA1', passport_issuing_country: 'AUS', passport_expiry: '2030-04-02T00:00:00',
      email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
      age_at_trip_start: 36,
    })
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Jamie Smith')

    fireEvent.click(screen.getByText('Details'))
    expect(getTravelerProfile).not.toHaveBeenCalled()
    expect(screen.getByText('Show passport details')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Show passport details'))
    await waitFor(() => expect(getTravelerProfile).toHaveBeenCalledWith(1, 1))
    expect(await screen.findByDisplayValue('JAMIE SMITH')).toBeInTheDocument()
    expect(screen.getByDisplayValue('PA1')).toBeInTheDocument()
    expect(screen.getByText(/36 at trip start/)).toBeInTheDocument()
  })

  it('Save sends only the changed keys merged over the loaded profile', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Jamie Smith', has_profile: true })])
    getTravelerProfile.mockResolvedValue({
      full_name: 'JAMIE SMITH', date_of_birth: '1990-04-02', sex: 'F', nationality: 'AUS',
      passport_number: 'PA1', passport_issuing_country: 'AUS', passport_expiry: '2030-04-02T00:00:00',
      email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
      age_at_trip_start: 36,
    })
    putTravelerProfile.mockResolvedValue({})
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Jamie Smith')
    fireEvent.click(screen.getByText('Details'))
    fireEvent.click(screen.getByText('Show passport details'))
    await screen.findByDisplayValue('JAMIE SMITH')

    fireEvent.change(screen.getByLabelText('Meal preference'), { target: { value: 'Vegetarian' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(putTravelerProfile).toHaveBeenCalledWith(1, 1, { meal_preference: 'Vegetarian' }))
  })

  it('collapsing the row (Hide) clears the loaded profile from the DOM', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Jamie Smith', has_profile: true })])
    getTravelerProfile.mockResolvedValue({
      full_name: 'JAMIE SMITH', date_of_birth: '', sex: '', nationality: '',
      passport_number: '', passport_issuing_country: '', passport_expiry: '',
      email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
      age_at_trip_start: null,
    })
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Jamie Smith')
    fireEvent.click(screen.getByText('Details'))
    fireEvent.click(screen.getByText('Show passport details'))
    await screen.findByDisplayValue('JAMIE SMITH')

    fireEvent.click(screen.getByText('Hide'))
    expect(screen.queryByDisplayValue('JAMIE SMITH')).toBeNull()
    expect(screen.queryByText('Show passport details')).toBeNull()
  })

  it('shows an expiry chip for an expiry 3 months after the trip end, not for 9 months', async () => {
    getTravelers.mockResolvedValue([
      traveler({ id: 1, display_name: 'Soon Expiry', passport_expiry: '2026-12-20T00:00:00' }),
      traveler({ id: 2, display_name: 'Fine Expiry', passport_expiry: '2027-06-20T00:00:00' }),
    ])
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Soon Expiry')
    const soonRow = screen.getByText('Soon Expiry').closest('div.group')
    const fineRow = screen.getByText('Fine Expiry').closest('div.group')
    expect(within(soonRow).getByText('Passport expires soon')).toBeInTheDocument()
    expect(within(fineRow).queryByText('Passport expires soon')).toBeNull()
  })

  it('"Fill from my vault" appears only on own row with a passport document, fills the form, and does not save', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Me', user_email: 'owner@example.com' })])
    getTravelerProfile.mockResolvedValue({
      full_name: '', date_of_birth: '', sex: '', nationality: '',
      passport_number: '', passport_issuing_country: '', passport_expiry: '',
      email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
      age_at_trip_start: null,
    })
    listDocuments.mockResolvedValue([{ id: 5, doc_type: 'passport', label: 'US Passport', country: 'USA', expiry_date: '2031-01-01' }])
    getDocumentHolder.mockResolvedValue({ holder_name: 'ME SMITH', nationality: 'USA', date_of_birth: '1990-01-01', sex: 'F' })
    getDocumentNumber.mockResolvedValue({ document_number: 'X1234567' })

    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Me')
    fireEvent.click(screen.getByText('Details'))
    fireEvent.click(screen.getByText('Show passport details'))
    await screen.findByRole('button', { name: 'Fill from my vault' })

    fireEvent.change(screen.getByDisplayValue('Choose a passport document…'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fill from my vault' }))

    await waitFor(() => expect(getDocumentHolder).toHaveBeenCalledWith('5'))
    expect(getDocumentNumber).toHaveBeenCalledWith('5')
    expect(await screen.findByDisplayValue('ME SMITH')).toBeInTheDocument()
    expect(screen.getByDisplayValue('X1234567')).toBeInTheDocument()
    expect(putTravelerProfile).not.toHaveBeenCalled()
  })

  it('shows the not-configured message on a 503 from putTravelerProfile', async () => {
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Jamie Smith' })])
    getTravelerProfile.mockResolvedValue({
      full_name: '', date_of_birth: '', sex: '', nationality: '',
      passport_number: '', passport_issuing_country: '', passport_expiry: '',
      email: '', phone: '', frequent_flyer: [], meal_preference: '', seat_preference: '', notes: '',
      age_at_trip_start: null,
    })
    const err = new Error('Service unavailable'); err.status = 503
    putTravelerProfile.mockRejectedValue(err)
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Jamie Smith')
    fireEvent.click(screen.getByText('Details'))
    fireEvent.click(screen.getByText('Show passport details'))
    await waitFor(() => expect(getTravelerProfile).toHaveBeenCalled())
    await screen.findByText('Save')
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText(/DOCUMENT_ENCRYPTION_KEY/)).toBeInTheDocument()
  })
})

describe('TravelersModal — editor', () => {
  const editorTrip = { ...TRIP, role: 'editor' }

  it('shows "Add me as a traveler" when absent and "Edit my details" once added; Edit/Remove/Details only on own row; no link-email field', async () => {
    getTravelers.mockResolvedValue([
      traveler({ id: 1, display_name: 'Someone Else', user_email: 'other@example.com' }),
    ])
    render(<TravelersModal trip={editorTrip} userEmail="editor@example.com" onClose={() => {}} />)
    await screen.findByText('Someone Else')

    expect(screen.getByText('Add me as a traveler')).toBeInTheDocument()
    expect(screen.queryByLabelText('Edit name/link')).toBeNull()
    expect(screen.queryByLabelText('Remove')).toBeNull()
    expect(screen.queryByText('Details')).toBeNull()
  })

  it('own row gets Details/Edit/Remove with no link-email field', async () => {
    getTravelers.mockResolvedValue([
      traveler({ id: 2, display_name: 'Me Editor', user_email: 'editor@example.com' }),
    ])
    render(<TravelersModal trip={editorTrip} userEmail="editor@example.com" onClose={() => {}} />)
    await screen.findByText('Me Editor')

    expect(screen.getByText('Edit my details')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Edit name/link'))
    expect(screen.queryByPlaceholderText('Link to email (optional)')).toBeNull()
  })
})

describe('TravelersModal — viewer', () => {
  const viewerTrip = { ...TRIP, role: 'viewer' }

  it('has no add/edit controls, and Details only on the viewer\'s own row', async () => {
    getTravelers.mockResolvedValue([
      traveler({ id: 1, display_name: 'Other Person', user_email: 'other@example.com' }),
      traveler({ id: 2, display_name: 'Me Viewer', user_email: 'viewer@example.com' }),
    ])
    render(<TravelersModal trip={viewerTrip} userEmail="viewer@example.com" onClose={() => {}} />)
    await screen.findByText('Other Person')

    expect(screen.queryByPlaceholderText('Name')).toBeNull()
    expect(screen.queryByText('Add me as a traveler')).toBeNull()
    expect(screen.queryAllByLabelText('Edit name/link')).toHaveLength(0)
    expect(screen.queryAllByLabelText('Remove')).toHaveLength(0)
    expect(screen.getAllByText('Details')).toHaveLength(1)
  })
})

describe('TravelersModal — offline', () => {
  it('has no add/edit/details controls', async () => {
    useOnline.mockReturnValue(false)
    getTravelers.mockResolvedValue([traveler({ id: 1, display_name: 'Cached Person', user_email: 'owner@example.com' })])
    render(<TravelersModal trip={TRIP} userEmail="owner@example.com" onClose={() => {}} />)
    await screen.findByText('Cached Person')

    expect(screen.queryByPlaceholderText('Name')).toBeNull()
    expect(screen.queryByText('Details')).toBeNull()
    expect(screen.queryByLabelText('Edit name/link')).toBeNull()
    expect(screen.queryByLabelText('Remove')).toBeNull()
  })
})
