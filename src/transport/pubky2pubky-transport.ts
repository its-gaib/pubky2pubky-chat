import {
  createBrowserTransport,
  type BrowserTransport,
  type BrowserTransportConfig,
  type BrowserTransportEvent,
} from 'pubky2pubky/browser'
import { parsePubkyId, type PubkyId } from '../domain/pubky-id'
import { validateMessageBody } from '../domain/message'
import {
  TransportUnavailableError,
  type ConnectedIdentity,
  type TransportAdapter,
  type TransportEvent,
  type TransportListener,
} from './transport'

const REQUIRED_CAPABILITY = '/pub/pubky2pubky/:rw'
const MAX_AUTHORIZATION_URL_BYTES = 2_048
const MAX_CLOCK_SKEW_MS = 30_000
const PEER_SCOPED_ERROR_CODES = new Set([
  'identity-verification-failed',
  'message-invalid',
  'peer-already-connected',
  'peer-not-connected',
  'peer-unreachable',
  'relay-path-unverified',
  'request-expired',
  'session-closed',
])
const encoder = new TextEncoder()

export class Pubky2PubkyTransportAdapter implements TransportAdapter {
  readonly availability = 'available' as const
  private readonly listeners = new Set<TransportListener>()
  private browser: BrowserTransport | null = null
  private ownerId: PubkyId | null = null
  private creating: Promise<BrowserTransport> | null = null
  private boundaryFailure: TransportUnavailableError | null = null

  constructor(private readonly config: BrowserTransportConfig) {
    globalThis.addEventListener?.('pagehide', () => {
      void this.disconnect().catch(() => undefined)
    })
  }

  async connectWithRing(): Promise<ConnectedIdentity> {
    this.assertHealthy()
    const browser = await this.getBrowser()
    if (this.ownerId === null) {
      const local = await browser.listLocalIdentities()
      this.assertHealthy()
      if (local.length > 1) {
        throw new TransportUnavailableError(
          'More than one local chat identity exists. Remove one before choosing an identity.',
        )
      }
      if (local.length === 1) {
        const stored = local[0]
        if (stored === undefined) throw new TransportUnavailableError('Stored Ring identity is missing.')
        const identity = parsePubkyId(stored.identity)
        await browser.initialize(identity)
        this.assertHealthy()
        if (this.ownerId !== identity) throw new TransportUnavailableError('Stored Ring identity could not be verified.')
      } else {
        await browser.initialize()
        const identity = parsePubkyId(await browser.connectWithRing())
        this.assertHealthy()
        if (this.ownerId !== identity) throw new TransportUnavailableError('Ring returned an inconsistent identity.')
      }
    }
    await browser.publishAndGoOnline()
    this.assertHealthy()
    if (this.ownerId === null) throw new TransportUnavailableError('Ring identity was not verified.')
    return { ownerId: this.ownerId }
  }

  async disconnect(): Promise<void> {
    if (this.browser !== null) await this.browser.disconnect()
  }

  async requestConversation(peerId: PubkyId): Promise<void> {
    this.assertHealthy()
    await (await this.getBrowser()).requestConversation(parsePubkyId(peerId))
    this.assertHealthy()
  }

  async acceptRequest(requestId: string): Promise<void> {
    this.assertHealthy()
    await (await this.getBrowser()).accept(requestId)
    this.assertHealthy()
  }

  async declineRequest(requestId: string): Promise<void> {
    this.assertHealthy()
    await (await this.getBrowser()).decline(requestId)
    this.assertHealthy()
  }

  async send(peerId: PubkyId, body: string): Promise<void> {
    this.assertHealthy()
    await (await this.getBrowser()).send(parsePubkyId(peerId), validateMessageBody(body))
    this.assertHealthy()
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async getBrowser(): Promise<BrowserTransport> {
    if (this.browser !== null) return this.browser
    this.creating ??= createBrowserTransport(this.config)
    const browser = await this.creating
    if (this.browser === null) {
      this.browser = browser
      browser.subscribe((event) => {
        try {
          this.handleBrowserEvent(event)
        } catch {
          this.boundaryFailure = new TransportUnavailableError(
            'Invalid data was rejected at the browser transport boundary.',
          )
          this.emit({
            type: 'connection',
            phase: 'error',
            detail: 'Invalid data was rejected at the browser transport boundary.',
          })
          void browser.disconnect().catch(() => undefined)
        }
      })
    }
    return this.browser
  }

  private handleBrowserEvent(event: BrowserTransportEvent): void {
    switch (event.type) {
      case 'unavailable':
        this.boundaryFailure = new TransportUnavailableError('Browser transport is unavailable.')
        this.emit({
          type: 'connection',
          phase: 'unavailable',
          detail: 'Browser transport is unavailable.',
        })
        return
      case 'auth-required':
        this.emit({
          type: 'authorization-required',
          authorizationUrl: validateAuthorizationUrl(event.authorizationUrl, this.config),
        })
        return
      case 'identity': {
        const identity = parsePubkyId(event.identity)
        if (this.ownerId !== null && this.ownerId !== identity) {
          throw new TransportUnavailableError('Ring identity changed unexpectedly.')
        }
        this.ownerId = identity
        return
      }
      case 'connecting':
        this.requireIdentity()
        if (event.peerId === undefined) {
          this.emit({ type: 'connection', phase: 'publishing' })
        } else {
          this.emit({ type: 'peer-state', peerId: parsePubkyId(event.peerId), phase: 'requesting' })
        }
        return
      case 'online-state':
        if (event.online && this.ownerId === null) {
          throw new TransportUnavailableError('Online state arrived before identity verification.')
        }
        this.emit({ type: 'connection', phase: event.online ? 'online' : 'disconnected' })
        return
      case 'inbound-request':
        this.requireIdentity()
        this.emit({
          type: 'inbound-request',
          request: {
            requestId: validateRequestId(event.id),
            peerId: parsePubkyId(event.peerId),
            receivedAt: validateTimestamp(event.receivedAt),
          },
        })
        return
      case 'inbound-request-expired':
        this.requireIdentity()
        this.emit({ type: 'request-withdrawn', requestId: validateRequestId(event.id) })
        return
      case 'peer-verified':
        this.requireIdentity()
        if (
          event.protocolVersion !== 4 ||
          event.path !== 'relay' ||
          event.route !== 'relay' ||
          event.e2e !== true ||
          event.irohQuicEncrypted !== true ||
          event.pubkyIdentityVerified !== true ||
          event.alpn !== 'pubky2pubky/iroh/v4'
        ) {
          throw new TransportUnavailableError('The browser transport returned an invalid verified peer.')
        }
        this.emit({ type: 'peer-state', peerId: parsePubkyId(event.peerId), phase: 'verified' })
        return
      case 'peer-disconnected':
        this.requireIdentity()
        this.emit({ type: 'peer-state', peerId: parsePubkyId(event.peerId), phase: 'offline' })
        return
      case 'message': {
        this.requireIdentity()
        const body = decodeMessage(event.body)
        this.emit({
          type: 'message',
          message: {
            id: globalThis.crypto.randomUUID(),
            peerId: parsePubkyId(event.peerId),
            body,
            receivedAt: validateTimestamp(event.receivedAt),
          },
        })
        return
      }
      case 'error':
        if (PEER_SCOPED_ERROR_CODES.has(event.code)) return
        this.emit({ type: 'connection', phase: 'error', detail: `Transport error: ${event.code}` })
    }
  }

  private requireIdentity(): PubkyId {
    if (this.ownerId === null) {
      throw new TransportUnavailableError('Transport event arrived before identity verification.')
    }
    return this.ownerId
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // Consumer failures cannot alter authenticated transport state.
      }
    }
  }

  private assertHealthy(): void {
    if (this.boundaryFailure !== null) throw this.boundaryFailure
  }
}

function validateAuthorizationUrl(value: string, config: BrowserTransportConfig): string {
  if (encoder.encode(value).byteLength > MAX_AUTHORIZATION_URL_BYTES) {
    throw new TransportUnavailableError('Ring authorization URL is invalid.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TransportUnavailableError('Ring authorization URL is invalid.')
  }
  const keys = [...url.searchParams.keys()].sort()
  if (
    url.protocol !== 'pubkyauth:' ||
    url.hostname !== 'signin_grant' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '' ||
    url.hash !== '' ||
    keys.join(',') !== 'caps,cid,cpk,relay,secret' ||
    url.searchParams.get('caps') !== REQUIRED_CAPABILITY ||
    url.searchParams.get('cid') !== config.clientId ||
    !isCanonicalPubky(url.searchParams.get('cpk')) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('secret') ?? '') ||
    normalizeUrl(url.searchParams.get('relay')) !== normalizeUrl(config.httpRelay)
  ) {
    throw new TransportUnavailableError('Ring authorization URL is invalid.')
  }
  return url.href
}

function isCanonicalPubky(value: string | null): boolean {
  if (value === null) return false
  try {
    return parsePubkyId(value) === value
  } catch {
    return false
  }
}

function normalizeUrl(value: string | null): string {
  if (value === null) return ''
  try {
    return new URL(value).href
  } catch {
    return ''
  }
}

function validateRequestId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TransportUnavailableError('Request ID is invalid.')
  return value
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new TransportUnavailableError('Transport timestamp is invalid.')
  }
  return value
}

function decodeMessage(bytes: Uint8Array): string {
  if (!isUint8Array(bytes) || bytes.byteLength === 0 || bytes.byteLength > 4_096) {
    throw new TransportUnavailableError('Transport message is invalid.')
  }
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (encoder.encode(body).byteLength !== bytes.byteLength) throw new Error('non-canonical UTF-8')
    return validateMessageBody(body)
  } catch {
    throw new TransportUnavailableError('Transport message is invalid.')
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
}
