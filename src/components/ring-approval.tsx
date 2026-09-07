import { Copy, Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'

type CopyStatus = 'idle' | 'copying' | 'copied' | 'failed'

export function RingApproval({ authorizationUrl }: { readonly authorizationUrl: string | null }) {
  if (authorizationUrl === null) return null
  return <RingApprovalRequest authorizationUrl={authorizationUrl} key={authorizationUrl} />
}

function RingApprovalRequest({ authorizationUrl }: { readonly authorizationUrl: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  async function copyApprovalLink() {
    setCopyStatus('copying')
    try {
      await navigator.clipboard.writeText(authorizationUrl)
      if (active.current) setCopyStatus('copied')
    } catch {
      if (active.current) setCopyStatus('failed')
    }
  }

  return (
    <div className="ring-approval" data-sentry-block>
      <p className="text-sm font-semibold text-zinc-100">Approve with Ring on your phone</p>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Open Pubky Ring on your phone, scan this QR code, then approve the request. Keep this page open.
      </p>
      <div className="ring-approval-qr">
        <QRCodeSVG
          aria-label="Pubky Ring approval QR code"
          bgColor="#ffffff"
          fgColor="#090a0b"
          level="M"
          marginSize={4}
          role="img"
          size={240}
          value={authorizationUrl}
        />
      </div>
      <p className="mb-2 text-xs leading-5 text-zinc-400">Using Ring on this device? Open it below.</p>
      <button
        className="button button-secondary w-full"
        onClick={() => { window.location.href = authorizationUrl }}
        type="button"
      >
        <Smartphone aria-hidden="true" size={15} />
        Open Ring on this device
      </button>
      <button
        className="button button-ghost mt-2 w-full"
        disabled={copyStatus === 'copying'}
        onClick={() => { void copyApprovalLink() }}
        type="button"
      >
        <Copy aria-hidden="true" size={15} />
        Copy approval link
      </button>
      <p aria-live="polite" className="ring-approval-feedback" role="status">
        {copyStatus === 'copied' && 'Approval link copied.'}
        {copyStatus === 'failed' && 'Could not copy the approval link. Scan the QR code or open Ring on this device.'}
      </p>
    </div>
  )
}
