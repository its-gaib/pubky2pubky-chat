import { describe, expect, it } from 'vitest'
import { isPubkyId, parsePubkyId, PubkyIdError } from './pubky-id'

const VALID_PUBKY = 'o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy'

describe('canonical Pubky ID validation', () => {
  it('accepts an exact 52-character canonical z-base-32 public key', () => {
    expect(parsePubkyId(VALID_PUBKY)).toBe(VALID_PUBKY)
    expect(isPubkyId(VALID_PUBKY)).toBe(true)
  })

  it.each([
    ` ${VALID_PUBKY}`,
    VALID_PUBKY.toUpperCase(),
    `pubky${VALID_PUBKY}`,
    VALID_PUBKY.slice(0, -1),
    `${VALID_PUBKY.slice(0, -1)}0`,
    `${VALID_PUBKY.slice(0, -1)}b`,
  ])('rejects non-canonical input without normalizing it: %s', (value) => {
    expect(() => parsePubkyId(value)).toThrow(PubkyIdError)
    expect(isPubkyId(value)).toBe(false)
  })

  it('rejects a canonical encoding that is not an Ed25519 point', () => {
    expect(() => parsePubkyId('yebyryonyebyryonyebyryonyebyryonyebyryonyebyryonyeby')).toThrow(
      'not a valid Ed25519 public key',
    )
  })
})
