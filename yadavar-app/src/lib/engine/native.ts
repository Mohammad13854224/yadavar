import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Api } from '../data/apiTypes'
import { AnkiEngine } from './ankiEngine'
import { BackendRpcError, ErrorKind, type Transport } from './rpc'

/** Kotlin/Java side: android/app/src/main/java/app/yadavar/review/AnkiBackendPlugin.java */
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
interface AnkiBackendPlugin {
  checkPermissions(): Promise<{ microphone: PermissionState; camera: PermissionState }>
  requestPermissions(options?: { permissions: ('microphone' | 'camera')[] }): Promise<{ microphone: PermissionState; camera: PermissionState }>
  openSettings(): Promise<void>
  exportBackup(): Promise<{ ok: boolean }>
  importBackup(): Promise<{ ok: boolean }>
  open(): Promise<{ dir: string; mediaDir: string }>
  run(call: { service: number; method: number; data: string }): Promise<{ data: string }>
}
const AnkiBackend = registerPlugin<AnkiBackendPlugin>('AnkiBackend')

const toBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

export const permissions = {
  check: () => AnkiBackend.checkPermissions(),
  request: () => AnkiBackend.requestPermissions({ permissions: ['microphone', 'camera'] }),
  openSettings: () => AnkiBackend.openSettings(),
}

/** The real Anki backend running inside the phone app. */
export async function createNativeApi(): Promise<Api> {
  const { mediaDir } = await AnkiBackend.open()

  const transport: Transport = {
    async run(service, method, data) {
      try {
        const out = await AnkiBackend.run({ service, method, data: toBase64(data) })
        return fromBase64(out.data)
      } catch (e) {
        const err = e as { message?: string; code?: string }
        throw new BackendRpcError(err.message ?? 'backend error', err.code === 'NOT_FOUND' ? ErrorKind.NOT_FOUND : undefined)
      }
    },
  }

  let engine!: AnkiEngine
  engine = new AnkiEngine(transport, {
    add: async (name, data) => (await engine.rpc.call('addMediaFile', { desiredName: name, data })).val as string,
    url: (name) => Capacitor.convertFileSrc(`file://${mediaDir}/${encodeURIComponent(name)}`),
  })
  engine.exportBackup = async () => {
    try {
      return await AnkiBackend.exportBackup()
    } catch (e) {
      if ((e as { code?: string }).code === 'CANCELLED') return { ok: false }
      throw e
    }
  }
  engine.importBackup = async () => {
    try {
      const r = await AnkiBackend.importBackup()
      await engine.reinit() // the collection file was replaced
      return r
    } catch (e) {
      if ((e as { code?: string }).code === 'CANCELLED') return { ok: false }
      throw e
    }
  }
  await engine.init()
  // ask for the microphone and camera right away, so the user can decide before they are needed
  void AnkiBackend.requestPermissions({ permissions: ['microphone', 'camera'] }).catch(() => undefined)
  return engine
}
