import type { Card, CardLayout, CardSide, ReviewLogEntry, Settings, Snapshot, TreeNode } from '../types'

export type ServerSnapshot = Snapshot & { dayStart: number }

export interface NextCard {
  card: Card | null
  /** ms until the card is seen again after again / hard / good / easy — straight from Anki's scheduler */
  delays?: number[]
  counts?: { new: number; learning: number; review: number }
  /** already reviewed today and not due again yet: an answer now is practice only (the schedule is left as it is) */
  practice?: boolean
}

export interface Buttons {
  learning: number[]
  young: number[]
  mature: number[]
}
export interface Retention {
  youngPassed: number
  youngFailed: number
  maturePassed: number
  matureFailed: number
}
/** Numbers straight from Anki's statistics engine (plus per-day revlog sums). Day 0 = today. */
export interface Stats {
  dayStart: number
  days: { day: number; cards: number; files: number; minutes: number }[]
  future: { day: number; due: number }[]
  cardCounts: Record<'new' | 'learn' | 'relearn' | 'young' | 'mature' | 'suspended' | 'buried', number>
  buttons: Record<'month' | 'quarter' | 'year' | 'all', Buttons>
  retention: Record<'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all', Retention>
  today: { answers: number; minutes: number; correct: number }
  fsrs: boolean
}

export interface FsrsStatus {
  enabled: boolean
  reviews: number
  hardLimit: number
  minItems: number
  last: null | {
    day: number
    reviews: number
    items?: number
    rmse?: number
    logLoss?: number
    baseline?: number
    enabled: boolean
    reason?: string
  }
}


/** Everything the UI needs from the Anki engine. Two implementations: the HTTP server on a PC and the on-device engine. */
export interface Api {
  fsrs(): Promise<FsrsStatus>
  fsrsCheck(): Promise<FsrsStatus>
  stats(): Promise<Stats>
  snapshot(): Promise<ServerSnapshot>
  /** Anki's next card among the cards directly in this folder (null = the top level) */
  next(folderId: string | null): Promise<NextCard>
  cardInfo(id: string): Promise<NextCard>
  /** one card with its pages and layout (snapshots only carry names and schedules) */
  cardFull(id: string): Promise<Card>
  createNode(parentId: string | null, name: string): Promise<TreeNode>
  /** resolves with the name Anki kept (made unique, "::" replaced) */
  renameNode(id: string, name: string): Promise<{ ok: boolean; name?: string }>
  /** folders (with everything inside) and cards together = one undo step */
  deleteItems(nodes: string[], cards: string[]): Promise<unknown>
  createCard(folderId: string | null, name: string, front: CardSide, back: CardSide, layout?: CardLayout): Promise<Card>
  /** cards from a file: a new folder of their own (in parentId) with Anki's daily new-card limit; one undo step */
  importCards(parentId: string | null, name: string, cards: { name: string; front: CardSide; back: CardSide; layout?: CardLayout }[], newPerDay: number | null): Promise<TreeNode>
  /** a folder's own daily new-card limit (null = none) */
  setNewLimit(id: string, limit: number | null): Promise<unknown>
  updateCard(id: string, patch: { name?: string; front?: CardSide; back?: CardSide; layout?: CardLayout }): Promise<Card>
  /** `millis`: how long the card was on screen (Anki records it in the review log) */
  answer(cardId: string, rating: number, millis: number): Promise<{ card: Card; revlog: ReviewLogEntry[]; practice?: boolean }>
  undo(): Promise<{ ok?: boolean }>
  redo(): Promise<{ ok?: boolean }>
  /** Cut + paste into a folder (null = the top level): folders are renamed into it, cards change deck; both keep their schedule. */
  moveItems(nodes: string[], cards: string[], to: string | null): Promise<unknown>
  /** Copy + paste (deep for folders). The copies are new cards. */
  copyItems(nodes: string[], cards: string[], to: string | null): Promise<unknown>
  saveSettings(s: Settings): Promise<unknown>
  reset(): Promise<unknown>
  /** Saves the whole collection (cards, media, schedule, history) as one `.colpkg` file chosen by the user. */
  exportBackup(): Promise<{ ok: boolean }>
  /** Replaces the whole collection with a `.colpkg` file chosen by the user (a safety copy is kept first). */
  importBackup(): Promise<{ ok: boolean }>
  uploadMedia(blob: Blob): Promise<string>
  mediaUrl(name: string): string
  /** Deletes these media files, only those no card uses any more (Anki's own Check Media decides) */
  removeMedia(names: string[]): Promise<{ removed: string[] }>
}
