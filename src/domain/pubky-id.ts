import { ed25519 } from '@noble/curves/ed25519.js'

const ZBASE32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const PUBKY_BYTE_LENGTH = 32
const PUBKY_TEXT_LENGTH = 52

declare const canonicalPubkyId: unique symbol

export type PubkyId = string & { readonly [canonicalPubkyId]: true }

export class PubkyIdError extends Error {
  constructor(message = 'Enter a canonical 52-character Pubky ID.') {
    super(message)
    this.name = 'PubkyIdError'
  }
}

function decodeZbase32(value: string): Uint8Array | null {
  let accumulator = 0
  let bitCount = 0
  const output: number[] = []

  for (const character of value) {
    const index = ZBASE32_ALPHABET.indexOf(character)
    if (index < 0) return null

    accumulator = (accumulator << 5) | index
    bitCount += 5

    while (bitCount >= 8) {
      bitCount -= 8
      output.push((accumulator >>> bitCount) & 0xff)
      accumulator &= bitCount === 0 ? 0 : (1 << bitCount) - 1
    }
  }

  if (output.length !== PUBKY_BYTE_LENGTH || accumulator !== 0) return null
  return Uint8Array.from(output)
}

function encodeZbase32(bytes: Uint8Array): string {
  let accumulator = 0
  let bitCount = 0
  let output = ''

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bitCount += 8

    while (bitCount >= 5) {
      bitCount -= 5
      output += ZBASE32_ALPHABET[(accumulator >>> bitCount) & 31]
      accumulator &= bitCount === 0 ? 0 : (1 << bitCount) - 1
    }
  }

  if (bitCount > 0) {
    output += ZBASE32_ALPHABET[(accumulator << (5 - bitCount)) & 31]
  }

  return output
}

export function parsePubkyId(value: string): PubkyId {
  if (value.length !== PUBKY_TEXT_LENGTH) throw new PubkyIdError()
  if (value !== value.toLowerCase()) throw new PubkyIdError('Pubky IDs use lowercase z-base-32.')

  const bytes = decodeZbase32(value)
  if (bytes === null || encodeZbase32(bytes) !== value) {
    throw new PubkyIdError('That is not a canonical Pubky ID.')
  }
  try {
    ed25519.Point.fromBytes(bytes)
  } catch {
    throw new PubkyIdError('That Pubky ID is not a valid Ed25519 public key.')
  }

  return value as PubkyId
}

export function isPubkyId(value: string): value is PubkyId {
  try {
    parsePubkyId(value)
    return true
  } catch {
    return false
  }
}

export function shortenPubkyId(value: PubkyId): string {
  return `${value.slice(0, 7)}…${value.slice(-7)}`
}
