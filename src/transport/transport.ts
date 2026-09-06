import type { PubkyId } from '../domain/pubky-id'

export type ConnectionPhase =
  | 'unavailable'
  | 'disconnected'
  | 'authorizing'
  | 'publishing'
  | 'online'
  | 'error'

export type PeerConnectionPhase = 'requesting' | 'awaiting-acceptance' | 'verified' | 'offline' | 'error'

export interface InboundChatRequest {
  readonly requestId: string
  readonly peerId: PubkyId
  readonly receivedAt: number
}

export interface InboundTransportMessage {
  readonly id: string
  readonly peerId: PubkyId
  readonly body: string
  /** Local receipt time assigned by the adapter, in Unix milliseconds. */
  readonly receivedAt: number
}

export type TransportEvent =
  | { readonly type: 'connection'; readonly phase: ConnectionPhase; readonly detail?: string }
  | { readonly type: 'authorization-required'; readonly authorizationUrl: string }
  | { readonly type: 'inbound-request'; readonly request: InboundChatRequest }
  | { readonly type: 'request-withdrawn'; readonly requestId: string }
  | { readonly type: 'peer-state'; readonly peerId: PubkyId; readonly phase: PeerConnectionPhase }
  | { readonly type: 'message'; readonly message: InboundTransportMessage }

export type TransportListener = (event: TransportEvent) => void

export interface ConnectedIdentity {
  readonly ownerId: PubkyId
}

/**
 * Boundary implemented by the immutable pubky2pubky browser package.
 * UI and persistence code must not infer success outside these methods/events.
 */
export interface TransportAdapter {
  readonly availability: 'available' | 'unavailable'
  readonly unavailableReason?: string

  connectWithRing(): Promise<ConnectedIdentity>
  disconnect(): Promise<void>
  requestConversation(peerId: PubkyId): Promise<void>
  /** Resolves only after the accepted peer and live endpoint are cryptographically verified. */
  acceptRequest(requestId: string): Promise<void>
  declineRequest(requestId: string): Promise<void>
  send(peerId: PubkyId, body: string): Promise<void>
  subscribe(listener: TransportListener): () => void
}

export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}
