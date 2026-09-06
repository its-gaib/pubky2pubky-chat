import Dexie, { type EntityTable, type Table } from 'dexie'

export interface StoredCryptoKey {
  readonly ownerId: string
  readonly key: CryptoKey
  readonly createdAt: number
}

export interface StoredConversation {
  readonly id: string
  readonly ownerId: string
  readonly peerId: string
  readonly updatedAt: number
}

export interface StoredEncryptedMessage {
  readonly id: string
  readonly ownerId: string
  readonly peerId: string
  readonly direction: string
  readonly delivery: string
  readonly createdAt: number
  readonly iv: Uint8Array<ArrayBuffer>
  readonly ciphertext: Uint8Array<ArrayBuffer>
}

export class ChatDatabase extends Dexie {
  keys!: EntityTable<StoredCryptoKey, 'ownerId'>
  conversations!: EntityTable<StoredConversation, 'id'>
  messages!: Table<StoredEncryptedMessage, [string, string]>

  constructor(name = 'pubky2pubky-chat') {
    super(name)
    this.version(1).stores({
      keys: '&ownerId',
      conversations: '&id, ownerId, [ownerId+peerId], [ownerId+updatedAt]',
      messages: '[ownerId+id], ownerId, [ownerId+peerId], [ownerId+createdAt], [ownerId+peerId+createdAt]',
    })
  }
}
