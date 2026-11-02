// Every state of the "مرورها" (reviews) tab on a phone, end to end: a real Anki server on a throw-away collection (with
// its test-only routes: YADAVAR_TEST=1), the app from Vite, and Edge (or Chrome) as a phone. Ids (Q3, U9 …) are the states
// in docs/reviews-tab-states.md.
//   npx tsx tools/reviews-test.ts            (all)
//   npx tsx tools/reviews-test.ts U Z X4     (only the groups / ids given)
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { intervalLabel } from '../src/lib/format'

const ROOT = resolve(import.meta.dirname, '..')
const SERVER = resolve(ROOT, '..', 'yadavar-server')
const only = process.argv.slice(2)
const DAY = 86400

const freePort = () =>
  new Promise<number>((res) => {
    const s = netServer()
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ the server's own API (seeding and checking)
let API = ''
async function http<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}
type N = { id: string; parentId: string | null; name: string }
type C = { id: string; folderId: string | null; name: string; state: string; due: number; ready: boolean; recall?: number; fsrs?: boolean }
type W = { id: string; kind: 'text' | 'image' | 'audio'; mediaId: string; x: number; y: number; w: number; h: number; html?: string }
/** a side showing `text` (so the test can tell which card is on screen) and the given widgets */
const side = (text: string, widgets: W[] = []) => ({ html: text ? `<div dir="rtl">${text}</div>` : '', widgets })
const api = {
  wipe: () => http('/api/test/wipe', {}),
  node: (parentId: string | null, name: string) => http<N>('/api/node', { parentId, name }),
  /** a new card; its front shows its name, its back «پشت name» */
  card: (folderId: string | null, name: string, front = side(name), back = side('پشت ' + name)) =>
    http<C>('/api/card', { folderId, name, front, back }),
  snap: () => http<{ nodes: N[]; cards: C[]; revlog: { cardId: string; at: number; rating: number }[] }>('/api/snapshot'),
  limit: (id: string, limit: number | null) => http('/api/node/limit', { id, limit }),
  rename: (id: string, name: string) => http('/api/node/rename', { id, name }),
  move: (cards: string[], to: string | null) => http('/api/move', { nodes: [], cards, to }),
  del: (cards: string[]) => http('/api/delete', { nodes: [], cards }),
  import: (parentId: string | null, name: string, names: string[]) =>
    http<N>('/api/cards/import', { parentId, name, newPerDay: null, cards: names.map((n) => ({ name: n, front: side(n), back: side('') })) }),
  /** Anki's "grade now": one review for each card (3 = good: a review card due tomorrow; 1 = again: learning, 10 minutes) */
  grade: (ids: string[], rating: number) => http('/api/test/grade', { ids, rating }),
  /** everything that happened moves this far into the past (whole days: Anki's calendar too) */
  shift: (seconds: number) => http('/api/test/shift', { seconds }),
  revlog: async () => (await http<{ rows: [number, number, number, number, number][] }>('/api/test/revlog', {})).rows,
  suspend: (ids: string[]) => http('/api/test/suspend', { ids }),
  settings: (s: Record<string, unknown>) => http('/api/settings', { theme: 'dark', fontScale: 1, newPerDay: 20, reviewsPerDay: 200, retention: 0.9, ...s }),
  next: (folderId: string | null) => http<{ card: C | null; delays?: number[] }>('/api/next?folder=' + (folderId ?? '')),
  /** studies the next card of the folder through the normal answer path (as if on another device) */
  async answer(folderId: string | null, rating: number) {
    const n = await api.next(folderId)
    return http<{ card: C }>('/api/answer', { cardId: n.card!.id, rating, millis: 3000 })
  },
  media: async (name: string, data: Buffer) => {
    const r = await fetch(`${API}/api/media?name=${encodeURIComponent(name)}`, { method: 'POST', body: data })
    return ((await r.json()) as { name: string }).name
  },
}
/** Anki spreads learning steps a little (10 minutes: up to about 12.5): this is surely past an "again" card's time */
const AGAIN = 15 * 60
/** review cards due today: studied ("good") a day ago */
async function dueCards(folderId: string | null, names: string[]) {
  const ids: string[] = []
  for (const n of names) ids.push((await api.card(folderId, n)).id)
  await api.grade(ids, 3)
  await api.shift(DAY)
  return ids
}
const cardNamed = async (name: string) => (await api.snap()).cards.find((c) => c.name === name)!

// ------------------------------------------------------------------ media for the cards
function png(w: number, h: number): Buffer {
  // a plain grey picture (uncompressed deflate blocks), enough for the browser to decode
  const row = Buffer.alloc(1 + w * 3, 0x80)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function wav(seconds: number): Buffer {
  const rate = 8000
  const n = rate * seconds
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin(i / 3))
  return b
}

// ------------------------------------------------------------------ the page
let browser: Browser
let page: Page
const base = { url: '' }
const errors: string[] = []
/** a fresh phone for every test (clock, reduced motion and the viewport never leak into the next one) */
async function newPhone(o: { reducedMotion?: 'reduce' } = {}) {
  await page?.context().close()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fa-IR', reducedMotion: o.reducedMotion })
  page = await ctx.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (e) => errors.push(String(e)))
}
const digits = (s: string) => Number(s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^\d.-]/g, ''))
const fa = (n: number) => n.toLocaleString('fa-IR')

const remTile = (name: string) => page.locator('.rem-card').filter({ has: page.locator('.rem-name', { hasText: new RegExp(`^${name}$`) }) })
const remNames = () => page.locator('.rem-card .rem-name').allInnerTexts()
const pill = () => page.locator('.toolbar-title .pill')
const topFrac = async () => (await page.locator('.done-btn .frac b').allInnerTexts()).map(digits)
const badge = () => page.locator('.tab .badge')
const pct = async () => digits(await page.locator('.risk .pct').innerText())
const riskStatus = () => page.locator('.risk .status').innerText()
const doneBox = () => page.locator('[aria-label="مرور شده‌ی امروز"]')
const infoBox = () => page.locator('[role=dialog][aria-label="خطر فراموشی"]')
const sess = () => page.locator('.session')
const grade = (name: string) => sess().locator('.grade').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) })
const nextBtn = () => sess().locator('.next')
const undoBtn = () => page.getByRole('button', { name: 'برگرداندن آخرین نمره' })
const closeBtn = () => page.getByRole('button', { name: 'خروج از مرور' })
const sideTag = () => sess().locator('.side-tag')
const finish = () => sess().locator('.finish h2')
const zoomBox = () => page.locator('[aria-label="نمایش بزرگ عکس"]')
const toast = () => page.locator('.toast')
const sessFrac = async () => (await sess().locator('.nextrow .frac b').allInnerTexts()).map(digits)
/** the text on the side of the card on screen */
const shown = async () => (await sess().locator(`.face.${(await sideTag().innerText()) === 'پشت کارت' ? 'back' : 'front'} .tb-text`).allInnerTexts()).join(' ').trim()
const worldOf = (s: 'front' | 'back') => sess().locator(`.face.${s} .world`)
const scaleOf = async (s: 'front' | 'back') => {
  const t = await worldOf(s).evaluate((e) => (e as HTMLElement).style.transform)
  return Number(/scale\(([\d.]+)\)/.exec(t)![1])
}

async function open() {
  await page.goto(base.url, { timeout: 60_000 })
  await page.locator('.risk').waitFor()
  await until('loaded', async () => !(await page.locator('.offline').count()))
}
async function startReview(name: string) {
  await remTile(name).click()
  await sess().waitFor()
  await until('session ready', async () => !(await sess().getByText('در حال آماده‌سازی…').count()))
}
/** taps empty paper on the card (not on a widget): the card turns over */
async function flip() {
  const before = await sideTag().innerText()
  await sess().locator('.flip').click({ position: { x: 14, y: 60 } })
  await until('turned', async () => (await sideTag().innerText()) !== before)
}
/** shows the back if needed, gives the grade and goes on; waits for the next card or the end */
async function rate(name: 'دوباره' | 'سخت' | 'خوب' | 'آسان') {
  if (!(await grade(name).isEnabled())) await flip()
  await grade(name).click()
  const before = (await sessFrac())[0]
  await nextBtn().click()
  // the count goes up first, then the next card arrives (on its front, grades off again)
  await until('answered', async () => (await finish().count()) > 0 || ((await sessFrac())[0] === before + 1 && (await sess().locator('.grade:disabled').count()) === 4))
}
async function undo() {
  const before = (await finish().count()) ? null : (await sessFrac())[0]
  await undoBtn().click()
  await until('undone', async () => !(await finish().count()) && (before === null || (await sessFrac())[0] === before - 1))
}
async function closeReview() {
  await closeBtn().click()
  await sess().waitFor({ state: 'detached' })
}
async function back(): Promise<boolean> {
  return page.evaluate(() => window.yadavarBack!())
}
/** the app comes back to the front (the phone unlocked, another app left): it reads everything again */
async function comeBack() {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}
async function failing(pattern: string, fn: () => Promise<void>, how: 'error' | 'offline' = 'error') {
  const h = (r: import('playwright-core').Route) => (how === 'error' ? r.fulfill({ status: 500, body: '{"error":"test"}' }) : r.abort())
  await page.route(pattern, h)
  try {
    await fn()
  } finally {
    await page.unroute(pattern, h)
  }
}
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    let ok = false
    try {
      ok = await cond()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() > end) throw new Error('timed out: ' + what)
    await sleep(60)
  }
}
function eq(what: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
function ok(what: string, cond: unknown) {
  if (!cond) throw new Error(what)
}
const toastSays = (text: string, ms = 5000) => until(`toast «${text}»`, async () => (await toast().innerText()).includes(text), ms)
const canvasPic = () => page.locator('.risk canvas').evaluate((c) => (c as HTMLCanvasElement).toDataURL())
const STATUS: [number, string][] = [
  [20, 'حافظه محکم است؛ اتصال‌ها قوی و پرانرژی‌اند'],
  [45, 'کم‌کم کم‌رنگ می‌شود؛ یک مرور سبک کافی است'],
  [70, 'هشدار: اتصال‌ها دارند ضعیف می‌شوند'],
  [101, 'خطر بالا! همین حالا مرور کن'],
]
const meter = async () => Number(await page.locator('.risk .track').getAttribute('data-value'))
/** waits until the liquid has reached the real value (the meter's) and returns it */
async function settledPct() {
  await until('the number reaches the meter', async () => (await pct()) === (await meter()), 8000)
  return pct()
}

// ------------------------------------------------------------------ tests
type T = { id: string; name: string; fn: () => Promise<void>; reducedMotion?: boolean }
const tests: T[] = []
const test = (id: string, name: string, fn: () => Promise<void>, o: { reducedMotion?: boolean } = {}) => tests.push({ id, name, fn, ...o })

// ---------- H: the top of the tab and the badge on the tab
test('H1', 'nothing today: «۰ پوشه», 0/0, no badge on the tab', async () => {
  await open()
  eq('pill', await pill().innerText(), '۰ پوشه')
  eq('fraction', await topFrac(), [0, 0])
  eq('badge', await badge().count(), 0)
})
test('H2', 'n places (home counts as one): «n پوشه» and the badge n', async () => {
  const a = await api.node(null, 'الف')
  await api.card(null, 'یک')
  await api.card(a.id, 'دو')
  await open()
  eq('pill', await pill().innerText(), '۲ پوشه')
  eq('badge', digits(await badge().first().innerText()), 2)
})
test('H3', 'the fraction: done today over done + everything still ready', async () => {
  const a = await api.node(null, 'الف')
  await dueCards(a.id, ['یک', 'دو'])
  await api.card(a.id, 'سه')
  await api.answer(a.id, 3) // one reviewed today, elsewhere
  await open()
  eq('fraction', await topFrac(), [1, 3])
})
test('H4', 'after a grade and closing the review the fraction and the places follow at once', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  await api.card(a.id, 'یک')
  await api.card(b.id, 'دو')
  await open()
  eq('before', await topFrac(), [0, 2])
  await startReview('الف')
  await rate('خوب')
  await closeReview()
  eq('after', await topFrac(), [1, 2])
  eq('pill', await pill().innerText(), '۱ پوشه')
  eq('places', await remNames(), ['ب'])
})
test('H4b', 'a card answered «دوباره» and ready again still counts as reviewed today (decision 4)', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await api.card(a.id, 'دو')
  await api.answer(a.id, 1) // again: back in 10 minutes
  await api.shift(AGAIN)
  await open()
  eq('fraction', await topFrac(), [1, 2])
  await page.locator('.done-btn').click()
  eq('the list agrees', await doneBox().locator('.head p').innerText(), '۱ کارت در ۱ پوشه')
})
test('H5', 'a card reviewed today and then deleted is not counted', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await api.answer(null, 3)
  const gone = (await api.snap()).revlog[0].cardId
  await api.del([gone])
  await open()
  eq('fraction', await topFrac(), [0, 1])
})
test('H6', 'tapping the fraction opens «مرور شده‌ی امروز»', async () => {
  await open()
  await page.locator('.done-btn').click()
  await doneBox().waitFor()
})
test('H7', 'numbers in Persian digits', async () => {
  for (let i = 0; i < 12; i++) await api.card(null, 'c' + i)
  await open()
  eq('fraction', await topFrac(), [0, 12])
  ok('Persian digits', /^[۰-۹\s]+$/.test(await page.locator('.done-btn .frac').innerText()))
})

// ---------- K: the forgetting-risk strip
test('K1', 'no review or learning card ready: 0٪ and «no card at risk»', async () => {
  await open()
  eq('pct', await settledPct(), 0)
  eq('status', await riskStatus(), 'امروز کارتی در خطر فراموشی نیست')
})
test('K2', 'only new cards ready: the same (new cards have nothing to forget)', async () => {
  await api.card(null, 'یک')
  await open()
  eq('pct', await settledPct(), 0)
  eq('status', await riskStatus(), 'امروز کارتی در خطر فراموشی نیست')
})
test('K3', 'the more overdue, the higher (never above 100٪); each band has its own words', async () => {
  await dueCards(null, ['یک', 'دو'])
  const seen: number[] = []
  for (const extra of [0, 3, 12, 60]) {
    if (extra) await api.shift(extra * DAY)
    await open()
    const v = await settledPct()
    seen.push(v)
    eq(`status at ${v}%`, await riskStatus(), STATUS.find((s) => v < s[0])![1])
  }
  for (let i = 1; i < seen.length; i++) ok(`rises: ${seen}`, seen[i] >= seen[i - 1])
  ok(`at most 100: ${seen}`, seen.every((v) => v <= 100))
  ok(`reaches the top band: ${seen}`, seen[seen.length - 1] >= 70)
})
test('K4', 'above 90٪ the strip trembles', async () => {
  await dueCards(null, ['یک'])
  await api.shift(200 * DAY)
  await open()
  ok('over 90', (await settledPct()) > 90)
  await until('trembling', async () => (await page.locator('.risk .track.quake').count()) === 1)
})
test('K5', 'a card exactly on time counts about a third', async () => {
  await dueCards(null, ['یک'])
  await open()
  const v = await settledPct()
  ok(`about 33: ${v}`, v >= 25 && v <= 40)
})
test('K7', 'reviewing some of the cards brings it down', async () => {
  await dueCards(null, ['یک', 'دو'])
  await open()
  const before = await settledPct()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await closeReview()
  const after = await settledPct()
  ok(`lower: ${before} → ${after}`, after < before && after > 0)
})
test('K8', 'everything reviewed: 0٪', async () => {
  await dueCards(null, ['یک', 'دو'])
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await rate('خوب')
  await closeReview()
  eq('pct', await settledPct(), 0)
})
test('K9', 'a new card studied today for the first time does not change it', async () => {
  const a = await api.node(null, 'الف')
  await dueCards(null, ['یک'])
  await api.card(a.id, 'نو')
  await open()
  const before = await settledPct()
  await startReview('الف')
  await rate('خوب')
  await closeReview()
  eq('same', await settledPct(), before)
})
test('K10', 'classic scheduler: the goal is 90٪ whatever «درصد یادآوری» says', async () => {
  await dueCards(null, ['یک'])
  await open()
  const before = await settledPct()
  await api.settings({ retention: 0.8 })
  await open()
  eq('same', await settledPct(), before)
})
test('K12', 'opening the tab: the number flows up from 0 to the real value', async () => {
  await dueCards(null, ['یک'])
  await page.goto(base.url)
  await page.locator('.risk').waitFor()
  await until('cards read', async () => (await meter()) > 0)
  const first = await pct()
  const end = await settledPct()
  ok(`flows up: ${first} → ${end}`, first < end)
})
test('K13', 'nothing moves while a review covers the tab; it moves again after', async () => {
  await dueCards(null, ['یک'])
  await open()
  await settledPct()
  const a = await canvasPic()
  await sleep(300)
  ok('moving on the tab', (await canvasPic()) !== a)
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sleep(200)
  const b = await canvasPic()
  await sleep(400)
  eq('still under the review', (await canvasPic()) === b, true)
  await closeReview()
  await sleep(300)
  const c = await canvasPic()
  await sleep(300)
  ok('moving again', (await canvasPic()) !== c)
})
test('K14', 'reduced motion: a still picture with the right number at once', async () => {
  await dueCards(null, ['یک'])
  await open()
  await until('number', async () => (await pct()) > 0)
  const v = await pct()
  const a = await canvasPic()
  await sleep(500)
  eq('still', (await canvasPic()) === a, true)
  eq('number', await pct(), v)
}, { reducedMotion: true })
test('K15', 'the i button: the explanation opens; «بستن» and a tap outside close it', async () => {
  await open()
  await page.getByRole('button', { name: 'توضیح نمودار: خطر فراموشی' }).click()
  await infoBox().waitFor()
  await infoBox().getByRole('button', { name: 'بستن' }).click()
  await infoBox().waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'توضیح نمودار: خطر فراموشی' }).click()
  await infoBox().waitFor()
  await page.mouse.click(10, 10)
  await infoBox().waitFor({ state: 'detached' })
})

// ---------- Q: the places to study today
test('Q1', 'nothing: «امروز مروری نداری»', async () => {
  await open()
  await page.getByText('امروز مروری نداری').waitFor()
  eq('tiles', await page.locator('.rem-card').count(), 0)
})
test('Q2', 'a card at the top level: the tile «کارت‌های بیرون پوشه‌ها»', async () => {
  await api.card(null, 'یک')
  await open()
  eq('tiles', await remNames(), ['کارت‌های بیرون پوشه‌ها'])
})
test('Q3', 'a folder: its name and «تعداد کارت‌ها» = due + new ready', async () => {
  const a = await api.node(null, 'الف')
  await dueCards(a.id, ['یک'])
  await api.card(a.id, 'دو')
  await api.card(a.id, 'سه')
  await open()
  eq('tiles', await remNames(), ['الف'])
  eq('count', await remTile('الف').locator('.badge').innerText(), 'تعداد کارت‌ها: ۳')
})
test('Q4', 'a parent and its child both ready: two tiles, each with its own cards only', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(a.id, 'یک')
  await api.card(b.id, 'دو')
  await api.card(b.id, 'سه')
  await open()
  eq('tiles (more new cards first)', await remNames(), ['ب', 'الف'])
  eq('parent', await remTile('الف').locator('.badge').innerText(), 'تعداد کارت‌ها: ۱')
  eq('child', await remTile('ب').locator('.badge').innerText(), 'تعداد کارت‌ها: ۲')
})
test('Q5', 'only the child is ready: only its tile', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(b.id, 'دو')
  await open()
  eq('tiles', await remNames(), ['ب'])
})
test('Q6', 'order: most due first, then most new', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  const c = await api.node(null, 'پ')
  const ids = [(await api.card(b.id, 'b1')).id, (await api.card(b.id, 'b2')).id, (await api.card(c.id, 'c1')).id]
  await api.grade(ids, 3)
  await api.shift(DAY)
  await api.card(a.id, 'a1')
  await api.card(a.id, 'a2')
  await api.card(a.id, 'a3')
  await api.card(c.id, 'c2')
  await api.card(c.id, 'c3')
  await open()
  eq('order', await remNames(), ['ب', 'پ', 'الف'])
})
test('Q7', 'a daily new-card limit: only that many new cards count (the limit window starts at 1)', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  for (let i = 0; i < 5; i++) await api.card(a.id, 'a' + i)
  for (let i = 0; i < 3; i++) await api.card(b.id, 'b' + i)
  await api.limit(a.id, 2)
  await api.limit(b.id, 1)
  await open()
  eq('count', await remTile('الف').locator('.badge').innerText(), 'تعداد کارت‌ها: ۲')
  eq('count', await remTile('ب').locator('.badge').innerText(), 'تعداد کارت‌ها: ۱')
})
test('Q8', 'a learning card whose time has not come: not counted', async () => {
  const c = await api.card(null, 'یک')
  await api.grade([c.id], 1)
  await open()
  eq('tiles', await page.locator('.rem-card').count(), 0)
})
test('Q9', 'a suspended card: not counted', async () => {
  const c = await api.card(null, 'یک')
  await api.suspend([c.id])
  await open()
  eq('tiles', await page.locator('.rem-card').count(), 0)
})
test('Q10', 'a long name: two lines, then cut off', async () => {
  const a = await api.node(null, 'نام '.repeat(60).trim())
  await api.card(a.id, 'یک')
  await open()
  const m = await page.locator('.rem-card .rem-name').evaluate((e) => ({ h: e.clientHeight, sh: e.scrollHeight, lh: parseFloat(getComputedStyle(e).lineHeight) }))
  ok(`two lines: ${JSON.stringify(m)}`, m.h <= m.lh * 2 + 2 && m.sh > m.h)
  ok('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
})
test('Q11', 'three hundred places: only the tiles near the screen are built; every one is reachable by scrolling', async () => {
  for (let i = 0; i < 300; i++) await api.import(null, 'پوشه ' + String(i).padStart(3, '0'), ['c'])
  await open()
  eq('pill', await pill().innerText(), '۳۰۰ پوشه')
  ok('few tiles in the page', (await page.locator('.rem-card').count()) < 60)
  const seen = new Set<string>()
  for (let step = 0; step < 300 && seen.size < 300; step++) {
    for (const n of await remNames()) seen.add(n)
    await page.evaluate(() => {
      // the tab's panel is what scrolls
      for (const el of document.querySelectorAll<HTMLElement>('.panel, .scroll')) el.scrollTop += 300
    })
    await sleep(150)
  }
  eq('every place seen once scrolled to', seen.size, 300)
  ok('still few tiles in the page', (await page.locator('.rem-card').count()) < 60)
})
test('Q12', 'tapping a tile opens the review of that place', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await startReview('الف')
  eq('title', await sess().locator('.title b').innerText(), 'الف')
  eq('card', await shown(), 'یک')
})
test('Q13', 'a folder renamed (here: elsewhere, then the app comes back): the tile shows the new name', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await api.rename(a.id, 'تازه')
  await comeBack()
  await until('renamed', async () => JSON.stringify(await remNames()) === '["تازه"]')
})
test('Q14', 'a card made in the info tab: its folder shows up in the reviews tab', async () => {
  await api.node(null, 'الف')
  await open()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await page.locator('.item-card').filter({ hasText: 'الف' }).click()
  await page.locator('.actions .btn').filter({ has: page.locator('.short', { hasText: /^کارت$/ }) }).click()
  await page.locator('.rename-input').press('Enter')
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await until('tile', async () => JSON.stringify(await remNames()) === '["الف"]')
})

// ---------- W: «مرور شده‌ی امروز»
test('W1', 'nothing reviewed yet: the empty message and «۰ کارت در ۰ پوشه»', async () => {
  await open()
  await page.locator('.done-btn').click()
  await doneBox().getByText('امروز هنوز کارتی مرور نکرده‌ای.').waitFor()
  eq('head', await doneBox().locator('.head p').innerText(), '۰ کارت در ۰ پوشه')
})
test('W2', 'one row per folder with its path and number of cards', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(null, 'یک')
  await api.card(b.id, 'دو')
  await api.card(b.id, 'سه')
  await api.answer(null, 3)
  await api.answer(b.id, 3)
  await api.answer(b.id, 4)
  await open()
  await page.locator('.done-btn').click()
  eq('head', await doneBox().locator('.head p').innerText(), '۳ کارت در ۲ پوشه')
  const rows = await doneBox().locator('.row').evaluateAll((rs) => rs.map((r) => [r.querySelector('b')!.textContent, r.querySelector('small')?.textContent, r.querySelector('.pill')!.textContent]))
  eq('rows', rows, [['کارت‌های بیرون پوشه‌ها', 'خانه', '۱ کارت'], ['ب', 'خانه / الف', '۲ کارت']])
})
test('W3', 'a row opens its drawer; again closes it; another row closes the first', async () => {
  const a = await api.node(null, 'الف')
  await api.card(null, 'یک')
  await api.card(a.id, 'دو')
  await api.answer(null, 3)
  await api.answer(a.id, 3)
  await open()
  await page.locator('.done-btn').click()
  const rows = doneBox().locator('.row')
  await rows.nth(0).click()
  eq('first open', await rows.nth(0).getAttribute('aria-expanded'), 'true')
  await rows.nth(0).click()
  eq('first closed', await rows.nth(0).getAttribute('aria-expanded'), 'false')
  await rows.nth(0).click()
  await rows.nth(1).click()
  eq('only the second', [await rows.nth(0).getAttribute('aria-expanded'), await rows.nth(1).getAttribute('aria-expanded')], ['false', 'true'])
})
test('W4', 'a card reviewed several times: listed once, with its last grade', async () => {
  const c = await api.card(null, 'یک')
  await api.answer(null, 1)
  await api.shift(AGAIN)
  await http('/api/answer', { cardId: c.id, rating: 3, millis: 1000 })
  await open()
  await page.locator('.done-btn').click()
  await doneBox().locator('.row').click()
  eq('cards', await doneBox().locator('li .cn').allInnerTexts(), ['یک'])
  eq('grade', await doneBox().locator('li .tag').allInnerTexts(), ['خوب'])
})
test('W5', 'every grade with its own name', async () => {
  for (const n of ['a', 'b', 'c', 'd']) await api.card(null, n)
  for (const r of [1, 2, 3, 4]) await api.answer(null, r)
  await open()
  await page.locator('.done-btn').click()
  await doneBox().locator('.row').click()
  eq('grades', (await doneBox().locator('li .tag').allInnerTexts()).sort(), ['آسان', 'خوب', 'دوباره', 'سخت'].sort())
  eq('tones', (await doneBox().locator('li .tag').evaluateAll((t) => t.map((x) => x.classList[1]))).sort(), ['again', 'easy', 'good', 'hard'])
})
test('W6', 'a deleted card is not listed', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await api.answer(null, 3)
  await api.answer(null, 3)
  await api.del([(await cardNamed('یک')).id])
  await open()
  await page.locator('.done-btn').click()
  eq('head', await doneBox().locator('.head p').innerText(), '۱ کارت در ۱ پوشه')
})
test('W7', 'a card moved to another folder after its review: listed under the folder it is in now', async () => {
  const a = await api.node(null, 'الف')
  const c = await api.card(null, 'یک')
  await api.answer(null, 3)
  await api.move([c.id], a.id)
  await open()
  await page.locator('.done-btn').click()
  eq('row', await doneBox().locator('.row b').allInnerTexts(), ['الف'])
})
test('W8', 'closing: × and a tap outside', async () => {
  await open()
  await page.locator('.done-btn').click()
  await doneBox().getByRole('button', { name: 'بستن' }).click()
  await doneBox().waitFor({ state: 'detached' })
  await page.locator('.done-btn').click()
  await doneBox().waitFor()
  await page.mouse.click(10, 10)
  await doneBox().waitFor({ state: 'detached' })
})
test('W9', 'a long list scrolls inside the window', async () => {
  const ids: string[] = []
  for (let i = 0; i < 40; i++) ids.push((await api.card(null, 'c' + i)).id)
  await api.grade(ids, 3)
  await open()
  await page.locator('.done-btn').click()
  await doneBox().locator('.row').click()
  await sleep(400)
  const m = await doneBox().locator('.list').evaluate((l) => ({ sh: l.scrollHeight, ch: l.clientHeight }))
  ok(`scrolls: ${JSON.stringify(m)}`, m.sh > m.ch)
  ok('the window fits the screen', ((await doneBox().boundingBox())!.height) <= 844)
  const item = await doneBox().locator('.item').evaluate((l) => ({ sh: l.scrollHeight, ch: l.clientHeight }))
  ok(`the open row is not cut off: ${JSON.stringify(item)}`, item.ch >= item.sh)
  await doneBox().locator('li').last().scrollIntoViewIfNeeded()
  ok('the last card can be seen', await doneBox().locator('li').last().isVisible())
})

// ---------- E: opening a review
test('E1', 'while the first card is asked for: «در حال آماده‌سازی…»', async () => {
  await api.card(null, 'یک')
  await open()
  await page.route('**/api/next**', async (r) => {
    await sleep(1200)
    await r.continue()
  })
  await remTile('کارت‌های بیرون پوشه‌ها').click()
  await sess().getByText('در حال آماده‌سازی…').waitFor()
  await sess().locator('.flip').waitFor()
})
test('E2', 'the first card Anki wants, on its front, ungraded; grade buttons off', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('first', await shown(), (await api.next(null)).card!.name)
  eq('front', await sideTag().innerText(), 'روی کارت')
  eq('grades off', await sess().locator('.grade:disabled').count(), 4)
  eq('next off', await nextBtn().isDisabled(), true)
})
test('E3', 'the title: a folder shows its name and path; the top level the same name as its tile', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(b.id, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('ب')
  eq('folder', [await sess().locator('.title b').innerText(), await sess().locator('.title small').innerText()], ['ب', 'خانه / الف'])
  await closeReview()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('home', [await sess().locator('.title b').innerText(), await sess().locator('.title small').innerText()], ['کارت‌های بیرون پوشه‌ها', 'خانه'])
})
test('E4', 'the cards were studied elsewhere meanwhile: «کارتی برای مرور نیست», no «next review» line', async () => {
  await api.card(null, 'یک')
  await open()
  await api.del([(await cardNamed('یک')).id])
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('end', await finish().innerText(), 'کارتی برای مرور نیست')
  eq('no next line', await sess().locator('.next-due').count(), 0)
  eq('undo off', await undoBtn().isDisabled(), true)
})
test('E5', 'a folder with a ready subfolder: only its own cards, the subfolder untouched', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(b.id, 'زیر') // made first: ahead in Anki's queue for الف
  await api.card(a.id, 'یک')
  await api.card(a.id, 'دو')
  await open()
  await startReview('الف')
  const seen = [await shown()]
  await rate('خوب')
  seen.push(await shown())
  await rate('خوب')
  eq('own cards only', seen.sort(), ['دو', 'یک'])
  eq('end', await finish().innerText(), 'مرور این پوشه تمام شد')
  eq('subfolder untouched', (await cardNamed('زیر')).state, 'new')
})
test('E6', 'the server cannot be reached: an error screen (not «no cards»); «تلاش دوباره» works', async () => {
  await api.card(null, 'یک')
  await open()
  await failing('**/api/next**', async () => {
    await remTile('کارت‌های بیرون پوشه‌ها').click()
    await sess().getByText('ارتباط با سرور انکی برقرار نشد').waitFor()
    eq('no «no cards»', await sess().getByText('کارتی برای مرور نیست').count(), 0)
  }, 'offline')
  await sess().getByRole('button', { name: 'تلاش دوباره' }).click()
  await sess().locator('.flip').waitFor()
  eq('card', await shown(), 'یک')
})
test('E6b', 'the error screen closes with «بازگشت به مرورها»', async () => {
  await api.card(null, 'یک')
  await open()
  await failing('**/api/next**', async () => {
    await remTile('کارت‌های بیرون پوشه‌ها').click()
    await sess().getByText('ارتباط با سرور انکی برقرار نشد').waitFor()
  }, 'offline')
  await sess().getByRole('button', { name: 'بازگشت به مرورها' }).click()
  await sess().waitFor({ state: 'detached' })
})
test('E7', 'the fraction under the card starts at 0 of (new + learning + review)', async () => {
  await dueCards(null, ['یک'])
  const c = await api.card(null, 'دو')
  await api.card(null, 'سه')
  await api.grade([c.id], 1)
  await api.shift(AGAIN)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('fraction', await sessFrac(), [0, 3])
})

// ---------- A: the card on screen
test('A1', 'a tap turns the card over and back', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  eq('back', [await sideTag().innerText(), await shown()], ['پشت کارت', 'پشت یک'])
  await flip()
  eq('front', await sideTag().innerText(), 'روی کارت')
})
test('A2', 'the grades turn on with the first look at the back and stay on after turning back', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  eq('on', await sess().locator('.grade:disabled').count(), 0)
  await flip()
  eq('still on', await sess().locator('.grade:disabled').count(), 0)
})
test('A3', 'dragging moves the card and does not turn it', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const before = await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)
  const b = (await sess().locator('.flip').boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  await sleep(150)
  ok('moved', (await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)) !== before)
  eq('not turned', await sideTag().innerText(), 'روی کارت')
})
async function pinch(target: Locator, grow: number) {
  const b = (await target.boundingBox())!
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const cdp = await page.context().newCDPSession(page)
  const pts = (d: number) => [{ x: cx - d, y: cy, id: 0 }, { x: cx + d, y: cy, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) })
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(40 + (grow * i) / 6) })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
test('A4', 'two fingers zoom (and do not turn the card)', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const z0 = await scaleOf('front')
  await pinch(sess().locator('.flip'), 80)
  await sleep(150)
  ok(`bigger: ${z0} → ${await scaleOf('front')}`, (await scaleOf('front')) > z0 * 1.3)
  eq('not turned', await sideTag().innerText(), 'روی کارت')
})
test('A5', '⤢ shows the whole card again and does not turn it', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const t0 = await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)
  await pinch(sess().locator('.flip'), 80)
  await sleep(150)
  ok('zoomed', (await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)) !== t0)
  await sess().getByRole('button', { name: 'نمایش کامل' }).click()
  eq('whole card', await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform), t0)
  eq('not turned', await sideTag().innerText(), 'روی کارت')
})
async function mediaCard(kind: 'image' | 'audio' | 'text', w = 220, h = 160) {
  const mediaId = kind === 'image' ? await api.media('a.png', png(64, 48)) : kind === 'audio' ? await api.media('a.wav', wav(3)) : ''
  const widget: W = { id: 'w1', kind, mediaId, x: 20, y: 20, w, h, ...(kind === 'text' ? { html: '<div dir="rtl">متن کادر</div>' } : {}) }
  await api.card(null, 'یک', side('', [widget]), side('پشت'))
}
test('A6', 'a tap on a picture shows it full screen and does not turn the card', async () => {
  await mediaCard('image')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sess().locator('.face.front .w.image img').waitFor()
  await sess().locator('.face.front .w.image').click()
  await zoomBox().waitFor()
  eq('not turned', await sideTag().innerText(), 'روی کارت')
})
test('A7', 'the full-screen picture: drag moves it, a double tap shows it whole, × closes', async () => {
  await mediaCard('image')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sess().locator('.face.front .w.image img').waitFor()
  await sess().locator('.face.front .w.image').click()
  const img = zoomBox().locator('img')
  await until('fitted', async () => (await img.evaluate((e) => (e as HTMLElement).style.visibility)) === 'visible')
  const t0 = await img.evaluate((e) => (e as HTMLElement).style.transform)
  await page.mouse.move(200, 400)
  await page.mouse.down()
  await page.mouse.move(260, 460, { steps: 5 })
  await page.mouse.up()
  ok('moved', (await img.evaluate((e) => (e as HTMLElement).style.transform)) !== t0)
  await page.mouse.click(200, 400)
  await page.mouse.click(200, 400)
  await until('whole again', async () => (await img.evaluate((e) => (e as HTMLElement).style.transform)) === t0)
  await zoomBox().getByRole('button', { name: 'بستن' }).click()
  await zoomBox().waitFor({ state: 'detached' })
  eq('review still there', await sess().count(), 1)
})
test('A8', 'a tap on a sound plays it and does not turn the card', async () => {
  await mediaCard('audio', 300, 80)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const w = sess().locator('.face.front .w.audio')
  await w.locator('audio').waitFor()
  const b = (await w.boundingBox())!
  await page.mouse.click(b.x + 4, b.y + 4) // the widget's own corner, not the player's controls
  await until('playing', async () => !(await w.locator('audio').evaluate((a) => (a as HTMLAudioElement).paused)))
  eq('not turned', await sideTag().innerText(), 'روی کارت')
})
test('A9', 'a tap on a text box turns the card (decision 2)', async () => {
  await mediaCard('text')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sess().locator('.face.front .w.text').click()
  await until('turned', async () => (await sideTag().innerText()) === 'پشت کارت')
})
test('A10', 'an empty card: a frame of its own and it still turns over', async () => {
  await api.card(null, 'یک', side(''), side(''))
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const sheet = (await sess().locator('.face.front .sheet').boundingBox())!
  ok('a visible sheet', sheet.width > 20 && sheet.height > 20)
  await flip()
})
test('A11', 'a card bigger than the frame is shown small enough to fit', async () => {
  await mediaCard('image', 3000, 2000)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  ok('scaled down', (await scaleOf('front')) < 0.2)
  const f = (await sess().locator('.flip').boundingBox())!
  const s = (await sess().locator('.face.front .sheet').boundingBox())!
  ok('inside the frame', s.x >= f.x - 1 && s.x + s.width <= f.x + f.width + 1 && s.y + s.height <= f.y + f.height + 1)
})
test('A12', 'the next card starts on its front, at the whole-card view (no zoom carried over)', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const fitted = await scaleOf('front')
  await pinch(sess().locator('.flip'), 80)
  await rate('خوب')
  eq('front', await sideTag().innerText(), 'روی کارت')
  ok('whole card', Math.abs((await scaleOf('front')) - fitted) < 0.01)
})
test('A14', 'a fixed card without lines (made under those settings): its whole page, unruled, even never opened in the editor', async () => {
  const layout = { v: 2, stageW: 0, front: { x: 0, y: 0, w: 360, h: 480 }, back: { x: 0, y: 0, w: 360, h: 480 }, crops: { front: null, back: null }, fixed: { w: 360, h: 480 }, lines: false }
  const text = { id: 'w1', kind: 'text' as const, mediaId: '', x: 20, y: 400, w: 80, h: 36, html: '<div dir="rtl">پایین</div>' }
  const c = await http<C>('/api/card', { folderId: null, name: 'ثابت', front: side('', [text]), back: side('پشت'), layout })
  await api.grade([c.id], 3)
  await api.shift(DAY)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const sheet = sess().locator('.face.front .sheet')
  eq('the whole page', [await sheet.evaluate((e) => (e as HTMLElement).style.width), await sheet.evaluate((e) => (e as HTMLElement).style.height)], ['360px', '480px'])
  ok('no lines', await sheet.evaluate((e) => e.classList.contains('plain')))
})
test('A13', 'turning the phone: the card fits the new frame (unless the reader zoomed)', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const t0 = await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)
  await page.setViewportSize({ width: 844, height: 390 })
  await until('refitted', async () => (await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)) !== t0)
  await pinch(sess().locator('.flip'), 60)
  await sleep(100)
  const zoomed = await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(300)
  eq('the reader’s view kept', await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform), zoomed)
})

// ---------- G: the grade buttons and «رفتن به کارت بعدی»
test('G1', 'back not seen: the four grades and «next» are off', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('grades', await sess().locator('.grade:disabled').count(), 4)
  await grade('خوب').click({ force: true })
  eq('nothing chosen', await sess().locator('.grade.on').count(), 0)
  eq('next', await nextBtn().isDisabled(), true)
})
test('G2', 'under each grade: the interval Anki gives for it', async () => {
  await dueCards(null, ['یک'])
  await open()
  const want = ((await api.next(null)).delays ?? []).map(intervalLabel)
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('labels', await sess().locator('.grade small').allInnerTexts(), want)
})
test('G3', 'choosing a grade: it lights up, the others dim, «next» turns on', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  await grade('سخت').click()
  eq('on', await sess().locator('.grade.on b').allInnerTexts(), ['سخت'])
  eq('dim', await sess().locator('.grade.dim').count(), 3)
  eq('next', await nextBtn().isEnabled(), true)
})
test('G4', 'changing the choice: only the new one', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  await grade('سخت').click()
  await grade('آسان').click()
  eq('on', await sess().locator('.grade.on b').allInnerTexts(), ['آسان'])
})
test('G5', '«next»: the grade is saved in Anki, the fraction goes up, the next card comes', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const first = await shown()
  await rate('آسان')
  eq('fraction', await sessFrac(), [1, 2])
  ok('another card', (await shown()) !== first)
  const log = await api.revlog()
  eq('one review, easy', log.map((r) => [String(r[1]), r[2]]), [[(await cardNamed(first)).id, 4]])
  eq('scheduled', (await cardNamed(first)).state, 'review')
})
test('G6', 'two quick taps on «next»: one grade only', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  await grade('خوب').click()
  await nextBtn().evaluate((b) => {
    ;(b as HTMLButtonElement).click()
    ;(b as HTMLButtonElement).click()
  })
  await until('answered', async () => (await sessFrac())[0] === 1)
  await sleep(500)
  eq('reviews', (await api.revlog()).length, 1)
  eq('fraction', await sessFrac(), [1, 2])
})
test('G7', '«دوباره»: the card is not done; it comes back when its time comes (here: a new review later)', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('دوباره')
  eq('end for now', await finish().innerText(), 'مرور این پوشه تمام شد')
  eq('next today', await sess().locator('.next-due b').innerText(), 'امروز')
  await closeReview()
  await api.shift(AGAIN)
  await comeBack()
  await until('back', async () => JSON.stringify(await remNames()) === '["کارت‌های بیرون پوشه‌ها"]')
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('the same card', await shown(), 'یک')
})
test('G8', 'saving the grade fails: «نمره ثبت نشد», the same card with the same choice', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await flip()
  await grade('خوب').click()
  await failing('**/api/answer', async () => {
    await nextBtn().click()
    await toastSays('نمره ثبت نشد')
  })
  eq('same card', await shown(), 'پشت یک')
  eq('choice kept', await sess().locator('.grade.on b').allInnerTexts(), ['خوب'])
  eq('nothing saved', (await api.revlog()).length, 0)
  await nextBtn().click()
  await finish().waitFor()
  eq('saved now', (await api.revlog()).length, 1)
})
test('G9', 'the time on screen goes to Anki, at most 60 seconds', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sleep(1500)
  await rate('خوب')
  const t1 = (await api.revlog())[0][3]
  ok(`about 1.5 s: ${t1}`, t1 >= 1400 && t1 < 10_000)
  await page.clock.install()
  await flip()
  await grade('خوب').click()
  await page.clock.fastForward('02:00')
  await nextBtn().click()
  await finish().waitFor()
  eq('capped', (await api.revlog())[1][3], 60_000)
})
test('G10', 'a folder whose subfolder card is ahead in Anki’s queue: the grade is saved, undo still works', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(b.id, 'زیر')
  await api.card(a.id, 'یک')
  await open()
  await startReview('الف')
  await rate('خوب')
  eq('saved', (await cardNamed('یک')).state, 'review')
  await undo()
  eq('undone', (await cardNamed('یک')).state, 'new')
  eq('no review left', (await api.revlog()).length, 0)
  eq('the card back on screen', await shown(), 'یک')
})
test('G11', 'the 900th review: closing the review switches FSRS on (message); the risk now follows «درصد یادآوری»', async () => {
  // 899 reviews before: the app checks on launch too, so the 900th must be the one given here
  const f = await api.import(null, 'انبوه', Array.from({ length: 899 }, (_, i) => 'k' + i))
  const ids = (await api.snap()).cards.filter((c) => c.folderId === f.id).map((c) => c.id)
  await api.grade(ids, 3)
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await closeReview()
  await toastSays('FSRS فعال شد', 60_000)
  await until('cards measured by FSRS', async () => (await api.snap()).cards.every((c) => c.state === 'new' || c.fsrs))
  await api.shift(DAY)
  await open()
  const at90 = await settledPct()
  await api.settings({ retention: 0.8 })
  await open()
  const at80 = await settledPct()
  ok(`lower goal, lower risk: ${at90} → ${at80}`, at80 < at90)
})

// ---------- U: taking a grade back
test('U1', 'no grade yet: undo is off', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('off', await undoBtn().isDisabled(), true)
})
test('U2', 'undo: the card again, on its front, ungraded; the fraction back; its schedule exactly as before', async () => {
  const [id] = await dueCards(null, ['یک'])
  await api.card(null, 'دو')
  const before = (await api.snap()).cards.find((c) => c.id === id)!
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('first is the due one', await shown(), 'یک')
  await rate('آسان')
  await undo()
  eq('card', [await shown(), await sideTag().innerText()], ['یک', 'روی کارت'])
  eq('no choice', await sess().locator('.grade.on').count(), 0)
  eq('grades off', await sess().locator('.grade:disabled').count(), 4)
  eq('fraction', await sessFrac(), [0, 2])
  const after = (await api.snap()).cards.find((c) => c.id === id)!
  eq('schedule', [after.state, after.due, after.ready], [before.state, before.due, before.ready])
  eq('review log', (await api.revlog()).length, 1)
})
test('U3', 'several undos in a row: one grade back each time, down to the first', async () => {
  for (const n of ['a', 'b', 'c']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const order = [await shown()]
  await rate('خوب')
  order.push(await shown())
  await rate('خوب')
  order.push(await shown())
  await rate('خوب')
  await undo()
  eq('third', await shown(), order[2])
  await undo()
  eq('second', await shown(), order[1])
  await undo()
  eq('first', await shown(), order[0])
  eq('off', await undoBtn().isDisabled(), true)
  eq('nothing left in Anki', (await api.revlog()).length, 0)
})
test('U4', 'from the end screen: back to the last card', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await finish().waitFor()
  await undo()
  eq('card', await shown(), 'یک')
})
test('U5', 'on a card half done (turned, a grade chosen): the previous card takes its place', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const first = await shown()
  await rate('خوب')
  await flip()
  await grade('سخت').click()
  await undo()
  eq('previous', [await shown(), await sideTag().innerText()], [first, 'روی کارت'])
  eq('no choice', await sess().locator('.grade.on').count(), 0)
})
test('U6', 'the same card graded twice in one review (time passed meanwhile): two undos bring it back new', async () => {
  // real time (moving the collection's clock would wipe Anki's undo history): a one-minute learning step
  await http('/api/test/steps', { learn: [1] })
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const a = await shown()
  await rate('دوباره')
  await sleep(80_000) // the "again" card is due once more
  const b = await shown()
  await rate('خوب')
  eq('the first card is back', await shown(), a)
  await rate('خوب')
  await finish().waitFor()
  await undo()
  eq('the repeat', await shown(), a)
  await undo()
  eq('the other card', await shown(), b)
  await undo()
  eq('the first answer', await shown(), a)
  eq('new again', (await cardNamed(a)).state, 'new')
  eq('nothing left', (await api.revlog()).length, 0)
})
test('U8', 'undo fails on the server: «برگرداندن انجام نشد», nothing changes', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  const now = await shown()
  await failing('**/api/undo', async () => {
    await undoBtn().click()
    await toastSays('برگرداندن انجام نشد')
  })
  eq('same card', await shown(), now)
  eq('fraction', await sessFrac(), [1, 2])
  eq('undo still on', await undoBtn().isEnabled(), true)
})
test('U9', 'more than 30 grades: 30 undos, then the button is off (Anki keeps 30 steps; decision 1)', async () => {
  const ids: string[] = []
  for (let i = 0; i < 32; i++) ids.push((await api.card(null, 'c' + i)).id)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  for (let i = 0; i < 32; i++) await rate('آسان')
  await finish().waitFor()
  for (let i = 0; i < 30; i++) {
    ok(`undo ${i + 1} on`, await undoBtn().isEnabled())
    await undo()
  }
  eq('off after 30', await undoBtn().isDisabled(), true)
  eq('two grades stay in Anki', (await api.revlog()).length, 2)
  eq('fraction', await sessFrac(), [2, 32])
})
test('U9b', 'Anki has nothing to undo after all: a message, nothing pretends to be undone', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  const now = await shown()
  await page.route('**/api/undo', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' }))
  await undoBtn().click()
  await toastSays('برگرداندن انجام نشد')
  eq('same card', await shown(), now)
  eq('fraction', await sessFrac(), [1, 2])
})
test('U10', 'undo and «next» tapped together: only one of them runs', async () => {
  for (const n of ['a', 'b', 'c']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await flip()
  await grade('خوب').click()
  await page.evaluate(() => {
    ;(document.querySelector('[aria-label="برگرداندن آخرین نمره"]') as HTMLButtonElement).click()
    ;(document.querySelector('.session .next') as HTMLButtonElement).click()
  })
  await sleep(800)
  const log = (await api.revlog()).length
  const frac = await sessFrac()
  eq('app and Anki agree', frac[0], log)
})
test('U11', 'an undone grade is not in «مرور شده‌ی امروز» nor in the fraction', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await rate('خوب')
  await undo()
  await closeReview()
  eq('fraction', await topFrac(), [1, 2])
  await page.locator('.done-btn').click()
  eq('list', await doneBox().locator('.head p').innerText(), '۱ کارت در ۱ پوشه')
})

// ---------- Z: the end screen
test('Z1', 'all done: the title, how many, and each grade’s count', async () => {
  for (const n of ['a', 'b', 'c']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await rate('آسان')
  await rate('خوب')
  eq('title', await finish().innerText(), 'مرور این پوشه تمام شد')
  await sess().getByText('۳ کارت مرور کردی').waitFor()
  eq('counts', (await sess().locator('.sum b').allInnerTexts()).map(digits), [0, 0, 2, 1])
})
test('Z3', 'only cards for later days: «فردا» / «n روز دیگر»', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  eq('tomorrow', await sess().locator('.next-due b').innerText(), 'فردا')
  await undo()
  await rate('آسان')
  ok('days', /روز دیگر$/.test(await sess().locator('.next-due b').innerText()))
})
test('Z4', 'new cards held back by the daily limit: «فردا»; no more new cards today', async () => {
  const a = await api.node(null, 'الف')
  for (let i = 0; i < 4; i++) await api.card(a.id, 'a' + i)
  await api.limit(a.id, 2)
  await open()
  await startReview('الف')
  eq('fraction', await sessFrac(), [0, 2])
  await rate('آسان')
  await rate('آسان')
  eq('end', await finish().innerText(), 'مرور این پوشه تمام شد')
  eq('next', await sess().locator('.next-due b').innerText(), 'فردا')
  await closeReview()
  eq('no tile', await page.locator('.rem-card').count(), 0)
})
test('Z6', '«بازگشت به مرورها»: closed; the tile gone', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await sess().getByRole('button', { name: 'بازگشت به مرورها' }).click()
  await sess().waitFor({ state: 'detached' })
  eq('tiles', await page.locator('.rem-card').count(), 0)
})

// ---------- O: leaving a review
test('O1', '× half way: the grades stay, the card on screen stays ready', async () => {
  for (const n of ['a', 'b', 'c']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  const left = await shown()
  await flip()
  await grade('آسان').click()
  await closeReview()
  eq('saved', (await api.revlog()).length, 1)
  eq('still ready', (await cardNamed(left)).ready, true)
  eq('count', await remTile('کارت‌های بیرون پوشه‌ها').locator('.badge').innerText(), 'تعداد کارت‌ها: ۲')
})
test('O2', 'closing without a grade: no FSRS check', async () => {
  await api.card(null, 'یک')
  await open()
  await sleep(500) // the check made on launch
  const asked: string[] = []
  page.on('request', (r) => r.url().includes('/api/fsrs') && asked.push(r.url()))
  await startReview('کارت‌های بیرون پوشه‌ها')
  await closeReview()
  await sleep(500)
  eq('no check', asked, [])
})
test('O3', 'closing after grades: the FSRS check runs', async () => {
  await api.card(null, 'یک')
  await open()
  await sleep(500)
  const asked: string[] = []
  page.on('request', (r) => r.url().includes('/api/fsrs') && asked.push(r.url()))
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await closeReview()
  await until('checked', () => asked.some((u) => u.includes('/api/fsrs/check')))
})
test('O4', 'opening the same place again: Anki’s next card, the undo history empty', async () => {
  for (const n of ['a', 'b']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  const next = await shown()
  await closeReview()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('card', await shown(), next)
  eq('undo off', await undoBtn().isDisabled(), true)
  eq('fraction', await sessFrac(), [0, 1])
})

// ---------- B: the Android back button
test('B1', 'a full-screen picture: back closes only the picture', async () => {
  await mediaCard('image')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sess().locator('.face.front .w.image img').waitFor()
  await sess().locator('.face.front .w.image').click()
  await zoomBox().waitFor()
  eq('used', await back(), true)
  await zoomBox().waitFor({ state: 'detached' })
  eq('review open', await sess().count(), 1)
})
test('B2', 'a review: back closes it (like ×)', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  eq('used', await back(), true)
  await sess().waitFor({ state: 'detached' })
  eq('grade kept', (await api.revlog()).length, 1)
})
test('B3', '«مرور شده‌ی امروز»: back closes the window, not the app', async () => {
  await open()
  await page.locator('.done-btn').click()
  await doneBox().waitFor()
  eq('used', await back(), true)
  await doneBox().waitFor({ state: 'detached' })
})
test('B4', 'the risk explanation: back closes it, not the app', async () => {
  await open()
  await page.getByRole('button', { name: 'توضیح نمودار: خطر فراموشی' }).click()
  await infoBox().waitFor()
  eq('used', await back(), true)
  await infoBox().waitFor({ state: 'detached' })
})
test('B5', 'nothing open: back goes to Android (leaves the app)', async () => {
  await open()
  eq('not used', await back(), false)
})

// ---------- Y: keeping up to date by itself
test('Y1', 'an «again» card whose time comes while the tab is open: its tile returns within 30 s', async () => {
  await http('/api/test/steps', { learn: [1] }) // real time: a one-minute step
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('دوباره')
  await closeReview()
  eq('gone for now', await page.locator('.rem-card').count(), 0)
  const due = (await cardNamed('یک')).due
  await until('back', async () => (await page.locator('.rem-card').count()) === 1, due - Date.now() + 35_000)
  ok('not before its time', Date.now() >= due - 1000)
})
test('Y2', 'a new Anki day while the tab is open: the new day’s cards appear by themselves', async () => {
  await page.clock.install()
  const c = await api.card(null, 'یک')
  await api.grade([c.id], 3) // due tomorrow
  await open()
  eq('nothing today', await page.locator('.rem-card').count(), 0)
  await api.shift(DAY) // the server's day moves on …
  await page.clock.fastForward('24:00:30') // … and so does the phone's clock
  await until('tomorrow’s card', async () => (await page.locator('.rem-card').count()) === 1, 10_000)
})
test('Y3', 'coming back to the app: everything read again', async () => {
  await open()
  await api.card(null, 'یک')
  await comeBack()
  await until('tile', async () => (await page.locator('.rem-card').count()) === 1)
})
test('Y4', 'while a review is open nothing is read again by itself', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const asked: string[] = []
  page.on('request', (r) => r.url().includes('/api/snapshot') && asked.push(r.url()))
  await comeBack()
  await sleep(600)
  eq('no snapshot', asked, [])
})

// ---------- N: the server
test('N1', 'server down at launch: the banner; «تلاش دوباره» once it is back', async () => {
  await api.card(null, 'یک')
  await page.route('**/api/snapshot', (r) => r.abort())
  await page.goto(base.url)
  await page.locator('.offline').waitFor()
  await page.unroute('**/api/snapshot')
  await page.locator('.offline').getByRole('button', { name: 'تلاش دوباره' }).click()
  await page.locator('.offline').waitFor({ state: 'detached' })
  eq('tile', await page.locator('.rem-card').count(), 1)
})

// ---------- X: combinations
test('X1', 'reviewing one folder leaves the other folders’ counts alone', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  for (const n of ['a1', 'a2']) await api.card(a.id, n)
  for (const n of ['b1', 'b2', 'b3']) await api.card(b.id, n)
  await open()
  await startReview('الف')
  await rate('خوب')
  await rate('خوب')
  await closeReview()
  eq('tiles', await remNames(), ['ب'])
  eq('ب', await remTile('ب').locator('.badge').innerText(), 'تعداد کارت‌ها: ۳')
})
test('X4', 'grades, an undo, closing: the fraction and the list agree', async () => {
  for (const n of ['a', 'b', 'c']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await rate('خوب')
  await rate('دوباره')
  await rate('خوب')
  await undo()
  await closeReview()
  eq('fraction', await topFrac(), [2, 3])
  await page.locator('.done-btn').click()
  eq('list', await doneBox().locator('.head p').innerText(), '۲ کارت در ۱ پوشه')
})
test('X7', 'a daily limit inside a review: only that many new cards, then the end', async () => {
  const a = await api.node(null, 'الف')
  for (let i = 0; i < 5; i++) await api.card(a.id, 'a' + i)
  await api.limit(a.id, 2)
  await open()
  await startReview('الف')
  await rate('خوب')
  await rate('خوب')
  await finish().waitFor()
  eq('two studied', (await api.revlog()).length, 2)
})
test('X8', 'the limit changed in the info tab: the tile’s count follows', async () => {
  const a = await api.node(null, 'الف')
  for (let i = 0; i < 5; i++) await api.card(a.id, 'a' + i)
  await open()
  eq('all five', await remTile('الف').locator('.badge').innerText(), 'تعداد کارت‌ها: ۵')
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await page.locator('.item-card').filter({ hasText: 'الف' }).locator('.item-dots').click()
  await page.locator('.box[role=dialog]').getByRole('button', { name: /کارت جدید در روز/ }).click()
  const box = page.locator('[aria-label="کارت جدید در روز"]')
  await box.getByRole('radio', { name: 'سقف روزانه' }).click()
  for (let i = 0; i < 9; i++) await box.getByRole('button', { name: 'کمتر' }).click() // 20 → 15 → 10 → 9 … → 3
  await box.getByRole('button', { name: 'ذخیره' }).click()
  await box.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await until('three', async () => (await remTile('الف').locator('.badge').innerText()) === 'تعداد کارت‌ها: ۳')
})
test('X9', 'a zoomed picture, back, back: first the picture, then the review', async () => {
  await mediaCard('image')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await sess().locator('.face.front .w.image img').waitFor()
  await sess().locator('.face.front .w.image').click()
  await zoomBox().waitFor()
  await back()
  await zoomBox().waitFor({ state: 'detached' })
  eq('review open', await sess().count(), 1)
  await back()
  await sess().waitFor({ state: 'detached' })
  eq('nothing more', await back(), false)
})
test('X10', 'zoom on the front, turn over and back: the front keeps its view', async () => {
  await api.card(null, 'یک')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  await pinch(sess().locator('.flip'), 80)
  await sleep(100)
  const z = await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform)
  await flip()
  await flip()
  eq('kept', await worldOf('front').evaluate((e) => (e as HTMLElement).style.transform), z)
})
test('X11', 'a sound playing on the front: it goes on after turning over (decision 3), stops with the next card', async () => {
  await mediaCard('audio', 300, 80)
  await api.card(null, 'دو')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  if ((await shown()) === 'دو') await rate('خوب') // the sound card first
  const w = sess().locator('.face.front .w.audio')
  await w.locator('audio').waitFor()
  const b = (await w.boundingBox())!
  await page.mouse.click(b.x + 4, b.y + 4)
  await until('playing', async () => !(await w.locator('audio').evaluate((a) => (a as HTMLAudioElement).paused)))
  await flip()
  await sleep(300)
  eq('still playing', await w.locator('audio').evaluate((a) => !(a as HTMLAudioElement).paused), true)
})
test('X12', 'the top-level review shows only the cards outside every folder', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'داخل')
  await api.card(null, 'بیرون')
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  eq('card', await shown(), 'بیرون')
  await rate('خوب')
  await finish().waitFor()
  eq('folder untouched', (await cardNamed('داخل')).state, 'new')
})
test('X14', 'Anki’s day moves on during a review: grading goes on (the card done yesterday is due again today)', async () => {
  for (const n of ['a', 'b']) await api.card(null, n)
  await open()
  await startReview('کارت‌های بیرون پوشه‌ها')
  const first = await shown()
  await rate('خوب')
  await api.shift(DAY)
  await rate('خوب')
  eq('yesterday’s card again', await shown(), first)
  await rate('خوب')
  await finish().waitFor()
  eq('all saved', (await api.revlog()).length, 3)
})
test('X15', 'a paste still running in the info tab, then a review and undo: the undo takes back the grade, not the paste', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  await api.card(null, 'جابه‌جا')
  await api.card(a.id, 'مرور')
  await open()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await page.locator('.item-card').filter({ hasText: 'جابه‌جا' }).locator('.item-dots').click()
  await page.locator('.box[role=dialog]').getByRole('button', { name: 'کات' }).click()
  await page.locator('.item-card').filter({ has: page.locator('.item-name', { hasText: /^ب$/ }) }).click()
  await page.route('**/api/move', async (r) => {
    await sleep(4000)
    await r.continue()
  })
  await page.locator('.actions .btn').filter({ has: page.locator('.short', { hasText: /^پیست$/ }) }).click()
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await startReview('الف')
  await flip()
  // the «در حال چسباندن…» message covers part of the buttons; the rest can still be tapped
  await grade('خوب').evaluate((b) => (b as HTMLButtonElement).click())
  await nextBtn().evaluate((b) => (b as HTMLButtonElement).click())
  await finish().waitFor({ timeout: 10_000 })
  // the paste is in Anki now; if the grade went in before it, an undo would take the paste back instead
  await until('paste done', async () => (await cardNamed('جابه‌جا')).folderId === b.id, 8000)
  await undo()
  await sleep(300)
  eq('the grade undone', (await cardNamed('مرور')).state, 'new')
  eq('the paste stays', (await cardNamed('جابه‌جا')).folderId, b.id)
})
test('X16', 'three hundred places, review one from the end: its tile goes, the list is fine', async () => {
  for (let i = 0; i < 300; i++) await api.import(null, 'پوشه ' + String(i).padStart(3, '0'), ['c'])
  await open()
  await page.evaluate(() => {
    for (const el of [document.scrollingElement, ...document.querySelectorAll('.panel, .scroll')] as HTMLElement[]) if (el) el.scrollTop = 1e9
    scrollTo(0, 1e9)
  })
  await until('at the end of the list', () => page.locator('.panel').evaluate((p) => p.scrollTop > 1000 && p.scrollTop + p.clientHeight >= p.scrollHeight - 2))
  const last = page.locator('.rem-card').last()
  await until('the last tile built', async () => (await page.locator('.rem-card').count()) > 0 && (await last.isVisible()))
  const name = await last.locator('.rem-name').innerText()
  await last.click()
  await sess().waitFor()
  await rate('خوب')
  await closeReview()
  eq('pill', await pill().innerText(), '۲۹۹ پوشه')
  eq('gone', await page.locator('.rem-card .rem-name', { hasText: new RegExp(`^${name}$`) }).count(), 0)
})
test('X17', '«مرور شده‌ی امروز» open while the app reads everything again: it stays open', async () => {
  await api.card(null, 'یک')
  await api.answer(null, 3)
  await open()
  await page.locator('.done-btn').click()
  await doneBox().waitFor()
  await api.card(null, 'دو')
  await api.answer(null, 3)
  await comeBack()
  await until('updated', async () => (await doneBox().locator('.head p').innerText()) === '۲ کارت در ۱ پوشه')
})
test('X18', 'another tab and back: the strip flows in again (an open window covers the tab bar: no switching under it)', async () => {
  await dueCards(null, ['یک'])
  await open()
  const v = await settledPct()
  await page.locator('.done-btn').click()
  const nav = page.getByRole('button', { name: /وضعیت/ }).first()
  const nb = (await nav.boundingBox())!
  await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2) // lands on the window's backdrop: it closes
  await doneBox().waitFor({ state: 'detached' })
  eq('still on the reviews tab', await page.locator('.risk').count(), 1)
  await nav.click()
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  ok('flows from 0', (await pct()) < v)
  eq('same value', await settledPct(), v)
})
test('X19', 'dark theme and big text: nothing sticks out sideways, on the tab or in a review', async () => {
  await api.settings({ theme: 'dark', fontScale: 1.4 })
  await api.node(null, 'نام '.repeat(30).trim()).then((n) => api.card(n.id, 'یک'))
  await open()
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  eq('tab', await wide(), false)
  await page.locator('.rem-card').click()
  await sess().waitFor()
  await flip()
  eq('review', await wide(), false)
  const g = await sess().locator('.grades').boundingBox()
  ok('grades on screen', g && g.x >= 0 && g.x + g.width <= 390)
})

// ---------- M: the brain map (from the forgetting-risk strip)
const brainBox = () => page.locator('.brain')
const sheet = () => page.locator('.brain .sheet')
type BrainPeek = { count: number; ids: string[]; regions: { id: string | null; name: string; x: number; y: number; z: number; r: number }[]; region: number[]; links: [string, string, number][]; sel: number }
/** what the brain shows (the scene is reachable as window.brain while developing) */
const peek = () =>
  page.evaluate((): BrainPeek => {
    const b = (window as any).brain
    const m = b.model
    const links: [string, string, number][] = []
    for (let l = 0; l < m.linkA.length; l++) links.push([m.ids[m.linkA[l]], m.ids[m.linkB[l]], m.linkKind[l]])
    return { count: m.count, ids: m.ids, regions: m.regions, region: Array.from(m.region), links, sel: b.selIndex }
  })
async function openBrain() {
  await page.locator('.risk .track').click()
  await brainBox().waitFor()
  await until('scene ready', () => page.evaluate(() => !!(window as any).brain?.model))
}
/** flies to the card's neuron and selects it, as a tap on it does */
async function pickNeuron(name: string) {
  const id = (await cardNamed(name)).id
  await page.evaluate((id) => {
    const b = (window as any).brain
    b.focusNeuron(b.model.ids.indexOf(id))
  }, id)
  await until('sheet', async () => (await sheet().locator('.name b').innerText()) === name)
}
/** runs code with the app's store, as the info tab does (cut / paste, delete) */
const withStore = (code: string) => page.evaluate(async (code) => new Function('app', `return (async () => { ${code} })()`)((await import('/src/lib/store.svelte.ts' as string)).app), code)
const inside = (a: BrainPeek['regions'][number], b: BrainPeek['regions'][number]) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) + a.r <= b.r + 1e-3

test('M1', 'a tap on the strip opens the brain; ✕ and back close it', async () => {
  await api.card(null, 'یک')
  await open()
  await openBrain()
  await brainBox().getByRole('button', { name: 'بستن' }).first().click()
  await brainBox().waitFor({ state: 'detached' })
  await openBrain()
  eq('used', await back(), true)
  await brainBox().waitFor({ state: 'detached' })
  eq('nothing else open', await back(), false)
})
test('M2', 'one neuron per card, one region per folder; subfolders sit inside their folder, siblings side by side', async () => {
  const a = await api.node(null, 'الف')
  const a1 = await api.node(a.id, 'الف ۱')
  const a2 = await api.node(a.id, 'الف ۲')
  const b = await api.node(null, 'ب')
  for (const [f, n] of [[a, 3], [a1, 4], [a2, 2], [b, 5]] as const) for (let i = 0; i < n; i++) await api.card(f.id, `${f.name} ${i}`)
  await api.card(null, 'بیرون')
  await open()
  await openBrain()
  eq('header', (await brainBox().locator('.title small').innerText()).split('·').slice(0, 2).map((s) => s.trim()), ['۱۵ نرون', '۴ ناحیه'])
  const p = await peek()
  eq('neurons', p.count, 15)
  const reg = (name: string) => p.regions.find((r) => r.name === name)!
  ok('الف ۱ inside الف', inside(reg('الف ۱'), reg('الف')))
  ok('الف ۲ inside الف', inside(reg('الف ۲'), reg('الف')))
  ok('ب not inside الف', !inside(reg('ب'), reg('الف')))
  // each card's neuron is in its own folder's region (and inside its sphere)
  const snap = await api.snap()
  for (const c of snap.cards) {
    const i = p.ids.indexOf(c.id)
    const r = p.regions[p.region[i]]
    eq(`region of ${c.name}`, r.id, c.folderId)
  }
  // siblings that follow each other in the list touch (no other region between them)
  const d = Math.hypot(reg('الف ۱').x - reg('الف ۲').x, reg('الف ۱').y - reg('الف ۲').y, reg('الف ۱').z - reg('الف ۲').z)
  ok(`siblings close: ${d.toFixed(2)}`, d <= reg('الف ۱').r + reg('الف ۲').r + 1)
})
test('M3', 'a neuron picked: its card name above it and in the sheet; back drops the selection first, then the brain', async () => {
  const f = await api.node(null, 'لغات')
  await api.card(f.id, 'سیب')
  await api.card(f.id, 'گلابی')
  await open()
  await openBrain()
  await pickNeuron('سیب')
  eq('label', await page.locator('.brain-sel-label').innerText(), 'سیب')
  eq('path', await sheet().locator('.name small').innerText(), 'خانه / لغات')
  ok('new card: immature', (await sheet().locator('.state').innerText()).startsWith('نابالغ'))
  eq('back: selection', await back(), true)
  await sheet().waitFor({ state: 'detached' })
  eq('brain still open', await brainBox().count(), 1)
  eq('back: brain', await back(), true)
  await brainBox().waitFor({ state: 'detached' })
})
test('M4', '«مرور نرون انتخابی»: just that card, Anki schedules it, and the brain shows it at once', async () => {
  const f = await api.node(null, 'لغات')
  await dueCards(f.id, ['سیب', 'گلابی'])
  await open()
  await openBrain()
  await pickNeuron('گلابی')
  const before = (await api.revlog()).length
  await sheet().getByRole('button', { name: 'مرور نرون انتخابی' }).click()
  await sess().waitFor()
  await until('session ready', async () => !(await sess().getByText('در حال آماده‌سازی…').count()))
  eq('title', await sess().locator('.title b').innerText(), 'گلابی')
  eq('path', await sess().locator('.title small').innerText(), 'خانه / لغات')
  eq('shows that card', await shown(), 'گلابی')
  await rate('خوب')
  eq('done', await finish().innerText(), 'نرون تقویت شد')
  eq('one review', (await api.revlog()).length, before + 1)
  const pear = await cardNamed('گلابی')
  ok('not due any more', !pear.ready)
  ok('the other one untouched', (await cardNamed('سیب')).ready)
  await sess().getByRole('button', { name: 'بازگشت به مغز' }).click()
  await sess().waitFor({ state: 'detached' })
  eq('brain still open, same neuron', await sheet().locator('.name b').innerText(), 'گلابی')
  ok('strong now', (await sheet().locator('.state').innerText()).startsWith('قوی'))
})
test('M5', 'cards reviewed within hours of each other are linked; hours apart they are not', async () => {
  const f = await api.node(null, 'الف')
  const g = await api.node(null, 'ب')
  const a = await api.card(f.id, 'یک')
  const b = await api.card(g.id, 'دو')
  const c = await api.card(g.id, 'سه')
  await api.grade([a.id], 3)
  await api.shift(7 * 3600) // seven hours later
  await api.grade([b.id], 3)
  await api.grade([c.id], 3)
  await open()
  await openBrain()
  const p = await peek()
  const linked = (x: string, y: string) => p.links.some(([s, t, k]) => k === 1 && ((s === x && t === y) || (s === y && t === x)))
  ok('دو–سه linked (minutes apart, different folders)', linked(b.id, c.id))
  ok('یک–دو not linked (seven hours apart)', !linked(a.id, b.id))
  eq('header', (await brainBox().locator('.title small').innerText()).includes('اتصال'), true)
})
test('M6', 'a card moved, a folder moved, a card deleted (while the brain is open): the brain follows at once', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  const sub = await api.node(a.id, 'زیر')
  const one = await api.card(a.id, 'یک')
  await api.card(b.id, 'دو')
  const three = await api.card(sub.id, 'سه')
  await open()
  await openBrain()
  // the card goes to ب (cut and paste, as in the info tab)
  await withStore(`app.cut({ nodes: [], cards: ['${one.id}'] }); await app.paste('${b.id}')`)
  await until('moved', async () => {
    const p = await peek()
    return p.regions[p.region[p.ids.indexOf(one.id)]].id === b.id
  })
  // the subfolder goes into ب too: its region is now inside ب's
  await withStore(`app.cut({ nodes: ['${sub.id}'], cards: [] }); await app.paste('${b.id}')`)
  await until('folder moved', async () => {
    const p = await peek()
    const r = (id: string) => p.regions.find((x) => x.id === id)!
    return inside(r(sub.id), r(b.id)) && !inside(r(sub.id), r(a.id))
  })
  // a deleted card is gone
  await withStore(`app.deleteItems({ nodes: [], cards: ['${three.id}'] })`)
  await until('deleted', async () => !(await peek()).ids.includes(three.id))
  eq('header', (await brainBox().locator('.title small').innerText()).split('·')[0].trim(), '۲ نرون')
})
test('M7', 'no cards: the brain says so', async () => {
  await open()
  await openBrain()
  await brainBox().getByText('هنوز نرونی نداری').waitFor()
})
test('M8', 'a tap on a neuron on the screen picks it', async () => {
  const f = await api.node(null, 'لغات')
  await api.card(f.id, 'سیب')
  await open()
  await openBrain()
  await sleep(2600) // the camera flies in
  const at = await page.evaluate(() => {
    const b = (window as any).brain
    const v = b.v.clone().fromArray(b.model.pos, 0).project(b.camera)
    const r = b.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  })
  await page.mouse.click(at.x, at.y)
  await until('picked', async () => (await sheet().locator('.name b').innerText()) === 'سیب')
})
test('M9', 'the same card again the same day from the brain: practice only, the schedule and the review log stay', async () => {
  const f = await api.node(null, 'لغات')
  await dueCards(f.id, ['گلابی'])
  await open()
  await openBrain()
  const review = async () => {
    await pickNeuron('گلابی')
    await sheet().getByRole('button', { name: 'مرور نرون انتخابی' }).click()
    await sess().waitFor()
    await until('session ready', async () => !(await sess().getByText('در حال آماده‌سازی…').count()))
  }
  await review()
  await rate('خوب')
  eq('first: a real review', await finish().innerText(), 'نرون تقویت شد')
  await sess().getByRole('button', { name: 'بازگشت به مغز' }).click()
  await sess().waitFor({ state: 'detached' })
  const logged = (await api.revlog()).length
  const due = (await cardNamed('گلابی')).due
  await review()
  ok('says it is practice', (await sess().locator('.practice').count()) === 1)
  await flip()
  eq('no intervals on the buttons', await sess().locator('.grade small').first().innerText(), 'تمرین')
  await rate('آسان')
  eq('second: practice', await finish().innerText(), 'تمرین انجام شد')
  eq('no new review in the log', (await api.revlog()).length, logged)
  eq('the schedule stayed', (await cardNamed('گلابی')).due, due)
  // undo: nothing to take back in Anki (the real review before it stays)
  await undo()
  eq('card back', await shown(), 'گلابی')
  eq('the real review is still there', (await api.revlog()).length, logged)
  eq('the schedule still stayed', (await cardNamed('گلابی')).due, due)
})

// ------------------------------------------------------------------ run
async function main() {
  const data = mkdtempSync(join(tmpdir(), 'yadavar-reviews-'))
  const port = await freePort()
  API = `http://127.0.0.1:${port}`
  const py = process.env.YADAVAR_PY ?? join(SERVER, '.venv', 'Scripts', 'python.exe')
  const server: ChildProcess = spawn(py, ['-u', join(SERVER, 'server.py')], {
    env: { ...process.env, YADAVAR_DATA: data, YADAVAR_PORT: String(port), YADAVAR_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let serverLog = ''
  server.stderr!.on('data', (d) => (serverLog += d))
  const stop = () => {
    try {
      execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: 'ignore' }) // the venv python is a launcher with a child
    } catch {
      server.kill()
    }
  }
  try {
    await until('server up', async () => (await fetch(API + '/api/fsrs')).ok, 30_000)
    process.env.YADAVAR_API = API
    const { createServer } = await import('vite')
    const vite = await createServer({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), server: { port: await freePort(), strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
    await vite.listen()
    base.url = `http://127.0.0.1:${vite.config.server.port}/`
    try {
      browser = await chromium.launch({ channel: 'msedge' })
    } catch {
      browser = await chromium.launch({ channel: 'chrome' })
    }
    const chosen = tests.filter((t) => !only.length || only.some((o) => t.id === o || t.id.replace(/\d.*$/, '') === o))
    let failed = 0
    const t0 = Date.now()
    for (const t of chosen) {
      await api.wipe()
      await newPhone({ reducedMotion: t.reducedMotion ? 'reduce' : undefined })
      errors.length = 0
      const started = Date.now()
      try {
        await t.fn()
        if (errors.length) throw new Error('page error: ' + errors.join(' | '))
        console.log(`PASS  ${t.id.padEnd(5)} ${t.name}`)
      } catch (e) {
        failed++
        const where = ((e as Error).stack ?? '').split('\n').find((l) => l.includes('reviews-test.ts'))?.trim() ?? ''
        console.log(`FAIL  ${t.id.padEnd(5)} ${t.name}\n        ${(e as Error).message.split('\n')[0]}\n        ${where}`)
      }
      if (Date.now() - started > 20_000) console.log(`      (${Math.round((Date.now() - started) / 1000)} s)`)
    }
    console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}  (${chosen.length} tests, ${Math.round((Date.now() - t0) / 1000)} s)`)
    await browser.close()
    await vite.close()
    process.exitCode = failed ? 1 : 0
  } catch (e) {
    console.error(e, serverLog.slice(-2000))
    process.exitCode = 1
  } finally {
    stop()
    await sleep(300)
    try {
      rmSync(data, { recursive: true, force: true })
    } catch {
      /* still locked: the temp folder is cleaned by Windows later */
    }
  }
}

main()
