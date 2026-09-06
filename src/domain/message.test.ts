import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_BYTES, MessageValidationError, validateMessageBody } from './message'

describe('message validation', () => {
  it('accepts exactly 4,096 UTF-8 bytes', () => {
    const body = 'a'.repeat(MAX_MESSAGE_BYTES)
    expect(validateMessageBody(body)).toBe(body)
  })

  it('rejects larger messages and invalid Unicode', () => {
    expect(() => validateMessageBody('a'.repeat(MAX_MESSAGE_BYTES + 1))).toThrow(MessageValidationError)
    expect(() => validateMessageBody('\ud800')).toThrow(MessageValidationError)
  })
})

