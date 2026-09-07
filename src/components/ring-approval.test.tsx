import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RingApproval } from './ring-approval'

const AUTHORIZATION_URL = 'pubkyauth://signin_grant?caps=%2Fpub%2Fpubky2pubky%2F%3Arw&relay=https%3A%2F%2Frelay.example%2Flink&secret=synthetic-request-a&cid=ring-approval-test'
const NEXT_AUTHORIZATION_URL = AUTHORIZATION_URL.replace('synthetic-request-a', 'synthetic-request-b')
const writeText = vi.fn<(value: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RingApproval', () => {
  it('shows a local QR and device actions only while an approval request exists', () => {
    const { container, rerender } = render(<RingApproval authorizationUrl={null} />)
    expect(screen.queryByRole('img', { name: 'Pubky Ring approval QR code' })).not.toBeInTheDocument()

    rerender(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)

    const qr = screen.getByRole('img', { name: 'Pubky Ring approval QR code' })
    expect(qr.tagName.toLowerCase()).toBe('svg')
    expect(qr.querySelector('path')).not.toBeNull()
    expect(qr.closest('[data-sentry-block]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open Ring on this device' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Copy approval link' })).toBeEnabled()
    expect(container.querySelector('a, img, image')).toBeNull()
    expect(container.innerHTML).not.toContain('pubkyauth:')
    expect(container.innerHTML).not.toContain('synthetic-request-a')

    rerender(<RingApproval authorizationUrl={null} />)
    expect(screen.queryByRole('img', { name: 'Pubky Ring approval QR code' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy approval link' })).not.toBeInTheDocument()
  })

  it('copies the current validated request unchanged and resets feedback for its replacement', async () => {
    const { rerender } = render(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))

    expect(writeText).toHaveBeenCalledExactlyOnceWith(AUTHORIZATION_URL)
    expect(await screen.findByText('Approval link copied.')).toBeInTheDocument()

    rerender(<RingApproval authorizationUrl={NEXT_AUTHORIZATION_URL} />)
    expect(screen.queryByText('Approval link copied.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))
    expect(writeText).toHaveBeenLastCalledWith(NEXT_AUTHORIZATION_URL)
    expect(await screen.findByText('Approval link copied.')).toBeInTheDocument()
  })

  it('reports clipboard rejection without exposing error details', async () => {
    writeText.mockRejectedValueOnce(new Error(`clipboard refused ${AUTHORIZATION_URL}`))
    const { container } = render(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))

    expect(await screen.findByText(/Could not copy the approval link/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy approval link' })).toBeEnabled()
    expect(container.innerHTML).not.toContain('synthetic-request-a')
  })

  it('offers QR and same-device actions when the clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    render(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))

    expect(await screen.findByText(/Could not copy the approval link/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Pubky Ring approval QR code' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Ring on this device' })).toBeEnabled()
  })

  it.each(['resolve', 'reject'] as const)('ignores a stale clipboard %s after the request changes', async (outcome) => {
    let settleCopy: (() => void) | undefined
    const pendingCopy = new Promise<void>((resolve, reject) => {
      settleCopy = outcome === 'resolve' ? resolve : () => reject(new Error('stale clipboard failure'))
    })
    writeText.mockReturnValueOnce(pendingCopy)
    const { rerender } = render(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))
    expect(screen.getByRole('button', { name: 'Copy approval link' })).toBeDisabled()

    rerender(<RingApproval authorizationUrl={NEXT_AUTHORIZATION_URL} />)
    await act(async () => {
      settleCopy?.()
      await pendingCopy.catch(() => undefined)
    })

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('button', { name: 'Copy approval link' })).toBeEnabled()
  })

  it('can finish a pending clipboard request after the panel unmounts', async () => {
    let settleCopy: (() => void) | undefined
    const pendingCopy = new Promise<void>((resolve) => { settleCopy = resolve })
    writeText.mockReturnValueOnce(pendingCopy)
    const { unmount, container } = render(<RingApproval authorizationUrl={AUTHORIZATION_URL} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy approval link' }))

    unmount()
    await act(async () => {
      settleCopy?.()
      await pendingCopy
    })

    expect(container).toBeEmptyDOMElement()
  })
})
