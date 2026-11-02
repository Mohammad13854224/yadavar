// Runs the on-device TypeScript engine against the unmodified Anki backend (Python wheel) through a stdin/stdout bridge.
//   npx tsx tools/engine-test.ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnkiEngine, recallNow } from '../src/lib/engine/ankiEngine'
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

let failed = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(extra)}`)
  if (!ok) failed++
}

async function main() {
  await nextLine() // "ready"
  const media = { add: async (n: string) => n, url: (n: string) => `media/${n}` }
  const e = new AnkiEngine(transport, media)

  let snap = await e.snapshot()
  check('empty snapshot', snap.nodes.length === 0 && snap.cards.length === 0, snap)

  const folder = await e.createNode(null, 'زبان')
  const file = await e.createNode(folder.id, 'لغات')
  check('nested nodes', file.parentId === folder.id, file)
  const sd = { html: '<div dir="ltr">hello</div>', widgets: [] }
  const card = await e.createCard(file.id, 'کارت ۱', sd, { html: '<div dir="rtl">سلام</div>', widgets: [{ id: 'w1', kind: 'image', mediaId: 'a.png', x: 1, y: 2, w: 3, h: 4 }] })
  check('card is new + ready', card.state === 'new' && card.ready, card)
  snap = await e.snapshot()
  const full = await e.cardFull(card.id)
  check('snapshot is light (name + schedule only)', snap.cards.length === 1 && snap.cards[0].light === true && snap.cards[0].name === 'کارت ۱', snap.cards)
  check('cardFull has pages + widgets', full.back.widgets[0].mediaId === 'a.png' && full.front.html.includes('hello') && !full.light, full)
  const flds = (await e.rpc.json('runDbCommand', { kind: 'query', sql: 'select flds from notes', args: [], first_row_only: false })) as string[][]
  check("the picture is referenced the way Anki's Check Media recognises", flds[0][0].includes("<img src='a.png'>"), flds[0][0])
  check('card sits in its folder', snap.cards[0].folderId === file.id, snap.cards[0])

  const up = await e.updateCard(card.id, { name: 'نام جدید', layout: { v: 2, stageW: 100, front: { x: 0, y: 0, w: 1, h: 1 }, back: { x: 0, y: 0, w: 1, h: 1 } } })
  check('update card', up.name === 'نام جدید' && (up.layout as { stageW: number }).stageW === 100, up)

  const n1 = await e.next(file.id)
  check('next returns the card + counts', n1.card?.id === card.id && n1.counts?.new === 1, n1)
  // "easy" is 4 days with Anki's random fuzz applied (3-5 days), the learning steps are exact
  const d = n1.delays ?? []
  // one 10-minute learning step: again 10m, hard 15m, good graduates (~1 day), easy ~4 days
  check('Anki button intervals (10m, 15m, ~1d, ~4d)', d[0] === 600000 && d[1] === 900000 && d[2] >= 86_400_000 && d[2] <= 2 * 86_400_000 && d[3] >= 3 * 86_400_000 && d[3] <= 5 * 86_400_000, d)

  const ans = await e.answer(card.id, 3, 4200)
  check('good on a new card graduates it (shown once)', ans.card.state === 'review' && ans.revlog.length === 1 && ans.revlog[0].rating === 3, ans)
  const again = await e.next(file.id)
  check('...and it is not queued again', again.card === null, again)
  const stats1 = await e.stats()
  check('stats count the review and its time', stats1.days[29].cards === 1 && stats1.today.answers === 1, stats1.days[29])
  check('stats card counts', stats1.cardCounts.young === 1, stats1.cardCounts)
  const u = await e.undo()
  const back = await e.cardInfo(card.id)
  check('undo restores the new card', u.ok && back.card?.state === 'new', back.card)
  // a card answered "again" waits for its 10 minutes (learn-ahead is 0): it must not come straight back
  const c2 = await e.createCard(file.id, 'c2', sd, sd)
  const a2 = await e.answer(c2.id, 1, 1000)
  const n2 = await e.next(file.id)
  check('"again" is not shown again immediately', a2.card.state === 'learning' && n2.card?.id !== c2.id, n2.card?.id)
  await e.deleteItems([], [c2.id])
  // the same card again the same day, not due any more: practice only (no review, the schedule stays)
  const c3 = await e.createCard(file.id, 'c3', sd, sd)
  const g3 = await e.answer(c3.id, 3, 1000)
  const i3 = await e.cardInfo(c3.id)
  const p3 = await e.answer(c3.id, 4, 1000)
  const c3after = (await e.cardInfo(c3.id)).card!
  check('a second answer the same day is practice', !!i3.practice && !!p3.practice && p3.revlog.length === 0, { i3: i3.practice, p3 })
  check('...and leaves the schedule and the reps as they were', c3after.due === g3.card.due && c3after.reps === g3.card.reps && c3after.interval === g3.card.interval, { c3after, g3: g3.card })
  check("a card in today's queue is not practice", !(await e.cardInfo(card.id)).practice)
  check("...and Anki's undo still takes back the real answer before it", (await e.undo()).ok && (await e.cardInfo(c3.id)).card!.state === 'new')
  await e.deleteItems([], [c3.id])

  await e.saveSettings({ theme: 'dark', fontScale: 1, newPerDay: 20, reviewsPerDay: 200, retention: 0.92 })
  const fs = await e.fsrs()
  check('fsrs status (off, 1 review so far)', !fs.enabled && fs.reviews === 1, fs)
  const fc = await e.fsrsCheck()
  check('fsrs check does nothing early', !fc.enabled, fc)

  await e.renameNode(file.id, 'لغات جدید')
  snap = await e.snapshot()
  check('rename keeps hierarchy', snap.nodes.find((n) => n.id === file.id)?.name === 'لغات جدید' && snap.nodes.find((n) => n.id === file.id)?.parentId === folder.id, snap.nodes)
  await e.deleteItems([folder.id], [card.id])
  snap = await e.snapshot()
  check('delete card + folder (children go too)', snap.nodes.length === 0 && snap.cards.length === 0, snap)

  // ---- FSRS switch-over with a synthetic history (150 cards, ~1000 reviews)
  const f2 = await e.createNode(null, 'fsrs')
  const ids: string[] = []
  for (let i = 0; i < 150; i++) ids.push((await e.createCard(f2.id, `c${i}`, sd, sd)).id)
  let seed = 3
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const now = Date.now()
  const day = 86_400_000
  const rows: unknown[][] = []
  const used = new Set<number>()
  for (const id of ids) {
    let t = now - Math.floor(60 + rnd() * 29) * day
    let ivl = 0
    let typ = 0
    let stab = 1
    while (t < now - day) {
      const gap = Math.max(1, Math.floor(stab * (0.8 + rnd() * 0.6)))
      const ok = rnd() < Math.pow(0.9, gap / stab)
      let tt = t
      while (used.has(tt)) tt++
      used.add(tt)
      rows.push([tt, Number(id), -1, ok ? 3 : 1, ok ? gap : -600, ivl, 2500, 5000, typ])
      stab = stab * (ok ? 2.2 : 0.4) + 0.2
      ivl = gap
      typ = 1
      t += gap * day
    }
  }
  await e.rpc.json('runDbCommand', { kind: 'executemany', sql: 'insert into revlog values (?,?,?,?,?,?,?,?,?)', args: rows })
  const before = await e.fsrs()
  check('synthetic history inserted', before.reviews === rows.length + 1 && rows.length > 900, before.reviews)
  // a check already ran today with almost as many reviews: at 900+ it must still switch on (no waiting for tomorrow)
  const { daysElapsed } = await e.rpc.call('schedTimingToday')
  await e.setConfig('ankio_fsrs_check', { day: daysElapsed ?? 0, reviews: before.reviews - 5, enabled: false })
  const after = await e.fsrsCheck()
  check('FSRS switched on at 900+ reviews (even right after a check the same day)', after.enabled && after.last?.reason?.includes('900') === true, after)
  const nx = await e.next(f2.id)
  check('scheduler still serves cards under FSRS', !!nx.card && (nx.delays?.length ?? 0) === 4, nx)

  // ---- cut / copy / paste and one-step undo / redo (Anki's own undo stack)
  const cnt = async () => {
    const sn = await e.snapshot()
    return { nodes: sn.nodes.length, cards: sn.cards.length, sn }
  }
  const base = await cnt()
  const pa = await e.createNode(null, 'مبدا')
  const pf = await e.createNode(pa.id, 'فایل')
  const pb = await e.createNode(null, 'مقصد')
  for (const n of ['x', 'y', 'z']) await e.createCard(pf.id, n, { html: `<div>${n}</div>`, widgets: [] }, { html: '<div>b</div>', widgets: [] })
  const b1 = await cnt()
  await e.copyItems([pa.id], [], pb.id)
  const b2 = await cnt()
  check('deep copy: folder + file + 3 cards', b2.nodes === b1.nodes + 2 && b2.cards === b1.cards + 3, [b1.nodes, b2.nodes, b1.cards, b2.cards])
  const copied = b2.sn.nodes.find((n) => n.parentId === pb.id)
  check('copy keeps the subfolder', !!copied && b2.sn.nodes.some((n) => n.parentId === copied.id))
  await e.undo()
  const b3 = await cnt()
  check('undo reverts the whole paste as ONE step', b3.nodes === b1.nodes && b3.cards === b1.cards, [b3.nodes, b3.cards])
  await e.redo()
  const b4 = await cnt()
  check('redo brings it back', b4.nodes === b2.nodes && b4.cards === b2.cards)
  await e.undo()
  await e.moveItems([pa.id], [], pb.id)
  const b5 = (await cnt()).sn
  const moved = b5.nodes.find((n) => n.id === pa.id)
  check('cut + paste moves the folder (cards stay, same ids)', moved?.parentId === pb.id && b5.cards.length === b1.cards, moved)
  await e.undo()
  check('undo of the move', (await cnt()).sn.nodes.find((n) => n.id === pa.id)?.parentId === null)
  await e.deleteItems([pa.id], [])
  await e.undo()
  const b6 = (await cnt()).sn
  check('undo of delete restores the folder with its cards', !!b6.nodes.find((n) => n.id === pf.id) && b6.cards.length === b1.cards)
  const second = await e.createNode(pb.id, 'دوم')
  await e.moveItems([], b6.cards.filter((c) => c.folderId === pf.id).slice(0, 2).map((c) => c.id), second.id)
  check('cards move to another folder', (await cnt()).sn.cards.filter((c) => c.folderId === second.id).length === 2)
  await e.copyItems([], b6.cards.filter((c) => c.folderId === pf.id).map((c) => c.id), second.id)
  const dup = (await cnt()).sn.cards.filter((c) => c.folderId === second.id)
  check('copied cards get unique names', dup.length === 2 + 3 && new Set(dup.map((c) => c.name)).size === 5, dup.map((c) => c.name))

  // ---- cards outside every folder (the top level) and folders holding both cards and folders
  const top = await e.createCard(null, 'بیرون', sd, sd)
  check('a card at the top level has no folder', top.folderId === null, top)
  check('...and is studied from the top level', (await e.next(null)).card?.id === top.id)
  const mixed = await e.createNode(null, 'مخلوط')
  const inner = await e.createNode(mixed.id, 'زیر')
  const own = await e.createCard(mixed.id, 'خودش', sd, sd)
  const deep = await e.createCard(inner.id, 'زیری', sd, sd)
  const nm = await e.next(mixed.id)
  check('a folder studies only its own cards (not its subfolder\'s)', nm.card?.id === own.id && nm.counts?.new === 1, nm.counts)
  await e.answer(own.id, 3, 1000)
  check('...then it is done, even though the subfolder still has a card', (await e.next(mixed.id)).card === null)
  check('the subfolder is studied on its own', (await e.next(inner.id)).card?.id === deep.id)
  // cut a folder and a card together, paste at the top level / into a folder: one undo step each
  await e.moveItems([inner.id], [top.id], mixed.id)
  let m1 = (await cnt()).sn
  check('mixed cut + paste into a folder', m1.cards.find((c) => c.id === top.id)?.folderId === mixed.id && m1.nodes.find((n) => n.id === inner.id)?.parentId === mixed.id)
  await e.moveItems([inner.id], [top.id, own.id], null)
  m1 = (await cnt()).sn
  check('mixed cut + paste to the top level', m1.cards.find((c) => c.id === own.id)?.folderId === null && m1.nodes.find((n) => n.id === inner.id)?.parentId === null)
  await e.undo()
  m1 = (await cnt()).sn
  check('undo of a mixed paste is one step', m1.cards.find((c) => c.id === own.id)?.folderId === mixed.id && m1.nodes.find((n) => n.id === inner.id)?.parentId === mixed.id)
  const before2 = await cnt()
  await e.copyItems([mixed.id], [top.id], null)
  const after2 = await cnt()
  check('mixed copy (folder with subfolder + 3 cards, plus 1 card)', after2.nodes === before2.nodes + 2 && after2.cards === before2.cards + 4, [before2.nodes, after2.nodes, before2.cards, after2.cards])
  await e.deleteItems([mixed.id], [top.id])
  const after3 = await cnt()
  check('mixed delete', after3.nodes === before2.nodes + 2 - 2 && !after3.sn.cards.some((c) => c.id === top.id || c.id === own.id || c.id === deep.id))
  await e.undo()
  check('undo of a mixed delete is one step', (await cnt()).sn.cards.some((c) => c.id === top.id) && (await cnt()).sn.cards.some((c) => c.id === deep.id))
  // a folder whose subfolder has reviews due first: its own cards are answered, and two undos take both back
  const np = await e.createNode(null, 'P')
  const nc = await e.createNode(np.id, 'C')
  for (let i = 0; i < 3; i++) {
    await e.createCard(nc.id, `sub${i}`, sd, sd)
    await e.createCard(np.id, `own${i}`, sd, sd)
  }
  const { daysElapsed: today } = await e.rpc.call('schedTimingToday')
  await e.rpc.json('runDbCommand', { kind: 'query', sql: 'update cards set type = 2, queue = 2, due = ?, ivl = 3, factor = 2500 where did = ?', args: [today ?? 0, Number(nc.id)], first_row_only: false })
  const o1 = (await e.next(np.id)).card!
  await e.answer(o1.id, 3, 4000)
  const o2 = (await e.next(np.id)).card!
  await e.answer(o2.id, 1, 4000)
  const both = [(await e.cardInfo(o1.id)).card!.reps, (await e.cardInfo(o2.id)).card!.reps]
  await e.undo()
  await e.undo()
  const back2 = [(await e.cardInfo(o1.id)).card!.reps, (await e.cardInfo(o2.id)).card!.reps]
  check("a folder's own card behind its subfolder's reviews is answered; two undos take both back",
    o1.folderId === np.id && o2.folderId === np.id && both.join() === '1,1' && back2.join() === '0,0', { both, back2 })
  // cards from a file: their own folder with a daily limit of new cards; folders filled by hand are not limited
  const words = Array.from({ length: 12 }, (_, i) => ({ name: `w${i}`, front: sd, back: sd }))
  const imp = await e.importCards(null, 'لغات وارد شده', words, 5)
  let si = await e.snapshot()
  const shownImp = si.cards.filter((c) => c.folderId === imp.id && c.ready).length
  let served = 0
  for (let r = await e.next(imp.id); r.card && served < 50; r = await e.next(imp.id)) {
    await e.answer(r.card.id, 3, 1000)
    served++
  }
  si = await e.snapshot()
  check('import: a folder of its own with the daily limit, 5 of 12 new cards listed and served today',
    imp.newLimit === 5 && si.cards.filter((c) => c.folderId === imp.id).length === 12 && shownImp === 5 && served === 5 &&
      si.cards.filter((c) => c.folderId === imp.id && c.ready).length === 0, { limit: imp.newLimit, shownImp, served })
  await e.setNewLimit(imp.id, null)
  si = await e.snapshot()
  check('import: without the limit the other 7 are listed', si.nodes.find((n) => n.id === imp.id)?.newLimit == null &&
    si.cards.filter((c) => c.folderId === imp.id && c.ready).length === 7)
  const rv = si.cards.filter((c) => c.state === 'review')
  check('review cards carry their chance of remembering (0..1)', rv.length > 0 && rv.every((c) => c.recall !== undefined && c.recall > 0 && c.recall <= 1), rv.map((c) => c.recall))
  // learning cards are measured too: against their step (classic), 100 % just answered, 90 % when the step is up
  const lc = await e.createCard(null, 'یادگیری', sd, sd)
  for (let r = await e.next(null); r.card; r = await e.next(null)) {
    await e.answer(r.card.id, r.card.id === lc.id ? 1 : 3, 1000)
    if (r.card.id === lc.id) break
  }
  const learn = (await e.cardInfo(lc.id)).card!
  check('a learning card carries its chance of remembering (about 100 % right after "again", classic)',
    learn.state === 'learning' && learn.recall !== undefined && learn.recall > 0.99, learn)
  const lrt = 1_000_000
  const at = (secs: number) => recallNow(1, 1, lrt + 600, 0, JSON.stringify({ lrt }), 100, lrt + secs, 0)!
  check('classic learning step: 100 % at the answer, 90 % when the 10-minute step is up, less after (same as the server)',
    at(0).recall === 1 && Math.abs(at(600).recall - 0.9) < 0.001 && at(1800).recall < 0.75 && !at(600).fsrs, [at(0), at(600), at(1800)])
  const onDay = recallNow(2, 2, 100, 10, '', 100, Date.now() / 1000, 0)
  check('classic review card on the day it falls due: 90 % (same as the server)', onDay?.recall === 0.9 && onDay.fsrs === false, onDay)
  const dflt = await e.createNode(null, 'Default')
  check('a folder named like Anki\'s Default deck is its own folder', dflt.id !== '1' && dflt.parentId === null, dflt)
  // names: what Anki keeps is told back; card names stay unique within a folder (upper / lower case alike)
  const rn = await e.createNode(null, 'نام')
  const kept = await e.renameNode(rn.id, 'Default')
  const snapRn = await e.snapshot()
  check('rename tells the name Anki kept (a top-level "Default" gets a number)', kept.name === snapRn.nodes.find((n) => n.id === rn.id)?.name && kept.name !== 'Default', kept)
  check('rename: "::" becomes ":"', (await e.renameNode(rn.id, 'a::b')).name === 'a:b')
  const dest = await e.createNode(null, 'مقصد')
  await e.createCard(dest.id, 'Word', sd, sd)
  const w1 = await e.createCard(null, 'word', sd, sd)
  const w2 = await e.createCard(null, 'Other', sd, sd)
  await e.moveItems([], [w1.id, w2.id], dest.id)
  let inDest = (await e.snapshot()).cards.filter((c) => c.folderId === dest.id).map((c) => c.name).sort()
  check('cut + paste: a card whose name (any case) is taken there gets a number', inDest.join() === ['Other', 'Word', 'word ۲'].sort().join(), inDest)
  const w3 = await e.createCard(null, 'WORD', sd, sd)
  await e.copyItems([], [w3.id], dest.id)
  inDest = (await e.snapshot()).cards.filter((c) => c.folderId === dest.id).map((c) => c.name).sort()
  check('copy + paste: the same, upper / lower case alike', inDest.includes('WORD ۳') && inDest.length === 4, inDest)
  await e.undo() // the copy
  await e.undo() // the card WORD
  await e.undo() // the move, with its renames
  inDest = (await e.snapshot()).cards.filter((c) => c.folderId === dest.id).map((c) => c.name)
  check('undo of a paste that renamed cards brings their names back too (one step)', inDest.length === 1 && inDest[0] === 'Word', inDest)

  // ---- review undo: Anki keeps its last 30 steps; past them undo says so (the review page then shows a message)
  const many = await e.createNode(null, 'سی')
  for (let i = 0; i < 32; i++) await e.createCard(many.id, 'u' + i, sd, sd)
  for (let i = 0; i < 32; i++) {
    const nx = await e.next(many.id)
    await e.answer(nx.card!.id, 4, 1000)
  }
  let undone = 0
  while ((await e.undo()).ok) undone++
  check('review undo: exactly 30 answers can be taken back', undone === 30, undone)
  check('...and the 31st says nothing was undone', (await e.undo()).ok === false)

  // ---- settings: theme / text size leave review undo alone; a new goal is an Anki option (an undo step of its own)
  const st = await e.createNode(null, 'تنظیم')
  await e.createCard(st.id, 's1', sd, sd)
  const sn = await e.next(st.id)
  await e.answer(sn.card!.id, 3, 1000)
  await e.saveSettings({ theme: 'light', fontScale: 1.2, retention: 0.9 } as never)
  check('a theme change leaves the last answer undoable', (await e.undo()).ok === true)
  await e.saveSettings({ theme: 'light', fontScale: 1.2, retention: 0.85 } as never)
  const dr = (await (e as never as { deckOptions(): Promise<{ cfg: { config: { desiredRetention: number } } }> }).deckOptions()).cfg.config.desiredRetention
  check('a new goal reaches Anki\'s deck options', Math.abs(dr - 0.85) < 1e-4, dr)
  void base
}

main()
  .catch((err) => {
    console.error('ERROR', err)
    failed++
  })
  .finally(() => {
    child.stdin.write('quit\n')
    setTimeout(() => process.exit(failed ? 1 : 0), 300)
  })
