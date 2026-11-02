<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Art from './Art.svelte'
  import Icon from './Icon.svelte'
  import { dueLabel, fa } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import { onBack } from '../lib/back'
  import { hold } from '../lib/hold'
  import { phone } from '../lib/phone.svelte'
  import ImportDialog from './ImportDialog.svelte'
  import ItemMenu from './ItemMenu.svelte'
  import LimitDialog from './LimitDialog.svelte'
  import { parseCards, readText, type ImportRow } from '../lib/importCards'
  import VirtualGrid from './VirtualGrid.svelte'
  import type { Items } from '../lib/store.svelte'
  import type { Card, TreeNode } from '../lib/types'

  type Props = {
    /** ids from the top folder down to the folder currently shown (empty = home) */
    path: string[]
    onpath: (p: string[]) => void
    onopencard: (id: string) => void
    onconfirm: (message: string, action: () => void) => void
  }
  let { path, onpath, onopencard, onconfirm }: Props = $props()

  /** id of the node or card whose name is being edited inline */
  let editingId = $state<string | null>(null)
  /** the same, read where Svelte would show the value from before (while the rename box is being removed) */
  let editingNow: string | null = null
  const setEditing = (id: string | null) => (editingId = editingNow = id)
  let inputEl = $state<HTMLInputElement>()
  let pathBar = $state<HTMLElement>()
  let grid = $state<{ reveal: (i: number) => void }>()
  /** a tap elsewhere ends a renaming: that same tap does not also open the item it landed on */
  let renameEndedAt = 0

  // the address is one scrollable line; keep the deepest (latest) part in view
  $effect(() => {
    void path.length
    tick().then(() => pathBar?.querySelector('.crumb.is-active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }))
  })
  /** phone: the "⋮" button of an item opens this small menu (rename / copy / cut / delete); on a selected item it acts on the whole selection */
  let menu = $state<{ keys: string[]; name: string } | null>(null)
  function openMenu(key: string, name: string) {
    const keys = selSet.has(key) ? [...selected] : [key]
    menu = { keys, name: keys.length > 1 ? `${fa(keys.length)} مورد انتخاب‌شده` : name }
  }

  // ---------- selection (phone): a long press starts it, further taps add / remove items ----------
  // keys are "n:<folder id>" or "c:<card id>": folders and cards are picked together
  let selected = $state<string[]>([])
  const selSet = $derived(new Set(selected))
  const selecting = $derived(phone.on && selected.length > 0)
  $effect(() => {
    void path // another folder: nothing stays selected
    selected = []
  })
  // items that went away (undo, a refresh) leave the selection
  $effect(() => {
    void app.nodes
    void app.cards
    const sel = untrack(() => selected)
    const keep = sel.filter((k) => (k.startsWith('n:') ? app.node(k.slice(2)) : app.card(k.slice(2))))
    if (keep.length !== sel.length) selected = keep
  })
  const toggle = (key: string) => (selected = selSet.has(key) ? selected.filter((x) => x !== key) : [...selected, key])
  const press = (key: string) => (phone.on && !editingId ? () => toggle(key) : null)
  const pick = (key: string, open: () => void) => {
    if (performance.now() - renameEndedAt < 500) return
    if (selecting) toggle(key)
    else open()
  }

  const itemsOf = (keys: string[]): Items => ({
    nodes: keys.filter((k) => k.startsWith('n:')).map((k) => k.slice(2)),
    cards: keys.filter((k) => k.startsWith('c:')).map((k) => k.slice(2)),
  })
  const nameOf = (key: string) => (key.startsWith('c:') ? app.card(key.slice(2))?.name : app.node(key.slice(2))?.name) ?? ''
  function doCopy(keys: string[]) {
    app.copy(itemsOf(keys))
    selected = []
    app.toast(keys.length > 1 ? `${fa(keys.length)} مورد کپی شد` : 'کپی شد')
  }
  function doCut(keys: string[]) {
    app.cut(itemsOf(keys))
    selected = []
    app.toast(keys.length > 1 ? `${fa(keys.length)} مورد کات شد` : 'کات شد')
  }
  function doDelete(keys: string[]) {
    const text = keys.length > 1 ? `${fa(keys.length)} مورد با همه‌ی محتوایشان حذف شود؟` : `«${nameOf(keys[0])}» حذف شود؟`
    onconfirm(text + ' (با دکمه‌ی برگشت می‌توانی برگردانی)', () => {
      selected = []
      app.deleteItems(itemsOf(keys))
    })
  }
  async function doPaste() {
    if (await app.paste(currentId)) selected = []
  }

  /** the folder shown; null = home (the top level) */
  const currentId = $derived(path.length ? path[path.length - 1] : null)
  const crumbs = $derived(path.map((id) => app.node(id)).filter((n) => !!n))

  // tile geometry (the virtual grid needs equally sized tiles)
  const minW = $derived(phone.on ? 100 : 158)
  const rowH = $derived(phone.on ? 124 : 196)
  const gap = $derived(phone.on ? 10 : 14)
  /** what the folder holds: its folders first, then its cards */
  type Entry = { kind: 'node'; n: TreeNode } | { kind: 'card'; c: Card }
  const entries = $derived<Entry[]>([
    ...app.children(currentId).map((n) => ({ kind: 'node' as const, n })),
    ...app.cardsOf(currentId).map((c) => ({ kind: 'card' as const, c })),
  ])

  /** put the new item into inline rename mode with its whole name selected */
  async function startEdit(id: string) {
    setEditing(id)
    await tick()
    // a tile far down a long list is only built once it is near the screen
    const i = entries.findIndex((e) => (e.kind === 'node' ? e.n.id : e.c.id) === id)
    if (i >= 0) grid?.reveal(i)
    await tick()
    inputEl?.focus()
    inputEl?.select()
    inputEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  async function newFolder() {
    const n = await app.createNode(currentId)
    if (n) await startEdit(n.id)
  }
  async function newCard() {
    const c = await app.createCard(currentId)
    if (c) await startEdit(c.id)
  }

  // ---------- cards from a file: they get a folder of their own with a daily limit of new cards ----------
  let fileInput = $state<HTMLInputElement>()
  let importing = $state<{ fileName: string; rows: ImportRow[]; skipped: number } | null>(null)
  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const { rows, skipped } = parseCards(await readText(file))
    importing = { fileName: file.name, rows, skipped }
  }
  async function doImport(name: string, perDay: number) {
    const job = importing
    importing = null
    if (!job) return
    const node = await app.importCards(currentId, name, job.rows, perDay)
    if (node) onpath([...path, node.id])
  }

  /** a folder's daily limit of new cards, from its ⋮ menu */
  let limitFor = $state<TreeNode | null>(null)

  function commit(kind: 'node' | 'card', value = inputEl?.value ?? '') {
    const id = editingNow
    if (!id) return
    setEditing(null)
    if (kind === 'node') app.renameNode(id, value)
    else app.renameCard(id, value)
  }

  function onKey(e: KeyboardEvent, kind: 'node' | 'card') {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(kind)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(null)
    }
  }

  function enter(id: string) {
    if (editingId) return
    onpath([...path, id])
  }
  /** the rename box removed while still in use (its tile scrolled out of a long list, the tab left): what was typed is kept */
  function keepTyped(input: HTMLInputElement, kind: 'node' | 'card') {
    return { destroy: () => editingNow && commit(kind, input.value) }
  }
  function goUp() {
    onpath(path.slice(0, -1))
  }
  // the phone's back button: one folder up (at home it is left to the app)
  $effect(() => onBack(() => (path.length ? (goUp(), true) : false)))
  function remove(kind: 'node' | 'card', id: string, name: string) {
    const text =
      kind === 'card'
        ? `کارت «${name}» حذف شود؟`
        : `«${name}» با همه‌ی محتوایش حذف شود؟ این کار قابل بازگشت نیست.`
    onconfirm(text, () => app.deleteItems(kind === 'card' ? { nodes: [], cards: [id] } : { nodes: [id], cards: [] }))
  }
</script>

{#snippet renameField(kind: 'node' | 'card', value: string)}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="rename-input"
    bind:this={inputEl}
    {value}
    spellcheck="false"
    autocomplete="off"
    onkeydown={(e) => onKey(e, kind)}
    onblur={() => {
      if (editingNow) renameEndedAt = performance.now() // a tap elsewhere (not Enter / Escape, which end it first)
      commit(kind)
    }}
    use:keepTyped={kind}
    onclick={(e) => e.stopPropagation()}
    aria-label="نام"
  />
{/snippet}

<section class="panel">
  <header class="page-head">
    <div>
      <h2>اطلاعات</h2>
    </div>
  </header>

  <!-- the path and the buttons stay at the top while the folders and cards scroll (phones scroll the whole page) -->
  <div class="pinned">
  <div class="path-bar" bind:this={pathBar}>
    {#if path.length}
      <button class="up" onclick={goUp} aria-label="یک سطح بالاتر" title="یک سطح بالاتر">
        <Icon name="up" size={16} />
      </button>
    {/if}
    <button class="crumb" class:is-active={!path.length} onclick={() => onpath([])}>
      <Icon name="home" size={13} stroke={2.2} /><span>خانه</span>
    </button>
    {#each crumbs as c, i (c.id)}
      <span class="crumb-sep"><Icon name="chevron" size={13} /></span>
      <button class="crumb" class:is-active={i === crumbs.length - 1} onclick={() => onpath(path.slice(0, i + 1))}>
        <span>{c.name}</span>
      </button>
    {/each}
  </div>

  <div class="toolbar">
    {#if !phone.on}
      <div class="toolbar-title">
        {currentId ? 'محتوای پوشه' : 'خانه'}
        <span class="pill">{fa(entries.length)} مورد</span>
      </div>
    {/if}
    <!-- rename / copy / cut / delete live in each item's ⋮ menu; paste shows up once something was cut or copied -->
    <div class="actions">
      <!-- while a long action runs (import, paste, undo) nothing else starts -->
      <button class="btn btn-soft" disabled={!!app.working} onclick={newFolder}>
        <Icon name="folderPlus" size={17} />
        <span class="long">ساخت پوشه</span><span class="short">پوشه</span>
      </button>
      <button class="btn btn-primary" disabled={!!app.working} onclick={newCard}>
        <Icon name="cardPlus" size={17} />
        <span class="long">ساخت کارت</span><span class="short">کارت</span>
      </button>
      <button class="btn btn-soft" disabled={!!app.working} onclick={() => fileInput?.click()} title="کارت‌ها از یک فایل متنی (هر خط: روی کارت، Tab، پشت کارت)">
        <Icon name="import" size={17} />
        <span class="long">وارد کردن</span><span class="short">ورود</span>
      </button>
      <input bind:this={fileInput} type="file" accept=".csv,.tsv,.txt,text/plain,text/csv" hidden onchange={onFile} />
      {#if app.clip}
        <button class="btn btn-soft paste" disabled={!!app.working} onclick={doPaste}>
          <Icon name="paste" size={17} />
          <span class="long">پیست اینجا</span><span class="short">پیست</span>
        </button>
      {/if}
      {#if phone.on}
        <button class="btn btn-soft sq" disabled={!app.histUndo || !!app.working} onclick={() => app.stepHistory(true)} aria-label="یک مرحله عقب"><Icon name="undo" size={18} /></button>
        <button class="btn btn-soft sq" disabled={!app.histRedo || !!app.working} onclick={() => app.stepHistory(false)} aria-label="یک مرحله جلو"><Icon name="redo" size={18} /></button>
      {/if}
    </div>
  </div>
  </div>

  <div class="scroll">
    <!-- only the tiles near the visible area exist, so even 10 000 cards stay smooth -->
    {#if entries.length}
      <VirtualGrid bind:this={grid} items={entries} {minW} {rowH} {gap} tile={entryTile} />
    {:else}
      <div class="grid">
        <div class="empty">
          <b>{currentId ? 'این پوشه خالی است' : 'هنوز چیزی نساخته‌ای'}</b><br />
          با «ساخت پوشه» یا «ساخت کارت» شروع کن؛ کارت را هم داخل پوشه و هم بیرون آن می‌شود ساخت.
        </div>
      </div>
    {/if}
  </div>
</section>

{#snippet entryTile(e: Entry)}
  {#if e.kind === 'node'}{@render nodeTile(e.n)}{:else}{@render cardTile(e.c)}{/if}
{/snippet}

{#snippet cardTile(c: Card)}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="item-card"
  class:is-new={editingId === c.id}
  class:sel={selSet.has('c:' + c.id)}
  role="button"
  tabindex="0"
  use:hold={press('c:' + c.id)}
  onclick={() => !editingId && pick('c:' + c.id, () => onopencard(c.id))}
  onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && !editingId && pick('c:' + c.id, () => onopencard(c.id))}
>
  {#if phone.on && (!selecting || selSet.has('c:' + c.id))}
    <button class="item-dots" aria-label="گزینه‌ها" onclick={(e) => { e.stopPropagation(); openMenu('c:' + c.id, c.name) }}>
      <Icon name="dots" size={18} />
    </button>
  {/if}
  {#if selSet.has('c:' + c.id)}<span class="tick"><Icon name="check" size={13} stroke={3} /></span>{/if}
  <div class="item-tools">
    <button class="mini-btn danger" aria-label="حذف کارت" onclick={(e) => { e.stopPropagation(); remove('card', c.id, c.name) }}>
      <Icon name="trash" size={14} />
    </button>
    <button class="mini-btn" aria-label="تغییر نام" onclick={(e) => { e.stopPropagation(); startEdit(c.id) }}>
      <Icon name="edit" size={14} />
    </button>
  </div>
  <div class="item-icon"><Art kind="card" /></div>
  {#if editingId === c.id}
    {@render renameField('card', c.name)}
  {:else}
    <div class="item-name">{c.name}</div>
  {/if}
  <div class="item-meta" class:is-due={app.isDue(c)}>
    {c.state === 'new' ? 'جدید' : app.isDue(c) ? 'برای امروز' : dueLabel(c.due)}
  </div>
</div>
{/snippet}

{#snippet nodeTile(n: TreeNode)}
  {@const counts = app.countsIn(n.id)}
  {@const info = app.dueInfo(n.id)}
  {@const today = info.due + info.fresh}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="item-card"
  class:is-new={editingId === n.id}
  class:sel={selSet.has('n:' + n.id)}
  role="button"
  tabindex="0"
  use:hold={press('n:' + n.id)}
  onclick={() => pick('n:' + n.id, () => enter(n.id))}
  onkeydown={(e) => e.key === 'Enter' && e.target === e.currentTarget && pick('n:' + n.id, () => enter(n.id))}
>
  {#if phone.on && (!selecting || selSet.has('n:' + n.id))}
    <button class="item-dots" aria-label="گزینه‌ها" onclick={(e) => { e.stopPropagation(); openMenu('n:' + n.id, n.name) }}>
      <Icon name="dots" size={18} />
    </button>
  {/if}
  {#if selSet.has('n:' + n.id)}<span class="tick"><Icon name="check" size={13} stroke={3} /></span>{/if}
  <div class="item-tools">
    <button class="mini-btn danger" aria-label="حذف" onclick={(e) => { e.stopPropagation(); remove('node', n.id, n.name) }}>
      <Icon name="trash" size={14} />
    </button>
    <button class="mini-btn" aria-label="تغییر نام" onclick={(e) => { e.stopPropagation(); startEdit(n.id) }}>
      <Icon name="edit" size={14} />
    </button>
  </div>
  <div class="item-icon"><Art kind="folder" /></div>
  {#if editingId === n.id}
    {@render renameField('node', n.name)}
  {:else}
    <div class="item-name">{n.name}</div>
  {/if}
  <div class="item-meta" class:is-due={today > 0} class:is-empty={!counts.folders && !counts.cards}>
    {#if !counts.folders && !counts.cards}خالی
    {:else if today > 0}{fa(today)} کارت امروز
    {:else}{[counts.folders ? `${fa(counts.folders)} پوشه` : '', counts.cards ? `${fa(counts.cards)} کارت` : ''].filter(Boolean).join(' · ')}{/if}
  </div>
</div>
{/snippet}

{#if menu}
  {@const folder = menu.keys.length === 1 && menu.keys[0].startsWith('n:') ? app.node(menu.keys[0].slice(2)) : undefined}
  <ItemMenu
    name={menu.name}
    limitLabel={folder?.newLimit ? fa(folder.newLimit) : 'بدون سقف'}
    onlimit={folder
      ? () => {
          const f = folder // taken before the menu (and with it this value) goes
          menu = null
          limitFor = f
        }
      : undefined}
    onclose={() => (menu = null)}
    onrename={menu.keys.length === 1
      ? () => {
          const key = menu!.keys[0]
          menu = null
          selected = []
          startEdit(key.slice(2))
        }
      : undefined}
    oncopy={() => {
      const keys = menu!.keys
      menu = null
      doCopy(keys)
    }}
    oncut={() => {
      const keys = menu!.keys
      menu = null
      doCut(keys)
    }}
    ondelete={() => {
      const keys = menu!.keys
      menu = null
      doDelete(keys)
    }}
  />
{/if}

{#if importing}
  <ImportDialog
    fileName={importing.fileName}
    rows={importing.rows}
    skipped={importing.skipped}
    onconfirm={doImport}
    onclose={() => (importing = null)}
  />
{/if}

{#if limitFor}
  <LimitDialog
    name={limitFor.name}
    limit={limitFor.newLimit ?? null}
    onsave={(l) => {
      const id = limitFor!.id
      limitFor = null
      app.setNewLimit(id, l)
    }}
    onclose={() => (limitFor = null)}
  />
{/if}

<style>
  @media (max-width: 860px) {
    .pinned {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--bg);
      padding-bottom: 12px;
      margin-bottom: 4px;
    }
    .pinned :global(.toolbar) {
      margin-bottom: 0;
    }
  }
  .path-bar {
    background: var(--surface);
    border-radius: 16px;
    padding: 8px 10px;
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    margin-bottom: 18px;
  }
  .path-bar::-webkit-scrollbar {
    display: none;
  }
  .path-bar > * {
    flex: none;
  }
  .crumb {
    border: 0;
    background: transparent;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-dim);
    padding: 7px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    white-space: nowrap;
  }
  .crumb span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .crumb.is-active {
    background: var(--primary-soft);
    color: var(--primary-text);
  }
  .crumb-sep {
    color: var(--line-2);
    user-select: none;
  }
  .up {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text-dim);
    display: grid;
    place-items: center;
    cursor: pointer;
    margin-inline-end: 6px;
    transition: 0.2s;
  }
  .up:hover {
    color: var(--primary-text);
    border-color: var(--primary);
  }
</style>
