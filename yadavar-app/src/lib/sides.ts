import type { Card, CardLayout, Settings } from './types'

export const DEFAULT_SIDE = { w: 560, h: 380 }
/** the one size of every fixed card's page (portrait, like an index card held in the hand; fits a phone's width) */
export const FIXED_SIDE = { w: 360, h: 480 }

/** The layout a new card starts with under the current settings (none: the endless ruled page, as before). */
export function newCardLayout(s: Settings): CardLayout | undefined {
  const fixed = !!s.fixedCards
  const lines = s.ruledCards !== false
  if (!fixed && lines) return undefined
  const size = fixed ? FIXED_SIDE : DEFAULT_SIDE
  return {
    v: 2,
    stageW: 0,
    front: { x: 0, y: 0, ...size },
    back: { x: 0, y: 0, ...size },
    crops: { front: null, back: null },
    ...(fixed ? { fixed: { ...FIXED_SIDE } } : {}),
    ...(lines ? {} : { lines: false }),
  }
}

/** the page of a fixed card, or null for an endless one */
export const fixedPage = (card: Card) => card.layout?.fixed ?? null
/** does the card's page have ruled lines? */
export const hasLines = (card: Card) => card.layout?.lines !== false

/**
 * Size of one side exactly as it was made in the editor (the whole box). Cards saved with an older
 * layout format fall back to the default size. Review shows every side at this size, 1:1.
 */
export function sidePaper(card: Card, which: 'front' | 'back') {
  const r = card.layout?.v === 2 ? card.layout[which] : undefined
  return { w: r?.w ?? DEFAULT_SIDE.w, h: r?.h ?? DEFAULT_SIDE.h }
}

/** The cut-out of a side that review shows, if the editor has set one. */
export function sideCrop(card: Card, which: 'front' | 'back') {
  // a fixed card shows its whole page, also before it was ever opened in the editor
  const f = card.layout?.fixed
  if (f) return { l: 0, t: 0, r: f.w, b: f.h }
  return card.layout?.crops?.[which] ?? null
}
