import type { Snapshot } from '../types'
import { idbClear, idbGet, idbPut } from './idb'

/**
 * Everything the UI needs from persistence. For now it is backed by IndexedDB inside the web view;
 * later an implementation that talks to the Anki backend (rslib) can replace it without touching the UI.
 */
export interface Repository {
  load(): Promise<Snapshot | null>
  save(snapshot: Snapshot): Promise<void>
  putMedia(blob: Blob): Promise<string>
  getMedia(id: string): Promise<Blob | null>
  wipe(): Promise<void>
}

export const localRepository: Repository = {
  async load() {
    return (await idbGet<Snapshot>('kv', 'snapshot')) ?? null
  },
  async save(snapshot) {
    await idbPut('kv', 'snapshot', snapshot)
  },
  async putMedia(blob) {
    const id = crypto.randomUUID()
    await idbPut('media', id, blob)
    return id
  },
  async getMedia(id) {
    return (await idbGet<Blob>('media', id)) ?? null
  },
  async wipe() {
    await idbClear('kv')
    await idbClear('media')
  },
}
