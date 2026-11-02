import type { Api, FsrsStatus, NextCard, ServerSnapshot, Stats } from '../data/apiTypes'
import type { Card, CardLayout, CardSide, ReviewLogEntry, Settings, TreeNode } from '../types'
import { BackendRpcError, ErrorKind, Rpc, type Transport } from './rpc'

/**
 * Yadavar's data model on top of Anki (the same mapping yadavar-server/server.py does with the Python library):
 *   folder -> deck ("Parent::Child")
 *   card   -> note of the "Ankio" notetype (Name, Front, Back, Extra = JSON with widgets + layout), in its folder's
 *             deck; cards at the top level (outside every folder) live in Anki's "Default" deck (id 1)
 * Every scheduling decision (queues, intervals, ease, learning steps, FSRS, undo, statistics) is made by Anki's own
 * Rust backend; this file only asks it questions and maps the answers. It runs identically on the phone (backend via
 * JNI) and against the desktop Python library in tests.
 */

// the notetype keeps the app's first name: every existing collection has its cards under it
const NOTETYPE = 'Ankio'
const FA = new Intl.NumberFormat('fa-IR', { useGrouping: false })
/** Anki's "Default" deck: the cards at the top level */
const ROOT = 1
const deckOf = (folderId: string | null | undefined) => (folderId ? Number(folderId) : ROOT)
const folderOf = (did: number) => (did === ROOT ? null : String(did))
const SETTINGS_KEY = 'ankio_settings'
const FSRS_CHECK_KEY = 'ankio_fsrs_check'

const FSRS_HARD_LIMIT = 900 // reviews: switch on no matter what
const FSRS_MIN_ITEMS = 400 // Anki's own minimum for training parameters on your history
const FSRS_MAX_RMSE = 0.06 // held-out calibration error (predicted vs actual recall)
const FSRS_MIN_GAIN = 0.03 // log-loss must beat a "no-skill" predictor by at least 3 %

const DAY_MS = 86_400_000
const EMPTY_SIDE = '<div dir="rtl"><br></div>'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Row = unknown[]

export interface MediaStore {
  /** Writes a file into Anki's media folder and returns the name Anki gave it. */
  add(name: string, data: Uint8Array): Promise<string>
  /** A URL the web view can load the media file from. */
  url(name: string): string
}

/**
 * The card's pictures and sounds written the way Anki recognises them (<img src>, [sound:]), kept in the hidden Extra
 * field: Anki's own tools (Check Media in Anki or AnkiDroid) then know the files are used and never clear them.
 */
const mediaRefs = (extra: Json) =>
  [...(extra.fw ?? []), ...(extra.bw ?? [])]
    .filter((w: Json) => w.mediaId && (w.kind === 'image' || w.kind === 'audio'))
    .map((w: Json) => (w.kind === 'audio' ? `[sound:${w.mediaId}]` : `<img src='${w.mediaId}'>`))
    .join('')

/**
 * The chance (0..1) of remembering a review card right now: from its FSRS memory state when there is one, otherwise
 * Anki's usual estimate for the classic scheduler (90 % at the end of the interval).
 */
/**
 * The chance (0..1) of remembering a card right now, and whether FSRS measured it; undefined for new cards (as the
 * server). With FSRS: Anki's own formula from the memory state (review and learning cards alike), timed to the second
 * from the last review ("lrt"). The classic scheduler has no memory model: 90 % on the day a card falls due, falling
 * the longer it waits; a card in its learning steps is measured the same way against its step.
 */
export const recallNow = (
  type: number,
  queue: number,
  due: number,
  ivl: number,
  data: string,
  today: number,
  now: number,
  cutoff: number,
): { recall: number; fsrs: boolean } | undefined => {
  if (type !== 1 && type !== 2 && type !== 3) return undefined
  let mem: Json = {}
  try {
    mem = data ? JSON.parse(data) : {}
  } catch {
    mem = {}
  }
  const lrt: number | undefined = mem.lrt
  const round = (x: number) => Math.round(x * 1e4) / 1e4
  if (mem.s) {
    const decay = mem.decay || 0.5
    const elapsed = lrt ? Math.max(0, (now - lrt) / 86400) : type === 2 ? Math.max(0, today - (due - ivl)) : 0
    const factor = Math.pow(0.9, 1 / -decay) - 1
    return { recall: round(Math.pow(1 + (factor * elapsed) / mem.s, -decay)), fsrs: true }
  }
  if (type === 2) {
    if (ivl <= 0) return undefined
    // in whole days, as the classic scheduler counts its intervals
    return { recall: round(Math.pow(0.9, Math.max(0, today - (due - ivl)) / ivl)), fsrs: false }
  }
  if (!lrt) return { recall: 0.9, fsrs: false }
  const dueAt = queue === 1 ? due : cutoff - 86400 + (due - today) * 86400 // steps of a day or more: a day number
  const step = Math.max(60, dueAt - lrt)
  return { recall: round(Math.pow(0.9, Math.max(0, now - lrt) / step)), fsrs: false }
}

const cleanName = (name: string) => name.replace(/::/g, ':').trim() || 'بدون نام'
const lastSep = (full: string): [string, string] => {
  const parts = full.split('::')
  return [parts.slice(0, -1).join('::'), parts[parts.length - 1]]
}

export class AnkiEngine implements Api {
  readonly rpc: Rpc
  private notetypeId = 0
  private ready: Promise<void> | null = null
  private nowSecs = () => Math.floor(Date.now() / 1000)

  /** Call after the collection file was replaced (restore from a backup): everything is read again. */
  /** Replaced by the platform wrapper (see native.ts): the phone's file picker does the actual work. */
  exportBackup: () => Promise<{ ok: boolean }> = async () => ({ ok: false })
  importBackup: () => Promise<{ ok: boolean }> = async () => ({ ok: false })

  reinit(): Promise<void> {
    this.ready = null
    this.notetypeId = 0
    return this.init()
  }

  constructor(
    transport: Transport,
    private media: MediaStore,
  ) {
    this.rpc = new Rpc(transport)
  }

  /** Creates the "Ankio" notetype on first use and lifts Anki's daily limits (a file shows every ready card). */
  init(): Promise<void> {
    this.ready ??= this.setup()
    return this.ready
  }

  private async setup() {
    const names = (await this.rpc.call('getNotetypeNames')).entries ?? []
    const found = names.find((n: Json) => n.name === NOTETYPE)
    if (found) this.notetypeId = Number(found.id)
    else {
      // same recipe as Anki's Python library: start from the stock "Basic" notetype and replace fields and template
      const base = (await this.jsonOut('getStockNotetypeLegacy', { kind: 0 })) as Json
      const nt: Json = { ...base, name: NOTETYPE, flds: [], tmpls: [] }
      for (const name of ['Name', 'Front', 'Back', 'Extra']) nt.flds.push({ ...base.flds[0], name, ord: null })
      nt.tmpls.push({ ...base.tmpls[0], name: 'Card', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}', ord: null })
      const added = await this.rpc.json('addNotetypeLegacy', nt)
      void added
      const again = (await this.rpc.call('getNotetypeNames')).entries ?? []
      this.notetypeId = Number(again.find((n: Json) => n.name === NOTETYPE)?.id)
    }
    if (!(await this.getConfig('ankio_limits_set', false))) {
      await this.setDeckOptions({ perDay: 9999 })
      await this.setConfig('ankio_limits_set', true)
    }
    // One learning step of 10 minutes (Anki's own deck option, not a change to the algorithm): "good" on a new card
    // graduates it straight away instead of asking for it a second time in the same session.
    // Anki's "learn ahead limit" is 20 minutes by default: a card due in 10 minutes is shown *now* when nothing else is
    // waiting. Set to 0, a card answered "again"/"hard" really waits for its time (the session ends when nothing is due).
    if (!(await this.getConfig('ankio_learnahead_set', false))) {
      await this.setConfig('collapseTime', 0)
      await this.setConfig('ankio_learnahead_set', true)
    }
    if (!(await this.getConfig('ankio_steps_set', false))) {
      await this.setDeckOptions({ learnSteps: [10], relearnSteps: [10] })
      await this.setConfig('ankio_steps_set', true)
    }
    await this.ensureMediaRefs()
  }

  /** Once (and after a backup is restored): cards made before mediaRefs existed get their references, without an undo step. */
  private async ensureMediaRefs() {
    if (await this.getConfig('ankio_media_refs_set', false)) return
    const found = await this.rpc.call('searchNotes', { search: `note:"${NOTETYPE}"` })
    const changed: Json[] = []
    for (const nid of found.ids ?? []) {
      const note = await this.rpc.call('getNote', { nid })
      let extra: Json
      try {
        extra = JSON.parse(note.fields[3] || '{}')
      } catch {
        continue
      }
      const refs = mediaRefs(extra)
      if ((extra.media ?? '') === refs) continue
      extra.media = refs
      note.fields[3] = JSON.stringify(extra)
      changed.push(note)
    }
    for (let i = 0; i < changed.length; i += 200) await this.rpc.call('updateNotes', { notes: changed.slice(i, i + 200), skipUndoEntry: true })
    await this.setConfig('ankio_media_refs_set', true)
  }

  /** Calls a method whose answer is a `Json { bytes }` message and parses it. */
  private async jsonOut(name: string, request: Record<string, unknown>): Promise<unknown> {
    const res = await this.rpc.call(name, request)
    return res.json && res.json.length ? JSON.parse(new TextDecoder().decode(res.json)) : null
  }

  // ------------------------------------------------------------------ small helpers

  async getConfig<T>(key: string, fallback: T): Promise<T> {
    try {
      const v = await this.jsonOut('getConfigJson', { val: key })
      return (v ?? fallback) as T
    } catch (e) {
      if (e instanceof BackendRpcError && e.kind === ErrorKind.NOT_FOUND) return fallback
      throw e
    }
  }

  async setConfig(key: string, value: unknown) {
    await this.rpc.call('setConfigJson', { key, valueJson: new TextEncoder().encode(JSON.stringify(value)), undoable: false })
  }

  private async sql(sql: string, args: unknown[] = []): Promise<Row[]> {
    const r = await this.rpc.json('runDbCommand', { kind: 'query', sql, args, first_row_only: false })
    return (r as Row[]) ?? []
  }

  private async timing() {
    const t = await this.rpc.call('schedTimingToday')
    return { today: t.daysElapsed ?? 0, cutoff: Number(t.nextDayAt ?? 0) }
  }

  // ------------------------------------------------------------------ decks (folders)

  private async deckNames(): Promise<{ id: number; name: string }[]> {
    const res = await this.rpc.call('getDeckNames', { skipEmptyDefault: false, includeFiltered: false })
    return res.entries ?? []
  }

  private async nodes(): Promise<TreeNode[]> {
    const decks = await this.deckNames()
    const byName = new Map(decks.map((d) => [d.name, d.id]))
    const out: TreeNode[] = []
    for (const d of decks) {
      if (d.id === ROOT) continue
      const [parent, short] = lastSep(d.name)
      const pid = parent ? byName.get(parent) : undefined
      out.push({
        id: String(d.id),
        parentId: pid ? String(pid) : null,
        name: short,
        createdAt: d.id,
        newLimit: ((await this.deckJson(d.id)).newLimit as number | null) ?? null,
      })
    }
    return out
  }

  /** Anki's own "new cards per day" for this one deck (its "this deck" limit); null = no limit of its own. */
  async setNewLimit(id: string, limit: number | null) {
    const deck = await this.deckJson(Number(id))
    deck.newLimit = limit ? Math.round(limit) : null
    await this.rpc.call('updateDeckLegacy', { json: new TextEncoder().encode(JSON.stringify(deck)) })
    return { ok: true }
  }

  /** For folders with a daily new-card limit: how many new cards Anki still shows today (its own deck tree counts). */
  private async newLeftToday(): Promise<Map<number, number>> {
    const limited = new Set<number>()
    for (const d of await this.deckNames()) if ((await this.deckJson(d.id)).newLimit) limited.add(Number(d.id))
    const out = new Map<number, number>()
    if (!limited.size) return out
    const stack: Json[] = [await this.rpc.call('deckTree', { now: this.nowSecs() })]
    while (stack.length) {
      const node = stack.pop()!
      if (limited.has(Number(node.deckId))) out.set(Number(node.deckId), node.newCount ?? 0)
      stack.push(...(node.children ?? []))
    }
    return out
  }

  /**
   * Cards brought in from a file: a folder of their own (so its daily new-card limit leaves every other folder alone),
   * its limit, and the cards in their order — one undo step.
   */
  async importCards(parentId: string | null, name: string, cards: { name: string; front: CardSide; back: CardSide; layout?: CardLayout }[], newPerDay: number | null): Promise<TreeNode> {
    await this.init()
    const id = await this.tx(async () => {
      const parent = parentId ? ((await this.deckJson(Number(parentId))).name as string) : ''
      const clean = cleanName(name)
      const full = this.uniqueDeckName(parent ? `${parent}::${clean}` : clean, new Set((await this.deckNames()).map((d) => d.name.toLowerCase())))
      const deck = await this.rpc.call('newDeck')
      deck.name = full
      const did = String((await this.rpc.call('addDeck', deck)).id)
      if (newPerDay) await this.setNewLimit(did, newPerDay)
      // all cards in a few batch operations (a single undo step can only merge as many steps as Anki keeps)
      await this.addCopies(cards.map((c) => ({ did: Number(did), fields: this.noteFields(c) })))
      return did
    })
    return (await this.nodes()).find((n) => n.id === id)!
  }

  async createNode(parentId: string | null, name: string): Promise<TreeNode> {
    await this.init()
    const clean = cleanName(name)
    let full = clean
    if (parentId) full = `${(await this.deckJson(Number(parentId))).name}::${clean}`
    full = this.uniqueDeckName(full, new Set((await this.deckNames()).map((d) => d.name.toLowerCase())))
    const deck = await this.rpc.call('newDeck')
    deck.name = full
    const added = await this.rpc.call('addDeck', deck)
    const id = Number(added.id)
    const [parent, short] = lastSep(full)
    return { id: String(id), parentId: parent ? parentId : null, name: short, createdAt: id }
  }

  private async deckJson(id: number): Promise<Json> {
    return (await this.jsonOut('getDeckLegacy', { did: id })) as Json
  }

  async renameNode(id: string, name: string) {
    const current = (await this.deckJson(Number(id))).name as string
    const [parent] = lastSep(current)
    const clean = cleanName(name)
    let full = parent ? `${parent}::${clean}` : clean
    // e.g. a top-level folder called like Anki's "Default" deck
    if (full.toLowerCase() !== current.toLowerCase()) full = this.uniqueDeckName(full, new Set((await this.deckNames()).map((d) => d.name.toLowerCase())))
    await this.rpc.call('renameDeck', { deckId: Number(id), newName: full })
    return { ok: true, name: lastSep(full)[1] } // the name Anki keeps (it may differ from the one asked)
  }

  /** Folders (with everything inside) and cards, as ONE undo step. */
  async deleteItems(nodes: string[], cards: string[]) {
    await this.tx(async () => {
      if (cards.length) await this.rpc.call('removeNotes', { noteIds: [], cardIds: cards.map(Number) })
      if (!nodes.length) return
      const all = await this.deckNames()
      const names = nodes.map((id) => all.find((d) => String(d.id) === id)?.name).filter((n): n is string => !!n)
      const doomed = all.filter((d) => names.some((n) => d.name === n || d.name.startsWith(n + '::'))).map((d) => d.id)
      if (doomed.length) await this.rpc.call('removeDecks', { dids: doomed })
    })
    return { ok: true }
  }

  // ------------------------------------------------------------------ cards

  /** Due time in ms. Anki stores review cards as a day number and (re)learning cards as epoch seconds. */
  private dueMs(c: Json, today: number, cutoff: number): number {
    if (c.queue === 2 || c.queue === 3 || (c.type === 2 && c.queue < 0)) {
      return (cutoff - 86400 + (c.due - today) * 86400) * 1000
    }
    if (c.type === 1 || c.type === 3) return c.due * 1000
    return Date.now()
  }

  private isReady(c: Json, today: number, collapse: number): boolean {
    if (c.queue < 0) return false // suspended / buried
    if (c.queue === 0) return true
    if (c.queue === 1) return c.due <= this.nowSecs() + collapse
    return c.due <= today
  }

  private cardFrom(row: Row, today: number, cutoff: number, collapse: number): Card {
    // id, nid, did, odid, type, queue, due, ivl, factor, reps, lapses, flds, data
    const [id, nid, did, odid, type, queue, due, ivl, factor, reps, lapses, flds, data] = row as [number, number, number, number, number, number, number, number, number, number, number, string, string]
    const fields = String(flds).split('\x1f')
    let extra: Json = {}
    try {
      extra = JSON.parse(fields[3] || '{}')
    } catch {
      extra = {}
    }
    const c = { type, queue, due }
    return {
      id: String(id),
      folderId: folderOf(odid || did),
      name: fields[0] ?? '',
      front: { html: fields[1] || EMPTY_SIDE, widgets: extra.fw ?? [] },
      back: { html: fields[2] || EMPTY_SIDE, widgets: extra.bw ?? [] },
      layout: extra.layout,
      state: type === 0 ? 'new' : type === 2 ? 'review' : type === 1 || type === 3 ? 'learning' : 'new',
      ready: this.isReady(c, today, collapse),
      parked: queue < 0,
      due: this.dueMs(c, today, cutoff),
      interval: ivl,
      ease: factor ? factor / 1000 : undefined,
      relearn: type === 3,
      reps,
      lapses,
      createdAt: nid,
      ...recallNow(type, queue, due, ivl, data ?? '', today, Date.now() / 1000, cutoff),
    } as Card
  }

  private static CARD_SQL =
    'select c.id, c.nid, c.did, c.odid, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, n.flds, c.data ' +
    'from cards c join notes n on n.id = c.nid '

  private async cardById(id: number): Promise<Card> {
    const rows = await this.sql(AnkiEngine.CARD_SQL + 'where c.id = ?', [id])
    if (!rows.length) throw new Error('card not found')
    const { today, cutoff } = await this.timing()
    return this.cardFrom(rows[0], today, cutoff, await this.getConfig('collapseTime', 1200))
  }

  /**
   * The list view needs a card's name and schedule, not its pages: only the first field (the name) is read here, so a
   * snapshot of 10 000 cards stays small. Contents and layout are loaded when a card is opened (cardInfo).
   */
  private async allCards(): Promise<Card[]> {
    const { today, cutoff } = await this.timing()
    const collapse = await this.getConfig('collapseTime', 1200)
    const rows = await this.sql(
      'select c.id, c.nid, c.did, c.odid, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, ' +
        "substr(n.flds, 1, instr(n.flds || char(31), char(31)) - 1), c.data from cards c join notes n on n.id = c.nid where n.mid = ? order by c.id",
      [this.notetypeId],
    )
    // folders with a daily new-card limit: only the next new cards in Anki's order (position) are shown today
    const left = await this.newLeftToday()
    const allowed = new Set<number>()
    for (const [did, n] of left) {
      if (n <= 0) continue
      for (const r of await this.sql('select id from cards where did = ? and queue = 0 order by due, id limit ?', [did, n])) allowed.add(Number(r[0]))
    }
    return rows.map((r) => {
      const c = this.cardFrom(r, today, cutoff, collapse)
      const [id, , did, , , queue] = r as number[]
      if (queue === 0 && left.has(did) && !allowed.has(id)) c.ready = false
      return { ...c, front: { html: EMPTY_SIDE, widgets: [] }, back: { html: EMPTY_SIDE, widgets: [] }, layout: undefined, light: true }
    })
  }

  /** The four fields of a new note (Name, Front, Back, Extra) from a card payload. */
  private noteFields(body: { name: string; front: CardSide; back: CardSide; layout?: CardLayout }): string[] {
    const extra: Json = { fw: body.front.widgets, bw: body.back.widgets }
    if (body.layout) extra.layout = body.layout
    extra.media = mediaRefs(extra)
    return [body.name, body.front.html, body.back.html, JSON.stringify(extra)]
  }

  /** Create (cardId null) or update the note behind a card. */
  private async writeNote(cardId: number | null, deckId: number | null, body: Json): Promise<number> {
    let note: Json
    let extra: Json = {}
    if (cardId === null) {
      note = await this.rpc.call('newNote', { ntid: this.notetypeId })
      note.fields = note.fields ?? ['', '', '', '']
    } else {
      const c = await this.rpc.call('getCard', { cid: cardId })
      note = await this.rpc.call('getNote', { nid: c.noteId })
      try {
        extra = JSON.parse(note.fields[3] || '{}')
      } catch {
        extra = {}
      }
    }
    if ('name' in body) note.fields[0] = body.name
    if ('front' in body) {
      note.fields[1] = body.front.html
      extra.fw = body.front.widgets
    }
    if ('back' in body) {
      note.fields[2] = body.back.html
      extra.bw = body.back.widgets
    }
    if ('layout' in body) extra.layout = body.layout
    extra.media = mediaRefs(extra)
    note.fields[3] = JSON.stringify(extra)
    if (cardId === null) {
      const added = await this.rpc.call('addNote', { note, deckId })
      const cards = await this.rpc.call('cardsOfNote', { nid: added.noteId })
      return Number(cards.cids[0])
    }
    await this.rpc.call('updateNotes', { notes: [note], skipUndoEntry: false })
    return cardId
  }

  async createCard(folderId: string | null, name: string, front: CardSide, back: CardSide, layout?: CardLayout): Promise<Card> {
    await this.init()
    const id = await this.writeNote(null, deckOf(folderId), layout ? { name, front, back, layout } : { name, front, back })
    return this.cardById(id)
  }

  async updateCard(id: string, patch: { name?: string; front?: CardSide; back?: CardSide; layout?: CardLayout }): Promise<Card> {
    await this.init()
    await this.writeNote(Number(id), null, patch)
    return this.cardById(Number(id))
  }

  // ------------------------------------------------------------------ snapshot, settings, reset

  async snapshot(): Promise<ServerSnapshot> {
    await this.init()
    const { cutoff } = await this.timing()
    return {
      version: 1,
      nodes: await this.nodes(),
      cards: await this.allCards(),
      revlog: await this.revlog(),
      settings: await this.getConfig<Settings>(SETTINGS_KEY, {} as Settings),
      dayStart: (cutoff - 86400) * 1000,
    }
  }

  private async revlog(): Promise<ReviewLogEntry[]> {
    const rows = await this.sql('select id, cid, ease from revlog where ease between 1 and 4 order by id')
    return rows.map((r) => ({ cardId: String(r[1]), at: Number(r[0]), rating: Number(r[2]) as 1 | 2 | 3 | 4 }))
  }

  async saveSettings(s: Settings) {
    await this.setConfig(SETTINGS_KEY, s)
    // only a real change of the goal touches Anki's options (that is an undo step: it would end review undo)
    const now = (await this.deckOptions()).cfg.config?.desiredRetention ?? 0
    if (s.retention && Math.abs(now - Number(s.retention)) > 1e-4) await this.setDeckOptions({ retention: Number(s.retention) })
    return { ok: true }
  }

  async reset() {
    const decks = (await this.deckNames()).filter((d) => d.id !== ROOT).map((d) => d.id)
    if (decks.length) await this.rpc.call('removeDecks', { dids: decks })
    const notes = await this.rpc.call('searchNotes', { search: `note:"${NOTETYPE}"` })
    if (notes.ids?.length) await this.rpc.call('removeNotes', { noteIds: notes.ids, cardIds: [] })
    return { ok: true }
  }

  // ------------------------------------------------------------------ media

  async uploadMedia(blob: Blob): Promise<string> {
    const ext = (blob.type.split('/')[1] ?? 'bin').split(';')[0].replace('mpeg', 'mp3').replace('x-wav', 'wav')
    return this.media.add(`yadavar.${ext}`, new Uint8Array(await blob.arrayBuffer()))
  }

  mediaUrl(name: string): string {
    return this.media.url(name)
  }

  async removeMedia(names: string[]): Promise<{ removed: string[] }> {
    await this.init()
    const unused = new Set<string>((await this.rpc.call('checkMedia')).unused ?? [])
    const fnames = names.filter((n) => unused.has(n))
    if (fnames.length) {
      await this.rpc.call('trashMediaFiles', { fnames })
      await this.rpc.call('emptyTrash')
    }
    return { removed: fnames }
  }

  // ------------------------------------------------------------------ studying (all of it Anki's scheduler)

  /** How long until the card is seen again after this answer, read from Anki's own next states. */
  private stateDelayMs(state: Json): number {
    const inner = state.filtered ?? state.normal ?? {}
    const kind = Object.keys(inner)[0]
    const node = inner[kind] ?? {}
    if (kind === 'learning') return (node.scheduledSecs ?? 0) * 1000
    if (kind === 'relearning') return (node.learning?.scheduledSecs ?? 0) * 1000
    if (kind === 'review') return (node.scheduledDays ?? 0) * DAY_MS
    if (kind === 'preview') return (node.scheduledSecs ?? 0) * 1000
    return 0
  }

  private delaysOf(s: Json): number[] {
    return [s.again, s.hard, s.good, s.easy].map((x) => this.stateDelayMs(x ?? {}))
  }

  async cardFull(id: string): Promise<Card> {
    await this.init()
    return this.cardById(Number(id))
  }

  async cardInfo(id: string): Promise<NextCard> {
    const states = await this.rpc.call('getSchedulingStates', { cid: Number(id) })
    const out: NextCard = { card: await this.cardById(Number(id)), delays: this.delaysOf(states) }
    if (await this.isPractice(Number(id))) out.practice = true
    return out
  }

  /**
   * A card already reviewed today that is not due again yet (opened on its own, e.g. from the brain): an answer now is
   * only practice. Anki would count every such answer as a real review, and FSRS raises the memory's stability with
   * each one (a few "easy" in a row in one day would push it weeks away); so the schedule is left as it is. A card
   * waiting in today's queue (learning steps, "again") is never practice.
   */
  private async isPractice(cid: number): Promise<boolean> {
    const { today, cutoff } = await this.timing()
    const rows = await this.sql('select queue, due from cards where id = ?', [cid])
    if (!rows.length) return false
    const [queue, due] = rows[0].map(Number)
    const dueNow = queue === 0 || ((queue === 1 || queue === 4) && due <= Date.now() / 1000) || ((queue === 2 || queue === 3) && due <= today)
    if (dueNow) return false
    const done = await this.sql('select count() from revlog where cid = ? and id >= ? and ease > 0', [cid, (cutoff - 86400) * 1000])
    return Number(done[0]?.[0] ?? 0) > 0
  }

  /**
   * The next card Anki wants studied among the cards that sit directly in this folder (or at the top level): queue
   * order, learning steps, limits are all Anki's. Anki's queue of a deck also holds its subfolders' cards; those are
   * skipped here (each folder is reviewed on its own), keeping Anki's order for the rest.
   */
  async next(folderId: string | null): Promise<NextCard> {
    const did = deckOf(folderId)
    await this.rpc.call('setCurrentDeck', { did })
    let nested = false
    if (did !== ROOT) {
      const name = (await this.deckJson(did)).name as string
      nested = (await this.deckNames()).some((d) => d.name.startsWith(name + '::'))
    }
    const q = await this.rpc.call('getQueuedCards', { fetchLimit: nested ? 100000 : 1, intradayLearningOnly: false })
    let cards: Json[] = q.cards ?? []
    let counts = { new: q.newCount ?? 0, learning: q.learningCount ?? 0, review: q.reviewCount ?? 0 }
    if (nested) {
      cards = cards.filter((c) => Number(c.card.originalDeckId || c.card.deckId) === did)
      const n = (k: number) => cards.filter((c) => (c.queue ?? 0) === k).length
      counts = { new: n(0), learning: n(1), review: n(2) }
    }
    const first = cards[0]
    if (!first) return { card: null, counts }
    const cid = first.card.id
    return { card: await this.cardById(cid), delays: this.delaysOf(first.states ?? {}), counts }
  }

  async answer(cardId: string, rating: number, millis: number) {
    if (await this.isPractice(Number(cardId))) return { card: await this.cardById(Number(cardId)), revlog: [] as ReviewLogEntry[], practice: true }
    const states = await this.rpc.call('getSchedulingStates', { cid: Number(cardId) })
    const chosen = [states.again, states.hard, states.good, states.easy][rating - 1]
    const top = await this.rpc.call('getQueuedCards', { fetchLimit: 1, intradayLearningOnly: false })
    if (String(top.cards?.[0]?.card?.id) === String(cardId)) {
      await this.rpc.call('answerCard', {
        cardId: Number(cardId),
        currentState: states.current,
        newState: chosen,
        rating: rating - 1,
        answeredAtMillis: Date.now(),
        millisecondsTaken: Math.max(0, Math.min(Math.round(millis), 60_000)),
      })
    } else {
      // A folder is studied on its own, but Anki's queue for its deck also holds the subfolders' cards: when one of
      // those is ahead, Anki would refuse an answer for this card (and a refused answer wipes Anki's undo history).
      // "Grade now" (what Anki's card browser uses) applies the very same scheduling states as one undo step; it only
      // does not record the seconds spent (writing them into the review log by hand would also wipe the undo history).
      await this.rpc.call('gradeNow', { cardIds: [Number(cardId)], rating: rating - 1 })
    }
    const rows = await this.sql('select id, cid, ease from revlog where cid = ? order by id desc limit 1', [Number(cardId)])
    const last: ReviewLogEntry[] = rows.length ? [{ cardId: String(rows[0][1]), at: Number(rows[0][0]), rating: Number(rows[0][2]) as 1 | 2 | 3 | 4 }] : []
    return { card: await this.cardById(Number(cardId)), revlog: last }
  }

  // ------------------------------------------------------------------ cut / copy / paste (one undo step per action)

  /** Runs several Anki operations as ONE undo step (Anki's own merge of undo entries). */
  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    const step = async () => Number((await this.rpc.call('getUndoStatus')).lastStep ?? 0)
    const start = await step()
    const out = await fn()
    if ((await step()) - start > 1) {
      try {
        await this.rpc.call('mergeUndoEntries', { val: start + 1 })
      } catch {
        // more steps than Anki keeps (about 30): the work is done, only its undo stays partial
      }
    }
    return out
  }

  private uniqueDeckName(full: string, taken: Set<string>): string {
    if (!taken.has(full.toLowerCase())) return full
    for (let i = 2; ; i++) {
      const c = `${full} ${FA.format(i)}`
      if (!taken.has(c.toLowerCase())) return c
    }
  }

  /** Cut + paste: folders are renamed into the new parent (subfolders and cards follow), cards change deck. One undo step. */
  async moveItems(nodes: string[], cards: string[], parentId: string | null) {
    await this.init()
    await this.tx(async () => {
      if (cards.length) {
        const did = deckOf(parentId)
        await this.rpc.call('setDeck', { cardIds: cards.map(Number), deckId: did })
        // card names are unique within a folder: a moved card whose name is taken there gets a number
        const moved = new Set(cards.map(Number))
        const here = await this.fieldsOf('c.did = ?', [did])
        const taken = new Set(here.filter((c) => !moved.has(c.id)).map((c) => c.fields[0].toLowerCase()))
        for (const c of here.filter((x) => moved.has(x.id))) {
          let name = c.fields[0]
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${c.fields[0]} ${FA.format(n)}`
          taken.add(name.toLowerCase())
          if (name !== c.fields[0]) await this.writeNote(c.id, null, { name })
        }
      }
      const parent = parentId ? ((await this.deckJson(Number(parentId))).name as string) : ''
      for (const sid of nodes) {
        const cur = (await this.deckJson(Number(sid))).name as string
        if (parent === cur || parent.startsWith(cur + '::')) continue // into itself
        const short = lastSep(cur)[1]
        const full = parent ? `${parent}::${short}` : short
        if (full === cur) continue
        const taken = new Set((await this.deckNames()).map((d) => d.name.toLowerCase()))
        await this.rpc.call('renameDeck', { deckId: Number(sid), newName: this.uniqueDeckName(full, taken) })
      }
    })
    return { ok: true }
  }

  private newGuid(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~'
    const r = crypto.getRandomValues(new Uint8Array(10))
    return Array.from(r, (x) => chars[x % chars.length]).join('')
  }

  /** Field texts of the cards (one SQL query per chunk), in the order asked. */
  private async fieldsOf(where: string, args: unknown[]): Promise<{ id: number; did: number; fields: string[] }[]> {
    const rows = await this.sql(`select c.id, c.did, n.flds from cards c join notes n on n.id = c.nid where ${where} order by c.id`, args)
    return rows.map((r) => ({ id: Number(r[0]), did: Number(r[1]), fields: String(r[2]).split('\x1f') }))
  }

  private async addCopies(items: { did: number; fields: string[] }[]) {
    const requests = []
    for (const it of items) {
      const note = await this.rpc.call('newNote', { ntid: this.notetypeId })
      note.guid = this.newGuid()
      note.fields = it.fields
      requests.push({ note, deckId: it.did })
    }
    // chunks keep each request small; the whole paste is still one undo step (see tx)
    for (let i = 0; i < requests.length; i += 400) await this.rpc.call('addNotes', { requests: requests.slice(i, i + 400) })
  }

  /** Copy + paste: folders with everything below them, and cards. Copies are new cards (fresh schedule). One undo step. */
  async copyItems(nodes: string[], cards: string[], parentId: string | null) {
    await this.init()
    await this.tx(async () => {
      if (cards.length) await this.copyCards(cards, deckOf(parentId))
      const parent = parentId ? ((await this.deckJson(Number(parentId))).name as string) : ''
      for (const sid of nodes) {
        const all = await this.deckNames()
        const src = all.find((d) => String(d.id) === sid)?.name
        if (!src) continue
        const taken = new Set(all.map((d) => d.name.toLowerCase()))
        const short = lastSep(src)[1]
        const top = this.uniqueDeckName(parent ? `${parent}::${short}` : short, taken)
        const tree = all.filter((d) => d.name === src || d.name.startsWith(src + '::')).sort((a, b) => a.name.split('::').length - b.name.split('::').length)
        const made = new Map<number, number>()
        for (const d of tree) {
          const deck = await this.rpc.call('newDeck')
          deck.name = top + d.name.slice(src.length)
          const added = await this.rpc.call('addDeck', deck)
          made.set(d.id, Number(added.id))
          const limit = (await this.deckJson(d.id)).newLimit // an imported folder keeps its daily limit of new cards
          if (limit) await this.setNewLimit(String(added.id), limit)
        }
        const marks = [...made.keys()].map(() => '?').join(',')
        const copies = await this.fieldsOf(`n.mid = ? and c.did in (${marks})`, [this.notetypeId, ...made.keys()])
        await this.addCopies(copies.map((c) => ({ did: made.get(c.did)!, fields: c.fields })))
      }
    })
    return { ok: true }
  }

  /** Copies of the cards into deck `did`; a copy whose name is taken there gets a number. */
  private async copyCards(ids: string[], did: number) {
    const taken = new Set((await this.fieldsOf('c.did = ?', [did])).map((c) => c.fields[0].toLowerCase()))
    const items: { did: number; fields: string[] }[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const rows = await this.fieldsOf(`c.id in (${part.map(() => '?').join(',')})`, part.map(Number))
      for (const r of rows) {
        let name = r.fields[0]
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${r.fields[0]} ${FA.format(n)}`
        taken.add(name.toLowerCase())
        items.push({ did, fields: [name, ...r.fields.slice(1)] })
      }
    }
    await this.addCopies(items)
  }

  async redo() {
    const status = await this.rpc.call('getUndoStatus')
    if (!status.redo) return { ok: false }
    await this.rpc.call('redo')
    return { ok: true }
  }

  async undo() {
    const status = await this.rpc.call('getUndoStatus')
    if (!status.undo) return { ok: false }
    await this.rpc.call('undo')
    return { ok: true }
  }

  // ------------------------------------------------------------------ FSRS (automatic switch-over)

  private async deckOptions() {
    const cur = await this.rpc.call('getDeckConfigsForUpdate', { did: 1 })
    const cfg = (cur.allConfig ?? []).find((c: Json) => Number(c.config?.id) === Number(cur.currentDeck?.configId))
    return { cur, cfg: cfg.config as Json }
  }

  /** Writes Anki's deck options through its own backend call (the same one Anki's options screen uses). */
  private async setDeckOptions(o: { fsrs?: boolean; params?: number[]; retention?: number; perDay?: number; learnSteps?: number[]; relearnSteps?: number[] }) {
    const { cur, cfg } = await this.deckOptions()
    cfg.config = cfg.config ?? {}
    if (o.params?.length) cfg.config.fsrsParams_6 = o.params // protobuf name of fsrs_params_6 (a wrong name is silently ignored)
    if (o.retention) cfg.config.desiredRetention = o.retention
    if (o.learnSteps) cfg.config.learnSteps = o.learnSteps
    if (o.relearnSteps) cfg.config.relearnSteps = o.relearnSteps
    if (o.perDay) {
      cfg.config.newPerDay = o.perDay
      cfg.config.reviewsPerDay = o.perDay
    }
    await this.rpc.call('updateDeckConfigs', {
      targetDeckId: 1,
      configs: [cfg],
      mode: 0,
      cardStateCustomizer: cur.cardStateCustomizer ?? '',
      limits: cur.currentDeck?.limits ?? {},
      newCardsIgnoreReviewLimit: !!cur.newCardsIgnoreReviewLimit,
      fsrs: o.fsrs ?? !!cur.fsrs,
      applyAllParentLimits: !!cur.applyAllParentLimits,
      fsrsReschedule: false,
      fsrsHealthCheck: false,
    })
  }

  private async reviewCount(): Promise<number> {
    const r = await this.sql('select count() from revlog where type in (0,1,2,3) and ease between 1 and 4')
    return Number(r[0]?.[0] ?? 0)
  }

  private async baselineLogLoss(): Promise<number> {
    const r = await this.sql('select sum(ease > 1), sum(ease = 1) from revlog where type = 1 and ease between 1 and 4')
    const ok = Number(r[0]?.[0] ?? 0)
    const bad = Number(r[0]?.[1] ?? 0)
    const n = ok + bad
    if (!n || !ok || !bad) return 0
    const p = ok / n
    return -(p * Math.log(p) + (1 - p) * Math.log(1 - p))
  }

  async fsrs(): Promise<FsrsStatus> {
    await this.init()
    const { cur } = await this.deckOptions()
    return {
      enabled: !!cur.fsrs,
      reviews: await this.reviewCount(),
      hardLimit: FSRS_HARD_LIMIT,
      minItems: FSRS_MIN_ITEMS,
      last: await this.getConfig<FsrsStatus['last']>(FSRS_CHECK_KEY, null),
    }
  }

  /**
   * Decide whether FSRS should replace Anki's classic scheduler for this collection, and switch it on if so.
   *  - 900+ reviews: always switch on.
   *  - Otherwise, once there are enough items to train on (400), the parameters are trained on the older part of the
   *    history and tested on the newer part (Anki's own time-series evaluation). FSRS is switched on only if its
   *    predictions are well calibrated (RMSE <= 6 %) AND clearly better than a no-skill predictor (>= 3 %).
   * Runs at most once a day (unless forced) and only while FSRS is off.
   */
  async fsrsCheck(force = false): Promise<FsrsStatus> {
    const status = await this.fsrs()
    if (status.enabled) return status
    const n = status.reviews
    const { today } = await this.timing()
    const last = (status.last ?? {}) as Json
    // below 900 reviews: train at most once a day (or after 20 more reviews); at 900 it switches on right away
    if (!force && n < FSRS_HARD_LIMIT && (n < FSRS_MIN_ITEMS || (last.day === today && (last.reviews ?? 0) >= n - 20))) return status

    const result: Json = { day: today, reviews: n, enabled: false }
    const comp = await this.rpc.call('computeFsrsParams', { search: '', currentParams: [], ignoreRevlogsBeforeMs: 0, numOfRelearningSteps: 1, healthCheck: false })
    result.items = comp.fsrsItems ?? 0
    const params: number[] = comp.params ?? []
    let reason: string | null = null
    if (result.items >= FSRS_MIN_ITEMS && params.length) {
      // evaluate on held-out data using these parameters
      await this.setDeckOptions({ fsrs: false, params })
      const ev = await this.rpc.call('evaluateParams', { search: '', ignoreRevlogsBeforeMs: 0, numOfRelearningSteps: 1 })
      const base = await this.baselineLogLoss()
      result.rmse = ev.rmseBins
      result.logLoss = ev.logLoss
      result.baseline = base
      if (n >= FSRS_HARD_LIMIT) reason = `reached ${FSRS_HARD_LIMIT} reviews`
      else if (ev.rmseBins <= FSRS_MAX_RMSE && base > 0 && ev.logLoss <= base * (1 - FSRS_MIN_GAIN)) {
        reason = 'evidence: calibrated and beats the no-skill baseline'
      }
    } else if (n >= FSRS_HARD_LIMIT) reason = `reached ${FSRS_HARD_LIMIT} reviews`
    if (reason) {
      const settings = await this.getConfig<Partial<Settings>>(SETTINGS_KEY, {})
      await this.setDeckOptions({ fsrs: true, params: params.length ? params : undefined, retention: Number(settings.retention ?? 0.9) })
      result.enabled = true
      result.reason = reason
      result.enabledAt = Date.now()
    }
    await this.setConfig(FSRS_CHECK_KEY, result)
    return this.fsrs()
  }

  // ------------------------------------------------------------------ statistics (Anki's own graphs engine)

  async stats(): Promise<Stats> {
    await this.init()
    const g = await this.rpc.call('graphs', { search: '', days: 0 })
    const { cutoff } = await this.timing()
    const day0 = cutoff - 86400
    const rows = await this.sql(
      'select r.id, r.time, r.cid, coalesce(nullif(c.odid, 0), c.did) from revlog r left join cards c on c.id = r.cid where r.type < 4 and r.id >= ?',
      [(day0 - 40 * 86400) * 1000],
    )
    const perDay = new Map<number, { cards: number; ms: number; files: Set<number> }>()
    for (const [rid, ms, , did] of rows as [number, number, number, number][]) {
      const off = Math.floor((Math.floor(rid / 1000) - day0) / 86400)
      const d = perDay.get(off) ?? { cards: 0, ms: 0, files: new Set<number>() }
      d.cards++
      d.ms += ms
      if (did) d.files.add(did)
      perDay.set(off, d)
    }
    const days = []
    for (let o = -29; o <= 0; o++) {
      const d = perDay.get(o)
      days.push({ day: o, cards: d?.cards ?? 0, files: d?.files.size ?? 0, minutes: Math.round(((d?.ms ?? 0) / 60000) * 10) / 10 })
    }
    const future: Record<number, number> = {}
    for (const [k, n] of Object.entries(g.futureDue?.futureDue ?? {})) {
      const key = Math.max(0, Number(k)) // overdue cards count as due today
      future[key] = (future[key] ?? 0) + Number(n)
    }
    const cc = g.cardCounts?.excludingInactive ?? {}
    const btn = (b: Json = {}) => ({ learning: b.learning ?? [], young: b.young ?? [], mature: b.mature ?? [] })
    const tr = (t: Json = {}) => ({ youngPassed: t.youngPassed ?? 0, youngFailed: t.youngFailed ?? 0, maturePassed: t.maturePassed ?? 0, matureFailed: t.matureFailed ?? 0 })
    const today = g.today ?? {}
    const t = g.trueRetention ?? {}
    return {
      dayStart: day0 * 1000,
      days,
      future: Array.from({ length: 15 }, (_, o) => ({ day: o, due: future[o] ?? 0 })),
      cardCounts: {
        new: cc.newCards ?? 0, learn: cc.learn ?? 0, relearn: cc.relearn ?? 0, young: cc.young ?? 0,
        mature: cc.mature ?? 0, suspended: cc.suspended ?? 0, buried: cc.buried ?? 0,
      },
      buttons: { month: btn(g.buttons?.oneMonth), quarter: btn(g.buttons?.threeMonths), year: btn(g.buttons?.oneYear), all: btn(g.buttons?.allTime) },
      retention: { today: tr(t.today), yesterday: tr(t.yesterday), week: tr(t.week), month: tr(t.month), year: tr(t.year), all: tr(t.allTime) },
      today: { answers: today.answerCount ?? 0, minutes: Math.round(((today.answerMillis ?? 0) / 60000) * 10) / 10, correct: today.correctCount ?? 0 },
      fsrs: !!g.fsrs,
    }
  }
}
