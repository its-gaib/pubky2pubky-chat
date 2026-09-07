import { validateMessageBody, type ChatMessage, type MessageDelivery } from '../domain/message'
import { parsePubkyId, type PubkyId } from '../domain/pubky-id'
import type { ConversationSummary, HistoryRepository } from '../storage/history-repository'
import {
  TransportUnavailableError,
  type ConnectionPhase,
  type InboundChatRequest,
  type PeerConnectionPhase,
  type TransportAdapter,
  type TransportEvent,
} from '../transport/transport'

export interface ConversationView extends ConversationSummary {
  readonly connection: PeerConnectionPhase
}

export interface ChatState {
  readonly connection: ConnectionPhase
  readonly connectionDetail: string | null
  readonly authorizationUrl: string | null
  readonly ownerId: PubkyId | null
  readonly conversations: readonly ConversationView[]
  readonly inboundRequests: readonly InboundChatRequest[]
  readonly selectedPeerId: PubkyId | null
  readonly messages: readonly ChatMessage[]
  readonly busy: boolean
}

const INITIAL_STATE: ChatState = {
  connection: 'disconnected',
  connectionDetail: null,
  authorizationUrl: null,
  ownerId: null,
  conversations: [],
  inboundRequests: [],
  selectedPeerId: null,
  messages: [],
  busy: false,
}

const MAX_INBOUND_REQUESTS = 100

type StateListener = () => void

function safeErrorMessage(error: unknown): string {
  if (error instanceof TransportUnavailableError) return error.message.slice(0, 200)
  return 'The secure connection could not be completed. Try again.'
}

function assertRequestId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('Invalid request ID from transport.')
}

function connectionDetail(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, 200)
}

function assertConnectionPhase(value: ConnectionPhase): void {
  if (!['unavailable', 'disconnected', 'authorizing', 'publishing', 'online', 'error'].includes(value)) {
    throw new TypeError('Invalid connection phase from transport.')
  }
}

function assertPeerPhase(value: PeerConnectionPhase): void {
  if (!['requesting', 'awaiting-acceptance', 'verified', 'offline', 'error'].includes(value)) {
    throw new TypeError('Invalid peer phase from transport.')
  }
}

export class ChatController {
  private state: ChatState
  private readonly listeners = new Set<StateListener>()
  private unsubscribeTransport: () => void = () => undefined
  private generation = 0
  private disposed = false

  constructor(
    private readonly transport: TransportAdapter,
    private readonly history: HistoryRepository,
  ) {
    this.state = {
      ...INITIAL_STATE,
      connection: transport.availability === 'unavailable' ? 'unavailable' : 'disconnected',
      connectionDetail: connectionDetail(transport.unavailableReason),
    }
    this.bindTransport(this.generation)
  }

  getSnapshot = (): ChatState => this.state

  subscribe = (listener: StateListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribeTransport()
    void this.transport.disconnect().catch(() => undefined)
    this.listeners.clear()
  }

  async connectWithRing(): Promise<void> {
    if (this.state.busy) return
    const generation = this.generation + 1
    this.generation = generation
    this.unsubscribeTransport()
    this.state = {
      ...INITIAL_STATE,
      connection: 'authorizing',
      busy: true,
    }
    this.emit()
    try {
      await this.transport.disconnect()
      if (!this.isCurrent(generation)) return
      this.bindTransport(generation)
      const identity = await this.transport.connectWithRing()
      if (!this.isCurrent(generation)) return
      const ownerId = parsePubkyId(identity.ownerId)
      await this.history.prepareAccount(ownerId)
      if (!this.isCurrent(generation)) return
      const summaries = await this.history.listConversations(ownerId)
      if (!this.isCurrent(generation)) return
      this.patch({
        ownerId,
        connection: 'online',
        connectionDetail: null,
        authorizationUrl: null,
        conversations: summaries.map((summary) => ({ ...summary, connection: 'offline' })),
        busy: false,
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({
        busy: false,
        connection: this.transport.availability === 'unavailable' ? 'unavailable' : 'error',
        connectionDetail: safeErrorMessage(error),
        authorizationUrl: null,
      })
    }
  }

  async disconnect(): Promise<void> {
    const generation = this.generation + 1
    this.generation = generation
    this.unsubscribeTransport()
    try {
      await this.transport.disconnect()
    } catch {
      // Local identity state still clears if network teardown has already failed.
    }
    if (!this.isCurrent(generation)) return
    this.state = {
      ...INITIAL_STATE,
      connection: this.transport.availability === 'unavailable' ? 'unavailable' : 'disconnected',
      connectionDetail: connectionDetail(this.transport.unavailableReason),
    }
    this.bindTransport(generation)
    this.emit()
  }

  async startConversation(rawPeerId: string): Promise<void> {
    const ownerId = this.requireOwner()
    const generation = this.generation
    const peerId = parsePubkyId(rawPeerId)
    if (ownerId === peerId) throw new TypeError('You cannot chat with your own Pubky.')
    if (this.state.connection !== 'online') throw new TypeError('Connect with Ring before starting a chat.')

    const previousSelection = this.state.selectedPeerId
    const previousMessages = this.state.messages
    const previousConversation = this.state.conversations.find((candidate) => candidate.peerId === peerId)
    const provisionalCreatedAt = Date.now()
    if (previousConversation === undefined) {
      await this.history.createConversation(ownerId, peerId, provisionalCreatedAt)
      if (!this.isCurrent(generation, ownerId)) return
    }
    this.upsertConversation(peerId, 'requesting', provisionalCreatedAt)
    this.patch({ busy: true, connectionDetail: null, selectedPeerId: peerId, messages: [] })
    try {
      await this.transport.requestConversation(peerId)
      if (!this.isCurrent(generation, ownerId)) return
      this.patch({ busy: false })
    } catch (error) {
      if (!this.isCurrent(generation, ownerId)) return
      const verified = this.state.conversations.find((candidate) => candidate.peerId === peerId)?.connection === 'verified'
      if (!verified) {
        if (previousConversation === undefined) {
          await this.history.deleteConversation(ownerId, peerId).catch(() => undefined)
          if (!this.isCurrent(generation, ownerId)) return
          this.patch({
            conversations: this.state.conversations.filter((candidate) => candidate.peerId !== peerId),
            selectedPeerId: previousSelection,
            messages: previousMessages,
          })
        } else {
          this.upsertConversation(peerId, previousConversation.connection, previousConversation.updatedAt)
          this.patch({ selectedPeerId: previousSelection, messages: previousMessages })
        }
      }
      this.patch({ busy: false, connectionDetail: safeErrorMessage(error) })
      throw error
    }
  }

  async selectConversation(peerId: PubkyId): Promise<void> {
    const ownerId = this.requireOwner()
    const generation = this.generation
    parsePubkyId(peerId)
    const messages = await this.history.listMessages(ownerId, peerId)
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({ selectedPeerId: peerId, messages })
  }

  async acceptRequest(requestId: string): Promise<void> {
    assertRequestId(requestId)
    const request = this.state.inboundRequests.find((candidate) => candidate.requestId === requestId)
    if (request === undefined) throw new TypeError('That request is no longer pending.')
    const ownerId = this.requireOwner()
    const generation = this.generation
    const previousSelection = this.state.selectedPeerId
    const previousMessages = this.state.messages
    const previousConversation = this.state.conversations.find((candidate) => candidate.peerId === request.peerId)
    const provisionalCreatedAt = Date.now()
    if (previousConversation === undefined) {
      await this.history.createConversation(ownerId, request.peerId, provisionalCreatedAt)
      if (!this.isCurrent(generation, ownerId)) return
    }
    const messages = await this.history.listMessages(ownerId, request.peerId)
    if (!this.isCurrent(generation, ownerId)) return
    this.upsertConversation(request.peerId, 'requesting', provisionalCreatedAt)
    this.patch({ selectedPeerId: request.peerId, messages, busy: true, connectionDetail: null })
    try {
      await this.transport.acceptRequest(requestId)
    } catch (error) {
      if (!this.isCurrent(generation, ownerId)) return
      const verified = this.state.conversations.find(
        (candidate) => candidate.peerId === request.peerId,
      )?.connection === 'verified'
      if (!verified) {
        if (previousConversation === undefined) {
          await this.history.deleteConversation(ownerId, request.peerId).catch(() => undefined)
          if (!this.isCurrent(generation, ownerId)) return
          this.patch({
            conversations: this.state.conversations.filter((candidate) => candidate.peerId !== request.peerId),
            selectedPeerId: previousSelection,
            messages: previousMessages,
          })
        } else {
          this.upsertConversation(request.peerId, previousConversation.connection, previousConversation.updatedAt)
          this.patch({ selectedPeerId: previousSelection, messages: previousMessages })
        }
      }
      this.patch({ busy: false, connectionDetail: safeErrorMessage(error) })
      throw error
    }
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({
      inboundRequests: this.state.inboundRequests.filter((candidate) => candidate.requestId !== requestId),
      busy: false,
    })
  }

  async declineRequest(requestId: string): Promise<void> {
    assertRequestId(requestId)
    const ownerId = this.requireOwner()
    const generation = this.generation
    await this.transport.declineRequest(requestId)
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({
      inboundRequests: this.state.inboundRequests.filter((candidate) => candidate.requestId !== requestId),
    })
  }

  async send(bodyInput: string): Promise<void> {
    const ownerId = this.requireOwner()
    const generation = this.generation
    const peerId = this.state.selectedPeerId
    if (peerId === null) throw new TypeError('Choose a conversation first.')
    const conversation = this.state.conversations.find((candidate) => candidate.peerId === peerId)
    if (conversation?.connection !== 'verified') {
      throw new TypeError('Messages stay disabled until the peer connection is verified.')
    }
    const body = validateMessageBody(bodyInput)
    const id = globalThis.crypto.randomUUID()
    const createdAt = Date.now()
    const message = await this.history.appendMessage({
      id,
      ownerId,
      peerId,
      direction: 'outbound',
      delivery: 'sending',
      body,
      createdAt,
    })
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({ messages: [...this.state.messages, message].slice(-this.history.limits.maxPerConversation) })
    this.upsertConversation(peerId, 'verified', createdAt)
    try {
      await this.transport.send(peerId, body)
      await this.history.updateMessageDelivery(ownerId, id, 'sent')
      if (!this.isCurrent(generation, ownerId)) return
      this.replaceMessageDelivery(id, 'sent')
    } catch (error) {
      await this.history.updateMessageDelivery(ownerId, id, 'failed').catch(() => undefined)
      if (this.isCurrent(generation, ownerId)) this.replaceMessageDelivery(id, 'failed')
      throw error
    }
  }

  async deleteSelectedConversation(): Promise<void> {
    const ownerId = this.requireOwner()
    const generation = this.generation
    const peerId = this.state.selectedPeerId
    if (peerId === null) return
    await this.history.deleteConversation(ownerId, peerId)
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({
      selectedPeerId: null,
      messages: [],
      conversations: this.state.conversations.filter((conversation) => conversation.peerId !== peerId),
    })
  }

  async clearLocalHistory(): Promise<void> {
    const ownerId = this.requireOwner()
    const generation = this.generation
    await this.history.clearAccount(ownerId)
    if (!this.isCurrent(generation, ownerId)) return
    this.patch({ conversations: [], selectedPeerId: null, messages: [] })
  }

  private requireOwner(): PubkyId {
    if (this.state.ownerId === null) throw new TypeError('Connect with Ring first.')
    return this.state.ownerId
  }

  private isCurrent(generation: number, ownerId?: PubkyId): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      (ownerId === undefined || this.state.ownerId === ownerId)
    )
  }

  private bindTransport(generation: number): void {
    this.unsubscribeTransport()
    this.unsubscribeTransport = this.transport.subscribe((event) => {
      if (!this.isCurrent(generation)) return
      void this.handleTransportEvent(event, generation).catch(() => {
        if (this.isCurrent(generation)) {
          this.patch({
            connection: 'error',
            connectionDetail: 'Invalid data was rejected at the transport boundary.',
          })
        }
      })
    })
  }

  private patch(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private upsertConversation(peerId: PubkyId, connection: PeerConnectionPhase, updatedAt: number): void {
    const other = this.state.conversations.filter((conversation) => conversation.peerId !== peerId)
    this.patch({
      conversations: [{ peerId, connection, updatedAt }, ...other].slice(0, this.history.limits.maxConversations),
    })
  }

  private replaceMessageDelivery(id: string, delivery: MessageDelivery): void {
    this.patch({
      messages: this.state.messages.map((message) =>
        message.id === id ? { ...message, delivery } : message,
      ),
    })
  }

  private async handleTransportEvent(event: TransportEvent, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    if (event.type === 'connection') {
      assertConnectionPhase(event.phase)
      this.patch({
        connection: event.phase,
        connectionDetail: connectionDetail(event.detail),
        authorizationUrl: event.phase === 'authorizing' ? this.state.authorizationUrl : null,
      })
      return
    }

    if (event.type === 'authorization-required') {
      this.patch({ authorizationUrl: validateAuthorizationUrl(event.authorizationUrl) })
      return
    }

    if (event.type === 'inbound-request') {
      assertRequestId(event.request.requestId)
      const peerId = parsePubkyId(event.request.peerId)
      assertFiniteRequestTime(event.request.receivedAt)
      if (!this.state.inboundRequests.some(({ requestId }) => requestId === event.request.requestId)) {
        this.patch({
          inboundRequests: [...this.state.inboundRequests, { ...event.request, peerId }].slice(-MAX_INBOUND_REQUESTS),
        })
      }
      return
    }

    if (event.type === 'request-withdrawn') {
      assertRequestId(event.requestId)
      this.patch({
        inboundRequests: this.state.inboundRequests.filter(({ requestId }) => requestId !== event.requestId),
      })
      return
    }

    if (event.type === 'peer-state') {
      const peerId = parsePubkyId(event.peerId)
      assertPeerPhase(event.phase)
      if (!this.state.conversations.some((conversation) => conversation.peerId === peerId)) {
        throw new TypeError('Transport emitted state for an unknown conversation.')
      }
      this.upsertConversation(peerId, event.phase, Date.now())
      return
    }

    const ownerId = this.requireOwner()
    const peerId = parsePubkyId(event.message.peerId)
    assertFiniteRequestTime(event.message.receivedAt)
    const conversation = this.state.conversations.find((candidate) => candidate.peerId === peerId)
    if (conversation?.connection !== 'verified') {
      throw new TypeError('Transport delivered a message without a verified conversation.')
    }
    const stored = await this.history.appendMessage({
      id: event.message.id,
      ownerId,
      peerId,
      direction: 'inbound',
      delivery: 'sent',
      body: event.message.body,
      createdAt: event.message.receivedAt,
    })
    if (!this.isCurrent(generation, ownerId)) return
    if (this.state.selectedPeerId === peerId) {
      this.patch({ messages: [...this.state.messages, stored].slice(-this.history.limits.maxPerConversation) })
    }
    this.upsertConversation(peerId, 'verified', stored.createdAt)
  }
}

function assertFiniteRequestTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid request time from transport.')
}

function validateAuthorizationUrl(value: string): string {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (value.length === 0 || value.length > 4_096 || hasControlCharacter) {
    throw new TypeError('Invalid Ring authorization URL from transport.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Invalid Ring authorization URL from transport.')
  }
  if (url.protocol !== 'pubkyauth:' || url.hostname !== 'signin_grant' || url.hash !== '') {
    throw new TypeError('Invalid Ring authorization URL from transport.')
  }
  return url.href
}
