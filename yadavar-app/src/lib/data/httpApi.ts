import type { Card, CardLayout, CardSide, ReviewLogEntry, Settings, TreeNode } from '../types'
import type { Api, FsrsStatus, NextCard, ServerSnapshot, Stats } from './apiTypes'

/**
 * Talks to the Yadavar server, which runs the unmodified official Anki backend (see ../../../yadavar-server).
 * Empty base = same origin (the server also serves the built UI, and `vite dev` proxies /api to it).
 * For the Android app set VITE_API=http://<pc-address>:8765 when building.
 */
export const API_BASE: string = (import.meta.env.VITE_API as string | undefined) ?? ''

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? res.statusText)
  return data as T
}

export const httpApi: Api = {
  fsrs: () => call<FsrsStatus>('/api/fsrs'),
  fsrsCheck: () => call<FsrsStatus>('/api/fsrs/check', {}),
  stats: () => call<Stats>('/api/stats'),
  snapshot: () => call<ServerSnapshot>('/api/snapshot'),
  next: (folderId: string | null) => call<NextCard>(`/api/next?folder=${folderId ?? ''}`),
  cardInfo: (id: string) => call<NextCard>(`/api/card/${id}`),
  cardFull: (id: string) => call<Card>('/api/cardfull', { id }),
  createNode: (parentId: string | null, name: string) => call<TreeNode>('/api/node', { parentId, name }),
  renameNode: (id: string, name: string) => call<{ ok: boolean; name?: string }>('/api/node/rename', { id, name }),
  deleteItems: (nodes: string[], cards: string[]) => call('/api/delete', { nodes, cards }),
  createCard: (folderId: string | null, name: string, front: CardSide, back: CardSide, layout?: CardLayout) =>
    call<Card>('/api/card', { folderId, name, front, back, ...(layout ? { layout } : {}) }),
  importCards: (parentId: string | null, name: string, cards: { name: string; front: CardSide; back: CardSide; layout?: CardLayout }[], newPerDay: number | null) =>
    call<TreeNode>('/api/cards/import', { parentId, name, cards, newPerDay }),
  setNewLimit: (id: string, limit: number | null) => call('/api/node/limit', { id, limit }),
  removeMedia: (names: string[]) => call<{ removed: string[] }>('/api/media/remove', { names }),
  updateCard: (id: string, patch: { name?: string; front?: CardSide; back?: CardSide; layout?: CardLayout }) =>
    call<Card>('/api/card/update', { id, ...patch }),
  answer: (cardId: string, rating: number, millis: number) =>
    call<{ card: Card; revlog: ReviewLogEntry[] }>('/api/answer', { cardId, rating, millis }),
  undo: () => call<{ ok?: boolean }>('/api/undo', {}),
  redo: () => call<{ ok?: boolean }>('/api/redo', {}),
  moveItems: (nodes: string[], cards: string[], to: string | null) => call('/api/move', { nodes, cards, to }),
  copyItems: (nodes: string[], cards: string[], to: string | null) => call('/api/copy', { nodes, cards, to }),
  saveSettings: (s: Settings) => call('/api/settings', s),
  reset: () => call('/api/reset', {}),

  async exportBackup() {
    const res = await fetch(API_BASE + '/api/export')
    if (!res.ok) throw new Error('export failed')
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `yadavar-${new Date().toISOString().slice(0, 10)}.colpkg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true }
  },
  async importBackup() {
    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.colpkg'
      input.onchange = () => resolve(input.files?.[0] ?? null)
      input.oncancel = () => resolve(null)
      input.click()
    })
    if (!file) return { ok: false }
    const res = await fetch(API_BASE + '/api/import', { method: 'POST', body: file })
    if (!res.ok) throw new Error('import failed')
    return { ok: true }
  },

  async uploadMedia(blob: Blob): Promise<string> {
    const ext = (blob.type.split('/')[1] ?? 'bin').split(';')[0].replace('mpeg', 'mp3').replace('x-wav', 'wav')
    const res = await fetch(`${API_BASE}/api/media?name=${encodeURIComponent('yadavar.' + ext)}`, { method: 'POST', body: blob })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error ?? res.statusText)
    return data.name as string
  },
  mediaUrl: (name: string) => `${API_BASE}/api/media/${encodeURIComponent(name)}`,
}
