import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})

afterEach(() => {
  cleanup()
})

