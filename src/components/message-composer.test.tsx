import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageComposer } from './message-composer'

describe('MessageComposer', () => {
  it('keeps message entry and send disabled before peer verification', () => {
    render(<MessageComposer enabled={false} onSend={vi.fn()} />)

    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByPlaceholderText('A verified peer connection is required')).toBeDisabled()
  })
})

