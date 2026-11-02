<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { onBack } from '../lib/back'
  import { buildBrain, FADING, FORGETTING, KIND_LEARNING, KIND_NEW, KIND_PARKED, type BrainModel } from '../lib/brain/model'
  import type { BrainScene } from '../lib/brain/scene'
  import { fa, intervalLabel } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import Icon from './Icon.svelte'
  import InfoButton from './InfoButton.svelte'

  /** The user's cards as a living brain (see lib/brain). */
  type Props = { onclose: () => void; onreview: (cardId: string, folderId: string | null) => void; paused?: boolean }
  let { onclose, onreview, paused = false }: Props = $props()

  let canvas: HTMLCanvasElement
  let layer: HTMLDivElement
  let scene: BrainScene | null = null
  let failed = $state(false)
  let model = $state.raw<BrainModel | null>(null)
  let selected = $state(-1)

  // what has changed since the brain was last looked at grows / lights up when it opens
  const SEEN = 'ankio.brain.seen'
  let since = 0
  try {
    since = Number(localStorage.getItem(SEEN)) || 0
  } catch {
    since = 0
  }

  // every change to the cards, the folders or the reviews (a move, a delete, a review) rebuilds it at once
  $effect(() => {
    const input = {
      nodes: app.nodes,
      cards: app.cards,
      revlog: app.revlog,
      retention: app.settings.retention,
    }
    untrack(() => {
      const m = buildBrain({ ...input, children: (id) => app.children(id), cardsOf: (id) => app.cardsOf(id) })
      model = m
      if (scene) {
        scene.setModel(m, since)
        since = Date.now()
      }
    })
  })

  onMount(async () => {
    try {
      const { BrainScene } = await import('../lib/brain/scene')
      scene = new BrainScene(canvas, layer, {
        onselect: (i) => (selected = i),
      })
      if (model) {
        scene.setModel(model, since)
        since = Date.now()
      }
      scene.setPaused(paused)
      if (import.meta.env.DEV) (window as unknown as { brain: BrainScene }).brain = scene // (for looking inside while developing)
    } catch (e) {
      console.error(e)
      failed = true
    }
  })
  onDestroy(() => {
    scene?.dispose()
    try {
      localStorage.setItem(SEEN, String(Date.now()))
    } catch {
      /* private mode: it just shows everything as new next time */
    }
  })

  $effect(() => {
    const p = paused
    scene?.setPaused(p)
  })

  // the back button: the selection first, then the brain
  $effect(() =>
    onBack(() => {
      if (selected >= 0) scene?.setSelected(-1, true)
      else onclose()
      return true
    }),
  )

  const card = $derived(model && selected >= 0 ? app.card(model.ids[selected]) : undefined)
  // (the name is read first: with `scene?.` alone nothing would be tracked while the scene is still loading)
  $effect(() => {
    const name = card ? card.name || 'بی‌نام' : ''
    scene?.setSelLabel(name)
  })

  const stats = $derived.by(() => {
    const m = model
    if (!m) return { neurons: 0, regions: 0, links: 0, weak: 0, fresh: 0 }
    let fresh = 0
    for (let i = 0; i < m.count; i++) if (m.info[i * 4 + 2] === KIND_NEW) fresh++
    let links = 0
    for (let l = 0; l < m.linkA.length; l++) if (m.linkKind[l] === 1 || m.linkS[l] > 0.06) links++
    return { neurons: m.count, regions: m.regions.length - 1, links, weak: m.weakCount, fresh }
  })

  /** what the selected neuron is like, in words */
  const about = $derived.by(() => {
    const m = model
    const i = selected
    if (!m || i < 0 || !card) return null
    const h = m.info[i * 4]
    const kind = m.info[i * 4 + 2]
    const recall = m.recall[i]
    const goal = Math.round(app.settings.retention * 100)
    let state: string
    let tone: string
    if (kind === KIND_NEW) ((state = 'نابالغ — هنوز یاد گرفته نشده؛ سیناپس‌هایش خاموش‌اند'), (tone = 'new'))
    else if (kind === KIND_PARKED) ((state = 'خاموش — کارت معلق است'), (tone = 'parked'))
    else if (kind === KIND_LEARNING) ((state = 'در حال یادگیری — تقویت اولیه، هنوز ناپایدار'), (tone = 'learning'))
    else if (h >= 1) ((state = `قوی — بالای هدف ${fa(goal)}٪ تو، به‌خوبی در یاد است`), (tone = 'strong'))
    else if (h >= FADING) ((state = `رو به فراموشی — کمی زیر هدف ${fa(goal)}٪ تو`), (tone = 'fading'))
    else if (h >= FORGETTING) ((state = 'در حال فراموش شدن — اتصال‌هایش دارند از دست می‌روند'), (tone = 'weak'))
    else ((state = 'فراموش‌شده — ولی هنوز آنجاست؛ یک مرور دوباره روشنش می‌کند'), (tone = 'lost'))
    let links = 0
    let together = 0
    for (let l = 0; l < m.linkA.length; l++)
      if (m.linkA[l] === i || m.linkB[l] === i) {
        links++
        if (m.linkKind[l] === 1) together++
      }
    const path = card.folderId ? ['خانه', ...app.pathOf(card.folderId).map((n) => n.name)].join(' / ') : 'خانه'
    return { state, tone, recall, links, together, path }
  })

  /** the camera to the card nearest to being forgotten (the lowest chance of recall right now) */
  function weakest() {
    const m = model
    if (!m || !m.weakOrder.length) return
    scene?.focusNeuron(m.weakOrder[0])
  }

  const info = {
    title: 'مغز تو',
    lines: [
      'هر کارت یک نرون است و هر پوشه یک ناحیه از مغز. پوشه‌های داخل یک پوشه، داخل ناحیه‌ی همان پوشه‌اند و پوشه‌هایی که در فهرست کنار هم‌اند، در مغز هم کنار هم می‌نشینند. هر چه را جابه‌جا یا پاک کنی، مغز همان لحظه با تو عوض می‌شود.',
      'رنگ هر نرون از مقایسه‌ی احتمال یادآوری همین حالای آن کارت با هدفی که خودت در تنظیمات گذاشته‌ای (مثلاً ۹۰٪) می‌آید: تا وقتی به هدف رسیده فیروزه‌ای است؛ همین که کمی زیر هدف برود کهربایی می‌شود (رو به فراموشی)، کمی پایین‌تر نارنجی (در حال فراموشی) و وقتی خیلی دور شود، یعنی ۲۰ درصد یا بیشتر زیر هدف، قرمز کم‌نور (فراموش‌شده). در آزمایشگاه دیده‌اند که با فراموشی، خارهای دندریتی کوچک و حذف می‌شوند و سیناپس‌ها از دست می‌روند؛ ذره‌هایی که از نرون‌های ضعیف جدا می‌شوند همین‌اند.',
      'اما سلول‌های حافظه (انگرام) معمولاً پاک نمی‌شوند: آزمایش رایان و توناگاوا (۲۰۱۵) نشان داد حافظه‌ای که فراموش‌شده به نظر می‌رسد هنوز هست و فقط راه رسیدن به آن بسته شده. برای همین نرون ضعیف خاموش نمی‌شود؛ حلقه‌ی توخالی‌اش می‌ماند و با یک مرور دوباره روشن می‌شود.',
      'اندازه و درخشش نرون یعنی کارت چقدر ماندگار شده (فاصله‌ی مرورش). نزدیک که شوی، خود سلول پیدا می‌شود: جسم هرمی، دندریت‌ها با خارهایشان، و آکسون با غلاف میلین و گره‌های رانویه که پیام عصبی از یکی به بعدی می‌پرد. حافظه‌ی ماندگارتر خارهای بیشتر و میلین کامل‌تری دارد (مدارهایی که بارها به کار بروند میلین بیشتری می‌گیرند)؛ در حافظه‌ی رو به فراموشی میلین تکه‌تکه می‌شود.',
      'کارت تازه نرونی نابالغ است با «سیناپس‌های خاموش» که هنوز پیامی نمی‌رسانند؛ کارتی که تازه یاد گرفته‌ای کم‌فروغ و لرزان است و اتصال‌هایش کم‌رنگ و کم‌پیام، چون تقویت اولیه هنوز تثبیت نشده؛ هر چه کارت ماندگارتر شود، اتصال‌هایش محکم‌تر و پیام‌هایش بیشتر می‌شود. نرون ضعیف هم اتصال‌هایش را از دست می‌دهد و کمتر پیام می‌فرستد.',
      'اتصال‌ها: نرون‌های یک پوشه به نزدیک‌ترین همسایه‌هایشان وصل‌اند. کارت‌هایی که در فاصله‌ی چند ساعت از هم مرور کنی هم به هم وصل می‌شوند (کمان‌های بنفش)، چون حافظه‌هایی که نزدیک هم ساخته شوند نرون‌های مشترک پیدا می‌کنند (کای و همکاران، ۲۰۱۶)؛ هر چه نزدیک‌تر و بیشتر، محکم‌تر. اتصال ضعیف تکه‌تکه دیده می‌شود و پیام روی آن نیمه‌راه خاموش می‌شود. اتصالی که از آخرین باری که مغز را دیدی ساخته شده، جلوی چشمت رشد می‌کند.',
      'با یک انگشت بچرخان، با دو انگشت زوم و جابه‌جا کن. زوم که کنی، از میان نرون‌ها جلو می‌روی و هر قدر بخواهی پیش می‌روی؛ چرخش هم همیشه دور نقطه‌ای کمی جلوتر از توست. روی هر نرون بزن تا اسم کارتش را ببینی و همان را مرور کنی؛ روی اسم یک ناحیه بزن تا داخلش بروی. دکمه‌ی «ضعیف‌ترین نرون» تو را به کارتی می‌برد که از همه به فراموشی نزدیک‌تر است.',
    ],
  }
</script>

<div class="brain" role="dialog" aria-modal="true" aria-label="نقشه‌ی مغز">
  <canvas bind:this={canvas} aria-label="نقشه‌ی سه‌بعدی نرون‌ها"></canvas>
  <div class="layer" bind:this={layer}></div>

  <header>
    <button class="ic" onclick={onclose} aria-label="بستن"><Icon name="close" size={18} stroke={2.4} /></button>
    <div class="title">
      <b>مغز تو <InfoButton {...info} /></b>
      <small>
        {fa(stats.neurons)} نرون · {fa(stats.regions)} ناحیه · {fa(stats.links)} اتصال
        {#if stats.weak}· <span class="w">{fa(stats.weak)} ضعیف</span>{/if}
      </small>
    </div>
    <button class="ic" onclick={() => scene?.home()} aria-label="نمای کامل" title="نمای کامل"><Icon name="focus" size={18} /></button>
  </header>

  {#if failed}
    <div class="empty"><b>نمایش سه‌بعدی روی این دستگاه در دسترس نیست</b>(WebGL خاموش است یا پشتیبانی نمی‌شود)</div>
  {:else if model && !model.count}
    <div class="empty"><b>هنوز نرونی نداری</b>هر کارتی که بسازی یا وارد کنی، اینجا یک نرون می‌شود.</div>
  {:else if model && stats.fresh === stats.neurons}
    <div class="hint">همه‌ی نرون‌ها هنوز نابالغ‌اند؛ با اولین مرورها سیناپس‌ها روشن و اتصال‌ها ساخته می‌شوند.</div>
  {/if}

  {#if about && card}
    <div class="sheet tone-{about.tone}">
      <div class="row">
        <div class="name">
          <b dir="auto">{card.name || 'بی‌نام'}</b>
          <small dir="auto">{about.path}</small>
        </div>
        <button class="ic sm" onclick={() => scene?.setSelected(-1, true)} aria-label="بستن"><Icon name="close" size={16} stroke={2.4} /></button>
      </div>
      <p class="state"><i></i>{about.state}</p>
      <div class="facts">
        {#if about.recall >= 0}<span><b>{fa(Math.round(about.recall * 100))}٪</b>یادآوری</span>{/if}
        {#if card.state === 'review'}<span><b>{intervalLabel(card.interval * 86_400_000)}</b>فاصله</span>{/if}
        <span><b>{fa(card.reps)}</b>مرور</span>
        {#if card.lapses}<span><b>{fa(card.lapses)}</b>فراموشی</span>{/if}
        <span><b>{fa(about.links)}</b>اتصال</span>
      </div>
      <button class="btn btn-primary go" onclick={() => onreview(card.id, card.folderId)}>
        <Icon name="spark" size={16} />مرور نرون انتخابی
      </button>
    </div>
  {:else if model && model.count}
    <div class="dock">
      {#if model.weakOrder.length}
        <button class="pill-btn" onclick={weakest}><Icon name="target" size={13} stroke={2.2} />ضعیف‌ترین نرون</button>
      {/if}
      <div class="legend" aria-hidden="true">
        <span><i style:background="#3fdcf2"></i>قوی (بالای {fa(Math.round(app.settings.retention * 100))}٪)</span>
        <span><i style:background="#ffc94d"></i>رو به فراموشی</span>
        <span><i style:background="#ff7a3d"></i>در حال فراموشی</span>
        <span><i style:background="#e0344f"></i>فراموش‌شده</span>
        <span><i style:background="#8c93c9"></i>جدید</span>
      </div>
    </div>
  {/if}
</div>

<style>
  /* a dark lab screen in both themes: the cells glow on black */
  .brain {
    position: fixed;
    inset: 0;
    z-index: 280;
    background: #02050b;
    color: #e9ebf5;
    animation: fade 0.3s ease;
    overflow: hidden;
    touch-action: none;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  .layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .layer :global(.brain-label) {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 46vw;
    font: inherit;
    font-size: 11.5px;
    color: #e9ebf5;
    background: rgba(8, 12, 22, 0.62);
    border: 1px solid color-mix(in srgb, var(--c) 55%, transparent);
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
    backdrop-filter: blur(4px);
    transition: opacity 0.25s;
    will-change: transform;
    white-space: nowrap;
  }
  .layer :global(.brain-label b) {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .layer :global(.brain-label small) {
    color: var(--c);
    font-weight: 700;
    font-size: 10.5px;
  }
  .layer :global(.brain-sel-label) {
    position: absolute;
    left: 0;
    top: 0;
    max-width: 60vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    font-weight: 800;
    color: #fff;
    text-shadow:
      0 0 8px #000,
      0 0 2px #000;
    will-change: transform;
  }

  header {
    position: absolute;
    top: 0;
    inset-inline: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: calc(12px + var(--safe-top)) 14px 10px;
    background: linear-gradient(180deg, rgba(2, 5, 11, 0.85), transparent);
    pointer-events: none;
  }
  header > * {
    pointer-events: auto;
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    text-align: center;
  }
  .title b {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: calc(15px * var(--font-scale));
    font-weight: 800;
  }
  .title small {
    font-size: 11px;
    color: #9aa3c0;
  }
  .title .w {
    color: #ff9a5c;
    font-weight: 700;
  }
  .ic {
    width: 40px;
    height: 40px;
    border-radius: 13px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(16, 20, 34, 0.7);
    color: #cfd5ea;
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: none;
    backdrop-filter: blur(6px);
  }
  .ic.sm {
    width: 32px;
    height: 32px;
    border-radius: 10px;
  }

  .empty,
  .hint {
    position: absolute;
    inset-inline: 16px;
    margin-inline: auto;
    max-width: 420px;
    text-align: center;
    font-size: 12.5px;
    line-height: 1.9;
    color: #aab1c8;
  }
  .empty {
    top: 42%;
  }
  .empty b {
    display: block;
    font-size: 15px;
    color: #e9ebf5;
  }
  .hint {
    bottom: calc(86px + var(--safe-bottom));
    background: rgba(10, 14, 26, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 8px 14px;
    pointer-events: none;
  }

  .dock {
    position: absolute;
    bottom: calc(14px + var(--safe-bottom));
    inset-inline: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    pointer-events: none;
  }
  .dock > * {
    pointer-events: auto;
  }
  .pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, #ff7a3d, #e0344f);
    border: 0;
    border-radius: 999px;
    padding: 6px 11px;
    cursor: pointer;
    white-space: nowrap;
    box-shadow: 0 6px 18px -10px #e0344f;
  }
  .legend {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 10.5px;
    color: #9aa3c0;
    background: rgba(10, 14, 26, 0.6);
    border-radius: 999px;
    padding: 6px 12px;
    pointer-events: none;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 6px currentColor;
  }

  .sheet {
    --t: #3fdcf2;
    position: absolute;
    inset-inline: 12px;
    bottom: calc(12px + var(--safe-bottom));
    margin-inline: auto;
    max-width: 460px;
    background: rgba(12, 16, 28, 0.88);
    border: 1px solid color-mix(in srgb, var(--t) 40%, transparent);
    box-shadow: 0 0 30px -12px var(--t);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: up 0.28s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  @keyframes up {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
  }
  .tone-fading {
    --t: #ffc94d;
  }
  .tone-weak {
    --t: #ff7a3d;
  }
  .tone-lost {
    --t: #e0344f;
  }
  .tone-new {
    --t: #8c93c9;
  }
  .tone-learning {
    --t: #ffd75e;
  }
  .tone-parked {
    --t: #55607a;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name b {
    font-size: calc(15px * var(--font-scale));
    font-weight: 800;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .name small {
    font-size: 11px;
    color: #8f98b6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: #d5daea;
  }
  .state i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
    background: var(--t);
    box-shadow: 0 0 10px var(--t);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .facts span {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    font-size: 11px;
    color: #8f98b6;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 10px;
    padding: 5px 9px;
  }
  .facts b {
    color: #fff;
    font-size: 12.5px;
  }
  .go {
    justify-content: center;
    gap: 8px;
  }
</style>
