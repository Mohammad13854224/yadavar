// Screenshots for the repository's front page (.github/assets): a throw-away collection with a few folders and cards
// studied over some days, the app from Vite, a phone-sized browser.
//   npx tsx tools/shots.ts
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const SERVER = resolve(ROOT, '..', 'ankio-server')
const OUT = resolve(ROOT, '..', '.github', 'assets')
const DAY = 86400
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise<number>((res) => {
    const s = netServer()
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
  })

let API = ''
async function http<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}
// a fixed, unruled page (360 × 480) with the text in its middle, the way a card looks made under those settings
const PAGE = { w: 360, h: 480 }
let wid = 0
const textW = (t: string) => Math.min(320, 40 + t.length * 15)
const side = (text: string) => ({
  html: '',
  widgets: [{ id: 'w' + ++wid, kind: 'text', mediaId: '', x: 180 - textW(text) / 2, y: 210, w: textW(text), h: 60, rot: 0, html: text }],
})
const layout = { v: 2, stageW: 0, front: { x: 0, y: 0, ...PAGE }, back: { x: 0, y: 0, ...PAGE }, crops: { front: null, back: null }, fixed: { ...PAGE }, lines: false }
const node = (parentId: string | null, name: string) => http<{ id: string }>('/api/node', { parentId, name })
const card = (folderId: string | null, front: string, back: string) => http<{ id: string }>('/api/card', { folderId, name: front, front: side(front), back: side(back), layout })
const grade = (ids: string[], rating: number) => http('/api/test/grade', { ids, rating })
const shift = (seconds: number) => http('/api/test/shift', { seconds })

async function seed() {
  const en = await node(null, 'زبان انگلیسی')
  const words = await node(en.id, 'لغات روزمره')
  const verbs = await node(en.id, 'فعل‌ها')
  const hist = await node(null, 'تاریخ')
  const bio = await node(null, 'زیست‌شناسی')
  const sets: [string, [string, string][]][] = [
    [words.id, [['apple', 'سیب'], ['window', 'پنجره'], ['river', 'رود'], ['bridge', 'پل'], ['cloud', 'ابر'], ['market', 'بازار'], ['garden', 'باغ'], ['mirror', 'آینه'], ['honey', 'عسل'], ['island', 'جزیره']]],
    [verbs.id, [['to borrow', 'قرض گرفتن'], ['to forgive', 'بخشیدن'], ['to whisper', 'زمزمه کردن'], ['to wander', 'پرسه زدن'], ['to gather', 'جمع کردن'], ['to measure', 'اندازه گرفتن']]],
    [hist.id, [['کورش بزرگ', 'بنیان‌گذار هخامنشیان'], ['تخت جمشید', 'پارسه، ۵۱۸ پ.م'], ['جاده‌ی ابریشم', 'راه بازرگانی شرق و غرب'], ['نهضت ترجمه', 'بغداد، سده‌ی سوم'], ['ابن سینا', 'قانون در طب'], ['خیام', 'ریاضی‌دان و شاعر']]],
    [bio.id, [['نورون', 'یاخته‌ی عصبی'], ['سیناپس', 'محل اتصال دو نورون'], ['میلین', 'غلاف آکسون'], ['هیپوکامپ', 'حافظه‌ی رویدادی'], ['دندریت', 'شاخه‌ی دریافت پیام'], ['میتوکندری', 'نیروگاه یاخته']]],
  ]
  const all: string[][] = []
  for (const [f, list] of sets) {
    const ids: string[] = []
    for (const [a, b] of list) ids.push((await card(f, a, b)).id)
    all.push(ids)
  }
  // a few weeks of studying: some cards well kept, some fading, some new
  const studied = all.flatMap((ids) => ids.slice(0, Math.ceil(ids.length * 0.75)))
  await grade(studied, 3)
  await shift(3 * DAY)
  await grade(studied.filter((_, i) => i % 3 !== 0), 3)
  await shift(9 * DAY)
  await grade(studied.filter((_, i) => i % 4 === 1), 3)
  await shift(5 * DAY)
}

async function shot(page: Page, name: string) {
  await sleep(600)
  await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 84, scale: 'css' }) // light for the repository's front page
  console.log('saved', name)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const data = mkdtempSync(join(tmpdir(), 'ankio-shots-'))
  const port = await freePort()
  API = `http://127.0.0.1:${port}`
  const py = process.env.ANKIO_PY ?? join(SERVER, '.venv', 'Scripts', 'python.exe')
  const server: ChildProcess = spawn(py, ['-u', join(SERVER, 'server.py')], {
    env: { ...process.env, ANKIO_DATA: data, ANKIO_PORT: String(port), ANKIO_TEST: '1' },
    stdio: 'ignore',
  })
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(API + '/api/fsrs')).ok) break
      } catch {
        /* not up yet */
      }
      await sleep(500)
    }
    await http('/api/test/wipe', {})
    await seed()
    process.env.ANKIO_API = API
    const { createServer } = await import('vite')
    const vite = await createServer({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), server: { port: await freePort(), strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
    await vite.listen()
    const url = `http://127.0.0.1:${vite.config.server.port}/`
    const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] }).catch(() => chromium.launch({ channel: 'chrome' }))
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
    await page.goto(url)
    await page.locator('.risk').waitFor()
    await sleep(1500)
    await shot(page, 'reviews')

    // a review: the back of a card, a grade chosen
    await page.locator('.rem-card').first().click().catch(() => {})
    await page.locator('.session').waitFor({ timeout: 8000 }).catch(() => {})
    if (await page.locator('.session .flip').count()) {
      await sleep(800)
      await page.locator('.session .flip').click({ position: { x: 30, y: 30 } })
      await sleep(900)
      await page.locator('.grade.good').click()
      await shot(page, 'review')
      await page.locator('[aria-label="خروج از مرور"]').click()
      await page.locator('.session').waitFor({ state: 'detached' })
      await sleep(800)
    }

    // the brain
    await page.locator('[data-value]').first().click({ force: true })
    await page.locator('.brain canvas').waitFor()
    await sleep(5000)
    await shot(page, 'brain')
    // a weak neuron up close
    const weakest = page.getByRole('button', { name: 'ضعیف‌ترین نرون' })
    if (await weakest.count()) {
      await weakest.click()
      await sleep(3500)
      await shot(page, 'neuron')
    }
    await page.locator('.brain header [aria-label="بستن"]').click()
    await page.locator('.brain').waitFor({ state: 'detached' })
    await sleep(600)

    // the folders
    await page.getByRole('button', { name: /اطلاعات/ }).first().click()
    await sleep(1200)
    await shot(page, 'folders')

    await browser.close()
    await vite.close()
  } finally {
    try {
      execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: 'ignore' })
    } catch {
      server.kill()
    }
    await sleep(300)
    try {
      rmSync(data, { recursive: true, force: true })
    } catch {
      /* cleaned by Windows later */
    }
  }
}

main()
