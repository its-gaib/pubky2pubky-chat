import { ArrowUp, LockKeyhole } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { MAX_MESSAGE_BYTES, messageByteLength, validateMessageBody } from '../domain/message'

interface MessageComposerProps {
  readonly enabled: boolean
  readonly onSend: (body: string) => Promise<void>
}

export function MessageComposer({ enabled, onSend }: MessageComposerProps) {
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const byteLength = messageByteLength(body)
  const canSend = enabled && !sending && body.trim().length > 0 && byteLength <= MAX_MESSAGE_BYTES

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    try {
      const validated = validateMessageBody(body)
      setSending(true)
      setError(null)
      await onSend(validated)
      setBody('')
    } catch {
      setError('Message was not sent. Check the verified connection and try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <label className="sr-only" htmlFor="chat-message">
        Message
      </label>
      <textarea
        aria-describedby="composer-help"
        className="composer-input"
        disabled={!enabled || sending}
        id="chat-message"
        onChange={(event) => setBody(event.target.value)}
        placeholder={enabled ? 'Write an encrypted message…' : 'A verified peer connection is required'}
        rows={1}
        value={body}
      />
      <button aria-label="Send message" className="composer-send" disabled={!canSend} type="submit">
        <ArrowUp aria-hidden="true" size={19} strokeWidth={2.5} />
      </button>
      <div className="col-span-2 flex items-center justify-between px-1" id="composer-help">
        <span className={error === null ? 'composer-help' : 'composer-error'}>
          <LockKeyhole aria-hidden="true" size={11} />
          {error ?? 'Message bodies stay end-to-end encrypted'}
        </span>
        <span className={byteLength > MAX_MESSAGE_BYTES ? 'composer-count composer-count-over' : 'composer-count'}>
          {byteLength.toLocaleString()} / {MAX_MESSAGE_BYTES.toLocaleString()} bytes
        </span>
      </div>
    </form>
  )
}

