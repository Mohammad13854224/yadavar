// The phone-engine half of yadavar-server/verify.py (run by it): studies the same days on its own copy of the collection
// through src/lib/engine/ankiEngine.ts — the code the phone app runs — on the unmodified Anki backend, and writes what
// it saw and the state after every day to a JSON file that verify.py compares with Anki's own reviewer.
//   npx tsx tools/verify-engine.ts <collection.anki2> <days> <skipped days, comma separated> <out.json>
import { spawn } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AnkiEngine } from '../src/lib/engine/ankiEngine'
import { decodeBackendError, type Transport } from '../src/lib/engine/rpc'

const [colPath, daysArg, skippedArg, outPath] = process.argv.slice(2)
const DAYS = Number(daysArg)
const SKIPPED = new Set((skippedArg ?? '').split(',').filter(Boolean).map(Number))
const MS = 5000
const py = process.env.YADAVAR_PY ?? join('..', 'yadavar-server', '.venv', 'Scripts', 'python.exe')

/** the same answers as verify.py */
const rating = (cid: number, day: number, reps: number) => {
  const h = ((cid % 1000003) * 31 + day * 17 + reps * 7) % 100
  return h < 10 ? 1 : h < 20 ? 2 : h < 88 ? 3 : 4
}

function openBridge(path: string) {
  const child = spawn(py, ['-I', join('..', 'yadavar-server', 'rpc_bridge.py'), path], { stdio: ['pipe', 'pipe', 'inherit'] })
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
  return {
    transport,
    ready: nextLine(),
    quit: () =>
      new Promise<void>((res) => {
        child.on('exit', () => res())
        child.stdin.write('quit\n')
      }),
  }
}

type Row = unknown[]
async function main() {
  const out: unknown[] = []
  let switched = false
  for (let day = 0; day < DAYS; day++) {
    const b = openBridge(colPath)
    await b.ready
    const e = new AnkiEngine(b.transport, { add: async (n) => n, url: (n) => n })
    await e.init()
    const sql = async (q: string, args: unknown[] = []) =>
      ((await e.rpc.json('runDbCommand', { kind: 'query', sql: q, args, first_row_only: false })) as Row[]) ?? []

    let shown: string[] = []
    let due: string[] = []
    let wrongFolder = 0
    let leftAfter = 0
    const rounds: [number, number][][] = []
    if (!SKIPPED.has(day)) {
      const snap = await e.snapshot()
      shown = snap.cards.filter((c) => c.ready).map((c) => c.id)
      // what Anki itself would ask for today, folder by folder
      const decks = (await e.rpc.call('getDeckNames', { skipEmptyDefault: false, includeFiltered: false })).entries ?? []
      const set = new Set<string>()
      for (const d of decks) {
        await e.rpc.call('setCurrentDeck', { did: Number(d.id) })
        const q = await e.rpc.call('getQueuedCards', { fetchLimit: 100000, intradayLearningOnly: false })
        for (const c of q.cards ?? []) set.add(String(c.card.id))
      }
      due = [...set]
      const folders: (string | null)[] = [null, ...snap.nodes.map((n) => n.id)]
      for (let round = 0; round < 8; round++) {
        if (round) await sql('update cards set due = due - 3600 where queue = 1') // an hour later
        const answers: [number, number][] = []
        for (const f of folders) {
          for (;;) {
            const r = await e.next(f)
            if (!r.card) break
            if (r.card.folderId !== f) wrongFolder++
            const rate = rating(Number(r.card.id), day, r.card.reps)
            await e.answer(r.card.id, rate, MS)
            answers.push([Number(r.card.id), rate])
          }
        }
        rounds.push(answers)
        if (!Number((await sql('select count() from cards where queue = 1'))[0][0])) break
      }
      leftAfter = (await e.snapshot()).cards.filter((c) => c.ready).length
    }
    // the app checks FSRS after every review session
    const fs = await e.fsrsCheck()

    const cards: Record<string, unknown> = {}
    for (const r of await sql('select id, did, odid, type, queue, due, ivl, factor, reps, lapses, left, data from cards order by id')) {
      const [id, did, odid, type, queue, dueV, ivl, factor, reps, lapses, left, data] = r
      cards[String(id)] = { did, odid, type, queue, due: dueV, ivl, factor, reps, lapses, left, data: data ?? '' }
    }
    const revlog: Record<string, unknown[]> = {}
    for (const r of await sql('select cid, ease, ivl, lastIvl, factor, type from revlog order by id')) {
      ;(revlog[String(r[0])] ??= []).push(r.slice(1))
    }
    out.push({ day, rounds, shown, due, wrongFolder, leftAfter, fsrs: fs.enabled, reviews: fs.reviews, state: { cards, revlog } })

    // the next day: the calendar moves on, and everything so far moves a day into the past (as in verify.py)
    await sql('update col set crt = crt - 86400')
    await sql('update revlog set id = id - 86400000')
    await sql("update cards set data = json_set(data, '$.lrt', json_extract(data, '$.lrt') - 86400) where json_extract(data, '$.lrt') is not null")
    await b.quit()
    // the collection as it is right after FSRS was switched on: verify.py replays the days after it with Anki itself
    if (fs.enabled && !switched) {
      switched = true
      copyFileSync(colPath, colPath.replace(/\.anki2$/, '-fsrs.anki2'))
    }
  }
  writeFileSync(outPath, JSON.stringify(out))
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
