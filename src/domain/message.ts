import type { PubkyId } from './pubky-id'

export const MAX_MESSAGE_BYTES = 4_096

export type MessageDirection = 'inbound' | 'outbound'
export type MessageDelivery = 'sending' | 'sent' | 'failed'

export interface ChatMessage {
  readonly id: string
  readonly ownerId: PubkyId
  readonly peerId: PubkyId
  readonly direction: MessageDirection
  readonly delivery: MessageDelivery
  readonly body: string
  readonly createdAt: number
}

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageValidationError'
  }
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function validateMessageBody(value: string): string {
  if (value.trim().length === 0) {
    throw new MessageValidationError('Write a message first.')
  }
  if (containsUnpairedSurrogate(value)) {
    throw new MessageValidationError('The message contains invalid text.')
  }

  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new MessageValidationError(`Messages are limited to ${MAX_MESSAGE_BYTES.toLocaleString()} bytes.`)
  }
  return value
}

export function messageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
