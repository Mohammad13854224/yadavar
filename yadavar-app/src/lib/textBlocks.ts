import { cleanHtml } from './format'

/**
 * Card text is now made of text widgets (see Widget.svelte). Older cards keep their text in the side's html: free text
 * blocks on the ruled page, or before that one ruled sheet. Review still draws that html, and the editor turns it into
 * text widgets when the card is opened.
 *
 * A block is stored in the side's html as
 *   <div data-x="…" data-y="…" [data-w="…"] dir="rtl|ltr"> one <div dir> per line </div>
 * `x` is the block's starting edge: the right edge of a right-to-left block, the left edge of a left-to-right one, so the
 * text grows away from the point that was tapped. A block with `w` has a fixed width and `x` is its left edge (the text of
 * cards made before blocks existed: one sheet of that width at 0,0).
 */
export const ROW = 34 // height of one ruled line
export const TEXT_SIZE = 18 // text size (px) of a new text widget
export const MAX_BLOCK_W = 640 // a free block wraps its lines at this width

export type TextBlock = { x: number; y: number; w?: number; dir: 'rtl' | 'ltr'; html: string }

export const EMPTY_LINE = (dir: 'rtl' | 'ltr' = 'rtl') => `<div dir="${dir}"><br></div>`
export const snapRow = (y: number) => Math.floor(y / ROW) * ROW

const hasText = (html: string) => {
  const d = document.createElement('div')
  d.innerHTML = html
  return !!d.textContent?.trim()
}
const num = (s: string | undefined, max = 1e6) => {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0
}

/** The blocks of a side (only what the editor can produce is kept). `legacyW` is the sheet width of an older card. */
export function parseBlocks(html: string, legacyW: number): TextBlock[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const tops = Array.from(doc.body.children) as HTMLElement[]
  const isBlock = (el: HTMLElement) => el.nodeName === 'DIV' && el.hasAttribute('data-x')
  if (tops.some(isBlock)) {
    return tops.filter(isBlock).flatMap((el) => {
      const lines = cleanHtml(el.innerHTML)
      if (!hasText(lines)) return []
      const w = el.dataset.w ? Math.min(4000, Math.max(40, num(el.dataset.w))) : undefined
      return [{ x: num(el.dataset.x), y: snapRow(num(el.dataset.y)), w, dir: el.dir === 'ltr' ? 'ltr' : 'rtl', html: lines } as TextBlock]
    })
  }
  const lines = cleanHtml(html || '')
  return hasText(lines) ? [{ x: 0, y: 0, w: legacyW, dir: 'ltr', html: lines }] : []
}

export function blockHtml(b: TextBlock): string {
  const r = (n: number) => Math.round(n * 10) / 10
  return `<div data-x="${r(b.x)}" data-y="${snapRow(b.y)}"${b.w ? ` data-w="${r(b.w)}"` : ''} dir="${b.dir}">${b.html}</div>`
}
