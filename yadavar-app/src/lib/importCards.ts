import { uid } from './format'
import { TEXT_SIZE } from './textBlocks'
import type { CardSide } from './types'

/**
 * Cards from a text file, one card per line: front and back separated by a tab, ";", "|" or "," (what spreadsheets
 * and Anki's own text export write; fields may be in "double quotes"). Lines starting with # are comments.
 */
export type ImportRow = { front: string; back: string }

const DELIMS = ['\t', ';', '|', ','] as const

/** one line split on the delimiter, honouring "quoted, fields" ("" inside quotes is a quote) */
function fields(line: string, d: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && !cur.trim()) {
      quoted = true
      cur = ''
    } else if (ch === d) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

/**
 * The text of a file whatever it was saved as: UTF-8, UTF-16 (Excel's "Unicode text") or, for a Persian Windows, the
 * old Arabic code page Excel writes plain CSV in.
 */
export async function readText(file: Blob): Promise<string> {
  const b = new Uint8Array(await file.arrayBuffer())
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b)
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    // that code page has no Persian ye and kaf: Excel writes the Arabic letters for them
    return new TextDecoder('windows-1256').decode(b).replace(/ي/g, 'ی').replace(/ك/g, 'ک')
  }
}

/** a field with HTML in it (Anki's own export) as the plain text it shows: line breaks kept, tags and &entities; gone */
function plain(f: string): string {
  if (!/<[a-z/][^>]*>|&[a-z#0-9]+;/i.test(f)) return f
  const html = f.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n')
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

export function parseCards(text: string): {
  rows: ImportRow[]
  skipped: number
} {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  // the delimiter most lines have (tab first: a translation may well contain commas)
  const d = DELIMS.find((x) => lines.filter((l) => l.includes(x)).length >= Math.max(1, lines.length * 0.8)) ?? '\t'
  const rows: ImportRow[] = []
  let skipped = 0
  for (const l of lines) {
    const f = fields(l, d).map(plain)
    const front = f[0] ?? ''
    const back = f
      .slice(1)
      .join(d === ',' ? ', ' : ' ')
      .trim()
    if (front && back) rows.push({ front, back })
    else skipped++
  }
  return { rows, skipped }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** the direction of the first letter: English and the like left-to-right, Persian / Arabic right-to-left */
const dirOf = (t: string): 'ltr' | 'rtl' => {
  const m = t.match(/[A-Za-zÀ-ɏ֐-ࣿ]/)
  return m && /[A-Za-zÀ-ɏ]/.test(m[0]) ? 'ltr' : 'rtl'
}

const WIDE = 520 // the same comfortable line length a text widget grows to while writing
let ctx: CanvasRenderingContext2D | null = null

/**
 * One side of an imported card: a single text widget, as wide as its text (wrapping after a comfortable length). On a
 * fixed card's page it wraps within the page and sits in its middle.
 */
export async function sideFor(text: string, page: { w: number; h: number } | null = null): Promise<CardSide> {
  const MAX_W = page ? page.w - 32 : WIDE
  const font = `${TEXT_SIZE}px "Vazirmatn Variable"`
  await document.fonts.load(font, text)
  ctx ??= document.createElement('canvas').getContext('2d')
  let width = text.length * TEXT_SIZE * 0.6
  if (ctx) {
    ctx.font = font
    width = Math.max(...text.split('\n').map((l) => ctx!.measureText(l).width))
  }
  const pad = 8 + 2 // the widget's own padding, plus a little room
  const w = Math.min(MAX_W, Math.ceil(width) + pad)
  // each line of the text, wrapped after the widget's width
  const lines = ctx
    ? text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((ctx!.measureText(l).width + pad) / MAX_W)), 0)
    : Math.max(1, Math.ceil((width + pad) / MAX_W))
  const dir = dirOf(text)
  const h = Math.round(lines * TEXT_SIZE * 1.6 + 4)
  return {
    html: '',
    widgets: [
      {
        id: uid(),
        kind: 'text',
        mediaId: '',
        x: page ? Math.round((page.w - w) / 2) : 0,
        y: page ? Math.max(0, Math.round((page.h - h) / 2)) : 0,
        w,
        h,
        rot: 0,
        html: text
          .split('\n')
          .map((l) => `<div dir="${dir}">${esc(l)}</div>`)
          .join(''),
        size: TEXT_SIZE,
        dir,
      },
    ],
  }
}
