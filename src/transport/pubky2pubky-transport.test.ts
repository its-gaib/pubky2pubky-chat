import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserTransport,
  BrowserTransportConfig,
  BrowserTransportEvent,
  LocalIdentitySummary,
  MessageReceipt,
  PubkyId,
} from 'pubky2pubky/browser'
import type { TransportEvent } from './transport'

const browserFactory = vi.hoisted(() => vi.fn())

vi.mock('pubky2pubky/browser', () => ({
  createBrowserTransport: browserFactory,
}))

import { Pubky2PubkyTransportAdapter } from './pubky2pubky-transport'

const OWNER = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy'
const PEER = 'o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy'
const CONFIG: BrowserTransportConfig = {
  clientId: 'chat.pubky2pubky',
  httpRelay: 'https://httprelay.staging.pubky.app/inbox',
  irohRelays: ['https://euc1-1.relay.n0.iroh.link/'],
}

class FakeBrowserTransport implements BrowserTransport {
  private readonly listeners = new Set<(event: BrowserTransportEvent) => void>()
  local: readonly LocalIdentitySummary[] = []
  authUrl = authorizationUrl()
  disconnectCalls = 0

  subscribe(listener: (event: BrowserTransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(): Promise<void> {
    return Promise.resolve()
  }

  connectWithRing(): Promise<PubkyId> {
    this.emit({ type: 'auth-required', authorizationUrl: this.authUrl })
    this.emit({ type: 'identity', identity: OWNER, restored: false })
    return Promise.resolve(OWNER)
  }

  listLocalIdentities(): Promise<readonly LocalIdentitySummary[]> {
    return Promise.resolve(this.local)
  }

  removeLocalIdentity(): Promise<LocalIdentitySummary> {
    return Promise.reject(new Error('not used'))
  }

  publishAndGoOnline(): Promise<void> {
    this.emit({ type: 'connecting' })
    this.emit({ type: 'online-state', online: true, status: 'online' })
    return Promise.resolve()
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  requestPeer(): Promise<void> {
    return Promise.resolve()
  }

  requestConversation(): Promise<void> {
    return Promise.resolve()
  }

  acceptInbound(): Promise<void> {
    return Promise.resolve()
  }

  accept(): Promise<void> {
    return Promise.resolve()
  }

  rejectInbound(): Promise<void> {
    return Promise.resolve()
  }

  decline(): Promise<void> {
    return Promise.resolve()
  }

  sendMessage(peerId: PubkyId): Promise<MessageReceipt> {
    return Promise.resolve({ peerId, acceptedAt: Date.now() })
  }

  send(peerId: PubkyId): Promise<MessageReceipt> {
    return Promise.resolve({ peerId, acceptedAt: Date.now() })
  }

  disconnect(): Promise<void> {
    this.disconnectCalls += 1
    return Promise.resolve()
  }

  destroy(): Promise<void> {
    return Promise.resolve()
  }

  emit(event: BrowserTransportEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function authorizationUrl(): string {
  const url = new URL('pubkyauth://signin_grant')
  url.searchParams.set('caps', '/pub/pubky2pubky/:rw')
  url.searchParams.set('relay', CONFIG.httpRelay)
  url.searchParams.set('secret', 'a'.repeat(43))
  url.searchParams.set('cid', CONFIG.clientId)
  url.searchParams.set('cpk', OWNER)
  return url.href
}

let browser: FakeBrowserTransport

beforeEach(() => {
  browser = new FakeBrowserTransport()
  browserFactory.mockReset()
  browserFactory.mockResolvedValue(browser)
})

describe('real browser adapter boundary', () => {
  it('surfaces only the validated auth deep link and reports online after identity', async () => {
    const adapter = new Pubky2PubkyTransportAdapter(CONFIG)
    const events: TransportEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await expect(adapter.connectWithRing()).resolves.toEqual({ ownerId: OWNER })
    expect(events).toContainEqual({
      type: 'authorization-required',
      authorizationUrl: browser.authUrl,
    })
    expect(events).toContainEqual({ type: 'connection', phase: 'online' })
  })

  it('fails closed and disconnects when a secret-bearing auth URL violates the exact contract', async () => {
    browser.authUrl = 'pubkyauth://signin_grant?caps=%2Fpub%2Fevil%2F%3Arw&secret=visible'
    const adapter = new Pubky2PubkyTransportAdapter(CONFIG)
    const events: TransportEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await expect(adapter.connectWithRing()).rejects.toThrow('Invalid data was rejected')
    expect(browser.disconnectCalls).toBeGreaterThan(0)
    expect(events).toContainEqual({
      type: 'connection',
      phase: 'error',
      detail: 'Invalid data was rejected at the browser transport boundary.',
    })
    expect(JSON.stringify(events)).not.toContain('visible')
  })

  it('accepts verified peers and valid UTF-8 messages, but rejects forged verification flags', async () => {
    const adapter = new Pubky2PubkyTransportAdapter(CONFIG)
    const events: TransportEvent[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connectWithRing()

    browser.emit({
      type: 'peer-verified',
      peerId: PEER,
      peerDeviceId: 'browser',
      path: 'relay',
      route: 'relay',
      e2e: true,
      irohQuicEncrypted: true,
      pubkyIdentityVerified: true,
      protocolVersion: 4,
      alpn: 'pubky2pubky/iroh/v4',
    })
    browser.emit({
      type: 'message',
      peerId: PEER,
      body: new TextEncoder().encode('hello'),
      receivedAt: Date.now(),
    })
    expect(events).toContainEqual({ type: 'peer-state', peerId: PEER, phase: 'verified' })
    expect(events.some((event) => event.type === 'message' && event.message.body === 'hello')).toBe(true)

    browser.emit({
      type: 'peer-verified',
      peerId: PEER,
      peerDeviceId: 'browser',
      path: 'relay',
      route: 'relay',
      e2e: false,
      irohQuicEncrypted: true,
      pubkyIdentityVerified: true,
      protocolVersion: 4,
      alpn: 'pubky2pubky/iroh/v4',
    } as unknown as BrowserTransportEvent)
    expect(browser.disconnectCalls).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ type: 'connection', phase: 'error' })
  })

  it.each(['message-invalid', 'identity-verification-failed'] as const)(
    'does not let peer-scoped %s downgrade the global online state',
    async (code) => {
      const adapter = new Pubky2PubkyTransportAdapter(CONFIG)
      const events: TransportEvent[] = []
      adapter.subscribe((event) => events.push(event))
      await adapter.connectWithRing()

      browser.emit({ type: 'error', code })

      expect(events).not.toContainEqual(expect.objectContaining({ type: 'connection', phase: 'error' }))
      expect(events.at(-1)).toEqual({ type: 'connection', phase: 'online' })
    },
  )
})
