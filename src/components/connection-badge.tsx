import { Check, CircleAlert, CircleDotDashed, Radio, ShieldCheck } from 'lucide-react'
import type { ConnectionPhase, PeerConnectionPhase } from '../transport/transport'

interface RingConnectionBadgeProps {
  readonly phase: ConnectionPhase
}

export function RingConnectionBadge({ phase }: RingConnectionBadgeProps) {
  if (phase === 'online') {
    return (
      <span className="status-pill status-pill-online">
        <Radio aria-hidden="true" size={13} /> Online
      </span>
    )
  }
  if (phase === 'authorizing' || phase === 'publishing') {
    return (
      <span className="status-pill status-pill-progress">
        <CircleDotDashed aria-hidden="true" size={13} /> Connecting
      </span>
    )
  }
  if (phase === 'error' || phase === 'unavailable') {
    return (
      <span className="status-pill status-pill-error">
        <CircleAlert aria-hidden="true" size={13} /> Unavailable
      </span>
    )
  }
  return (
    <span className="status-pill">
      <span aria-hidden="true" className="status-dot" /> Offline
    </span>
  )
}

interface PeerConnectionBadgeProps {
  readonly phase: PeerConnectionPhase
}

export function PeerConnectionBadge({ phase }: PeerConnectionBadgeProps) {
  if (phase === 'verified') {
    return (
      <span className="peer-truth">
        <ShieldCheck aria-hidden="true" size={14} /> Relayed · E2E encrypted
      </span>
    )
  }
  if (phase === 'awaiting-acceptance' || phase === 'requesting') {
    return (
      <span className="peer-pending">
        <CircleDotDashed aria-hidden="true" size={14} /> Waiting for peer
      </span>
    )
  }
  if (phase === 'error') {
    return (
      <span className="peer-error">
        <CircleAlert aria-hidden="true" size={14} /> Connection failed
      </span>
    )
  }
  return (
    <span className="peer-offline">
      <Check aria-hidden="true" size={14} /> Saved locally · Offline
    </span>
  )
}

