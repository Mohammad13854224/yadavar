// Every state of the "اطلاعات" (info) tab on a phone, end to end: a real Anki server on a throw-away collection, the
// app from Vite, and Edge (or Chrome) as a phone. Ids (P3, V6 …) are the states in docs/info-tab-states.md.
//   npx tsx tools/info-test.ts            (all)
//   npx tsx tools/info-test.ts V I        (only the groups / ids given, e.g. "V" or "V6")
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const SERVER = resolve(ROOT, '..', 'yadavar-server')
const only = process.argv.slice(2)

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
type N = { id: string; parentId: string | null; name: string; newLimit?: number }
type C = { id: string; folderId: string | null; name: string; state: string; due: number }
const side = { html: '', widgets: [] }
const api = {
  reset: () => http('/api/reset', {}),
  node: (parentId: string | null, name: string) => http<N>('/api/node', { parentId, name }),
  card: (folderId: string | null, name: string) => http<C>('/api/card', { folderId, name, front: side, back: side }),
  snap: () => http<{ nodes: N[]; cards: C[] }>('/api/snapshot'),
  limit: (id: string, limit: number | null) => http('/api/node/limit', { id, limit }),
  import: (parentId: string | null, name: string, names: string[], newPerDay: number | null) =>
    http<N>('/api/cards/import', { parentId, name, newPerDay, cards: names.map((n) => ({ name: n, front: side, back: side })) }),
  /** studies the card once (it must be the next one Anki shows in its folder) */
  async answer(folderId: string | null, rating: number) {
    const n = await http<{ card: C }>('/api/next?folder=' + (folderId ?? ''))
    return http<{ card: C }>('/api/answer', { cardId: n.card.id, rating, millis: 3000 })
  },
}
const nodeNamed = async (name: string) => (await api.snap()).nodes.find((n) => n.name === name)
const cardsIn = async (folderId: string | null) => (await api.snap()).cards.filter((c) => c.folderId === folderId)

// ------------------------------------------------------------------ the page
let page: Page
const base = { url: '' }
const tile = (name: string) => page.locator('.item-card').filter({ has: page.getByText(name, { exact: true }) })
const tileNames = () => page.locator('.item-card .item-name').allInnerTexts()
const tool = (label: string) => page.locator('.actions .btn').filter({ has: page.locator('.short', { hasText: new RegExp(`^${label}$`) }) })
const undoBtn = () => page.getByRole('button', { name: 'یک مرحله عقب' })
const redoBtn = () => page.getByRole('button', { name: 'یک مرحله جلو' })
const renameInput = () => page.locator('.rename-input')
const menuBox = () => page.locator('.box[role=dialog]')
const menuBtn = (label: string) => menuBox().getByRole('button', { name: label })
const confirmBox = () => page.locator('[role=alertdialog]')
const toast = () => page.locator('.toast')
const crumbs = () => page.locator('.path-bar .crumb').allInnerTexts()
const editor = () => page.locator('[aria-label="ویرایش کارت"]')

async function open() {
  await page.goto(base.url, { timeout: 60_000 })
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await page.locator('.path-bar').waitFor()
}
async function enter(...names: string[]) {
  for (const n of names) {
    await tile(n).click()
    await page.locator('.path-bar .crumb.is-active').getByText(n, { exact: true }).waitFor()
  }
}
async function longPress(l: Locator, ms = 650, moveBy = 0) {
  const b = (await l.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  if (moveBy) await page.mouse.move(x + moveBy, y, { steps: 3 })
  await sleep(ms)
  await page.mouse.up()
}
const dots = (name: string) => tile(name).locator('.item-dots')
async function menu(name: string) {
  await dots(name).click()
  await menuBox().waitFor()
}
async function back(): Promise<boolean> {
  return page.evaluate(() => window.yadavarBack!())
}
/** creates through the toolbar and names it (Enter) */
async function make(kind: 'پوشه' | 'کارت', name?: string) {
  await tool(kind).click()
  await renameInput().waitFor()
  if (name !== undefined) await renameInput().fill(name)
  await renameInput().press('Enter')
  await renameInput().waitFor({ state: 'detached' })
}
async function rename(item: string, to: string, key: 'Enter' | 'Escape' = 'Enter') {
  await menu(item)
  await menuBtn('تغییر نام').click()
  await renameInput().fill(to)
  await renameInput().press(key)
  await renameInput().waitFor({ state: 'detached' })
}
async function importFile(name: string, content: string | Buffer) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: typeof content === 'string' ? Buffer.from(content, 'utf8') : content })
  await page.locator('[aria-label="وارد کردن کارت‌ها"]').waitFor()
}
const importBox = () => page.locator('[aria-label="وارد کردن کارت‌ها"]')
const limitBox = () => page.locator('[aria-label="کارت جدید در روز"]')
/** an Anki request answered with an error (or never answered: "offline") while `fn` runs */
async function failing(pattern: string, fn: () => Promise<void>, how: 'error' | 'offline' = 'error') {
  const h = (r: import('playwright-core').Route) => (how === 'error' ? r.fulfill({ status: 500, body: '{"error":"test"}' }) : r.abort())
  await page.route(pattern, h)
  try {
    await fn()
  } finally {
    await page.unroute(pattern, h)
  }
}
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 4000) {
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
const toastSays = (text: string) => until(`toast «${text}»`, async () => (await toast().innerText()).includes(text))
/** scrolls the list (on a phone the page itself) to its end / its top */
const scrollList = (to: 'end' | 'top') =>
  page.locator('.vg').evaluate((vg, to) => {
    let sp: HTMLElement | null = vg.parentElement
    while (sp && !/auto|scroll/.test(getComputedStyle(sp).overflowY)) sp = sp.parentElement
    const y = to === 'end' ? 1e9 : 0
    if (sp) sp.scrollTop = y
    window.scrollTo(0, y)
  }, to)
const fa = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false })

// ------------------------------------------------------------------ tests
type T = { id: string; name: string; fn: () => Promise<void> }
const tests: T[] = []
const test = (id: string, name: string, fn: () => Promise<void>) => tests.push({ id, name, fn })

// ---------- P: the path bar
test('P1', 'home: no "up" button, «خانه» is the active crumb', async () => {
  await open()
  eq('up buttons', await page.locator('.path-bar .up').count(), 0)
  eq('active', await page.locator('.crumb.is-active').innerText(), 'خانه')
})
test('P2', 'inside a folder: "up" shows, the path lists every level, the deepest one active', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.node(b.id, 'پ')
  await open()
  await enter('الف', 'ب', 'پ')
  eq('crumbs', await crumbs(), ['خانه', 'الف', 'ب', 'پ'])
  eq('up', await page.locator('.path-bar .up').count(), 1)
  eq('active', await page.locator('.crumb.is-active').innerText(), 'پ')
})
test('P3', '"up" goes one level up', async () => {
  const a = await api.node(null, 'الف')
  await api.node(a.id, 'ب')
  await open()
  await enter('الف', 'ب')
  await page.locator('.path-bar .up').click()
  eq('crumbs', await crumbs(), ['خانه', 'الف'])
  await page.locator('.path-bar .up').click()
  eq('crumbs', await crumbs(), ['خانه'])
})
test('P4', '«خانه» from three levels down goes home', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.node(b.id, 'پ')
  await open()
  await enter('الف', 'ب', 'پ')
  await page.locator('.path-bar .crumb').first().click()
  eq('crumbs', await crumbs(), ['خانه'])
  ok('home items', (await tileNames()).includes('الف'))
})
test('P5', 'a crumb in the middle goes to that level', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.node(b.id, 'پ')
  await open()
  await enter('الف', 'ب', 'پ')
  await page.locator('.path-bar .crumb').nth(1).click()
  eq('crumbs', await crumbs(), ['خانه', 'الف'])
  eq('items', await tileNames(), ['ب'])
})
test('P6', 'the active crumb: stays, but the selection is cleared', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await longPress(tile('یک'))
  eq('selected', await page.locator('.item-card.sel').count(), 1)
  await page.locator('.crumb.is-active').click()
  eq('crumbs', await crumbs(), ['خانه', 'الف'])
  eq('selected after', await page.locator('.item-card.sel').count(), 0)
})
test('P7', 'a deep path with long names scrolls sideways and keeps the deepest part in view; long names are cut with …', async () => {
  let parent: string | null = null
  const names: string[] = []
  for (let i = 1; i <= 6; i++) {
    const name = `پوشه‌ای با یک نام خیلی خیلی طولانی شماره ${fa(i)}`
    names.push(name)
    parent = (await api.node(parent, name)).id
  }
  await open()
  await enter(...names)
  const m = await page.locator('.path-bar').evaluate((bar) => {
    const a = bar.querySelector('.crumb.is-active')!.getBoundingClientRect()
    const r = bar.getBoundingClientRect()
    const widest = Math.max(...[...bar.querySelectorAll('.crumb')].map((c) => c.getBoundingClientRect().width))
    return { scrolls: bar.scrollWidth > bar.clientWidth, inView: a.left >= r.left - 1 && a.right <= r.right + 1, widest, page: document.documentElement.scrollWidth <= innerWidth }
  })
  ok('the bar scrolls', m.scrolls)
  ok('the deepest crumb is in view', m.inView)
  ok('no crumb wider than 220px', m.widest <= 221)
  ok('the page itself does not scroll sideways', m.page)
})
test('P8', 'a folder of the path that disappears (undo of its creation) shortens the path', async () => {
  const a = await api.node(null, 'الف')
  await open()
  await enter('الف')
  await make('پوشه', 'تازه')
  await enter('تازه')
  await undoBtn().click() // the rename of "تازه"
  await undoBtn().click() // its creation
  await until('path back to الف', async () => JSON.stringify(await crumbs()) === JSON.stringify(['خانه', 'الف']))
  ok('folder gone on the server', !(await api.snap()).nodes.some((n) => n.parentId === a.id))
})
test('P9', 'a renamed folder shows its new name in the path, and its old one after undo', async () => {
  await api.node(null, 'قدیم')
  await open()
  await rename('قدیم', 'جدید')
  await enter('جدید')
  eq('crumbs', await crumbs(), ['خانه', 'جدید'])
  await until('undo enabled', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('crumb reverted', async () => (await crumbs())[1] === 'قدیم')
})
test('P10', 'another tab and back: the info tab opens in the folder it was left in, with no selection or menu left; tapped again it goes home', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await longPress(tile('یک'))
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  eq('crumbs', await crumbs(), ['خانه', 'الف'])
  eq('selected', await page.locator('.item-card.sel').count(), 0)
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  eq('crumbs after a second tap', await crumbs(), ['خانه'])
})
test('P11', 'phone: the path and the buttons stay at the top while the list scrolls', async () => {
  const a = await api.node(null, 'الف')
  for (let i = 0; i < 30; i++) await api.node(a.id, 'ب' + i)
  await open()
  await enter('الف')
  const top = await page.evaluate(() => {
    const panel = document.querySelector('.panel') as HTMLElement
    panel.scrollTop = 900
    return { scrolled: panel.scrollTop, pin: document.querySelector('.pinned')!.getBoundingClientRect().top, panel: panel.getBoundingClientRect().top }
  })
  ok('the list scrolled', top.scrolled > 300)
  eq('path bar still at the top', Math.round(top.pin), Math.round(top.panel))
  ok('new-folder button visible', await tool('پوشه').isVisible())
})

// ---------- T: the toolbar
test('T2', 'phone: no toolbar title, the short labels, undo and redo', async () => {
  await open()
  eq('title', await page.locator('.toolbar-title').count(), 0)
  for (const l of ['پوشه', 'کارت', 'ورود']) ok(`button ${l}`, await tool(l).isVisible())
  ok('undo shown', await undoBtn().isVisible())
  ok('redo shown', await redoBtn().isVisible())
  ok('long labels hidden', !(await page.locator('.actions .long').first().isVisible()))
})
test('T3', 'new folder: «پوشه جدید», then «پوشه جدید ۲»; its name is selected for typing', async () => {
  await open()
  await tool('پوشه').click()
  await renameInput().waitFor()
  const sel = await renameInput().evaluate((i: HTMLInputElement) => [i.value, i.selectionStart, i.selectionEnd, document.activeElement === i])
  eq('input', sel, ['پوشه جدید', 0, 'پوشه جدید'.length, true])
  await renameInput().press('Enter')
  await tool('پوشه').click()
  await renameInput().waitFor()
  eq('second name', await renameInput().inputValue(), 'پوشه جدید ۲')
  await renameInput().press('Enter')
  eq('server', (await api.snap()).nodes.map((n) => n.name).sort(), ['پوشه جدید', 'پوشه جدید ۲'].sort())
})
test('T3b', 'new folder: a free «پوشه جدید» is used even when «پوشه جدید ۲» exists; case is ignored for taken names', async () => {
  await api.node(null, 'پوشه جدید ۲')
  await open()
  await tool('پوشه').click()
  await renameInput().waitFor()
  eq('name', await renameInput().inputValue(), 'پوشه جدید')
})
test('T4', 'new card: «کارت جدید», then «کارت جدید ۲», in the folder shown', async () => {
  const a = await api.node(null, 'الف')
  await open()
  await enter('الف')
  await make('کارت')
  await make('کارت')
  eq('server', (await cardsIn(a.id)).map((c) => c.name), ['کارت جدید', 'کارت جدید ۲'])
})
test('T5', 'new folder and card three levels down land there; at home a card sits at the top level', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await open()
  await make('کارت', 'بیرونی')
  await enter('الف', 'ب')
  await make('پوشه', 'زیر')
  await make('کارت', 'درونی')
  await until('card names saved', async () => (await api.snap()).cards.some((c) => c.name === 'درونی'), 5000)
  const s = await api.snap()
  eq('folder parent', s.nodes.find((n) => n.name === 'زیر')?.parentId, b.id)
  eq('card folder', s.cards.find((c) => c.name === 'درونی')?.folderId, b.id)
  eq('top card', s.cards.find((c) => c.name === 'بیرونی')?.folderId, null)
})
test('T6', 'two quick taps on «پوشه» / «کارت»: two items with different names, the same in the app and in Anki', async () => {
  await open()
  await tool('پوشه').dblclick()
  await until('two folders', async () => (await page.locator('.item-card').count()) === 2)
  await page.keyboard.press('Enter')
  await tool('کارت').dblclick()
  await until('two cards', async () => (await page.locator('.item-card').count()) === 4)
  await page.keyboard.press('Enter')
  await sleep(300)
  const s = await api.snap()
  eq('folder names (server)', s.nodes.map((n) => n.name).sort(), ['پوشه جدید', 'پوشه جدید ۲'].sort())
  eq('card names (server)', s.cards.map((c) => c.name).sort(), ['کارت جدید', 'کارت جدید ۲'].sort())
  eq('app = server', (await tileNames()).sort(), [...s.nodes.map((n) => n.name), ...s.cards.map((c) => c.name)].sort())
})
test('T7', '«پیست» shows only while something is cut or copied', async () => {
  await api.card(null, 'یک')
  await open()
  eq('no paste', await tool('پیست').count(), 0)
  await menu('یک')
  await menuBtn('کپی').click()
  ok('paste shown', await tool('پیست').isVisible())
})
test('T8', 'undo / redo: off at first; undo takes the new folder away, redo brings it back', async () => {
  await open()
  ok('undo off', await undoBtn().isDisabled())
  ok('redo off', await redoBtn().isDisabled())
  await tool('پوشه').click()
  await renameInput().press('Escape')
  await until('undo on', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('folder gone', async () => (await page.locator('.item-card').count()) === 0)
  ok('redo on', await redoBtn().isEnabled())
  ok('undo off again', await undoBtn().isDisabled())
  await redoBtn().click()
  await until('folder back', async () => (await tileNames()).includes('پوشه جدید'))
  eq('server', (await api.snap()).nodes.length, 1)
})
test('T9', 'after a card is renamed (a card edit, not a tree step) undo is off', async () => {
  await api.card(null, 'یک')
  await open()
  await make('پوشه', 'x')
  await until('undo on', () => undoBtn().isEnabled())
  await rename('یک', 'دو')
  await until('undo off', () => undoBtn().isDisabled())
})
test('T10', 'more than 30 steps: undo counts at most 30, and all 30 really go back', async () => {
  const a = await api.node(null, 'الف')
  for (let i = 0; i < 31; i++) await api.node(a.id, `پ${i}`)
  await open()
  await enter('الف')
  for (let i = 0; i < 31; i++) {
    await menu(`پ${i}`)
    await menuBtn('حذف').click()
    await confirmBox().getByRole('button', { name: 'حذف' }).click()
    await until('deleted', async () => !(await tileNames()).includes(`پ${i}`))
  }
  await sleep(400)
  let n = 0
  while (await undoBtn().isEnabled()) {
    const before = (await api.snap()).nodes.length
    await undoBtn().click()
    n++
    await until(`undo ${n} done`, async () => (await api.snap()).nodes.length === before + 1 && !(await toast().count()), 8000)
    if (n > 40) break
  }
  eq('undo steps', n, 30)
  eq('folders back (Anki)', (await api.snap()).nodes.length, 31)
})
test('T11', 'import: the same file can be picked twice; cancelling the file picker does nothing', async () => {
  await open()
  await importFile('words.txt', 'a\tb\n')
  await importBox().getByRole('button', { name: 'انصراف' }).click()
  await importFile('words.txt', 'a\tb\n')
  ok('dialog again', await importBox().isVisible())
  await importBox().getByRole('button', { name: 'انصراف' }).click()
  await page.locator('input[type=file]').setInputFiles([])
  eq('no dialog', await importBox().count(), 0)
})

// ---------- G: the grid
test('G1', 'empty home: «هنوز چیزی نساخته‌ای»', async () => {
  await open()
  ok('text', (await page.locator('.empty').innerText()).includes('هنوز چیزی نساخته‌ای'))
})
test('G2', 'empty folder: «این پوشه خالی است»', async () => {
  await api.node(null, 'الف')
  await open()
  await enter('الف')
  ok('text', (await page.locator('.empty').innerText()).includes('این پوشه خالی است'))
})
test('G3', 'folders first, then cards (each oldest first)', async () => {
  await api.card(null, 'کارت۱')
  await api.node(null, 'پوشه۱')
  await api.card(null, 'کارت۲')
  await api.node(null, 'پوشه۲')
  await open()
  eq('order', await tileNames(), ['پوشه۱', 'پوشه۲', 'کارت۱', 'کارت۲'])
})
test('G4', '3000 cards: only the tiles near the screen exist, and the last one is reachable', async () => {
  await api.import(null, 'بزرگ', Array.from({ length: 3000 }, (_, i) => `w${i}`), null)
  await open()
  await enter('بزرگ')
  const n = await page.locator('.item-card').count()
  ok(`few tiles in the page (${n})`, n < 150)
  await scrollList('end')
  await until('last tile', () => tile('w2999').isVisible())
})
test('G5', 'a new card at the end of a long list scrolls into view, ready for its name', async () => {
  await api.import(null, 'بزرگ', Array.from({ length: 400 }, (_, i) => `w${i}`), null)
  await open()
  await enter('بزرگ')
  await tool('کارت').click()
  await renameInput().waitFor()
  await until('input in view', async () => {
    const b = (await renameInput().boundingBox())!
    return b.y >= 0 && b.y + b.height <= 844
  })
})
test('F0', 'phone tiles show no due line and no hover tools (only the ⋮ button)', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  ok('meta hidden', !(await page.locator('.item-meta').first().isVisible()))
  ok('tools hidden', !(await page.locator('.item-tools').first().isVisible()))
  eq('⋮ on each', await page.locator('.item-dots').count(), 2)
})
test('F8', 'a tap on a folder opens it', async () => {
  await api.node(null, 'الف')
  await open()
  await tile('الف').click()
  eq('crumbs', await crumbs(), ['خانه', 'الف'])
})
test('C6', 'a tap on a card opens the card editor', async () => {
  await api.card(null, 'یک')
  await open()
  await tile('یک').click()
  await editor().waitFor()
})
test('C9', 'a card that cannot be loaded: a message, no editor', async () => {
  await api.card(null, 'یک')
  await open()
  await failing('**/api/cardfull', async () => {
    await tile('یک').click()
    await toastSays('باز کردن کارت انجام نشد')
  })
  eq('editor', await editor().count(), 0)
})

// ---------- R: renaming in place
test('R1', 'Enter keeps the new name (app and Anki)', async () => {
  await api.node(null, 'الف')
  await open()
  await rename('الف', 'ب')
  eq('tile', await tileNames(), ['ب'])
  await until('server', async () => !!(await nodeNamed('ب')))
})
test('R2', 'Escape keeps the old name', async () => {
  await api.node(null, 'الف')
  await open()
  await rename('الف', 'ب', 'Escape')
  eq('tile', await tileNames(), ['الف'])
  await sleep(300)
  ok('server', !!(await nodeNamed('الف')))
})
test('R3', 'a tap elsewhere (blur) keeps the new name', async () => {
  await api.card(null, 'یک')
  await open()
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('دو')
  await page.mouse.click(195, 560) // empty space below the tiles
  await renameInput().waitFor({ state: 'detached' })
  eq('tile', await tileNames(), ['دو'])
  await page.reload()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  eq('after reload', await tileNames(), ['دو'])
})
test('R4', 'an empty name (or only spaces) keeps the old one', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  await rename('الف', '   ')
  await rename('یک', '')
  eq('tiles', await tileNames(), ['الف', 'یک'])
})
test('R5', 'the same name: nothing is sent to Anki', async () => {
  await api.node(null, 'الف')
  await open()
  const sent: string[] = []
  page.on('request', (r) => r.url().includes('/api/node/rename') && sent.push(r.url()))
  await rename('الف', 'الف')
  await sleep(300)
  eq('requests', sent.length, 0)
})
test('R6', 'spaces around a name are dropped', async () => {
  await api.node(null, 'الف')
  await open()
  await rename('الف', '  ب  ')
  eq('tile', await tileNames(), ['ب'])
  await until('server', async () => !!(await nodeNamed('ب')))
})
test('R7', 'a folder name already used beside it: message, old name kept', async () => {
  await api.node(null, 'الف')
  await api.node(null, 'ب')
  await open()
  await rename('ب', 'الف')
  await toastSays('این نام قبلاً')
  eq('tiles', await tileNames(), ['الف', 'ب'])
})
test('R8', 'folder names differing only in upper / lower case count as the same (as in Anki)', async () => {
  await api.node(null, 'abc')
  await api.node(null, 'x')
  await open()
  await rename('x', 'ABC')
  await toastSays('این نام قبلاً')
  eq('tiles', await tileNames(), ['abc', 'x'])
})
test('R8b', 'a folder may change only the case of its own name', async () => {
  await api.node(null, 'abc')
  await open()
  await rename('abc', 'ABC')
  eq('tile', await tileNames(), ['ABC'])
  await until('server', async () => !!(await nodeNamed('ABC')))
})
test('R9', 'a folder name with "::" shows what Anki keeps (":")', async () => {
  await api.node(null, 'الف')
  await open()
  await rename('الف', 'a::b')
  eq('tile', await tileNames(), ['a:b'])
  await until('server', async () => !!(await nodeNamed('a:b')))
})
test('R10', 'a top-level folder called "Default" (Anki\'s own deck): the app shows the name Anki kept', async () => {
  await api.node(null, 'الف')
  await open()
  await rename('الف', 'Default')
  await sleep(500)
  const server = (await api.snap()).nodes[0].name
  eq('app = server', await tileNames(), [server])
})
test('R11', 'a card name already used in the same folder: message, old name kept', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await rename('دو', 'یک')
  await toastSays('این نام قبلاً')
  eq('tiles', await tileNames(), ['یک', 'دو'])
  await sleep(1200)
  eq('server', (await cardsIn(null)).map((c) => c.name), ['یک', 'دو'])
})
test('R11b', 'card names differing only in case count as the same; the same name in another folder is fine', async () => {
  const a = await api.node(null, 'الف')
  await api.card(null, 'Word')
  await api.card(null, 'x')
  await api.card(a.id, 'y')
  await open()
  await rename('x', 'word')
  await toastSays('این نام قبلاً')
  await enter('الف')
  await rename('y', 'Word')
  eq('tile', await tileNames(), ['Word'])
})
test('R12', 'a very long name, emoji, mixed Persian / English: kept whole, shown cut', async () => {
  await api.node(null, 'الف')
  await open()
  const long = 'نام 😀 خیلی long ' + 'ب'.repeat(150)
  await rename('الف', long)
  await until('server', async () => !!(await nodeNamed(long)))
  const w = await page.locator('.item-name').evaluate((e) => [e.scrollWidth, e.clientWidth, getComputedStyle(e).overflow])
  ok('tile fits its box', w[1] <= 200)
})
test('R13', 'Anki refuses a folder rename: the old name comes back, with a message', async () => {
  await api.node(null, 'الف')
  await open()
  await failing('**/api/node/rename', async () => {
    await rename('الف', 'ب')
    await toastSays('تغییر نام انجام نشد')
  })
  eq('tile', await tileNames(), ['الف'])
})
test('R13b', 'a card rename that cannot be saved: a message', async () => {
  await api.card(null, 'یک')
  await open()
  await failing('**/api/card/update', async () => {
    await rename('یک', 'دو')
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // saves at once
    await toastSays('ذخیره‌سازی انجام نشد')
  })
})
test('R14', 'renaming, then a tap on a folder: the name is kept and that tap only ends the renaming', async () => {
  await api.node(null, 'الف')
  await api.node(null, 'ب')
  await open()
  await menu('الف')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('ج')
  await tile('ب').click()
  await renameInput().waitFor({ state: 'detached' })
  eq('names', await tileNames(), ['ج', 'ب'])
  eq('still at home', await crumbs(), ['خانه'])
})
test('R14b', 'renaming, then a tap on a card: the name is kept and the card does not open', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('سه')
  await tile('دو').click()
  await renameInput().waitFor({ state: 'detached' })
  eq('names', await tileNames(), ['سه', 'دو'])
  await sleep(300)
  eq('editor', await editor().count(), 0)
})
test('R15', 'renaming, then «پوشه»: the first name is kept, the new folder is being named', async () => {
  await open()
  await tool('پوشه').click()
  await renameInput().fill('اول')
  await tool('پوشه').click()
  await until('second in rename', async () => (await renameInput().inputValue()) === 'پوشه جدید')
  ok('first kept', (await tileNames()).includes('اول'))
})
test('R16', 'renaming, then undo: the rename is saved first and is what undo takes back', async () => {
  await api.node(null, 'الف')
  await open()
  await make('پوشه', 'تازه')
  await until('undo on', () => undoBtn().isEnabled())
  await menu('الف')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('ب')
  await undoBtn().click()
  await until('back to الف', async () => (await tileNames()).includes('الف'))
  ok('تازه still there', (await tileNames()).includes('تازه'))
})
test('R17', 'while renaming, a long press does not start a selection', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await longPress(tile('دو'))
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})

// ---------- M: the ⋮ menu
test('M1', 'card menu: rename, copy, cut, delete, close (no daily limit)', async () => {
  await api.card(null, 'یک')
  await open()
  await menu('یک')
  eq('title', await menuBox().locator('h3').innerText(), 'یک')
  eq('buttons', await menuBox().locator('button').allInnerTexts(), ['تغییر نام', 'کپی', 'کات', 'حذف', 'بستن'])
})
test('M2', 'folder menu also has the daily limit: «بدون سقف» or the number', async () => {
  const a = await api.node(null, 'الف')
  await api.node(null, 'ب')
  await api.limit(a.id, 15)
  await open()
  await menu('الف')
  ok('limit 15', await menuBtn('کارت جدید در روز: ۱۵').isVisible())
  await menuBtn('بستن').click()
  await menu('ب')
  ok('no limit', await menuBtn('کارت جدید در روز: بدون سقف').isVisible())
})
test('M3', 'menu of a selected item with others selected: «N مورد انتخاب‌شده», no rename and no limit', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await longPress(tile('الف'))
  await tile('یک').click()
  await menu('الف')
  eq('title', await menuBox().locator('h3').innerText(), '۲ مورد انتخاب‌شده')
  eq('buttons', await menuBox().locator('button').allInnerTexts(), ['کپی', 'کات', 'حذف', 'بستن'])
})
test('M4', 'menu of the only selected item: as an unselected one', async () => {
  await api.node(null, 'الف')
  await open()
  await longPress(tile('الف'))
  await menu('الف')
  eq('title', await menuBox().locator('h3').innerText(), 'الف')
  ok('rename', await menuBtn('تغییر نام').isVisible())
})
test('M5', 'while selecting, ⋮ shows only on selected items', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await longPress(tile('یک'))
  eq('dots', [await dots('یک').count(), await dots('دو').count()], [1, 0])
})
test('M6', 'the menu closes with «بستن», Escape, a tap outside and the back button', async () => {
  await api.card(null, 'یک')
  await open()
  for (const how of ['button', 'escape', 'outside', 'back']) {
    await menu('یک')
    if (how === 'button') await menuBtn('بستن').click()
    if (how === 'escape') await page.keyboard.press('Escape')
    if (how === 'outside') await page.mouse.click(5, 5)
    if (how === 'back') eq('back used', await back(), true)
    await until(`closed by ${how}`, async () => (await menuBox().count()) === 0)
  }
  eq('still at home, nothing changed', await tileNames(), ['یک'])
})
test('M7', 'rename from the menu clears the selection', async () => {
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await renameInput().waitFor()
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('M8', 'copy / cut: a message (with the count for several), selection cleared', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await menu('یک')
  await menuBtn('کپی').click()
  await toastSays('کپی شد')
  await longPress(tile('یک'))
  await tile('دو').click()
  await menu('دو')
  await menuBtn('کات').click()
  await toastSays('۲ مورد کات شد')
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('M9', 'delete asks first: one item by name, several by count', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await menu('یک')
  await menuBtn('حذف').click()
  ok('by name', (await confirmBox().innerText()).includes('«یک» حذف شود؟'))
  await confirmBox().getByRole('button', { name: 'انصراف' }).click()
  await longPress(tile('یک'))
  await tile('دو').click()
  await menu('یک')
  await menuBtn('حذف').click()
  ok('by count', (await confirmBox().innerText()).includes('۲ مورد با همه‌ی محتوایشان حذف شود؟'))
})

// ---------- S: selecting
test('S1', 'a long press selects (tick, highlighted)', async () => {
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  ok('sel', await tile('یک').evaluate((e) => e.classList.contains('sel')))
  eq('tick', await tile('یک').locator('.tick').count(), 1)
})
test('S2', 'a press that moves (scrolling) selects nothing', async () => {
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'), 650, 30)
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('S2b', 'a short press opens, it does not select', async () => {
  await api.node(null, 'الف')
  await open()
  await longPress(tile('الف'), 150)
  eq('entered', await crumbs(), ['خانه', 'الف'])
})
test('S3', 'the release of a long press on a folder does not open it', async () => {
  await api.node(null, 'الف')
  await open()
  await longPress(tile('الف'))
  eq('still home', await crumbs(), ['خانه'])
  eq('selected', await page.locator('.item-card.sel').count(), 1)
})
test('S4', 'the system long-press menu (contextmenu) selects too', async () => {
  await api.card(null, 'یک')
  await open()
  await tile('یک').dispatchEvent('contextmenu')
  eq('selected', await page.locator('.item-card.sel').count(), 1)
})
test('S5', 'while selecting, taps add and remove items (folders and cards); nothing opens', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await longPress(tile('یک'))
  await tile('الف').click()
  await tile('دو').click()
  eq('three', await page.locator('.item-card.sel').count(), 3)
  await tile('دو').click()
  eq('two', await page.locator('.item-card.sel').count(), 2)
  eq('still home', await crumbs(), ['خانه'])
  eq('no editor', await editor().count(), 0)
})
test('S6', 'removing the last selected item ends selecting: taps open again, ⋮ back everywhere', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  await tile('یک').click()
  eq('selected', await page.locator('.item-card.sel').count(), 0)
  eq('dots', await page.locator('.item-dots').count(), 2)
  await tile('الف').click()
  eq('entered', await crumbs(), ['خانه', 'الف'])
})
test('S7', 'a long press on a selected item unselects it', async () => {
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await longPress(tile('یک'))
  await tile('دو').click()
  await longPress(tile('یک'))
  eq('selected', await page.locator('.item-card.sel').count(), 1)
})
test('S8', 'going into a folder clears the selection', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  await page.locator('.path-bar .crumb').first().click()
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})

// ---------- D: deleting
test('D2', 'deleting a folder takes its subfolders, their cards and review history with it', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.card(a.id, 'یک')
  await api.card(b.id, 'دو')
  await api.answer(b.id, 3)
  await api.card(null, 'بیرون')
  await open()
  await menu('الف')
  await menuBtn('حذف').click()
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('gone', async () => (await tileNames()).join() === 'بیرون')
  await sleep(300)
  const s = await api.snap()
  eq('server nodes', s.nodes.length, 0)
  eq('server cards', s.cards.map((c) => c.name), ['بیرون'])
})
test('D3', 'deleting folders and cards together is one step: one undo brings all back', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await longPress(tile('الف'))
  await tile('یک').click()
  await menu('یک')
  await menuBtn('حذف').click()
  ok('phone text mentions undo', (await confirmBox().innerText()).includes('برگردانی'))
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('deleted', async () => (await tileNames()).join() === 'دو')
  await until('undo on', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('all back', async () => (await tileNames()).length === 3)
  ok('undo off (one step)', await undoBtn().isDisabled())
})
test('D4', 'the delete question: «انصراف», Escape, a tap outside and back keep everything', async () => {
  await api.card(null, 'یک')
  await open()
  for (const how of ['cancel', 'escape', 'outside', 'back']) {
    await menu('یک')
    await menuBtn('حذف').click()
    await confirmBox().waitFor()
    if (how === 'cancel') await confirmBox().getByRole('button', { name: 'انصراف' }).click()
    if (how === 'escape') await page.keyboard.press('Escape')
    if (how === 'outside') await page.mouse.click(5, 5)
    if (how === 'back') eq('back used', await back(), true)
    await until(`closed by ${how}`, async () => (await confirmBox().count()) === 0)
  }
  eq('kept', await tileNames(), ['یک'])
  eq('server', (await cardsIn(null)).length, 1)
})
test('D5', 'Anki refuses a delete: a message, and the items show again', async () => {
  await api.card(null, 'یک')
  await open()
  await failing('**/api/delete', async () => {
    await menu('یک')
    await menuBtn('حذف').click()
    await confirmBox().getByRole('button', { name: 'حذف' }).click()
    await toastSays('حذف انجام نشد')
  })
  await until('item back', async () => (await tileNames()).join() === 'یک')
})
test('D7', 'undo of deleting the folder you were in brings it back (you stay where you are)', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await menu('الف')
  await menuBtn('حذف').click()
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('gone', async () => (await tileNames()).length === 0)
  await until('undo on', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('back', async () => (await tileNames()).join() === 'الف')
  await enter('الف')
  eq('its card', await tileNames(), ['یک'])
})

// ---------- V: paste
async function clip(names: string[], how: 'کپی' | 'کات') {
  if (names.length > 1) {
    await longPress(tile(names[0]))
    for (const n of names.slice(1)) await tile(n).click()
  }
  await menu(names[0])
  await menuBtn(how).click()
}
async function paste() {
  await tool('پیست').click()
}
test('V1', 'copy → paste elsewhere: a fresh copy (new schedule); a folder copy keeps its daily limit', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  await api.card(a.id, 'یک')
  await api.answer(a.id, 4) // studied: a review card now
  await api.limit(a.id, 7)
  await open()
  await enter('الف')
  await clip(['یک'], 'کپی')
  await page.locator('.path-bar .crumb').first().click()
  await enter('ب')
  await paste()
  await toastSays('انجام شد')
  eq('tile', await tileNames(), ['یک'])
  const s = await api.snap()
  eq('copy is new', s.cards.find((c) => c.folderId === b.id)?.state, 'new')
  ok('original studied', s.cards.find((c) => c.folderId === a.id)?.state !== 'new')
  await page.locator('.path-bar .crumb').first().click()
  await clip(['الف'], 'کپی')
  await enter('ب')
  await paste()
  await until('folder copy', async () => (await tileNames()).includes('الف'))
  eq('limit copied', (await api.snap()).nodes.find((n) => n.parentId === b.id && n.name === 'الف')?.newLimit, 7)
})
test('V2', 'copy → paste in the same folder: numbered names', async () => {
  await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  await clip(['الف', 'یک'], 'کپی')
  await paste()
  await until('copies', async () => (await tileNames()).length === 4)
  eq('names', await tileNames(), ['الف', 'الف ۲', 'یک', 'یک ۲'])
})
test('V3', 'copy a folder → paste inside itself: one copy, no endless nesting', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await clip(['الف'], 'کپی')
  await enter('الف')
  await paste()
  await until('copy inside', async () => (await tileNames()).includes('الف'))
  const s = await api.snap()
  eq('folders', s.nodes.length, 2)
  eq('cards', s.cards.length, 2)
})
test('V4', 'cut → paste elsewhere: moved with its schedule', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(null, 'ب')
  await api.card(a.id, 'یک')
  const before = (await api.answer(a.id, 4)).card
  await open()
  await enter('الف')
  await clip(['یک'], 'کات')
  await page.locator('.path-bar .crumb').first().click()
  await enter('ب')
  await paste()
  await toastSays('انجام شد')
  const moved = (await api.snap()).cards.find((c) => c.id === before.id)!
  eq('folder', moved.folderId, b.id)
  eq('schedule', [moved.state, moved.due], [before.state, before.due])
  eq('paste gone', await tool('پیست').count(), 0)
})
test('V5', 'cut → paste where it already is: nothing changes, the clipboard empties', async () => {
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کات')
  const sent: string[] = []
  page.on('request', (r) => r.url().includes('/api/move') && sent.push(r.url()))
  await paste()
  await until('paste gone', async () => (await tool('پیست').count()) === 0)
  eq('requests', sent.length, 0)
  eq('tiles', await tileNames(), ['یک'])
})
test('V6', 'cut a folder → paste inside itself or below it: refused with a message, the clipboard stays', async () => {
  const a = await api.node(null, 'الف')
  await api.node(a.id, 'ب')
  await open()
  await clip(['الف'], 'کات')
  await enter('الف')
  await paste()
  await toastSays('داخل خودش')
  await enter('ب')
  await paste()
  await toastSays('داخل خودش')
  ok('paste still there', await tool('پیست').isVisible())
  eq('server unchanged', (await api.snap()).nodes.find((n) => n.name === 'الف')?.parentId, null)
})
test('V7', 'cut → paste where a folder or card of that name exists (any case): numbered', async () => {
  const a = await api.node(null, 'الف')
  await api.node(a.id, 'ب')
  await api.card(a.id, 'Word')
  await api.node(null, 'ب')
  await api.card(null, 'word')
  await open()
  await clip(['ب', 'word'], 'کات')
  await enter('الف')
  await paste()
  await until('moved', async () => (await tileNames()).length === 4)
  eq('names', await tileNames(), ['ب', 'ب ۲', 'Word', 'word ۲'])
  eq('server', (await cardsIn(a.id)).map((c) => c.name).sort(), ['Word', 'word ۲'].sort())
})
test('V7c', 'undo of a paste that numbered a card: the card goes back with its own name', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کات')
  await enter('الف')
  await paste()
  await until('numbered', async () => (await tileNames()).includes('یک ۲'))
  await undoBtn().click()
  await until('back home with its name', async () => (await cardsIn(null)).map((c) => c.name).join() === 'یک' && (await cardsIn(a.id)).length === 1)
})
test('V7b', 'copy → paste where a card of that name exists in another case: numbered', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'Word')
  await api.card(null, 'word')
  await open()
  await clip(['word'], 'کپی')
  await enter('الف')
  await paste()
  await until('copied', async () => (await tileNames()).length === 2)
  eq('names', await tileNames(), ['Word', 'word ۲'])
})
test('V8', 'cut several, some already here: the others move in', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'درون')
  await api.card(null, 'بیرون')
  await open()
  await enter('الف')
  await clip(['درون'], 'کات')
  await page.locator('.path-bar .crumb').first().click()
  // add بیرون to the clipboard as well: cut both from their places is not possible at once, so cut بیرون with الف
  await clip(['بیرون', 'الف'], 'کات')
  await enter('الف')
  await paste()
  await toastSays('داخل خودش')
  await page.locator('.path-bar .crumb').first().click()
  await clip(['بیرون'], 'کات')
  await enter('الف')
  await paste()
  await until('moved in', async () => (await tileNames()).sort().join() === ['بیرون', 'درون'].sort().join())
})
test('V9', 'cut / copy, then delete what was cut: «پیست» goes away; delete one of two: the other still pastes', async () => {
  await api.node(null, 'مقصد')
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await clip(['یک'], 'کات')
  await menu('یک')
  await menuBtn('حذف').click()
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('paste gone', async () => (await tool('پیست').count()) === 0)
  await api.card(null, 'سه')
  await page.reload()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await clip(['دو', 'سه'], 'کپی')
  await menu('سه')
  await menuBtn('حذف').click()
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('سه gone', async () => !(await tileNames()).includes('سه'))
  ok('paste stays', await tool('پیست').isVisible())
  await enter('مقصد')
  await paste()
  await toastSays('انجام شد')
  eq('pasted', await tileNames(), ['دو'])
})
test('V10', 'paste done: «انجام شد», clipboard empty, selection cleared', async () => {
  await api.node(null, 'مقصد')
  await api.card(null, 'یک')
  await api.card(null, 'دو')
  await open()
  await clip(['یک'], 'کپی')
  await longPress(tile('دو'))
  await paste()
  await toastSays('انجام شد')
  eq('paste gone', await tool('پیست').count(), 0)
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('V11', 'paste refused by Anki: a message, the clipboard stays', async () => {
  await api.node(null, 'مقصد')
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کپی')
  await enter('مقصد')
  await failing('**/api/copy', async () => {
    await paste()
    await toastSays('چسباندن انجام نشد')
  })
  ok('paste still there', await tool('پیست').isVisible())
  eq('nothing pasted', await tileNames(), [])
})

// ---------- I: cards from a file
const cp1256 = (s: string) => {
  const map: Record<string, number> = { ا: 0xc7, ب: 0xc8, س: 0xd3, ل: 0xe1, م: 0xe3, ي: 0xed, ك: 0xdf, ت: 0xca, ر: 0xd1, '\t': 9, '\n': 10, ' ': 32 }
  return Buffer.from([...s].map((ch) => map[ch] ?? ch.charCodeAt(0)))
}
async function importAndCheck(file: string, content: string | Buffer, want: [string, string][]) {
  await open()
  await importFile(file, content)
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  const id = (await api.snap()).nodes.at(-1)!.id
  const got: [string, string][] = []
  for (const c of await cardsIn(id)) {
    const full = await http<{ front: { widgets: { html: string }[] }; back: { widgets: { html: string }[] } }>('/api/cardfull', { id: c.id })
    const text = (s: { widgets: { html: string }[] }) => s.widgets.map((w) => w.html.replace(/<div[^>]*>/g, '').replace(/<\/div>/g, '\n').trim()).join('')
    got.push([text(full.front), text(full.back)])
  }
  eq('cards', got, want)
}
test('I1a', 'UTF-8 file', () => importAndCheck('a.txt', 'سلام\thello\n', [['سلام', 'hello']]))
test('I1b', 'UTF-8 with BOM', () => importAndCheck('a.txt', '﻿سلام\thello\n', [['سلام', 'hello']]))
test('I1c', 'UTF-16 LE (Excel «Unicode text»)', () => importAndCheck('a.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('سلام\thello\r\n', 'utf16le')]), [['سلام', 'hello']]))
test('I1d', 'UTF-16 BE', () => importAndCheck('a.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('سلام\thello\n', 'utf16le').swap16()]), [['سلام', 'hello']]))
test('I1e', 'Windows-1256 (Persian Excel CSV): Arabic ي / ك become ی / ک', () => importAndCheck('a.csv', cp1256('سلام\tكيك\n'), [['سلام', 'کیک']]))
test('I2a', 'separator ";"', () => importAndCheck('a.csv', 'a;b\nc;d\n', [['a', 'b'], ['c', 'd']]))
test('I2b', 'separator "|"', () => importAndCheck('a.txt', 'a|b\nc|d\n', [['a', 'b'], ['c', 'd']]))
test('I2c', 'separator ","', () => importAndCheck('a.csv', 'a,b\nc,d\n', [['a', 'b'], ['c', 'd']]))
test('I2d', 'tab wins over commas inside the meaning', () => importAndCheck('a.txt', 'go\tto leave, to move\nrun\tto hurry, fast\n', [['go', 'to leave, to move'], ['run', 'to hurry, fast']]))
test('I2e', 'no separator at all: «کارتی … پیدا نشد», only «بستن»', async () => {
  await open()
  await importFile('a.txt', 'just words\nmore words\n')
  ok('text', (await importBox().innerText()).includes('کارتی در این فایل پیدا نشد'))
  eq('buttons', await importBox().locator('.row button').allInnerTexts(), ['بستن'])
})
test('I3', 'blank lines, # comments and Windows line ends ignored; a line without a back skipped and counted; extra columns join the back', async () => {
  await open()
  await importFile('a.txt', '# comment\r\n\r\na\tb\r\nonly front\r\nc\td\te\r\n')
  ok('counts', (await importBox().innerText()).includes('۲ کارت پیدا شد'))
  ok('skipped', (await importBox().innerText()).includes('۱ خط بدون پشت کارت'))
  await importBox().getByRole('button', { name: 'انصراف' }).click()
  await importAndCheck('a.txt', '# comment\r\n\r\na\tb\r\nonly front\r\nc\td\te\r\n', [['a', 'b'], ['c', 'd e']])
})
test('I4', 'quoted fields: separators and "" inside quotes', () => importAndCheck('a.csv', '"a, b","say ""hi"""\nc,d\n', [['a, b', 'say "hi"'], ['c', 'd']]))
test('I5', "Anki's HTML export: line breaks kept, tags and &entities; gone", () => importAndCheck('a.txt', 'one<br>two\t<b>bold</b>&nbsp;text\n', [['one\ntwo', 'bold text']]))
test('I6', 'an empty file: «کارتی … پیدا نشد»', async () => {
  await open()
  await importFile('empty.txt', '')
  ok('text', (await importBox().innerText()).includes('کارتی در این فایل پیدا نشد'))
  await importBox().locator('.row button').click()
  eq('closed', await importBox().count(), 0)
})
test('I7', 'preview: the first 3 cards only', async () => {
  await open()
  await importFile('a.txt', 'a\t1\nb\t2\nc\t3\nd\t4\n')
  eq('rows', await importBox().locator('.preview li').count(), 3)
  ok('found 4', (await importBox().innerText()).includes('۴ کارت پیدا شد'))
})
test('I8', 'the folder name comes from the file name', async () => {
  await open()
  for (const [file, want] of [['English words.txt', 'English words'], ['.txt', 'کارت‌های وارد شده'], ['a.b.csv', 'a.b']]) {
    await importFile(file, 'a\tb\n')
    eq(file, await importBox().locator('input').inputValue(), want)
    await importBox().getByRole('button', { name: 'انصراف' }).click()
  }
})
test('I9', 'an empty folder name: «وارد کن» is off', async () => {
  await open()
  await importFile('a.txt', 'a\tb\n')
  await importBox().locator('input').fill('   ')
  ok('off', await importBox().getByRole('button', { name: 'وارد کن' }).isDisabled())
})
test('I10', 'a folder name with "::" or one already used: Anki keeps ":" and a number', async () => {
  await api.node(null, 'لغات')
  await open()
  await importFile('a.txt', 'a\tb\n')
  await importBox().locator('input').fill('لغات')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  await page.locator('.path-bar .crumb').first().click()
  await importFile('b.txt', 'a\tb\n')
  await importBox().locator('input').fill('x::y')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  eq('server', (await api.snap()).nodes.map((n) => n.name).sort(), ['x:y', 'لغات', 'لغات ۲'].sort())
})
test('I11', 'cards a day: 20 at first; −/+ by 5 down to 10, then one at a time, never below 1 or above 500; the day count follows', async () => {
  await open()
  await importFile('a.txt', Array.from({ length: 50 }, (_, i) => `w${i}\tm`).join('\n'))
  const value = async () => importBox().locator('.stepper b').innerText()
  const minus = importBox().getByRole('button', { name: 'کمتر' })
  const plus = importBox().getByRole('button', { name: 'بیشتر' })
  eq('start', await value(), '۲۰')
  ok('days 3', (await importBox().locator('.hint').innerText()).includes('۳ روز'))
  const seen: string[] = []
  for (let i = 0; i < 13; i++) {
    await minus.click()
    seen.push(await value())
  }
  eq('down', seen, ['۱۵', '۱۰', '۹', '۸', '۷', '۶', '۵', '۴', '۳', '۲', '۱', '۱', '۱'])
  ok('days 50', (await importBox().locator('.hint').innerText()).includes('۵۰ روز'))
  const up: string[] = []
  for (let i = 0; i < 11; i++) {
    await plus.click()
    up.push(await value())
  }
  eq('up', up, ['۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹', '۱۰', '۱۵', '۲۰'])
  for (let i = 0; i < 110; i++) await plus.click()
  eq('max', await value(), '۵۰۰')
})
test('I12', 'import: a new folder here with the limit, you are taken into it, a message, one undo step', async () => {
  const a = await api.node(null, 'الف')
  await open()
  await enter('الف')
  await importFile('لغات.txt', 'a\t1\nb\t2\nc\t3\n')
  await importBox().getByRole('button', { name: 'کمتر' }).click()
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('۳ کارت وارد شد')
  eq('path', await crumbs(), ['خانه', 'الف', 'لغات'])
  eq('tiles', await tileNames(), ['a', 'b', 'c'])
  const n = (await api.snap()).nodes.find((x) => x.name === 'لغات')!
  eq('parent and limit', [n.parentId, n.newLimit], [a.id, 15])
  await undoBtn().click()
  await until('all gone', async () => (await api.snap()).nodes.length === 1 && (await api.snap()).cards.length === 0)
  await until('path back', async () => JSON.stringify(await crumbs()) === JSON.stringify(['خانه', 'الف']))
})
test('I13', 'the import dialog closes with «انصراف», ×, Escape, a tap outside and back: nothing imported', async () => {
  await open()
  for (const how of ['cancel', 'x', 'escape', 'outside', 'back']) {
    await importFile('a.txt', 'a\tb\n')
    if (how === 'cancel') await importBox().getByRole('button', { name: 'انصراف' }).click()
    if (how === 'x') await importBox().getByRole('button', { name: 'بستن' }).click()
    if (how === 'escape') await page.keyboard.press('Escape')
    if (how === 'outside') await page.mouse.click(3, 3)
    if (how === 'back') eq('back used', await back(), true)
    await until(`closed by ${how}`, async () => (await importBox().count()) === 0)
  }
  eq('server', (await api.snap()).nodes.length, 0)
})
test('I14', 'Anki refuses the import: a message, you stay where you were', async () => {
  await open()
  await importFile('a.txt', 'a\tb\n')
  await failing('**/api/cards/import', async () => {
    await importBox().getByRole('button', { name: 'وارد کن' }).click()
    await toastSays('وارد کردن انجام نشد')
  })
  eq('path', await crumbs(), ['خانه'])
  eq('server', (await api.snap()).nodes.length, 0)
})
test('I15', 'a file of 3000 cards', async () => {
  await open()
  await importFile('big.txt', Array.from({ length: 3000 }, (_, i) => `word${i}\tmeaning ${i}`).join('\n'))
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  const t0 = Date.now()
  await until('done', async () => (await toast().innerText()).includes('۳٬۰۰۰ کارت وارد شد'), 180_000)
  console.log('      took', Date.now() - t0, 'ms')
  eq('server', (await api.snap()).cards.length, 3000)
})
test('I16', 'while importing, nothing else can start (create, import, paste, undo are off)', async () => {
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کپی')
  await make('پوشه', 'x')
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  await page.route('**/api/cards/import', async (r) => {
    await gate
    await r.continue()
  })
  await importFile('a.txt', 'a\tb\n')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await until('busy message', async () => (await toast().innerText()).includes('در حال وارد کردن'))
  for (const l of ['پوشه', 'کارت', 'ورود', 'پیست']) ok(`${l} off`, await tool(l).isDisabled())
  ok('undo off', await undoBtn().isDisabled())
  release()
  await toastSays('کارت وارد شد')
  await page.unroute('**/api/cards/import')
  ok('on again', await tool('پوشه').isEnabled())
})
test('I17', 'card names: the front, spaces collapsed, at most 80 letters; the same front twice gets a number', async () => {
  const long = 'x'.repeat(100)
  await open()
  await importFile('a.txt', `two   words\tm\nsame\t1\nsame\t2\n${long}\tm\n`)
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  eq('names', await tileNames(), ['two words', 'same', 'same ۲', 'x'.repeat(80)])
})

// ---------- L: a folder's daily limit of new cards
async function limitOf(name: string) {
  await menu(name)
  await menuBox().getByRole('button', { name: /کارت جدید در روز/ }).click()
  await limitBox().waitFor()
}
test('L1', 'a folder without a limit: «بدون سقف» chosen, no number', async () => {
  await api.node(null, 'الف')
  await open()
  await limitOf('الف')
  eq('checked', await limitBox().getByRole('radio', { name: 'بدون سقف' }).getAttribute('aria-checked'), 'true')
  eq('stepper', await limitBox().locator('.stepper').count(), 0)
})
test('L2', 'a folder with a limit: «سقف روزانه» with its number', async () => {
  const a = await api.node(null, 'الف')
  await api.limit(a.id, 35)
  await open()
  await limitOf('الف')
  eq('checked', await limitBox().getByRole('radio', { name: 'سقف روزانه' }).getAttribute('aria-checked'), 'true')
  eq('value', await limitBox().locator('.stepper b').innerText(), '۳۵')
})
test('L3', 'switching off and on keeps the number chosen', async () => {
  await api.node(null, 'الف')
  await open()
  await limitOf('الف')
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  eq('default 20', await limitBox().locator('.stepper b').innerText(), '۲۰')
  await limitBox().getByRole('button', { name: 'بیشتر' }).click()
  await limitBox().getByRole('radio', { name: 'بدون سقف' }).click()
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  eq('kept', await limitBox().locator('.stepper b').innerText(), '۲۵')
})
test('L4', 'the number: by 5 above 10, one at a time below, 1 … 500', async () => {
  await api.node(null, 'الف')
  await open()
  await limitOf('الف')
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  const minus = limitBox().getByRole('button', { name: 'کمتر' })
  for (let i = 0; i < 2; i++) await minus.click()
  eq('10', await limitBox().locator('.stepper b').innerText(), '۱۰')
  await minus.click()
  eq('9', await limitBox().locator('.stepper b').innerText(), '۹')
  for (let i = 0; i < 20; i++) await minus.click()
  eq('1', await limitBox().locator('.stepper b').innerText(), '۱')
  for (let i = 0; i < 120; i++) await limitBox().getByRole('button', { name: 'بیشتر' }).click()
  eq('500', await limitBox().locator('.stepper b').innerText(), '۵۰۰')
})
test('L5', 'save: Anki has the limit, the menu shows it; «بدون سقف» removes it; each is one undo step', async () => {
  await api.node(null, 'الف')
  await open()
  await limitOf('الف')
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  await limitBox().getByRole('button', { name: 'ذخیره' }).click()
  await until('server 20', async () => (await nodeNamed('الف'))?.newLimit === 20)
  await menu('الف')
  ok('label', await menuBtn('کارت جدید در روز: ۲۰').isVisible())
  await menuBtn('کارت جدید در روز: ۲۰').click()
  await limitBox().getByRole('radio', { name: 'بدون سقف' }).click()
  await limitBox().getByRole('button', { name: 'ذخیره' }).click()
  await until('server none', async () => !(await nodeNamed('الف'))?.newLimit)
  await undoBtn().click()
  await until('undo → 20', async () => (await nodeNamed('الف'))?.newLimit === 20)
})
test('L5b', 'a limit holds back new cards: only that many are ready today', async () => {
  const a = await api.import(null, 'لغات', ['a', 'b', 'c', 'd', 'e'], null)
  await open()
  await limitOf('لغات')
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  for (let i = 0; i < 10; i++) await limitBox().getByRole('button', { name: 'کمتر' }).click() // 20 → 15 → 10 → 9 … → 2
  await limitBox().getByRole('button', { name: 'ذخیره' }).click()
  await until('2 ready', async () => (await http<{ cards: (C & { ready: boolean })[] }>('/api/snapshot')).cards.filter((c) => c.folderId === a.id && c.ready).length === 2)
})
test('L6', 'the limit dialog closes with «انصراف», Escape, a tap outside and back: nothing saved', async () => {
  await api.node(null, 'الف')
  await open()
  for (const how of ['cancel', 'escape', 'outside', 'back']) {
    await limitOf('الف')
    await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
    if (how === 'cancel') await limitBox().getByRole('button', { name: 'انصراف' }).click()
    if (how === 'escape') await page.keyboard.press('Escape')
    if (how === 'outside') await page.mouse.click(3, 3)
    if (how === 'back') eq('back used', await back(), true)
    await until(`closed by ${how}`, async () => (await limitBox().count()) === 0)
  }
  ok('no limit', !(await nodeNamed('الف'))?.newLimit)
})
test('L7', 'Anki refuses the limit: a message', async () => {
  await api.node(null, 'الف')
  await open()
  await limitOf('الف')
  await limitBox().getByRole('radio', { name: 'سقف روزانه' }).click()
  await failing('**/api/node/limit', async () => {
    await limitBox().getByRole('button', { name: 'ذخیره' }).click()
    await toastSays('تغییر انجام نشد')
  })
})

// ---------- N: no server
test('N1', 'no server: creating a folder or a card says so', async () => {
  await open()
  await failing('**/api/node', async () => {
    await tool('پوشه').click()
    await toastSays('ساخت پوشه انجام نشد')
  }, 'offline')
  await failing('**/api/card', async () => {
    await tool('کارت').click()
    await toastSays('ساخت کارت انجام نشد')
  }, 'offline')
  eq('nothing made', await page.locator('.item-card').count(), 0)
  eq('no rename box', await renameInput().count(), 0)
})
test('N2', 'no server: paste and undo say so', async () => {
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کپی')
  await make('پوشه', 'x')
  await failing('**/api/copy', () => paste().then(() => toastSays('چسباندن انجام نشد')), 'offline')
  await failing('**/api/undo', () => undoBtn().click().then(() => toastSays('برگرداندن انجام نشد')), 'offline')
})

// ---------- B: the back button (Android asks window.yadavarBack(); a browser sends popstate)
test('B1', 'at home: back is left to Android (the app goes away)', async () => {
  await open()
  eq('used', await back(), false)
})
test('B2', 'in a folder: back goes one folder up, each press, then is left to Android at home', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await api.node(b.id, 'پ')
  await open()
  await enter('الف', 'ب', 'پ')
  eq('1', await back(), true)
  eq('crumbs 1', await crumbs(), ['خانه', 'الف', 'ب'])
  eq('2', await back(), true)
  eq('3', await back(), true)
  eq('home', await crumbs(), ['خانه'])
  eq('4', await back(), false)
})
test('B3', 'back with the ⋮ menu open closes the menu only', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await menu('یک')
  eq('used', await back(), true)
  eq('menu closed', await menuBox().count(), 0)
  eq('same folder', await crumbs(), ['خانه', 'الف'])
})
test('B4', 'back with the card editor open closes the editor (the card is kept), the folder stays', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await tile('یک').click()
  await editor().waitFor()
  eq('used', await back(), true)
  await until('editor closed', async () => (await editor().count()) === 0)
  eq('same folder', await crumbs(), ['خانه', 'الف'])
})
test('B5', 'back while selecting: one folder up, the selection gone', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await longPress(tile('یک'))
  eq('used', await back(), true)
  eq('home', await crumbs(), ['خانه'])
  await enter('الف')
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('B6', 'back while renaming: the name is kept, one folder up', async () => {
  const a = await api.node(null, 'الف')
  await api.card(a.id, 'یک')
  await open()
  await enter('الف')
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('دو')
  eq('used', await back(), true)
  eq('home', await crumbs(), ['خانه'])
  await until('saved', async () => (await cardsIn(a.id))[0]?.name === 'دو', 5000)
})
test('B7', 'a browser on the phone: the back gesture goes one folder up and does not leave the app', async () => {
  const a = await api.node(null, 'الف')
  await api.node(a.id, 'ب')
  await open()
  await enter('الف', 'ب')
  await page.goBack()
  await until('up one', async () => JSON.stringify(await crumbs()) === JSON.stringify(['خانه', 'الف']))
  await page.goBack()
  await until('home', async () => JSON.stringify(await crumbs()) === JSON.stringify(['خانه']))
  ok('still the app', page.url().startsWith(base.url))
})

// ---------- X: states combined
test('X3', 'selection + paste: a paste that works clears it, a refused one keeps it', async () => {
  const a = await api.node(null, 'الف')
  await api.node(a.id, 'ب')
  await api.card(null, 'یک')
  await open()
  await clip(['الف'], 'کات')
  await enter('الف')
  await longPress(tile('ب'))
  await paste()
  await toastSays('داخل خودش')
  eq('kept', await page.locator('.item-card.sel').count(), 1)
})
test('X4', 'selection + new folder: the selection stays, the new folder is being named, long press is off meanwhile', async () => {
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  await tool('پوشه').click()
  await renameInput().waitFor()
  eq('selected', await page.locator('.item-card.sel').count(), 1)
  await renameInput().press('Enter')
})
test('X5', 'selection + import: you are taken into the new folder, nothing selected there or back home', async () => {
  await api.card(null, 'یک')
  await open()
  await longPress(tile('یک'))
  await importFile('a.txt', 'a\tb\n')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  await page.locator('.path-bar .crumb').first().click()
  eq('selected', await page.locator('.item-card.sel').count(), 0)
})
test('X6', 'selection + undo that removes a selected item: only what still exists stays selected', async () => {
  await api.card(null, 'یک')
  await open()
  await make('پوشه', 'تازه')
  await until('undo on', () => undoBtn().isEnabled())
  await longPress(tile('یک'))
  await tile('تازه').click()
  await undoBtn().click() // the rename
  await undoBtn().click() // the creation: "پوشه جدید" goes away
  await until('gone', async () => (await tileNames()).join() === 'یک')
  await menu('یک')
  eq('menu for one item', await menuBox().locator('h3').innerText(), 'یک')
})
test('X9', 'clipboard + undo: undo empties the clipboard', async () => {
  await api.card(null, 'یک')
  await open()
  await make('پوشه', 'x')
  await clip(['یک'], 'کپی')
  await undoBtn().click()
  await until('paste gone', async () => (await tool('پیست').count()) === 0)
})
test('X11', 'clipboard + another tab: still there when you come back', async () => {
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کپی')
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  ok('paste', await tool('پیست').isVisible())
})
test('X13', 'renaming + another tab: the name typed is kept', async () => {
  await api.card(null, 'یک')
  await open()
  await menu('یک')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('دو')
  await page.getByRole('button', { name: /مرورها/ }).first().click()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  eq('kept', await tileNames(), ['دو'])
})
test('X15', 'renaming + coming back to the app (a refresh from Anki): the text typed survives', async () => {
  await api.node(null, 'الف')
  await open()
  await menu('الف')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('ب')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await sleep(600)
  await renameInput().press('Enter')
  await until('server', async () => !!(await nodeNamed('ب')))
  eq('tile', await tileNames(), ['ب'])
})
test('X22', 'import three levels down: the new folder goes there, the path one deeper', async () => {
  const a = await api.node(null, 'الف')
  const b = await api.node(a.id, 'ب')
  await open()
  await enter('الف', 'ب')
  await importFile('لغات.txt', 'a\tb\n')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  eq('path', await crumbs(), ['خانه', 'الف', 'ب', 'لغات'])
  eq('parent', (await nodeNamed('لغات'))?.parentId, b.id)
})
test('X24', 'renaming in a long list, then scrolling it out of sight: the name typed is kept', async () => {
  await api.import(null, 'بزرگ', Array.from({ length: 600 }, (_, i) => `w${i}`), null)
  await open()
  await enter('بزرگ')
  await menu('w0')
  await menuBtn('تغییر نام').click()
  await renameInput().fill('اول')
  await scrollList('end')
  await sleep(400)
  await scrollList('top')
  await sleep(400)
  await until('kept', async () => (await tileNames()).includes('اول'))
})
test('X25', 'cut a folder, rename it, paste elsewhere: moved with its new name', async () => {
  await api.node(null, 'الف')
  await api.node(null, 'مقصد')
  await open()
  await clip(['الف'], 'کات')
  await rename('الف', 'ب')
  await enter('مقصد')
  await paste()
  await toastSays('انجام شد')
  eq('tile', await tileNames(), ['ب'])
})
test('X26', 'cut a card, make one of the same name at the target, paste: numbered', async () => {
  await api.node(null, 'مقصد')
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کات')
  await enter('مقصد')
  await make('کارت', 'یک')
  await paste()
  await toastSays('انجام شد')
  eq('names (the card moved in is older, so first, and gets the number)', await tileNames(), ['یک ۲', 'یک'])
})
test('X27', 'paste then undo: everything back where it was; redo: pasted again', async () => {
  const a = await api.node(null, 'الف')
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کات')
  await enter('الف')
  await paste()
  await toastSays('انجام شد')
  await undoBtn().click()
  await until('back home', async () => (await cardsIn(null)).length === 1)
  await redoBtn().click()
  await until('in الف again', async () => (await cardsIn(a.id)).length === 1)
})
test('X28', 'import while something is copied: the clipboard stays and still pastes', async () => {
  await api.card(null, 'یک')
  await open()
  await clip(['یک'], 'کپی')
  await importFile('a.txt', 'a\tb\n')
  await importBox().getByRole('button', { name: 'وارد کن' }).click()
  await toastSays('کارت وارد شد')
  await paste()
  await toastSays('انجام شد')
  ok('copy in the new folder', (await tileNames()).includes('یک'))
})
test('X29', 'rename then undo at once: the old name back', async () => {
  await api.node(null, 'الف')
  await open()
  await make('پوشه', 'x') // something on the undo stack first
  await rename('الف', 'ب')
  await until('undo on', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('old name', async () => !!(await nodeNamed('الف')))
  eq('tile', (await tileNames()).includes('الف'), true)
})
test('X30', 'delete then undo then redo: deleted again', async () => {
  await api.card(null, 'یک')
  await open()
  await menu('یک')
  await menuBtn('حذف').click()
  await confirmBox().getByRole('button', { name: 'حذف' }).click()
  await until('undo on', () => undoBtn().isEnabled())
  await undoBtn().click()
  await until('back', async () => (await tileNames()).includes('یک'))
  await redoBtn().click()
  await until('gone again', async () => (await cardsIn(null)).length === 0)
})

// ---------- K: «کارت ثابت و محدود» and «خط‌دار بودن» (settings) for the cards made from then on
const setCards = (o: { fixedCards?: boolean; ruledCards?: boolean }) => http('/api/settings', { theme: 'dark', fontScale: 1, newPerDay: 20, reviewsPerDay: 200, retention: 0.9, ...o })
const layoutOf = async (name: string) => {
  const c = (await api.snap()).cards.find((x) => x.name === name)!
  return (await http<{ layout?: { fixed?: { w: number; h: number }; lines?: boolean; crops?: unknown } }>('/api/cardfull', { id: c.id })).layout ?? null
}
const activeSide = () => editor().locator('.note-card.active')
async function closeEditor() {
  await editor().locator('.act.done').click()
  await until('editor closed', async () => (await editor().count()) === 0)
}

test('K1', 'the two switches: saved in Anki, still so after the app opens again', async () => {
  await page.goto(base.url, { timeout: 60_000 })
  await page.getByRole('button', { name: /تنظیمات/ }).first().click()
  const fixed = page.getByRole('switch', { name: 'کارت ثابت و محدود' })
  const lines = page.getByRole('switch', { name: 'خط‌دار بودن' })
  eq('defaults', [await fixed.getAttribute('aria-checked'), await lines.getAttribute('aria-checked')], ['false', 'true'])
  await fixed.click()
  await lines.click()
  await until('saved', async () => {
    const s = (await http<{ settings: { fixedCards?: boolean; ruledCards?: boolean } }>('/api/snapshot')).settings
    return s.fixedCards === true && s.ruledCards === false
  })
  await page.reload()
  await page.getByRole('button', { name: /تنظیمات/ }).first().click()
  eq('after reload', [await fixed.getAttribute('aria-checked'), await lines.getAttribute('aria-checked')], ['true', 'false'])
})
test('K2', 'fixed on: a new card is one page of the fixed size that does not move; things stay on it', async () => {
  await setCards({ fixedCards: true })
  await open()
  await make('کارت', 'ثابت')
  eq('saved as fixed', (await layoutOf('ثابت'))?.fixed, { w: 360, h: 480 })
  await tile('ثابت').click()
  await editor().waitFor()
  const pageEl = activeSide().locator('.page')
  await pageEl.waitFor()
  ok('ruled', await pageEl.evaluate((e) => e.classList.contains('lined')))
  const at = (await pageEl.boundingBox())!
  ok(`whole page in view: ${at.width}×${at.height}`, at.y >= 0 && at.y + at.height <= 844 && Math.abs(at.width / at.height - 360 / 480) < 0.01)
  // dragging the empty page or the wheel does not move it
  await page.mouse.move(at.x + at.width / 2, at.y + 40)
  await page.mouse.down()
  await page.mouse.move(at.x + at.width / 2 - 120, at.y + 200, { steps: 5 })
  await page.mouse.up()
  await page.mouse.wheel(0, -400)
  eq('page still', await pageEl.boundingBox(), at)
  eq('no ⤢', await editor().getByRole('button', { name: 'نمایش همه' }).count(), 0)
  // a text dragged far past the edge stays on the page
  await editor().locator('.tool.text').click()
  await page.keyboard.type('سلام')
  await activeSide().locator(':scope > .frame').click({ position: { x: at.width / 2, y: 30 } })
  const w = activeSide().locator('.widget').first()
  const b = (await w.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x - 400, b.y + 900, { steps: 8 })
  await page.mouse.up()
  const b2 = (await w.boundingBox())!
  const p2 = (await pageEl.boundingBox())!
  ok(`inside: ${JSON.stringify(b2)} in ${JSON.stringify(p2)}`, b2.x >= p2.x - 1 && b2.y + b2.height <= p2.y + p2.height + 1 && b2.x + b2.width <= p2.x + p2.width + 1)
  await closeEditor()
  eq('review shows the whole page', ((await layoutOf('ثابت')) as { crops: unknown }).crops, { front: { l: 0, t: 0, r: 360, b: 480 }, back: { l: 0, t: 0, r: 360, b: 480 } })
})
test('K3', 'lines off: new cards have no ruled lines (endless and fixed alike); on again: lined', async () => {
  await setCards({ ruledCards: false })
  await open()
  await make('کارت', 'بی‌خط')
  eq('saved', (await layoutOf('بی‌خط'))?.lines, false)
  await tile('بی‌خط').click()
  await editor().waitFor()
  await activeSide().locator(':scope > .frame').waitFor()
  eq('no lines', await activeSide().locator('.rules').count(), 0)
  await closeEditor()
  await setCards({ ruledCards: true })
  await page.reload()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await make('کارت', 'خط‌دار')
  eq('nothing special saved', await layoutOf('خط‌دار'), null)
  await tile('خط‌دار').click()
  await editor().waitFor()
  eq('lines', await activeSide().locator('.rules').count(), 1)
})
test('K4', 'cards made before keep how they were made when the settings change', async () => {
  await api.card(null, 'قدیمی')
  await setCards({ fixedCards: true, ruledCards: false })
  await open()
  await make('کارت', 'تازه')
  await setCards({})
  await page.reload()
  await page.getByRole('button', { name: /اطلاعات/ }).first().click()
  await tile('قدیمی').click()
  await editor().waitFor()
  await activeSide().locator(':scope > .frame').waitFor()
  eq('old: endless', await activeSide().locator('.page').count(), 0)
  await closeEditor()
  await tile('تازه').click()
  await editor().waitFor()
  await activeSide().locator('.page').waitFor()
  ok('new: fixed, no lines', !(await activeSide().locator('.page').evaluate((e) => e.classList.contains('lined'))))
})
test('K5', 'fixed on: imported cards are fixed too, their text inside the page', async () => {
  await setCards({ fixedCards: true })
  await open()
  await importFile('words.txt', 'a really quite long English sentence that would be wider than the page\tپاسخ')
  await importBox().getByRole('button', { name: /وارد کن/ }).click()
  await importBox().waitFor({ state: 'detached' })
  await until('imported', async () => (await api.snap()).cards.length === 1)
  const c = (await api.snap()).cards[0]
  const full = await http<{ layout?: { fixed?: unknown }; front: { widgets: { x: number; y: number; w: number; h: number }[] } }>('/api/cardfull', { id: c.id })
  eq('fixed', full.layout?.fixed, { w: 360, h: 480 })
  const w = full.front.widgets[0]
  ok(`inside: ${JSON.stringify(w)}`, w.x >= 0 && w.y >= 0 && w.x + w.w <= 360 && w.y + w.h <= 480)
})

// ------------------------------------------------------------------ run
async function main() {
  const data = mkdtempSync(join(tmpdir(), 'yadavar-info-'))
  const port = await freePort()
  API = `http://127.0.0.1:${port}`
  const py = process.env.YADAVAR_PY ?? join(SERVER, '.venv', 'Scripts', 'python.exe')
  const server: ChildProcess = spawn(py, ['-u', join(SERVER, 'server.py')], {
    env: { ...process.env, YADAVAR_DATA: data, YADAVAR_PORT: String(port) },
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
    let browser
    try {
      browser = await chromium.launch({ channel: 'msedge' })
    } catch {
      browser = await chromium.launch({ channel: 'chrome' })
    }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fa-IR' })
    page = await ctx.newPage()
    page.setDefaultTimeout(6000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    const chosen = tests.filter((t) => !only.length || only.some((o) => t.id === o || t.id.replace(/\d.*$/, '') === o))
    let failed = 0
    const t0 = Date.now()
    for (const t of chosen) {
      await api.reset()
      await setCards({}) // (reset keeps the settings: a K test must not leave fixed / unruled cards behind)
      errors.length = 0
      const started = Date.now()
      try {
        await t.fn()
        if (errors.length) throw new Error('page error: ' + errors.join(' | '))
        console.log(`PASS  ${t.id.padEnd(5)} ${t.name}`)
      } catch (e) {
        failed++
        console.log(`FAIL  ${t.id.padEnd(5)} ${t.name}\n        ${(e as Error).message.split('\n')[0]}`)
      } finally {
        if (Date.now() - started > 20_000) console.log(`      (${Math.round((Date.now() - started) / 1000)} s)`)
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        page.removeAllListeners('request')
      }
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
