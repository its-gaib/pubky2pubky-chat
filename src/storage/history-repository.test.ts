import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePubkyId } from '../domain/pubky-id'
import { ChatDatabase } from './database'
import { HistoryRepository, SecureHistoryError } from './history-repository'

const OWNER_A = parsePubkyId('ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy')
const OWNER_B = parsePubkyId('8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty')
const PEER = parsePubkyId('o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy')

let database: ChatDatabase
let history: HistoryRepository

beforeEach(() => {
  database = new ChatDatabase(`history-test-${crypto.randomUUID()}`)
  history = new HistoryRepository(database, {
    maxPerConversation: 2,
    maxPerAccount: 3,
    maxConversations: 4,
  })
})

afterEach(async () => {
  database.close()
  await database.delete()
})

describe('encrypted account-scoped history', () => {
  it('partitions conversations and messages by owner account', async () => {
    await history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'alpha', createdAt: 1 })
    await history.appendMessage({ ownerId: OWNER_B, peerId: PEER, direction: 'outbound', body: 'bravo', createdAt: 2 })

    expect(await history.listConversations(OWNER_A)).toEqual([{ peerId: PEER, updatedAt: 1 }])
    expect(await history.listConversations(OWNER_B)).toEqual([{ peerId: PEER, updatedAt: 2 }])
    await expect(history.listMessages(OWNER_A, PEER)).resolves.toMatchObject([{ body: 'alpha', ownerId: OWNER_A }])
    await expect(history.listMessages(OWNER_B, PEER)).resolves.toMatchObject([{ body: 'bravo', ownerId: OWNER_B }])

    const rawRows = await database.messages.toArray()
    expect(JSON.stringify(rawRows)).not.toContain('alpha')
    expect(JSON.stringify(rawRows)).not.toContain('bravo')
    const keys = await database.keys.toArray()
    expect(keys).toHaveLength(2)
    expect(keys.every(({ key }) => key.extractable === false)).toBe(true)
  })

  it('allows the same valid message ID in two account partitions', async () => {
    const id = crypto.randomUUID()
    await history.appendMessage({
      id,
      ownerId: OWNER_A,
      peerId: PEER,
      direction: 'outbound',
      body: 'alpha',
    })
    await history.appendMessage({
      id,
      ownerId: OWNER_B,
      peerId: PEER,
      direction: 'outbound',
      body: 'bravo',
    })

    await expect(history.listMessages(OWNER_A, PEER)).resolves.toMatchObject([{ id, body: 'alpha' }])
    await expect(history.listMessages(OWNER_B, PEER)).resolves.toMatchObject([{ id, body: 'bravo' }])
  })

  it('serializes account deletion against message appends', async () => {
    await Promise.all([
      history.appendMessage({
        ownerId: OWNER_A,
        peerId: PEER,
        direction: 'inbound',
        body: 'delete me',
      }),
      history.clearAccount(OWNER_A),
    ])

    await expect(history.listMessages(OWNER_A, PEER)).resolves.toEqual([])
  })

  it('serializes conversation deletion after an in-flight encrypted append', async () => {
    const subtle = globalThis.crypto.subtle
    const originalEncrypt = subtle.encrypt.bind(subtle)
    let releaseEncryption: () => void = () => undefined
    const encryptionGate = new Promise<void>((resolve) => {
      releaseEncryption = resolve
    })
    let markEncryptionStarted: () => void = () => undefined
    const encryptionStarted = new Promise<void>((resolve) => {
      markEncryptionStarted = resolve
    })
    const encryptSpy = vi.spyOn(subtle, 'encrypt').mockImplementation(async (...args) => {
      markEncryptionStarted()
      await encryptionGate
      return originalEncrypt(...args)
    })

    const append = history.appendMessage({
      ownerId: OWNER_A,
      peerId: PEER,
      direction: 'inbound',
      body: 'must stay deleted',
    })
    await encryptionStarted
    const deletion = history.deleteConversation(OWNER_A, PEER)
    releaseEncryption()

    await Promise.all([append, deletion])
    encryptSpy.mockRestore()
    await expect(history.listMessages(OWNER_A, PEER)).resolves.toEqual([])
    await expect(history.listConversations(OWNER_A)).resolves.toEqual([])
  })

  it('evicts oldest records at per-conversation and per-account limits', async () => {
    await history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'one', createdAt: 1 })
    await history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'two', createdAt: 2 })
    await history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'three', createdAt: 3 })
    await expect(history.listMessages(OWNER_A, PEER)).resolves.toMatchObject([{ body: 'two' }, { body: 'three' }])

    await history.appendMessage({ ownerId: OWNER_A, peerId: OWNER_B, direction: 'inbound', body: 'four', createdAt: 4 })
    await history.appendMessage({ ownerId: OWNER_A, peerId: OWNER_B, direction: 'inbound', body: 'five', createdAt: 5 })

    await expect(history.listMessages(OWNER_A, PEER)).resolves.toMatchObject([{ body: 'three' }])
    await expect(history.listMessages(OWNER_A, OWNER_B)).resolves.toMatchObject([{ body: 'four' }, { body: 'five' }])
    await expect(database.messages.where('ownerId').equals(OWNER_A).count()).resolves.toBe(3)
  })

  it('fails closed instead of regenerating a key over locked ciphertext', async () => {
    await history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'locked', createdAt: 1 })
    await database.keys.delete(OWNER_A)

    await expect(history.listMessages(OWNER_A, PEER)).rejects.toThrow(SecureHistoryError)
    await expect(
      history.appendMessage({ ownerId: OWNER_A, peerId: PEER, direction: 'outbound', body: 'replacement', createdAt: 2 }),
    ).rejects.toThrow('stored messages remain locked')
  })
})
