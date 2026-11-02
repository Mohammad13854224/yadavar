<script lang="ts">
  import { untrack } from 'svelte'
  import { onBack } from '../lib/back'
  import { dueLabel, fa, intervalLabel } from '../lib/format'
  import { hasLines, sideCrop, sidePaper } from '../lib/sides'
  import { app } from '../lib/store.svelte'
  import type { Card } from '../lib/types'
  import Icon from './Icon.svelte'
  import SideView from './SideView.svelte'
  import ImageZoom from './ImageZoom.svelte'

  type Rating = 1 | 2 | 3 | 4
  /** folderId null = the cards at the top level (home); cardId: just this one card (a neuron picked in the brain) */
  type Props = { folderId: string | null; cardId?: string | null; onclose: () => void }
  let { folderId, cardId = null, onclose }: Props = $props()
  const single = untrack(() => cardId !== null)

  // the same names as the folder's tile in the reviews tab (one card: its name, and the folder it is in)
  const title = $derived(single ? (app.card(cardId)?.name ?? '') : folderId ? (app.node(folderId)?.name ?? '') : 'کارت‌های بیرون پوشه‌ها')
  const path = $derived(
    folderId ? ['خانه', ...app.pathOf(folderId).slice(0, single ? undefined : -1).map((n) => n.name)].join(' / ') : 'خانه',
  )

  // Anki decides which card comes next (and when learning cards return); we only show it
  let currentId = $state<string | null>(null)
  let delays = $state<number[]>([])
  let waiting = $state({ new: 0, learning: 0, review: 0 })
  let loading = $state(true)
  /** the first card could not be asked for (the server cannot be reached) */
  let failed = $state(false)
  let busy = false
  let history = $state<{ cardId: string; rating: Rating; practice?: boolean }[]>([])
  /** the card was already reviewed today and is not due again: this answer is practice (the schedule stays) */
  let practice = $state(false)
  /** how many of the answers can still be taken back: Anki keeps its last 30 steps only */
  const UNDO_MAX = 30
  let undoable = $state(0)
  let answered = $state(0)

  // state of the card on screen
  let flipped = $state(false) // showing the back?
  let seenBack = $state(false) // the back was seen at least once -> grade buttons appear
  let selected = $state<Rating | null>(null)
  let zoomUrl = $state<string | null>(null)
  let frontView = $state<SideView>()
  let backView = $state<SideView>()
  let shownAt = Date.now() // when the card on screen appeared (Anki records the time taken)
  let turn = $state(0) // bumped for every new card so the flip card is rebuilt (no flip-back animation)

  const card = $derived<Card | undefined>(app.card(currentId))
  const labels = $derived(delays.map(intervalLabel))
  // every side is shown exactly as big as it was made in the editor
  const frontSize = $derived(card ? sidePaper(card, 'front') : { w: 560, h: 380 })
  const backSize = $derived(card ? sidePaper(card, 'back') : { w: 560, h: 380 })

  const total = $derived(answered + waiting.new + waiting.learning + waiting.review)
  const percent = $derived(total ? Math.round((answered / total) * 100) : 100)

  async function load() {
    if (single) {
      // one answer and it is done (Anki schedules it like any other answer, early or not)
      if (answered) {
        currentId = null
        waiting = { new: 0, learning: 0, review: 0 }
      } else {
        const r = await app.cardInfo(cardId!)
        currentId = r.card?.id ?? null
        delays = r.delays ?? []
        practice = !!r.practice
        waiting = { new: 0, learning: 0, review: 1 }
      }
      loading = false
      resetCard()
      return
    }
    const r = await app.nextCard(folderId)
    currentId = r.card?.id ?? null
    delays = r.delays ?? []
    waiting = r.counts ?? { new: 0, learning: 0, review: 0 }
    loading = false
    resetCard()
  }
  function start() {
    failed = false
    loading = true
    load().catch(() => {
      loading = false
      failed = true
    })
  }
  start()

  const grades: { rating: Rating; name: string; cls: string }[] = [
    { rating: 1, name: 'دوباره', cls: 'again' },
    { rating: 2, name: 'سخت', cls: 'hard' },
    { rating: 3, name: 'خوب', cls: 'good' },
    { rating: 4, name: 'آسان', cls: 'easy' },
  ]

  function flip(e?: Event) {
    // playing audio must not turn the card
    // pictures zoom, sounds play: only text and empty paper turn the card
    if ((e?.target as Element | null)?.closest?.('audio, .w.image, .w.audio')) return
    flipped = !flipped
    if (flipped) seenBack = true
  }

  function select(r: Rating) {
    if (seenBack) selected = r
  }

  async function nextCard() {
    const c = card
    if (!c || !selected || busy) return
    busy = true
    try {
      const r = await app.answerCard(c.id, selected, Date.now() - shownAt)
      history.push({ cardId: c.id, rating: selected, practice: r.practice })
      undoable = Math.min(UNDO_MAX, undoable + 1)
      answered++
      await load()
    } catch {
      app.toast('نمره ثبت نشد')
    } finally {
      busy = false
    }
  }

  async function undo() {
    if (busy || !undoable) return
    const step = history[history.length - 1]
    if (!step) return
    busy = true
    try {
      // practice changed nothing in Anki: nothing to take back there
      const info = step.practice ? await app.cardInfo(step.cardId) : await app.undoAnswer(step.cardId)
      history.pop()
      const counts = single ? { new: 0, learning: 0, review: 1 } : ((await app.nextCard(folderId)).counts ?? waiting)
      // the count and the card change together (never the old card under the new count)
      undoable--
      answered--
      waiting = counts
      currentId = step.cardId
      delays = info.delays ?? []
      if (single) practice = !!info.practice
      resetCard()
    } catch {
      app.toast('برگرداندن انجام نشد')
    } finally {
      busy = false
    }
  }

  function resetCard() {
    flipped = false
    seenBack = false
    selected = null
    shownAt = Date.now()
    turn++
  }

  function close() {
    app.flush()
    if (history.length) app.checkFsrs() // new reviews: the count goes up, and at 900 FSRS switches on
    onclose()
  }

  // the back button: a zoomed picture first, then the review itself
  $effect(() => onBack(() => (zoomUrl ? (zoomUrl = null) : close(), true)))

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (zoomUrl) return
    if (e.key === 'Escape') return close()
    if (e.key === 'z' || e.key === 'Z') return undo()
    if (!card) return
    if (e.key === ' ') {
      e.preventDefault()
      flip()
    } else if (['1', '2', '3', '4'].includes(e.key)) select(+e.key as Rating)
    else if (e.key === 'Enter') {
      e.preventDefault()
      nextCard()
    }
  }

  // summary shown at the end
  const counts = $derived(([1, 2, 3, 4] as Rating[]).map((r) => history.filter((h) => h.rating === r).length))
  const nextDue = $derived.by(() => {
    if (single) {
      const c = app.card(cardId)
      return c && !c.ready ? dueLabel(c.due) : null
    }
    const later = app.cardsOf(folderId).filter((c) => !c.ready)
    const dues = later.filter((c) => c.state !== 'new').map((c) => c.due)
    // new cards held back by the folder's daily limit start with the next Anki day
    if (later.some((c) => c.state === 'new')) dues.push(app.dayStart + 86_400_000)
    return dues.length ? dueLabel(Math.min(...dues)) : null
  })
</script>

<svelte:window onkeydown={onKey} />

{#if zoomUrl}
  <ImageZoom url={zoomUrl} onclose={() => (zoomUrl = null)} />
{/if}

<div class="session" role="dialog" aria-modal="true" aria-label="مرور">
  <header>
    <button class="icon-btn" onclick={close} aria-label="خروج از مرور"><Icon name="close" size={18} stroke={2.4} /></button>
    <div class="title">
      <b>{title}</b>
      {#if path}<small>{path}</small>{/if}
    </div>
    <button class="icon-btn" onclick={undo} disabled={!undoable} aria-label="برگرداندن آخرین نمره" title="برگرداندن (Z)">
      <Icon name="undo" size={18} />
    </button>
  </header>

  {#if loading}
    <div class="finish"><div class="done"><p>در حال آماده‌سازی…</p></div></div>
  {:else if failed}
    <div class="finish">
      <div class="done">
        <h2>ارتباط با سرور انکی برقرار نشد</h2>
        <button class="btn btn-primary" onclick={start}>تلاش دوباره</button>
        <button class="btn btn-soft" onclick={close}>بازگشت به مرورها</button>
      </div>
    </div>
  {:else if card}
    <div class="grid">
      <!-- right: the only panel -->
      <aside class="panel">
        <section class="block progress">
          <h4>پیشرفت مرور</h4>
          <div class="count"><b>{fa(answered)}</b><span>از {fa(total)} کارت</span></div>
          <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax={total} aria-valuenow={answered}>
            <span style:width="{percent}%"></span>
          </div>
          <small>{fa(percent)}٪ انجام شد</small>
        </section>

        <section class="block">
          <h4>میزان سختی</h4>
          <div class="grades" class:locked={!seenBack}>
            {#each grades as g, i (g.rating)}
              <button
                class="grade {g.cls}"
                class:on={selected === g.rating}
                class:dim={selected !== null && selected !== g.rating}
                disabled={!seenBack}
                aria-pressed={selected === g.rating}
                onclick={(e) => {
                  select(g.rating)
                  ;(e.currentTarget as HTMLElement).blur()
                }}
              >
                <b>{g.name}</b>
                <small>{practice ? 'تمرین' : labels[i]}</small>
                <kbd>{fa(g.rating)}</kbd>
              </button>
            {/each}
          </div>
          {#if !seenBack}<p class="need">بعد از دیدن پشت کارت فعال می‌شود</p>{/if}
          {#if practice}<p class="practice">این کارت امروز مرور شده؛ این بار فقط تمرین است و زمان مرور بعدی‌اش عوض نمی‌شود.</p>{/if}
        </section>

        <ul class="tips">
          <li>روی کارت بزن تا برگردد؛ بکش یا زوم کن تا هر جای آن را ببینی.</li>
          <li class="keys"><kbd>Space</kbd> برگرداندن · <kbd>۱–۴</kbd> سختی · <kbd>Enter</kbd> بعدی</li>
        </ul>

        <div class="nextrow">
          <!-- phones: done / still to do as a real fraction beside the button -->
          <span class="frac" dir="ltr" aria-label="{fa(answered)} از {fa(total)}">
            <b>{fa(answered)}</b>
            <i></i>
            <b>{fa(total)}</b>
          </span>
          <button class="next" disabled={!selected} onclick={nextCard}>
            رفتن به کارت بعدی<Icon name="chevron" size={18} stroke={2.4} />
          </button>
        </div>
      </aside>

      <!-- left: the card, in the middle of the free space -->
      <section class="center">
        <div class="stack">
          {#key turn}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="flip"
              role="button"
              tabindex="0"
              aria-label={flipped ? 'نمایش روی کارت' : 'نمایش پشت کارت'}
              onclick={flip}
            >
              <!-- the dotted backdrop, the label and the button stay still; only the card turns over -->
              <div class="face front" class:away={flipped}><SideView bind:this={frontView} bare side={card.front} size={frontSize} crop={sideCrop(card, 'front')} lines={hasLines(card)} onzoom={(u) => (zoomUrl = u)} /></div>
              <div class="face back" class:away={!flipped}><SideView bind:this={backView} bare side={card.back} size={backSize} crop={sideCrop(card, 'back')} lines={hasLines(card)} onzoom={(u) => (zoomUrl = u)} /></div>
              <p class="side-tag">{flipped ? 'پشت کارت' : 'روی کارت'}</p>
              <div class="side-ctl" role="presentation" onclick={(e) => e.stopPropagation()} onpointerdown={(e) => e.stopPropagation()}>
                <button onclick={() => (flipped ? backView : frontView)?.reset()} aria-label="نمایش کامل" title="نمایش کامل">⤢</button>
              </div>
            </div>
          {/key}
        </div>
      </section>
    </div>
  {:else}
    <div class="finish">
      <div class="done">
        <div class="done-icon"><Icon name="check" size={34} stroke={2.6} /></div>
        <h2>{single ? (history.length ? (history[0].practice ? 'تمرین انجام شد' : 'نرون تقویت شد') : 'این کارت پیدا نشد') : history.length ? 'مرور این پوشه تمام شد' : 'کارتی برای مرور نیست'}</h2>
        {#if history.length && !single}
          <p>{fa(history.length)} کارت مرور کردی</p>
          <div class="summary">
            {#each grades as g, i (g.rating)}
              <div class="sum {g.cls}"><b>{fa(counts[i])}</b><small>{g.name}</small></div>
            {/each}
          </div>
        {/if}
        {#if single && history[0]?.practice}<p>امروز یک بار مرورش کرده بودی؛ زمان‌بندی‌اش همان ماند.</p>{/if}
        {#if nextDue}<p class="next-due">{single ? 'مرور بعدی این کارت' : 'مرور بعدی این پوشه'}: <b>{nextDue}</b></p>{/if}
        <button class="btn btn-primary" onclick={close}>{single ? 'بازگشت به مغز' : 'بازگشت به مرورها'}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .session {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    background-image:
      radial-gradient(900px 520px at 100% -12%, var(--bg-glow-1) 0%, transparent 60%),
      radial-gradient(820px 520px at 8% 5%, var(--bg-glow-2) 0%, transparent 55%);
    animation: fade 0.25s ease;
    padding-top: var(--safe-top);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px 8px;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
    flex: none;
  }
  .icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 13px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text-dim);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: 0.2s;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--line-2);
    background: var(--surface-2);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: center;
  }
  .title b {
    font-size: calc(15px * var(--font-scale));
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title small {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* two columns: one panel on the right, the card on the left (the page is right-to-left) */
  .grid {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 8px 18px 18px;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 18px;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 22px;
    padding: 20px;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .block + .block {
    border-top: 1px dashed var(--line);
    padding-top: 16px;
  }
  .block h4 {
    font-size: 13px;
    font-weight: 700;
    color: var(--primary-text);
  }
  .count {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .count b {
    font-size: calc(38px * var(--font-scale));
    font-weight: 800;
    letter-spacing: -1px;
    line-height: 1;
  }
  .count span {
    font-size: 13px;
    color: var(--text-dim);
    font-weight: 600;
  }
  .meter {
    height: 12px;
    background: var(--surface-3);
    border-radius: 20px;
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    border-radius: 20px;
    background: linear-gradient(90deg, var(--primary-2), var(--primary));
    box-shadow: 0 0 14px -2px var(--primary);
    transition: width 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .block small {
    font-size: 11.5px;
    color: var(--muted);
    font-weight: 500;
  }
  .counters {
    gap: 11px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .c {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .c b {
    margin-inline-start: auto;
    color: var(--text);
    font-weight: 800;
  }

  /* the card takes all the free height, down to the grade buttons */
  .center {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    overflow-x: clip; /* the swinging card must not create a sideways scrollbar */
    display: flex;
  }
  .stack {
    min-width: 0;
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: column;
  }

  /* the flipping card: the side that leaves swings edge-on, then the other one swings in (sizes may differ) */
  .flip {
    position: relative;
    border-radius: 18px;
    background-color: var(--surface-2);
    border: 1px solid var(--line);
    background-image: radial-gradient(var(--line-2) 1px, transparent 1px);
    background-size: 22px 22px;
    overflow: hidden;
    perspective: 1600px;
    grid-template-columns: minmax(0, 1fr);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    animation: enter 0.45s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(14px) scale(0.98);
    }
  }
  .face {
    grid-area: 1 / 1;
    place-self: center;
    width: 100%;
    height: 100%; /* the same frame for every card; zoom and move inside it */
    min-height: 220px;
    border-radius: 18px;
    visibility: visible;
    transform: rotateY(0);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    will-change: transform;
    transition:
      transform 0.32s ease-out 0.32s,
      visibility 0s linear 0s;
  }
  .face.away {
    visibility: hidden;
    pointer-events: none;
    transition:
      transform 0.32s ease-in 0s,
      visibility 0s linear 0.32s;
  }
  .face.front.away {
    transform: rotateY(-90deg);
  }
  .face.back.away {
    transform: rotateY(90deg);
  }
  .side-tag {
    position: absolute;
    top: 8px;
    left: 50%;
    translate: -50% 0;
    padding: 5px 14px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-size: 12px;
    font-weight: 700;
    color: var(--text-dim);
    white-space: nowrap;
    pointer-events: none;
    z-index: 2;
  }
  .side-ctl {
    position: absolute;
    left: 8px;
    bottom: 8px;
    padding: 4px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: 2;
  }
  .side-ctl button {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 16px;
    cursor: pointer;
  }
  kbd {
    font-family: inherit;
    font-size: 10px;
    opacity: 0.65;
    font-weight: 600;
  }
  .grades {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .grade {
    border: 1.5px solid var(--line);
    background: var(--surface);
    border-radius: 14px;
    padding: 12px 6px 9px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    color: var(--text);
    transition: all 0.25s cubic-bezier(0.2, 0.8, 0.3, 1);
    position: relative;
    overflow: hidden;
  }
  .grade::before {
    content: '';
    position: absolute;
    top: 0;
    inset-inline: 0;
    height: 3px;
    background: var(--tone);
  }
  .grade b {
    font-size: calc(14px * var(--font-scale));
    font-weight: 800;
    color: var(--tone);
  }
  .grade small {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .grade:hover:not(:disabled) {
    transform: translateY(-2px);
    border-color: var(--tone);
  }
  .grade:disabled {
    opacity: 0.38;
    cursor: not-allowed;
    filter: saturate(0.3);
  }
  .grade.on {
    border-color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, var(--surface));
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--tone) 25%, transparent),
      0 14px 26px -16px var(--tone);
    transform: translateY(-2px);
  }
  .grade.dim {
    opacity: 0.55;
  }
  .again {
    --tone: var(--red);
  }
  .hard {
    --tone: var(--amber);
  }
  .good {
    --tone: var(--green);
  }
  .easy {
    --tone: #38bdf8;
  }
  .need {
    font-size: 11.5px;
    color: var(--amber);
    font-weight: 600;
  }
  .practice {
    margin-top: 8px;
    font-size: 11.5px;
    line-height: 1.7;
    color: var(--muted);
  }
  .tips {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    line-height: 1.9;
    color: var(--text-dim);
    font-weight: 500;
    margin-top: auto;
  }
  .tips .keys {
    font-size: 11px;
    color: var(--muted);
  }
  .tips kbd {
    background: var(--surface-3);
    border-radius: 6px;
    padding: 1px 6px;
    opacity: 1;
  }
  .next {
    border: 0;
    cursor: pointer;
    padding: 16px 14px;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    box-shadow:
      0 14px 28px -14px var(--primary),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: 0.25s;
  }
  .next:hover:not(:disabled) {
    transform: translateY(-2px);
  }
  .next:active:not(:disabled) {
    transform: scale(0.98);
  }
  .next:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    filter: saturate(0.4);
    box-shadow: none;
  }

  /* finished */
  .finish {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 18px;
    overflow-y: auto;
  }
  .done {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 20px;
    max-width: 440px;
    width: 100%;
  }
  .done-icon {
    width: 76px;
    height: 76px;
    border-radius: 24px;
    background: linear-gradient(135deg, #34d399, #059669);
    color: #fff;
    display: grid;
    place-items: center;
    box-shadow: 0 18px 34px -16px #059669;
  }
  .done h2 {
    font-size: calc(20px * var(--font-scale));
    font-weight: 800;
  }
  .done p {
    font-size: 13px;
    color: var(--text-dim);
  }
  .next-due b {
    color: var(--primary-text);
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    width: 100%;
  }
  .sum {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 12px 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sum b {
    font-size: 20px;
    font-weight: 800;
    color: var(--tone);
  }
  .sum small {
    font-size: 11px;
    color: var(--muted);
  }
  .done .btn {
    margin-top: 8px;
    width: 100%;
    padding: 15px;
  }

  .nextrow {
    display: contents;
  }
  .frac {
    display: none;
  }
  /* phones and narrow windows: the card on top; below it the four grade buttons in one row, then "next" and the fraction */
  @media (max-width: 960px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 6px 12px calc(12px + var(--safe-bottom));
    }
    .center {
      order: 1;
    }
    .panel {
      order: 2;
      background: transparent;
      border: 0;
      box-shadow: none;
      padding: 0;
      gap: 10px;
      overflow: visible;
      max-height: none;
    }
    .block + .block {
      border: 0;
      padding: 0;
    }
    .progress,
    .block h4,
    .tips,
    .need {
      display: none;
    }
    .grades {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .grade {
      padding: 10px 2px 8px;
      border-radius: 14px;
    }
    .nextrow {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .nextrow .next {
      flex: 1;
      padding: 14px 10px;
    }
    .frac {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      line-height: 1.15;
      min-width: 34px;
      color: var(--text);
    }
    .frac b {
      font-size: calc(15px * var(--font-scale));
      font-weight: 800;
    }
    .frac i {
      align-self: stretch;
      height: 2px;
      border-radius: 2px;
      background: var(--text-dim);
      margin: 2px 0;
    }
  }
  @media (max-width: 520px) {
    header {
      padding: 10px 12px 4px;
    }
    kbd {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .face {
      transition-duration: 0.01s;
    }
  }
</style>
