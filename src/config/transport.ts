import type { BrowserTransportConfig } from 'pubky2pubky/browser'

const DEFAULT_HTTP_RELAY = 'https://httprelay.staging.pubky.app/inbox'
const DEFAULT_IROH_RELAY = 'https://euc1-1.relay.n0.iroh.link/'
const DEFAULT_CLIENT_ID = 'chat.pubky2pubky'

function environment(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function getBrowserTransportConfig(): BrowserTransportConfig {
  const testnetHost = environment(import.meta.env.VITE_PUBKY2PUBKY_TESTNET_HOST)
  return {
    clientId: environment(import.meta.env.VITE_PUBKY2PUBKY_CLIENT_ID) ?? DEFAULT_CLIENT_ID,
    httpRelay: environment(import.meta.env.VITE_PUBKY2PUBKY_HTTP_RELAY) ?? DEFAULT_HTTP_RELAY,
    irohRelays: [environment(import.meta.env.VITE_PUBKY2PUBKY_IROH_RELAY) ?? DEFAULT_IROH_RELAY],
    ...(testnetHost === undefined ? {} : { testnet: { enabled: true, pubkyHost: testnetHost } }),
  }
}
