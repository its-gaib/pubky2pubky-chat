import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePubkyId } from '../domain/pubky-id'
import { ChatDatabase } from '../storage/database'
import { HistoryRepository } from '../storage/history-repository'
import type {
  ConnectedIdentity,
  TransportAdapter,
  TransportEvent,
  TransportListener,
} from '../transport/transport'
import { ChatController } from './chat-controller'

const OWNER_A = parsePubkyId('ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy')
const OWNER_B = parsePubkyId('8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty')
const PEER = parsePubkyId('o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy')

class FakeTransport implements TransportAdapter {
  readonly availability = 'available' as const
  readonly listeners: TransportListener[] = []
  identities = [OWNER_A]
  sendResolution: (() => void) | null = null
  requestConversationHook: (() => void) | null = null
  acceptRequestHook: (() => void) | null = null

  connectWithRing(): Promise<ConnectedIdentity> {
    const ownerId = this.identities.shift()
    if (ownerId === undefined) throw new Error('No test identity queued')
    return Promise.resolve({ ownerId })
  }

  async disconnect(): Promise<void> {}
  requestConversation(): Promise<void> {
    this.requestConversationHook?.()
    return Promise.resolve()
  }
  acceptRequest(): Promise<void> {
    this.acceptRequestHook?.()
    return Promise.resolve()
  }
  async declineRequest(): Promise<void> {}

  send(): Promise<void> {
    return new Promise((resolve) => {
      this.sendResolution = resolve
    })
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.push(listener)
    return () => undefined
  }

  emitCurrent(event: TransportEvent): void {
    this.listeners.at(-1)?.(event)
  }

  emitHistorical(index: number, event: TransportEvent): void {
    this.listeners[index]?.(event)
  }
}

let database: ChatDatabase
let history: HistoryRepository
let transport: FakeTransport
let controller: ChatController

beforeEach(() => {
  database = new ChatDatabase(`controller-test-${crypto.randomUUID()}`)
  history = new HistoryRepository(database)
  transport = new FakeTransport()
  controller = new ChatController(transport, history)
})

afterEach(async () => {
  controller.dispose()
  database.close()
  await database.delete()
})

describe('identity and delivery boundaries', () => {
  it('clears the pending Ring approval URL when authorization fails', async () => {
    vi.spyOn(transport, 'connectWithRing').mockImplementation(() => {
      transport.emitCurrent({
        type: 'authorization-required',
        authorizationUrl: 'pubkyauth://signin_grant?secret=synthetic-test-request',
      })
      expect(controller.getSnapshot().authorizationUrl).not.toBeNull()
      return Promise.reject(new Error('Synthetic Ring approval failure'))
    })

    await controller.connectWithRing()

    expect(controller.getSnapshot()).toMatchObject({
      authorizationUrl: null,
      busy: false,
      connection: 'error',
      ownerId: null,
    })
  })

  it('clears identity state and ignores stale-session events on reconnect', async () => {
    await controller.connectWithRing()
    await controller.startConversation(PEER)
    transport.emitCurrent({
      type: 'inbound-request',
      request: { requestId: 'old-request', peerId: PEER, receivedAt: Date.now() },
    })
    expect(controller.getSnapshot().ownerId).toBe(OWNER_A)
    expect(controller.getSnapshot().selectedPeerId).toBe(PEER)
    expect(controller.getSnapshot().inboundRequests).toHaveLength(1)

    transport.identities.push(OWNER_B)
    await controller.connectWithRing()
    expect(controller.getSnapshot()).toMatchObject({
      ownerId: OWNER_B,
      selectedPeerId: null,
      messages: [],
      inboundRequests: [],
    })

    transport.emitHistorical(1, {
      type: 'inbound-request',
      request: { requestId: 'stale-request', peerId: PEER, receivedAt: Date.now() },
    })
    expect(controller.getSnapshot().inboundRequests).toEqual([])
  })

  it('persists sending before transport and marks the row sent after resolution', async () => {
    await controller.connectWithRing()
    await controller.startConversation(PEER)
    transport.emitCurrent({ type: 'peer-state', peerId: PEER, phase: 'verified' })

    const sending = controller.send('hello')
    await vi.waitFor(async () => {
      expect(await database.messages.count()).toBe(1)
    })
    expect((await database.messages.toArray())[0]?.delivery).toBe('sending')

    transport.sendResolution?.()
    await sending
    expect((await database.messages.toArray())[0]?.delivery).toBe('sent')
    expect(controller.getSnapshot().messages[0]?.delivery).toBe('sent')
  })

  it('creates the outbound conversation before synchronous peer verification', async () => {
    await controller.connectWithRing()
    transport.requestConversationHook = () => {
      transport.emitCurrent({ type: 'peer-state', peerId: PEER, phase: 'verified' })
    }

    await controller.startConversation(PEER)

    expect(controller.getSnapshot()).toMatchObject({
      connection: 'online',
      selectedPeerId: PEER,
      busy: false,
    })
    expect(controller.getSnapshot().conversations[0]).toMatchObject({ peerId: PEER, connection: 'verified' })
  })

  it('creates the inbound conversation before synchronous acceptance verification', async () => {
    await controller.connectWithRing()
    transport.emitCurrent({
      type: 'inbound-request',
      request: { requestId: 'request-1', peerId: PEER, receivedAt: Date.now() },
    })
    transport.acceptRequestHook = () => {
      transport.emitCurrent({ type: 'peer-state', peerId: PEER, phase: 'verified' })
    }

    await controller.acceptRequest('request-1')

    expect(controller.getSnapshot()).toMatchObject({
      connection: 'online',
      selectedPeerId: PEER,
      inboundRequests: [],
      busy: false,
    })
    expect(controller.getSnapshot().conversations[0]).toMatchObject({ peerId: PEER, connection: 'verified' })
  })
})
