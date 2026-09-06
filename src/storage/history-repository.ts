import Dexie from 'dexie'
import {
  validateMessageBody,
  type ChatMessage,
  type MessageDelivery,
  type MessageDirection,
} from '../domain/message'
import { parsePubkyId, type PubkyId } from '../domain/pubky-id'
import {
  ChatDatabase,
  type StoredConversation,
  type StoredCryptoKey,
  type StoredEncryptedMessage,
} from './database'

export const DEFAULT_HISTORY_LIMITS = {
  maxPerConversation: 500,
  maxPerAccount: 5_000,
  maxConversations: 100,
} as const

export interface HistoryLimits {
  readonly maxPerConversation: number
  readonly maxPerAccount: number
  readonly maxConversations: number
}

export interface ConversationSummary {
  readonly peerId: PubkyId
  readonly updatedAt: number
}

export interface AppendMessageInput {
  readonly id?: string
  readonly ownerId: PubkyId
  readonly peerId: PubkyId
  readonly direction: MessageDirection
  readonly delivery?: MessageDelivery
  readonly body: string
  readonly createdAt?: number
}

export class SecureHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SecureHistoryError'
  }
}

function conversationId(ownerId: PubkyId, peerId: PubkyId): string {
  return `${ownerId}:${peerId}`
}

function assertFiniteTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SecureHistoryError('Stored history contains an invalid timestamp.')
  }
}

function assertDirection(value: string): asserts value is MessageDirection {
  if (value !== 'inbound' && value !== 'outbound') {
    throw new SecureHistoryError('Stored history contains an invalid message direction.')
  }
}

function assertMessageId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new SecureHistoryError('Message ID is invalid.')
  }
}

function assertDelivery(value: string): asserts value is MessageDelivery {
  if (value !== 'sending' && value !== 'sent' && value !== 'failed') {
    throw new SecureHistoryError('Stored history contains an invalid delivery state.')
  }
}

function isUsableKey(value: unknown): value is CryptoKey {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as CryptoKey
  try {
    return (
      candidate.type === 'secret' &&
      candidate.extractable === false &&
      candidate.algorithm.name === 'AES-GCM' &&
      candidate.usages.includes('encrypt') &&
      candidate.usages.includes('decrypt')
    )
  } catch {
    return false
  }
}

function ensureCrypto(): SubtleCrypto {
  if (globalThis.crypto?.subtle === undefined || globalThis.indexedDB === undefined) {
    throw new SecureHistoryError('Encrypted local history is unavailable in this browser.')
  }
  return globalThis.crypto.subtle
}

function additionalData(
  record: Pick<StoredEncryptedMessage, 'id' | 'ownerId' | 'peerId' | 'direction' | 'createdAt'>,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `pubky2pubky-history-v1\u0000${record.id}\u0000${record.ownerId}\u0000${record.peerId}\u0000${record.direction}\u0000${record.createdAt}`,
  )
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value)
}

function isUint8Array(value: unknown): value is Uint8Array<ArrayBuffer> {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]' &&
    Object.prototype.toString.call(value.buffer) === '[object ArrayBuffer]'
  )
}

function validateLimits(limits: HistoryLimits): void {
  for (const value of [limits.maxPerConversation, limits.maxPerAccount, limits.maxConversations]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('History limits must be positive safe integers.')
    }
  }
  if (limits.maxPerConversation > limits.maxPerAccount) {
    throw new TypeError('The per-conversation limit cannot exceed the account limit.')
  }
}

export class HistoryRepository {
  readonly db: ChatDatabase
  readonly limits: HistoryLimits
  private readonly accountMutationTails = new Map<PubkyId, Promise<void>>()

  constructor(db = new ChatDatabase(), limits: HistoryLimits = DEFAULT_HISTORY_LIMITS) {
    validateLimits(limits)
    this.db = db
    this.limits = limits
  }

  async open(): Promise<void> {
    ensureCrypto()
    try {
      await this.db.open()
    } catch (error) {
      throw new SecureHistoryError('Encrypted local history could not be opened.', { cause: error })
    }
  }

  async listConversations(ownerId: PubkyId): Promise<ConversationSummary[]> {
    parsePubkyId(ownerId)
    await this.open()
    const records = await this.db.conversations.where('ownerId').equals(ownerId).sortBy('updatedAt')
    return records.reverse().map((record) => this.validateConversation(record, ownerId))
  }

  async createConversation(ownerId: PubkyId, peerId: PubkyId, updatedAt = Date.now()): Promise<void> {
    this.assertParticipants(ownerId, peerId)
    assertFiniteTimestamp(updatedAt)
    await this.open()

    await this.db.transaction('rw', this.db.conversations, this.db.messages, async () => {
      await this.db.conversations.put({
        id: conversationId(ownerId, peerId),
        ownerId,
        peerId,
        updatedAt,
      })
      await this.pruneConversations(ownerId)
    })
  }

  async prepareAccount(ownerId: PubkyId): Promise<void> {
    parsePubkyId(ownerId)
    await this.open()
    await this.ensureOwnerKey(ownerId)
  }

  async appendMessage(input: AppendMessageInput): Promise<ChatMessage> {
    return this.withAccountMutation(input.ownerId, () => this.appendMessageUnlocked(input))
  }

  private async appendMessageUnlocked(input: AppendMessageInput): Promise<ChatMessage> {
    this.assertParticipants(input.ownerId, input.peerId)
    assertDirection(input.direction)
    const body = validateMessageBody(input.body)
    const createdAt = input.createdAt ?? Date.now()
    assertFiniteTimestamp(createdAt)
    const id = input.id ?? globalThis.crypto.randomUUID()
    assertMessageId(id)

    await this.open()
    const key = await this.ensureOwnerKey(input.ownerId)
    const baseRecord = {
      id,
      ownerId: input.ownerId,
      peerId: input.peerId,
      direction: input.direction,
      delivery: input.delivery ?? (input.direction === 'inbound' ? 'sent' : 'sending'),
      createdAt,
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    let ciphertext: ArrayBuffer
    try {
      ciphertext = await ensureCrypto().encrypt(
        { name: 'AES-GCM', iv, additionalData: additionalData(baseRecord), tagLength: 128 },
        key,
        new TextEncoder().encode(body),
      )
    } catch (error) {
      throw new SecureHistoryError('The message could not be encrypted for local storage.', { cause: error })
    }

    const stored: StoredEncryptedMessage = {
      ...baseRecord,
      iv: copyBytes(iv),
      ciphertext: copyBytes(new Uint8Array(ciphertext)),
    }

    await this.db.transaction('rw', this.db.messages, this.db.conversations, async () => {
      await this.db.messages.add(stored)
      await this.db.conversations.put({
        id: conversationId(input.ownerId, input.peerId),
        ownerId: input.ownerId,
        peerId: input.peerId,
        updatedAt: createdAt,
      })
      await this.pruneMessages(input.ownerId, input.peerId)
      await this.pruneConversations(input.ownerId)
    })

    return { ...baseRecord, direction: input.direction, body }
  }

  async updateMessageDelivery(
    ownerId: PubkyId,
    id: string,
    delivery: MessageDelivery,
  ): Promise<void> {
    parsePubkyId(ownerId)
    assertDelivery(delivery)
    assertMessageId(id)
    await this.open()
    const updated = await this.db.messages.update([ownerId, id], { delivery })
    if (updated !== 1) throw new SecureHistoryError('The local message no longer exists.')
  }

  async listMessages(ownerId: PubkyId, peerId: PubkyId): Promise<ChatMessage[]> {
    this.assertParticipants(ownerId, peerId)
    await this.open()
    const key = await this.requireOwnerKey(ownerId)
    const rows = await this.db.messages.where('[ownerId+peerId]').equals([ownerId, peerId]).sortBy('createdAt')
    return Promise.all(rows.map((row) => this.decryptRow(row, key, ownerId, peerId)))
  }

  async deleteConversation(ownerId: PubkyId, peerId: PubkyId): Promise<void> {
    this.assertParticipants(ownerId, peerId)
    await this.withAccountMutation(ownerId, async () => {
      await this.open()
      await this.db.transaction('rw', this.db.messages, this.db.conversations, async () => {
        await this.db.messages.where('[ownerId+peerId]').equals([ownerId, peerId]).delete()
        await this.db.conversations.delete(conversationId(ownerId, peerId))
      })
    })
  }

  async clearAccount(ownerId: PubkyId): Promise<void> {
    parsePubkyId(ownerId)
    await this.withAccountMutation(ownerId, async () => {
      await this.open()
      await this.db.transaction('rw', this.db.messages, this.db.conversations, this.db.keys, async () => {
        await this.db.messages.where('ownerId').equals(ownerId).delete()
        await this.db.conversations.where('ownerId').equals(ownerId).delete()
        await this.db.keys.delete(ownerId)
      })
    })
  }

  private async withAccountMutation<T>(ownerId: PubkyId, operation: () => Promise<T>): Promise<T> {
    parsePubkyId(ownerId)
    const previous = this.accountMutationTails.get(ownerId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.accountMutationTails.set(ownerId, tail)
    await previous.catch(() => undefined)
    try {
      const locks = globalThis.navigator?.locks
      if (locks !== undefined) {
        return await locks.request(`pubky2pubky:history:${ownerId}`, { mode: 'exclusive' }, operation)
      }
      return await operation()
    } finally {
      release()
      if (this.accountMutationTails.get(ownerId) === tail) this.accountMutationTails.delete(ownerId)
    }
  }

  private assertParticipants(ownerId: PubkyId, peerId: PubkyId): void {
    parsePubkyId(ownerId)
    parsePubkyId(peerId)
    if (ownerId === peerId) throw new SecureHistoryError('You cannot start a chat with yourself.')
  }

  private validateConversation(record: StoredConversation, expectedOwner: PubkyId): ConversationSummary {
    const ownerId = parsePubkyId(record.ownerId)
    const peerId = parsePubkyId(record.peerId)
    assertFiniteTimestamp(record.updatedAt)
    if (ownerId !== expectedOwner || record.id !== conversationId(ownerId, peerId)) {
      throw new SecureHistoryError('Stored conversation ownership is invalid.')
    }
    return { peerId, updatedAt: record.updatedAt }
  }

  private async ensureOwnerKey(ownerId: PubkyId): Promise<CryptoKey> {
    const existing = await this.db.keys.get(ownerId)
    if (existing !== undefined) return this.validateStoredKey(existing, ownerId)

    const messageCount = await this.db.messages.where('ownerId').equals(ownerId).count()
    if (messageCount !== 0) {
      throw new SecureHistoryError('The encryption key for this account is missing; stored messages remain locked.')
    }

    let generated: CryptoKey
    try {
      generated = await ensureCrypto().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      if (!isUsableKey(generated)) throw new Error('Browser returned an unusable key')
      await this.db.keys.add({ ownerId, key: generated, createdAt: Date.now() })
    } catch (error) {
      throw new SecureHistoryError('This browser cannot safely persist a non-extractable history key.', { cause: error })
    }

    const persisted = await this.db.keys.get(ownerId)
    if (persisted === undefined) {
      throw new SecureHistoryError('The local history key did not persist.')
    }
    return this.validateStoredKey(persisted, ownerId)
  }

  private async requireOwnerKey(ownerId: PubkyId): Promise<CryptoKey> {
    const record = await this.db.keys.get(ownerId)
    const count = await this.db.messages.where('ownerId').equals(ownerId).count()
    if (record === undefined) {
      if (count === 0) {
        return this.ensureOwnerKey(ownerId)
      }
      throw new SecureHistoryError('The encryption key for this account is missing; stored messages remain locked.')
    }
    return this.validateStoredKey(record, ownerId)
  }

  private validateStoredKey(record: StoredCryptoKey, expectedOwner: PubkyId): CryptoKey {
    if (record.ownerId !== expectedOwner || !isUsableKey(record.key)) {
      throw new SecureHistoryError('The local history encryption key is invalid.')
    }
    assertFiniteTimestamp(record.createdAt)
    return record.key
  }

  private async decryptRow(
    row: StoredEncryptedMessage,
    key: CryptoKey,
    expectedOwner: PubkyId,
    expectedPeer: PubkyId,
  ): Promise<ChatMessage> {
    const ownerId = parsePubkyId(row.ownerId)
    const peerId = parsePubkyId(row.peerId)
    assertMessageId(row.id)
    assertDirection(row.direction)
    assertDelivery(row.delivery)
    assertFiniteTimestamp(row.createdAt)
    if (ownerId !== expectedOwner || peerId !== expectedPeer) {
      throw new SecureHistoryError('Stored message ownership is invalid.')
    }
    if (!isUint8Array(row.iv) || row.iv.byteLength !== 12) {
      throw new SecureHistoryError('Stored message nonce is invalid.')
    }
    if (!isUint8Array(row.ciphertext) || row.ciphertext.byteLength < 17) {
      throw new SecureHistoryError('Stored message ciphertext is invalid.')
    }

    let plaintext: ArrayBuffer
    try {
      plaintext = await ensureCrypto().decrypt(
        { name: 'AES-GCM', iv: copyBytes(row.iv), additionalData: additionalData(row), tagLength: 128 },
        key,
        copyBytes(row.ciphertext),
      )
    } catch (error) {
      throw new SecureHistoryError('Stored message authentication failed.', { cause: error })
    }

    let body: string
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      validateMessageBody(body)
    } catch (error) {
      throw new SecureHistoryError('Stored message plaintext is invalid.', { cause: error })
    }
    return {
      id: row.id,
      ownerId,
      peerId,
      direction: row.direction,
      delivery: row.delivery,
      body,
      createdAt: row.createdAt,
    }
  }

  private async pruneMessages(ownerId: PubkyId, peerId: PubkyId): Promise<void> {
    const conversationRows = await this.db.messages
      .where('[ownerId+peerId]')
      .equals([ownerId, peerId])
      .sortBy('createdAt')
    const conversationOverflow = conversationRows.length - this.limits.maxPerConversation
    if (conversationOverflow > 0) {
      await this.db.messages.bulkDelete(
        conversationRows
          .slice(0, conversationOverflow)
          .map(({ ownerId: owner, id }) => [owner, id] as [string, string]),
      )
    }

    const accountRows = await this.db.messages.where('ownerId').equals(ownerId).sortBy('createdAt')
    const accountOverflow = accountRows.length - this.limits.maxPerAccount
    if (accountOverflow > 0) {
      await this.db.messages.bulkDelete(
        accountRows
          .slice(0, accountOverflow)
          .map(({ ownerId: owner, id }) => [owner, id] as [string, string]),
      )
    }
  }

  private async pruneConversations(ownerId: PubkyId): Promise<void> {
    const accountRows = await this.db.conversations.where('ownerId').equals(ownerId).sortBy('updatedAt')
    const overflow = accountRows.length - this.limits.maxConversations
    if (overflow <= 0) return

    const evicted = accountRows.slice(0, overflow)
    await this.db.conversations.bulkDelete(evicted.map(({ id }) => id))
    for (const conversation of evicted) {
      const peerId = parsePubkyId(conversation.peerId)
      await this.db.messages.where('[ownerId+peerId]').equals([ownerId, peerId]).delete()
    }
  }
}

export function isHistoryDatabaseAvailable(): boolean {
  return globalThis.indexedDB !== undefined && globalThis.crypto?.subtle !== undefined
}

export async function deleteHistoryDatabase(name = 'pubky2pubky-chat'): Promise<void> {
  await Dexie.delete(name)
}
