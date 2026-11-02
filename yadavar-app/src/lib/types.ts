/** A folder. The root (home) has no node; its children have parentId = null. */
export interface TreeNode {
  id: string
  parentId: string | null
  name: string
  createdAt: number
  /** Anki's daily limit of new cards for this folder (folders made by importing a file); null / missing = no limit */
  newLimit?: number | null
}

export type WidgetKind = 'image' | 'audio' | 'text'

/** A widget placed on a card side (picture, sound or text). Pixel coordinates are relative to the side's page. */
export interface MediaWidget {
  id: string
  kind: WidgetKind
  /** the picture / sound file; empty for text */
  mediaId: string
  x: number
  y: number
  w: number
  h: number
  /** rotation in degrees around the widget's centre */
  rot?: number
  /** text widgets: one <div dir> per line (plain text + <br>), text size in px, writing direction */
  html?: string
  size?: number
  dir?: 'rtl' | 'ltr'
  /** text widgets made from the old ruled-line text keep its line height (px) */
  lh?: number
  /** text widgets: font family (see lib/fonts.ts); missing = the app's font */
  font?: string
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Position and size of the two sides inside the editor stage (px). */
export interface CardLayout {
  /** format version: 2 = one box per side, each with its own size */
  v?: number
  stageW: number
  front: Rect
  back: Rect
  /** what review shows of each side; everything outside is cut off */
  crops?: { front?: CropBox | null; back?: CropBox | null }
  /**
   * a fixed card (made while «کارت ثابت و محدود» was on): each side is a page of exactly this size that does not move
   * in the editor; everything stays inside it and review shows the whole page. Missing: the endless page.
   */
  fixed?: { w: number; h: number }
  /** false: the page has no ruled lines (made while «خط‌دار» was off). Missing: ruled */
  lines?: boolean
}

/** The part of a side that review shows (page coordinates): the frame around all its text and widgets plus a margin, kept up to date by the editor. */
export interface CropBox {
  l: number
  t: number
  r: number
  b: number
}

export interface CardSide {
  /** the text blocks of the endless ruled page (see lib/textBlocks.ts); older cards: one <div> per line of a sheet */
  html: string
  widgets: MediaWidget[]
}

/**
 * Scheduling fields are placeholders that mirror Anki's card model.
 * They get replaced by the real Anki scheduler (rslib) once the backend is connected.
 */
export type CardState = 'new' | 'learning' | 'review'

export interface Card {
  id: string
  /** the folder the card sits in; null = the top level (home), outside every folder */
  folderId: string | null
  name: string
  front: CardSide
  back: CardSide
  state: CardState
  /** Anki says this card is ready to study today (new cards included) */
  ready: boolean
  /** suspended or buried in Anki: it does not come up until that is lifted */
  parked?: boolean
  /** timestamp (ms) at which the card is due */
  due: number
  /** interval in days */
  interval: number
  /** ease factor (Anki default 2.5) */
  ease?: number
  /** index in the learning steps while state is 'learning' */
  step?: number
  /** true while a lapsed card goes through the relearning steps */
  relearn?: boolean
  reps: number
  lapses: number
  createdAt: number
  /** the chance (0..1) of remembering it right now (review and learning cards; FSRS memory state, or the classic estimate) */
  recall?: number
  /** the recall comes from FSRS (its goal is the desired retention; the classic estimate's goal is 90 %) */
  fsrs?: boolean
  /** set while only the name and the schedule are loaded (lists); the pages come with `app.ensureCard` */
  light?: boolean
  /** user-chosen sizes of the front/back boxes in the editor */
  layout?: CardLayout
}

export interface ReviewLogEntry {
  cardId: string
  at: number
  /** 1 = again, 2 = hard, 3 = good, 4 = easy */
  rating: 1 | 2 | 3 | 4
}

export type ThemeChoice = 'dark' | 'light' | 'system'

export interface Settings {
  theme: ThemeChoice
  fontScale: number
  newPerDay: number
  reviewsPerDay: number
  retention: number
  /** the last fonts picked for text, newest first (shown on top of the font list) */
  recentFonts?: string[]
  /** cards made from now on are fixed pages, all of one size (see CardLayout.fixed); existing cards keep theirs */
  fixedCards?: boolean
  /** cards made from now on have ruled lines (missing = yes) */
  ruledCards?: boolean
}

export interface Snapshot {
  version: 1
  nodes: TreeNode[]
  cards: Card[]
  revlog: ReviewLogEntry[]
  settings: Settings
}

export const defaultSettings = (): Settings => ({
  theme: 'dark',
  fontScale: 1,
  newPerDay: 20,
  reviewsPerDay: 200,
  retention: 0.9,
})

export const emptySide = (): CardSide => ({ html: '<div dir="rtl"><br></div>', widgets: [] })

export type TabId = 'reviews' | 'info' | 'status' | 'settings'
