import { ArrowDownLeft, Check, X } from 'lucide-react'
import { shortenPubkyId } from '../domain/pubky-id'
import type { InboundChatRequest } from '../transport/transport'

interface InboundRequestCardProps {
  readonly request: InboundChatRequest
  readonly disabled: boolean
  readonly onAccept: (requestId: string) => void
  readonly onDecline: (requestId: string) => void
}

export function InboundRequestCard({
  request,
  disabled,
  onAccept,
  onDecline,
}: InboundRequestCardProps) {
  return (
    <article className="request-card">
      <div className="request-icon" aria-hidden="true">
        <ArrowDownLeft size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="request-eyebrow">Incoming chat request</p>
        <p className="truncate font-mono text-[13px] text-white" title={request.peerId}>
          {shortenPubkyId(request.peerId)}
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          Accept to authorize mutual live Pubky checks and application messages.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            className="button button-primary button-small"
            disabled={disabled}
            onClick={() => onAccept(request.requestId)}
            type="button"
          >
            <Check aria-hidden="true" size={14} /> Accept
          </button>
          <button
            className="button button-ghost button-small"
            disabled={disabled}
            onClick={() => onDecline(request.requestId)}
            type="button"
          >
            <X aria-hidden="true" size={14} /> Decline
          </button>
        </div>
      </div>
    </article>
  )
}
