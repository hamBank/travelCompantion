import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DocumentViewer from '../components/DocumentViewer.jsx'
import * as api from '../api.js'
import { createVaultOfflineStore, memoryAdapter } from '../vaultOfflineStore.js'

vi.mock('../api.js')

const doc = { id: 1, label: 'US Passport', doc_type: 'passport' }
const file = { id: 10, filename: 'passport.jpg', content_type: 'image/jpeg' }

let store

beforeEach(() => {
  vi.clearAllMocks()
  store = createVaultOfflineStore(memoryAdapter())
})

describe('DocumentViewer', () => {
  it('renders from the offline cache without calling the network fetch', async () => {
    const blob = new Blob(['cached'], { type: 'image/jpeg' })
    await store.put(file.id, blob, 'image/jpeg')

    render(<DocumentViewer doc={doc} files={[file]} initialFileId={file.id} onClose={() => {}} store={store} />)

    await waitFor(() => expect(screen.getByAltText('passport.jpg')).toBeTruthy())
    expect(api.fetchDocumentFileBlob).not.toHaveBeenCalled()
  })

  it('falls back to a network fetch when not cached', async () => {
    const blob = new Blob(['fresh'], { type: 'image/jpeg' })
    api.fetchDocumentFileBlob.mockResolvedValue(blob)

    render(<DocumentViewer doc={doc} files={[file]} initialFileId={file.id} onClose={() => {}} store={store} />)

    await waitFor(() => expect(api.fetchDocumentFileBlob).toHaveBeenCalledWith(doc.id, file.id))
    await waitFor(() => expect(screen.getByAltText('passport.jpg')).toBeTruthy())
  })

  it('shows a message when the file is unavailable offline and not fetchable', async () => {
    api.fetchDocumentFileBlob.mockResolvedValue(null)

    render(<DocumentViewer doc={doc} files={[file]} initialFileId={file.id} onClose={() => {}} store={store} />)

    expect(await screen.findByText('Not available offline')).toBeTruthy()
  })
})
