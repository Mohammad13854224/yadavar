import { api, type FsrsStatus } from './data/api'
import { demoSnapshot } from './data/seed'
import { localRepository } from './data/repository'
import { DAY, fa as faNum, startOfDay } from './format'
import { sideFor, type ImportRow } from './importCards'
import { newCardLayout } from './sides'
import {
  defaultSettings,
  emptySide,
  type Card,
  type CardLayout,
  type CardSide,
  type ReviewLogEntry,
  type Settings,
  type Snapshot,
  type TreeNode,
} from './types'

export interface DueInfo {
  /** cards of the folder that Anki says are ready today (already studied, now due) */
  due: number
  /** cards that were never studied */
  fresh: number
}

const faInt = new Intl.NumberFormat('fa-IR')

type CardPatch = { name?: string; front?: CardSide; back?: CardSide; layout?: CardLayout }

/** Folders and cards picked together (selection, cut / copy / paste, delete). */
export type Items = { nodes: string[]; cards: string[] }

class AppStore {
  // Big lists are replaced as a whole instead of being deeply reactive: cheap with tens of thousands of cards.
  nodes = $state.raw<TreeNode[]>([])
  cards = $state.raw<Card[]>([])
  revlog = $state.raw<ReviewLogEntry[]>([])
  /** how many tree actions (create, rename, cut/copy/paste, delete) can be undone / redone with Anki's undo */
  histUndo = $state(0)
  histRedo = $state(0)
  /** what was cut or copied; pasting clears it */
  clip = $state.raw<({ mode: 'copy' | 'cut' } & Items) | null>(null)
  settings = $state<Settings>(defaultSettings())
  ready = $state(false)
  /** set when the Anki server cannot be reached */
  offline = $state<string | null>(null)
  toastText = $state('')
  /** shown (and kept) while a long action such as pasting thousands of cards is running */
  working = $state('')
  /** state of the automatic FSRS switch-over (decided by the server from the review history) */
  fsrs = $state<FsrsStatus | null>(null)
  /** start of Anki's current day (ms); Anki's day rolls over at its own hour, not at midnight */
  dayStart = $state(startOfDay())
  /** when the cards were last read from Anki (ms): their `ready` flags are true as of then */
  snapAt = Date.now()

  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<string, CardPatch>()
  private settingsDirty = false
  /** the desired retention Anki has now (a change of it is an undo step in Anki) */
  private savedRetention = 0.9
  /** one Anki operation at a time, in the order the user did them (keeps Anki's undo stack in step with ours) */
  private tail: Promise<unknown> = Promise.resolve()

  private nodeIndex = $derived.by(() => new Map(this.nodes.map((n) => [n.id, n])))
  /** subfolders in the order they were made */
  private childIndex = $derived.by(() => {
    const m = new Map<string | null, TreeNode[]>()
    for (const n of this.nodes) {
      const list = m.get(n.parentId)
      if (list) list.push(n)
      else m.set(n.parentId, [n])
    }
    for (const list of m.values()) list.sort((a, b) => a.createdAt - b.createdAt)
    return m
  })
  private cardIndex = $derived.by(() => new Map(this.cards.map((c) => [c.id, c])))
  /** the cards that sit directly in each folder (key null = the top level) */
  private folderIndex = $derived.by(() => {
    const m = new Map<string | null, Card[]>()
    for (const c of this.cards) {
      const list = m.get(c.folderId)
      if (list) list.push(c)
      else m.set(c.folderId, [c])
    }
    for (const list of m.values()) list.sort((a, b) => a.createdAt - b.createdAt)
    return m
  })

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  private recorded() {
    this.histUndo = Math.min(30, this.histUndo + 1)
    this.histRedo = 0
  }
  /** something else (a card edit, a review answer) went onto Anki's undo stack: tree undo would hit that instead */
  private resetHistory() {
    this.histUndo = 0
    this.histRedo = 0
  }

  // ---------- lifecycle & persistence ----------

  async init() {
    try {
      let snap = await api.snapshot()
      if (!snap.nodes.length && !snap.cards.length) {
        // an empty collection: bring over what the old in-browser version had (if anything). New installs start empty;
        // sample data can be loaded from Settings.
        let old: Snapshot | null = null
        try {
          old = await localRepository.load()
        } catch {
          /* no local data */
        }
        if (old && old.nodes.length) {
          await this.importSnapshot(old, true)
          snap = await api.snapshot()
        }
      }
      this.apply(snap)
      this.offline = null
    } catch (e) {
      this.offline = e instanceof Error ? e.message : 'خطا'
    }
    this.ready = true
    this.checkFsrs()
  }

  /** Lets the server decide (at most once a day) whether FSRS has proven better for this history. */
  async checkFsrs() {
    try {
      const before = await api.fsrs()
      this.fsrs = before
      if (before.enabled) return
      const after = await api.fsrsCheck()
      this.fsrs = after
      // a check that trained (or switched on) changed Anki's options, which sit on Anki's undo stack now
      if (JSON.stringify(after.last) !== JSON.stringify(before.last)) this.resetHistory()
      if (after.enabled) {
        this.toast('FSRS فعال شد: زمان‌بندی حالا با مدل حافظه‌ی خودت انجام می‌شود')
        await this.refresh() // every card's chance of remembering is measured by FSRS now (the risk bar)
      }
    } catch {
      /* the next launch tries again */
    }
  }

  /** Re-read everything from Anki (e.g. when the window gets focus on a new day). */
  async refresh() {
    try {
      await this.flush()
      // in line with the changes still on their way: a snapshot read halfway through one would drop its result
      this.apply(await this.serial(() => api.snapshot()))
      this.offline = null
    } catch (e) {
      this.offline = e instanceof Error ? e.message : 'خطا'
    }
  }

  private apply(snap: { nodes: TreeNode[]; cards: Card[]; revlog: ReviewLogEntry[]; settings: Partial<Settings>; dayStart?: number }) {
    this.nodes = snap.nodes
    this.cards = snap.cards
    this.revlog = snap.revlog
    this.settings = { ...defaultSettings(), ...snap.settings }
    this.savedRetention = this.settings.retention
    if (snap.dayStart) this.dayStart = snap.dayStart
    this.snapAt = Date.now()
  }

  /** Copies folders and cards (not their old schedule: Anki starts them as new cards) into Anki. Old data's review files become folders. */
  private async importSnapshot(snap: Snapshot, withMedia: boolean) {
    const ids = new Map<string, string>()
    const media = new Map<string, string>()
    const mapMedia = async (side: CardSide): Promise<CardSide> => {
      const widgets = []
      for (const w of side.widgets) {
        if (w.kind === 'text') {
          widgets.push(w) // text has no file to copy
          continue
        }
        if (!withMedia) continue
        let name = media.get(w.mediaId)
        if (!name) {
          const blob = await localRepository.getMedia(w.mediaId)
          if (!blob) continue
          name = await api.uploadMedia(blob)
          media.set(w.mediaId, name)
        }
        widgets.push({ ...w, mediaId: name })
      }
      return { html: side.html, widgets }
    }
    const walk = async (parentId: string | null) => {
      for (const n of snap.nodes.filter((x) => x.parentId === parentId)) {
        const made = await api.createNode(parentId ? ids.get(parentId)! : null, n.name)
        ids.set(n.id, made.id)
        await walk(n.id)
      }
    }
    await walk(null)
    for (const c of [...snap.cards].sort((a, b) => a.createdAt - b.createdAt)) {
      const from = c.folderId ?? (c as { fileId?: string }).fileId ?? null // older data called it fileId
      const folderId = from ? ids.get(from) : null
      if (folderId === undefined) continue
      const made = await api.createCard(folderId, c.name, await mapMedia(c.front), await mapMedia(c.back))
      if (c.layout) await api.updateCard(made.id, { layout: c.layout })
    }
    if (withMedia) await api.saveSettings({ ...defaultSettings(), ...snap.settings })
  }

  /** Call after a local-only change (settings, card sides); the server is updated a moment later. */
  touch() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 400)
  }

  async flush() {
    clearTimeout(this.saveTimer)
    const batch = [...this.pending]
    this.pending.clear()
    try {
      if (batch.length) await this.serial(async () => { for (const [id, patch] of batch) await api.updateCard(id, patch) })
      if (this.settingsDirty) {
        this.settingsDirty = false
        const retention = this.settings.retention
        await api.saveSettings($state.snapshot(this.settings) as Settings)
        // desired retention is an Anki option: its change is on Anki's undo stack now (theme or text size are not)
        if (retention !== this.savedRetention) this.resetHistory()
        this.savedRetention = retention
      }
    } catch {
      this.toast('ذخیره‌سازی انجام نشد')
    }
  }

  private queue(id: string, patch: CardPatch) {
    this.pending.set(id, { ...this.pending.get(id), ...patch })
    this.resetHistory()
    this.touch()
  }

  /** Settings screen: persists the new values. */
  saveSettings() {
    this.settingsDirty = true
    this.touch()
  }

  /** Saves everything (cards, pictures, sounds, schedule, history) as one .colpkg file the user picks a place for. */
  async exportBackup() {
    await this.flush()
    try {
      const r = await api.exportBackup()
      this.toast(r.ok ? 'پشتیبان ذخیره شد' : 'ذخیره‌ی پشتیبان لغو شد')
    } catch {
      this.toast('پشتیبان‌گیری انجام نشد')
    }
  }

  /** Replaces everything with the content of a .colpkg file (the previous data is kept as a safety copy). */
  async importBackup() {
    await this.flush()
    try {
      const r = await api.importBackup()
      if (!r.ok) return this.toast('وارد کردن لغو شد')
      this.resetHistory()
      this.clip = null
      await this.refresh()
      await this.checkFsrs()
      this.toast('اطلاعات وارد شد')
    } catch (e) {
      // the reason is shown too (and stays longer): «the file is broken» is not the only way this can fail
      const why = String((e as { message?: string })?.message ?? e).slice(0, 160)
      this.toast(`وارد کردن انجام نشد. علت: ${why}`, 15000)
    }
  }

  async resetAll(withDemo: boolean) {
    await this.flush()
    try {
      await api.reset()
      this.resetHistory()
      this.clip = null
      if (withDemo) await this.importSnapshot(demoSnapshot(), false)
      this.apply(await api.snapshot())
    } catch {
      this.toast('پاک‌کردن انجام نشد؛ ارتباط با انکی برقرار نیست')
      await this.refresh() // whatever Anki holds now
    }
  }

  toast(text: string, ms = 2600) {
    this.toastText = text
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => (this.toastText = ''), ms)
  }

  // ---------- media ----------

  /** Stores a picture or sound in Anki's media folder; the returned name is what a widget refers to. */
  addMedia(blob: Blob): Promise<string> {
    return api.uploadMedia(blob)
  }

  /**
   * One-time cleanup for recordings made by older versions (uncompressed WAV): each is compressed to Opus (the same
   * sound, about a tenth of the size), the cards are pointed at the new file, and only the old files no card uses any
   * more are deleted. Returns how many sounds and the sizes before / after (bytes); null when nothing was done.
   */
  async shrinkSounds(): Promise<{ count: number; before: number; after: number } | null> {
    if (this.working) return null
    const { canCompressSound, soundToOpus } = await import('./compress')
    if (!(await canCompressSound())) {
      this.toast('این دستگاه فشرده‌سازی صدا را پشتیبانی نمی‌کند')
      return null
    }
    await this.flush()
    try {
      // the cards' pages: which card uses which WAV sound
      const users = new Map<string, string[]>()
      let k = 0
      for (const c of [...this.cards]) {
        this.working = `در حال پیدا کردن صداها… ${faNum(++k)} از ${faNum(this.cards.length)}`
        const full = await this.ensureCard(c.id)
        for (const w of [...(full?.front.widgets ?? []), ...(full?.back.widgets ?? [])])
          if (w.kind === 'audio' && /\.wav$/i.test(w.mediaId)) users.set(w.mediaId, [...(users.get(w.mediaId) ?? []), c.id])
      }
      const renamed = new Map<string, string>()
      let before = 0
      let after = 0
      let i = 0
      for (const name of users.keys()) {
        this.working = `در حال فشرده کردن صداها… ${faNum(++i)} از ${faNum(users.size)}`
        const url = await this.mediaUrl(name)
        if (!url) continue
        const res = await fetch(url).catch(() => null)
        if (!res?.ok) continue
        const wav = await res.blob()
        const opus = await soundToOpus(wav)
        if (!opus || opus.size >= wav.size * 0.9) continue // (only when it really is smaller)
        renamed.set(name, await this.addMedia(opus))
        before += wav.size
        after += opus.size
      }
      // the cards point at the new files (saved like any edit)
      const touched = new Set([...renamed.keys()].flatMap((n) => users.get(n) ?? []))
      for (const id of touched) {
        const c = this.card(id)
        if (!c) continue
        for (const which of ['front', 'back'] as const) {
          const side = c[which]
          if (!side.widgets.some((w) => renamed.has(w.mediaId))) continue
          this.setSide(id, which, { ...side, widgets: side.widgets.map((w) => (renamed.has(w.mediaId) ? { ...w, mediaId: renamed.get(w.mediaId)! } : w)) })
        }
      }
      await this.flush()
      if (renamed.size) await api.removeMedia([...renamed.keys()])
      return { count: renamed.size, before, after }
    } catch {
      this.toast('فشرده کردن صداها کامل نشد؛ چیزی پاک نشد')
      return null
    } finally {
      this.working = ''
    }
  }

  /** pictures / sounds just added: shown from memory at once, before (and after) they are stored */
  private localMedia = new Map<string, string>()
  showLocal(id: string, url: string) {
    this.localMedia.set(id, url)
  }

  async mediaUrl(id: string): Promise<string | null> {
    return this.localMedia.get(id) ?? api.mediaUrl(id)
  }

  // ---------- tree ----------

  node(id: string | null | undefined) {
    return id ? this.nodeIndex.get(id) : undefined
  }

  children(parentId: string | null): TreeNode[] {
    return this.childIndex.get(parentId) ?? []
  }

  /** Nodes from the root down to (and including) the given node. */
  pathOf(id: string): TreeNode[] {
    const out: TreeNode[] = []
    let cur = this.node(id)
    while (cur) {
      out.unshift(cur)
      cur = this.node(cur.parentId)
    }
    return out
  }

  /** base, or "base ۲", "base ۳" … : the first one no sibling has (upper / lower case ignored, as Anki does for folders) */
  private uniqueName(base: string, siblings: string[]) {
    const taken = new Set(siblings.map((n) => n.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let i = 2; ; i++) {
      const candidate = `${base} ${faInt.format(i)}`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
  }
  private nameTaken(siblings: { id: string; name: string }[], id: string, name: string) {
    return siblings.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())
  }

  async createNode(parentId: string | null): Promise<TreeNode | null> {
    try {
      // names must be unique among sibling folders: Anki identifies decks by their full name. Picked and added in turn
      // (two quick taps: the second one sees the first folder)
      const node = await this.serial(async () => {
        const n = await api.createNode(parentId, this.uniqueName('پوشه جدید', this.children(parentId).map((c) => c.name)))
        this.nodes = [...this.nodes, n]
        return n
      })
      this.recorded()
      return node
    } catch {
      this.toast('ساخت پوشه انجام نشد')
      return null
    }
  }

  renameNode(id: string, name: string) {
    const n = this.node(id)
    const trimmed = name.replace(/::/g, ':').trim() // "::" separates folders in Anki's deck names
    if (!n || !trimmed || n.name === trimmed) return
    if (this.nameTaken(this.children(n.parentId), id, trimmed)) return this.toast('این نام قبلاً در همین جا استفاده شده')
    const old = n.name
    this.nodes = this.nodes.map((x) => (x.id === id ? { ...x, name: trimmed } : x))
    this.serial(() => api.renameNode(id, trimmed)).then(
      (r) => {
        // Anki may keep another name (e.g. a top-level folder called like its "Default" deck)
        if (r?.name && r.name !== trimmed) this.nodes = this.nodes.map((x) => (x.id === id ? { ...x, name: r.name! } : x))
        this.recorded()
      },
      () => {
        this.nodes = this.nodes.map((x) => (x.id === id ? { ...x, name: old } : x))
        this.toast('تغییر نام انجام نشد')
      },
    )
  }

  /** The node and everything below it. */
  private subtree(id: string): Set<string> {
    const out = new Set<string>()
    const walk = (nid: string) => {
      out.add(nid)
      for (const c of this.children(nid)) walk(c.id)
    }
    walk(id)
    return out
  }

  /** Deletes folders (with everything inside) and cards as one step. */
  deleteItems({ nodes, cards }: Items) {
    const doomed = new Set<string>()
    for (const id of nodes) for (const d of this.subtree(id)) doomed.add(d)
    const gone = new Set(cards)
    for (const c of this.cards) if (c.folderId && doomed.has(c.folderId)) gone.add(c.id)
    this.nodes = this.nodes.filter((n) => !doomed.has(n.id))
    this.cards = this.cards.filter((c) => !gone.has(c.id))
    this.revlog = this.revlog.filter((r) => !gone.has(r.cardId))
    for (const id of gone) this.pending.delete(id)
    // what was cut or copied and is now gone cannot be pasted
    if (this.clip) {
      const clip = { ...this.clip, nodes: this.clip.nodes.filter((id) => !doomed.has(id)), cards: this.clip.cards.filter((id) => !gone.has(id)) }
      this.clip = clip.nodes.length || clip.cards.length ? clip : null
    }
    this.serial(() => api.deleteItems(nodes, cards)).then(
      () => this.recorded(),
      () => {
        this.toast('حذف انجام نشد')
        this.refresh() // the items are still there: show them again
      },
    )
  }

  /** What sits directly in a folder (null = the top level). */
  countsIn(id: string | null): { folders: number; cards: number } {
    return { folders: this.children(id).length, cards: this.cardsOf(id).length }
  }

  // ---------- cards ----------

  /** The cards directly in a folder (null = the top level), oldest first. */
  cardsOf(folderId: string | null): Card[] {
    return this.folderIndex.get(folderId) ?? []
  }

  card(id: string | null | undefined) {
    return id ? this.cardIndex.get(id) : undefined
  }

  async createCard(folderId: string | null): Promise<Card | null> {
    try {
      // card names are unique within a folder, as folder names are; picked and added in turn, as for folders
      const card = await this.serial(async () => {
        // fixed or unruled, as the settings say right now (cards made earlier keep theirs)
        const layout = newCardLayout(this.settings)
        const c = await api.createCard(folderId, this.uniqueName('کارت جدید', this.cardsOf(folderId).map((x) => x.name)), emptySide(), emptySide(), layout)
        this.cards = [...this.cards, c]
        return c
      })
      this.recorded()
      return card
    } catch {
      this.toast('ساخت کارت انجام نشد')
      return null
    }
  }

  /**
   * Cards from a file go into a new folder of their own (inside parentId) with Anki's daily limit of new cards, so a
   * long word list is learned a few a day; folders filled by hand keep no limit. One undo step.
   */
  async importCards(parentId: string | null, name: string, rows: ImportRow[], perDay: number | null): Promise<TreeNode | null> {
    if (this.working) return null
    this.working = 'در حال وارد کردن…'
    try {
      await this.flush()
      const layout = newCardLayout(this.settings)
      const page = layout?.fixed ?? null
      const cards: { name: string; front: CardSide; back: CardSide; layout?: CardLayout }[] = []
      const names: string[] = [] // the same word twice in a file: "word", "word ۲" (names are unique within a folder)
      for (const r of rows) {
        const cardName = this.uniqueName(r.front.replace(/\s+/g, ' ').slice(0, 80), names)
        names.push(cardName)
        cards.push({ name: cardName, front: await sideFor(r.front, page), back: await sideFor(r.back, page), ...(layout ? { layout } : {}) })
      }
      const node = await this.serial(() => api.importCards(parentId, name, cards, perDay))
      this.apply(await api.snapshot())
      this.recorded()
      this.toast(`${faNum(cards.length)} کارت وارد شد`)
      return node
    } catch {
      this.toast('وارد کردن انجام نشد')
      return null
    } finally {
      this.working = ''
    }
  }

  /** A folder's own daily limit of new cards (null = no limit). */
  async setNewLimit(id: string, limit: number | null) {
    try {
      await this.serial(() => api.setNewLimit(id, limit))
      this.apply(await api.snapshot())
      this.recorded()
    } catch {
      this.toast('تغییر انجام نشد')
    }
  }

  renameCard(id: string, name: string) {
    const c = this.card(id)
    const trimmed = name.trim()
    if (!c || !trimmed || c.name === trimmed) return
    if (this.nameTaken(this.cardsOf(c.folderId), id, trimmed)) return this.toast('این نام قبلاً در همین پوشه استفاده شده')
    this.cards = this.cards.map((x) => (x.id === id ? { ...x, name: trimmed } : x))
    this.queue(id, { name: trimmed })
    this.flush() // a rename is one finished action: saved now, not with the next batch of editor changes
  }

  setLayout(cardId: string, layout: CardLayout) {
    const c = this.card(cardId)
    if (!c) return
    c.layout = layout // edited in place: the lists do not show it, so nothing needs to re-render
    this.queue(cardId, { layout: $state.snapshot(layout) as CardLayout })
  }

  setSide(cardId: string, which: 'front' | 'back', side: CardSide) {
    const c = this.card(cardId)
    if (!c) return
    c[which] = side
    this.queue(cardId, { [which]: $state.snapshot(side) as CardSide })
  }

  // ---------- cut / copy / paste, one step back / forward ----------

  cut(items: Items) {
    this.clip = { mode: 'cut', nodes: [...items.nodes], cards: [...items.cards] }
  }
  copy(items: Items) {
    this.clip = { mode: 'copy', nodes: [...items.nodes], cards: [...items.cards] }
  }

  /** Pastes what was cut / copied (folders and cards alike) into a folder, or the top level when null. */
  async paste(destId: string | null): Promise<boolean> {
    const clip = this.clip
    if (!clip || this.working) return false
    if (clip.mode === 'cut' && destId && clip.nodes.some((id) => this.subtree(id).has(destId))) {
      this.toast('پوشه را داخل خودش نمی‌شود گذاشت')
      return false
    }
    // cut and pasted back where it already is: nothing to do
    if (
      clip.mode === 'cut' &&
      clip.nodes.every((id) => (this.node(id)?.parentId ?? null) === destId) &&
      clip.cards.every((id) => (this.card(id)?.folderId ?? null) === destId)
    ) {
      this.clip = null
      return true
    }
    this.working = 'در حال چسباندن…'
    try {
      await this.flush()
      await this.serial(() =>
        clip.mode === 'copy' ? api.copyItems(clip.nodes, clip.cards, destId) : api.moveItems(clip.nodes, clip.cards, destId),
      )
      this.apply(await api.snapshot())
      this.recorded()
      this.clip = null
      this.toast('انجام شد')
      return true
    } catch {
      this.toast('چسباندن انجام نشد')
      return false
    } finally {
      this.working = ''
    }
  }

  /** One step back / forward on Anki's own undo stack (only the tree actions made since the last card edit or review). */
  async stepHistory(back: boolean) {
    if (this.working) return
    await this.flush() // a pending card edit would be the next thing on the stack
    if (!(back ? this.histUndo : this.histRedo)) return
    this.working = back ? 'در حال برگرداندن…' : 'در حال انجام دوباره…'
    try {
      await this.serial(() => (back ? api.undo() : api.redo()))
      if (back) {
        this.histUndo--
        this.histRedo++
      } else {
        this.histRedo--
        this.histUndo++
      }
      this.apply(await api.snapshot())
      this.clip = null
    } catch {
      this.toast(back ? 'برگرداندن انجام نشد' : 'انجام دوباره ممکن نشد')
    } finally {
      this.working = ''
    }
  }

  // ---------- today's reviews (the schedule itself is Anki's) ----------

  /** Anki's verdict: an already-studied card that is due today. */
  isDue(c: Card) {
    return c.state !== 'new' && c.ready
  }

  private put(card: Card) {
    const i = this.cards.findIndex((c) => c.id === card.id)
    this.cards = i >= 0 ? this.cards.map((c, k) => (k === i ? card : c)) : [...this.cards, card]
  }

  /** Anki's next card among the cards directly in a folder (null = the top level), with the interval each answer button would give. */
  async nextCard(folderId: string | null) {
    const r = await api.next(folderId)
    if (r.card) this.put(r.card)
    return r
  }

  /** Makes sure the card's pages are loaded (lists only carry names and schedules). */
  async ensureCard(id: string): Promise<Card | undefined> {
    const c = this.card(id)
    if (!c || !c.light) return c
    const full = await api.cardFull(id)
    this.put(full)
    return full
  }

  /** Scheduling info for one particular card (used after undo). */
  async cardInfo(id: string) {
    const r = await api.cardInfo(id)
    if (r.card) this.put(r.card)
    return r
  }

  /** Give Anki the grade (1 again, 2 hard, 3 good, 4 easy); it schedules the card. */
  async answerCard(cardId: string, rating: 1 | 2 | 3 | 4, millis = 0) {
    await this.flush()
    // in line with the tree actions (a paste still running): Anki's undo stack keeps them in the order they were done
    const r = await this.serial(() => api.answer(cardId, rating, millis))
    this.put(r.card)
    if (r.practice) return { card: r.card, practice: true } // nothing changed in Anki
    this.revlog = [...this.revlog, ...r.revlog]
    this.resetHistory()
    return { card: r.card, practice: false }
  }

  /** Undo the last answer with Anki's own undo. */
  async undoAnswer(cardId: string) {
    const r = await this.serial(() => api.undo())
    if (!r.ok) throw new Error('nothing to undo') // Anki keeps the last 30 steps only
    this.resetHistory()
    const last = this.revlog[this.revlog.length - 1]
    if (last?.cardId === cardId) this.revlog = this.revlog.slice(0, -1)
    return this.cardInfo(cardId)
  }

  /** Cards directly in a folder (null = the top level) that are due or new. */
  dueInfo(folderId: string | null): DueInfo {
    const cards = this.cardsOf(folderId)
    // new cards Anki shows today (a folder with a daily limit shows only that many)
    return { due: cards.filter((c) => this.isDue(c)).length, fresh: cards.filter((c) => c.state === 'new' && c.ready).length }
  }

  /** Places (folders, and the top level as id null) with cards of their own to study today (due or new). */
  get duePlaces(): ({ id: string | null; name: string } & DueInfo)[] {
    const ids: (string | null)[] = [null, ...this.nodes.map((n) => n.id)]
    return ids
      .map((id) => ({ id, name: id ? (this.node(id)?.name ?? '') : 'خانه', ...this.dueInfo(id) }))
      .filter((f) => f.due + f.fresh > 0)
      .sort((a, b) => b.due - a.due || b.fresh - a.fresh)
  }

  /**
   * How much today's reviews matter (0..100): how dangerous it is to leave them. Each card due today has a chance of
   * being forgotten now; measured against its goal (FSRS: the desired retention, classic: 90 %), a card exactly on time
   * is a third of the way, three times the forgetting the goal allows (or more) is all the way. The bar adds up the
   * cards still waiting, over all of today's cards (the ones already reviewed today count as safe): it starts at the
   * day's whole risk and goes down with every card reviewed, to 0 when they are all done. New cards (nothing to forget
   * yet) do not count, nor do cards first studied today.
   */
  get todayRisk(): { percent: number; cards: number } {
    let sum = 0
    let n = 0
    for (const c of this.cards) {
      if (!c.ready || c.state === 'new') continue
      n++
      const allowed = Math.max(0.01, 1 - (c.fsrs ? this.settings.retention : 0.9)) // the forgetting the goal accepts
      sum += c.recall === undefined ? 1 / 3 : Math.min(1, Math.max(0, (1 - c.recall) / (3 * allowed)))
    }
    // done for today: answered today, not waiting again, and the answer was not the card's very first one (a new card's
    // first answer: it was never among the cards above)
    const since = this.dayStart
    const seen = new Set<string>()
    const today = new Set<string>()
    for (const r of this.revlog) {
      if (r.at >= since && seen.has(r.cardId)) today.add(r.cardId)
      seen.add(r.cardId)
    }
    let done = 0
    for (const id of today) {
      const c = this.card(id)
      if (c && !c.ready) done++
    }
    const total = n + done
    return { percent: total ? Math.round((sum / total) * 100) : 0, cards: n }
  }

  /** Cards to study today everywhere (ready for review + new). */
  get todayCards() {
    return this.duePlaces.reduce((sum, f) => sum + f.due + f.fresh, 0)
  }

  /**
   * Cards reviewed today (done: the same cards as the "reviewed today" list, also one answered "again" and ready again)
   * out of every card of today (total: those and the cards still waiting, each counted once).
   */
  get todayProgress() {
    const since = this.dayStart
    const reviewed = new Set(this.revlog.filter((r) => r.at >= since && this.card(r.cardId)).map((r) => r.cardId))
    const waiting = this.cards.filter((c) => c.ready && !reviewed.has(c.id)).length
    return { done: reviewed.size, total: reviewed.size + waiting }
  }

  get totals() {
    return {
      due: this.cards.filter((c) => this.isDue(c)).length,
      fresh: this.cards.filter((c) => c.state === 'new').length,
      all: this.cards.length,
    }
  }

  get doneToday() {
    return this.revlog.filter((r) => r.at >= this.dayStart).length
  }
}

export const app = new AppStore()
