// Runs the on-device TypeScript engine against the unmodified Anki backend (Python wheel) through a stdin/stdout bridge.
//   npx tsx tools/engine-test.ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnkiEngine } from '../src/lib/engine/ankiEngine'
import { decodeBackendError, type Transport } from '../src/lib/engine/rpc'

const py = process.env.YADAVAR_PY ?? join('..', 'yadavar-server', '.venv', 'Scripts', 'python.exe')
const dir = mkdtempSync(join(tmpdir(), 'yadavar-engine-'))
const child = spawn(py, ['-I', join('..', 'yadavar-server', 'rpc_bridge.py'), join(dir, 'c.anki2')], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: child.stdout })
const waiting: ((l: string) => void)[] = []
const buffered: string[] = []
lines.on('line', (l) => (waiting.length ? waiting.shift()!(l) : buffered.push(l)))
const nextLine = () => new Promise<string>((res) => (buffered.length ? res(buffered.shift()!) : waiting.push(res)))

const transport: Transport = {
  async run(s, m, data) {
    child.stdin.write(`${s} ${m} ${Buffer.from(data).toString('base64')}\n`)
    const l = await nextLine()
    const [kind, b64] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    if (kind === 'err') throw decodeBackendError(bytes)
    return bytes
  },
}


const N = Number(process.env.N ?? 10000)
const FILES = Number(process.env.FILES ?? 1)
const t = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const s0 = performance.now()
  const r = await fn()
  console.log(`${name.padEnd(46)} ${(performance.now() - s0).toFixed(0).padStart(7)} ms`)
  return r
}

async function main() {
  await nextLine()
  const media = { add: async (n: string) => n, url: (n: string) => `media/${n}` }
  const e = new AnkiEngine(transport, media)
  await e.snapshot()
  const folder = await e.createNode(null, 'big')
  const files = []
  for (let i = 0; i < FILES; i++) files.push(await e.createNode(folder.id, 'f' + i))
  const lines = Array.from({ length: 6 }, (_, i) => `<div dir="rtl">خط شماره ${i} از متن نمونه برای کارت</div>`).join('')
  const widgets = [{ id: 'w', kind: 'image', mediaId: 'a.png', x: 10, y: 10, w: 120, h: 80 }]
  await t(`create ${N} cards (one RPC each)`, async () => {
    for (let i = 0; i < N; i++) await e.createCard(files[i % FILES].id, 'card ' + i, { html: lines, widgets }, { html: lines, widgets })
  })
  const snap = await t('snapshot (nodes + all cards + revlog)', () => e.snapshot())
  console.log('   snapshot JSON size', (JSON.stringify(snap).length / 1e6).toFixed(1), 'MB')
  await t('snapshot again', () => e.snapshot())
  await t('next card of a file', () => e.next(files[0].id))
  await t('copy folder (deep, ' + N + ' cards)', () => e.copyItems([folder.id], [], null))
  await t('undo that paste', () => e.undo())
  await t('redo', () => e.redo())
  await t('cut: move folder into itself-free target', async () => {
    const dest = await e.createNode(null, 'dest')
    await e.moveItems([folder.id], [], dest.id)
  })
  await t('undo move', () => e.undo())
  await t('delete folder (' + N + ' cards)', () => e.deleteItems([folder.id], []))
  await t('undo delete', () => e.undo())
  await t('stats', () => e.stats())
}
main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => { child.stdin.write('quit' + String.fromCharCode(10)); setTimeout(() => process.exit(), 300) })
