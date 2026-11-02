import { httpApi } from './httpApi'
import type { Api } from './apiTypes'

export * from './apiTypes'

/**
 * The Anki engine used by the app:
 *  - inside the Android app (Capacitor): the real Anki backend (rslib) running on the phone;
 *  - in a browser on a PC: the Yadavar server (yadavar-server), which runs the same backend through Python.
 * The engine is created lazily so the browser build never loads the on-device code.
 */
let current: Api = httpApi

export async function selectApi(): Promise<void> {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (cap?.isNativePlatform?.()) {
    const { createNativeApi } = await import('../engine/native')
    current = await createNativeApi()
  }
}

export const api: Api = new Proxy({} as Api, {
  get: (_t, key: string) => (current as unknown as Record<string, unknown>)[key],
})
