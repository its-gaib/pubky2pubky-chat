import {
  ArrowRight,
  ChevronRight,
  Copy,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ChatController, type ConversationView } from './controller/chat-controller'
import { useChatController } from './controller/use-chat-controller'
import { isPubkyId, parsePubkyId, shortenPubkyId, type PubkyId } from './domain/pubky-id'
import { ChatDatabase } from './storage/database'
import { HistoryRepository, isHistoryDatabaseAvailable } from './storage/history-repository'
import { getBrowserTransportConfig } from './config/transport'
import { Pubky2PubkyTransportAdapter } from './transport/pubky2pubky-transport'
import { PeerConnectionBadge, RingConnectionBadge } from './components/connection-badge'
import { InboundRequestCard } from './components/inbound-request-card'
import { MessageComposer } from './components/message-composer'

const database = new ChatDatabase()
const history = new HistoryRepository(database)
const transport = new Pubky2PubkyTransportAdapter(getBrowserTransportConfig())
const controller = new ChatController(transport, history)

function ConversationAvatar({ peerId }: { readonly peerId: PubkyId }) {
  return (
    <div className="avatar" aria-hidden="true">
      {peerId.slice(0, 2).toUpperCase()}
    </div>
  )
}

function ConversationButton({
  conversation,
  selected,
  onSelect,
}: {
  readonly conversation: ConversationView
  readonly selected: boolean
  readonly onSelect: (peerId: PubkyId) => void
}) {
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      className={selected ? 'conversation conversation-selected' : 'conversation'}
      onClick={() => onSelect(conversation.peerId)}
      type="button"
    >
      <ConversationAvatar peerId={conversation.peerId} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-[13px] text-zinc-100">
          {shortenPubkyId(conversation.peerId)}
        </span>
        <span className="mt-1 block text-xs text-zinc-500">
          {conversation.connection === 'verified' ? 'Encrypted connection' : 'Not connected'}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="text-zinc-700" size={15} />
    </button>
  )
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export default function App() {
  const state = useChatController(controller)
  const [peerInput, setPeerInput] = useState('')
  const [peerError, setPeerError] = useState<string | null>(null)
  const [showHistoryConfirmation, setShowHistoryConfirmation] = useState(false)

  const selectedConversation = state.conversations.find(
    (conversation) => conversation.peerId === state.selectedPeerId,
  )
  const peerInputValid = isPubkyId(peerInput)

  function startChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      parsePubkyId(peerInput)
      setPeerError(null)
      void controller.startConversation(peerInput).catch(() => undefined)
    } catch (error) {
      setPeerError(error instanceof Error ? error.message : 'Enter a valid Pubky ID.')
    }
  }

  function selectConversation(peerId: PubkyId) {
    void controller.selectConversation(peerId).catch(() => undefined)
  }

  function acceptRequest(requestId: string) {
    void controller.acceptRequest(requestId).catch(() => undefined)
  }

  function declineRequest(requestId: string) {
    void controller.declineRequest(requestId).catch(() => undefined)
  }

  function copyOwnerId() {
    if (state.ownerId !== null) void navigator.clipboard.writeText(state.ownerId).catch(() => undefined)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <MessageCircle size={19} strokeWidth={2.3} />
          </div>
          <div>
            <p className="brand-name">pubky<span>2</span>pubky</p>
            <p className="brand-subtitle">Private browser chat</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
            <LockKeyhole aria-hidden="true" size={13} /> Browser-local history
          </div>
          <RingConnectionBadge phase={state.connection} />
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="identity-card" aria-labelledby="identity-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="section-kicker" id="identity-title">Your identity</p>
                <h1 className="mt-1 text-base font-semibold tracking-tight text-white">
                  {state.ownerId === null ? 'Connect with Pubky Ring' : 'Ring connected'}
                </h1>
              </div>
              <div className="ring-glyph" aria-hidden="true">
                <KeyRound size={18} />
              </div>
            </div>
            {state.ownerId === null ? (
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                Ring will approve the scoped chat capability. Your recovery phrase never enters this site.
              </p>
            ) : (
              <button className="identity-key" onClick={copyOwnerId} type="button">
                <span className="truncate font-mono text-xs">{state.ownerId}</span>
                <Copy aria-hidden="true" size={13} />
              </button>
            )}
            <button
              className="button button-primary mt-4 w-full"
              disabled={state.busy}
              onClick={() =>
                void (state.ownerId === null ? controller.connectWithRing() : controller.disconnect())
              }
              type="button"
            >
              <Fingerprint aria-hidden="true" size={17} />
              {state.busy
                ? 'Waiting for Ring…'
                : state.ownerId === null
                  ? 'Connect with Ring'
                  : 'Disconnect'}
            </button>
            {state.connectionDetail !== null && (
              <p className="notice notice-warning mt-3" role="status">{state.connectionDetail}</p>
            )}
            {state.authorizationUrl !== null && (
              <a className="button button-secondary mt-3 w-full" href={state.authorizationUrl}>
                Open Ring approval
              </a>
            )}
          </section>

          <section className="new-chat" aria-labelledby="new-chat-title">
            <div className="flex items-center justify-between">
              <p className="section-kicker" id="new-chat-title">Start a chat</p>
              <Plus aria-hidden="true" className="text-zinc-600" size={15} />
            </div>
            <form className="mt-3" onSubmit={startChat}>
              <label className="input-label" htmlFor="peer-pubky">Their 52-character Pubky ID</label>
              <div className="input-wrap">
                <Search aria-hidden="true" size={15} />
                <input
                  aria-describedby="peer-help"
                  autoComplete="off"
                  autoCorrect="off"
                  className="pubky-input"
                  id="peer-pubky"
                  onChange={(event) => {
                    setPeerInput(event.target.value)
                    setPeerError(null)
                  }}
                  placeholder="o4dksfbq…"
                  spellCheck="false"
                  value={peerInput}
                />
              </div>
              <p className={peerError === null ? 'input-help' : 'input-error'} id="peer-help">
                {peerError ?? `${peerInput.length} / 52 characters`}
              </p>
              <button
                className="button button-secondary mt-3 w-full"
                disabled={!peerInputValid || state.connection !== 'online' || state.busy}
                type="submit"
              >
                Request chat <ArrowRight aria-hidden="true" size={15} />
              </button>
            </form>
          </section>

          {state.inboundRequests.length > 0 && (
            <section className="request-list" aria-labelledby="requests-title">
              <p className="section-kicker mb-3" id="requests-title">Requests</p>
              {state.inboundRequests.map((request) => (
                <InboundRequestCard
                  disabled={state.busy}
                  key={request.requestId}
                  onAccept={acceptRequest}
                  onDecline={declineRequest}
                  request={request}
                />
              ))}
            </section>
          )}

          <section className="conversation-list" aria-labelledby="conversations-title">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="section-kicker" id="conversations-title">Conversations</p>
              <span className="count-badge">{state.conversations.length}</span>
            </div>
            {state.conversations.length === 0 ? (
              <div className="sidebar-empty">
                <MessageCircle aria-hidden="true" size={18} />
                <p>No local conversations yet.</p>
              </div>
            ) : (
              state.conversations.map((conversation) => (
                <ConversationButton
                  conversation={conversation}
                  key={conversation.peerId}
                  onSelect={selectConversation}
                  selected={conversation.peerId === state.selectedPeerId}
                />
              ))
            )}
          </section>

          <div className="sidebar-footer">
            {!showHistoryConfirmation ? (
              <button
                className="privacy-action"
                disabled={state.ownerId === null || state.conversations.length === 0}
                onClick={() => setShowHistoryConfirmation(true)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} /> Delete all local history
              </button>
            ) : (
              <div className="delete-confirmation" role="alert">
                <p>Delete every local chat for this account?</p>
                <div className="mt-2 flex gap-2">
                  <button
                    className="button button-danger button-small"
                    onClick={() => {
                      void controller.clearLocalHistory().then(() => setShowHistoryConfirmation(false))
                    }}
                    type="button"
                  >
                    Delete
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() => setShowHistoryConfirmation(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="storage-state">
              <span className={isHistoryDatabaseAvailable() ? 'storage-light storage-ok' : 'storage-light'} />
              {isHistoryDatabaseAvailable() ? 'Encrypted IndexedDB available' : 'Secure storage unavailable'}
            </p>
          </div>
        </aside>

        <section className="chat-panel" aria-label="Chat">
          {selectedConversation === undefined || state.selectedPeerId === null ? (
            <div className="welcome-state">
              <div className="welcome-orbit" aria-hidden="true">
                <div className="welcome-core"><Radio size={26} /></div>
              </div>
              <p className="section-kicker">Direct when possible · Relayed in browsers</p>
              <h2 className="welcome-title">A quieter place to talk.</h2>
              <p className="welcome-copy">
                Enter a Pubky ID to deliver a signed Hello over Iroh. Chat unlocks only after the recipient
                accepts and both sides complete live Pubky authority checks.
              </p>
              <div className="privacy-grid">
                <div>
                  <ShieldCheck aria-hidden="true" size={18} />
                  <p><strong>End-to-end encrypted</strong><span>Iroh terminates inside each browser.</span></p>
                </div>
                <div>
                  <LockKeyhole aria-hidden="true" size={18} />
                  <p><strong>Browser-local</strong><span>No chat bodies on a homeserver.</span></p>
                </div>
                <div>
                  <UserRound aria-hidden="true" size={18} />
                  <p><strong>Manual approval</strong><span>Application messages wait for acceptance.</span></p>
                </div>
              </div>
              <div className="transport-note" role="status">
                <span className="transport-note-icon"><MoreHorizontal aria-hidden="true" size={18} /></span>
                <span>
                  <strong>Relay metadata is visible</strong>
                  The Iroh relay can observe endpoint IDs, IP addresses, timing, and traffic shape—not message text.
                </span>
              </div>
            </div>
          ) : (
            <>
              <header className="chat-header">
                <div className="flex min-w-0 items-center gap-3">
                  <ConversationAvatar peerId={state.selectedPeerId} />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-white" title={state.selectedPeerId}>
                      {shortenPubkyId(state.selectedPeerId)}
                    </p>
                    <PeerConnectionBadge phase={selectedConversation.connection} />
                  </div>
                </div>
                <button
                  aria-label="Delete this local conversation"
                  className="icon-button"
                  onClick={() => void controller.deleteSelectedConversation()}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              </header>
              <div className="message-list" aria-live="polite">
                {state.messages.length === 0 ? (
                  <div className="message-empty">
                    <MessageCircle aria-hidden="true" size={20} />
                    <p>The encrypted transcript is empty.</p>
                    <span>Sending unlocks only after identity and peer verification.</span>
                  </div>
                ) : (
                  state.messages.map((message) => (
                    <article
                      className={message.direction === 'outbound' ? 'message message-outbound' : 'message'}
                      key={message.id}
                    >
                      <p>{message.body}</p>
                      <time dateTime={new Date(message.createdAt).toISOString()}>
                        {formatMessageTime(message.createdAt)}
                        {message.direction === 'outbound' && message.delivery !== 'sent'
                          ? ` · ${message.delivery === 'sending' ? 'Sending' : 'Failed'}`
                          : ''}
                      </time>
                    </article>
                  ))
                )}
              </div>
              <MessageComposer
                enabled={selectedConversation.connection === 'verified' && state.connection === 'online'}
                onSend={(body) => controller.send(body)}
              />
            </>
          )}
        </section>
      </main>
    </div>
  )
}
