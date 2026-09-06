# pubky2pubky chat

A standalone, browser-only chat surface for Pubky identities. It uses the shared `pubky2pubky` v4
browser transport and keeps chat history in this browser instead of writing messages to a
homeserver.

## Current status

- Polished responsive chat shell with Pubky Ring, outbound request, inbound consent, conversation,
  offline, unavailable, and error states.
- Canonical bare 52-character Pubky ID validation. URLs, routes, logs, analytics, service-worker
  caches, and DOM data attributes never carry Pubky IDs or message bodies.
- Account-and-peer-partitioned local history in IndexedDB.
- Message bodies encrypted before persistence with AES-256-GCM. Each account gets a non-extractable
  WebCrypto key stored by IndexedDB structured clone. Authentication data binds ciphertext to its
  record ID, owner, peer, direction, and timestamp.
- A fail-closed adapter around `pubky2pubky/browser`. It restores one local identity or asks Pubky
  Ring for an exact `/pub/pubky2pubky/:rw` Grant, publishes the browser device, handles inbound
  consent, and sends only after mutual v4 verification.
- **Relayed · E2E encrypted** appears only after identity, locator, Iroh endpoint, and peer
  verification have all completed.

## Browser networking constraint

Native Iroh can attempt direct paths and hole punching. Today’s browser/Wasm endpoint uses an Iroh
relay path because browsers cannot expose the UDP sockets required for native hole punching. Iroh’s
authenticated QUIC session still terminates in each browser. The relay can observe endpoint IDs,
IP addresses, timing, traffic shape, and ciphertext, but not message plaintext.

The initiator resolves the recipient’s public v4 device/relay records and encrypted Iroh QUIC reaches
the recipient before manual acceptance. The recipient verifies the inbound signed Hello offline.
Accepting then authorizes mutual live Pubky authority checks and application messaging; it is not a
network-metadata-hiding consent boundary.

The homeserver stores signed discovery material under `/pub/pubky2pubky/`; it is not chat storage.
Messages are sent over Iroh and chat bodies are retained only as encrypted browser-local history.

## Local development

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

The Vite server binds to `127.0.0.1` by default. Never enter a recovery phrase in this vibe. The
Connect action opens Pubky Ring with a short-lived, memory-only authorization URL and requests only
the scoped Grant needed to publish pubky2pubky device records.

The default development and deployment configuration trusts the Pubky staging HTTP relay and the
`euc1-1.relay.n0.iroh.link` Iroh relay. Override them only with reviewed origins through
`VITE_PUBKY2PUBKY_HTTP_RELAY` and `VITE_PUBKY2PUBKY_IROH_RELAY`. Plain HTTP is accepted only for an
explicit loopback testnet configured with `VITE_PUBKY2PUBKY_TESTNET_HOST`.

## Verification

```sh
npm run lint
npm run typecheck
npm run test:run
npm run build
npm audit
```

Tests cover canonical Pubky ID parsing, UTF-8 message size limits, encrypted account partitioning,
retention limits, missing-key fail-closed behavior, and send controls before peer verification.

## Storage and deletion notes

Message plaintext exists in page memory while it is displayed, but is not persisted. IndexedDB does
retain metadata needed to find a conversation: owner Pubky, peer Pubky, direction, timestamps, and
ciphertext length. “Delete all local history” removes that account’s ciphertext, conversation rows,
and encryption key. Browser or filesystem storage may retain forensic remnants outside this app’s
control, so deletion is not advertised as secure erasure.

The non-extractable key prevents key export and protects bodies in an offline database copy. It does
not protect plaintext from malicious code already executing in this origin; CSP, dependency pinning,
and transport-package review remain part of the security boundary.

History is capped at 500 records per conversation, 5,000 records per account, and 100 conversations.
The oldest records are evicted first.

## Deployment boundary

`vercel.json` permits network connections only to the app origin, the exact Pubky staging HTTP relay,
and the exact HTTPS/WSS Iroh relay origin. It allows no framing, object/media access, camera,
microphone, geolocation, payment, or USB permissions. Do not broaden `connect-src` with wildcards.
