<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { cleanHtml } from '../lib/format'
  import { fontBox, fontCss } from '../lib/fonts'
  import { fitView, panzoom, widgetsBox, type View } from '../lib/panzoom'
  import { app } from '../lib/store.svelte'
  import { parseBlocks, ROW, TEXT_SIZE } from '../lib/textBlocks'
  import type { CardSide, CropBox, MediaWidget } from '../lib/types'

  /**
   * A side of the card in a frame of fixed size: only the cut-out the editor drew around everything (`crop`) is shown,
   * as a ruled card; the rest of the endless page is cut off. It opens zoomed so the whole card is inside the frame;
   * zoom (two fingers / wheel) and moving around are free. `size.w` is the sheet width of a card made before text widgets.
   * `label` (روی کارت / پشت کارت) is shown at the top of the frame, above the card. `bare`: no backdrop, label or
   * buttons of its own (review draws those once, standing still, while only the card turns over); room for a label is
   * still kept at the top.
   */
  type Props = {
    side: CardSide
    size: { w: number; h: number }
    crop?: CropBox | null
    label?: string
    bare?: boolean
    onzoom?: (url: string) => void
    /** ruled lines on the card (false: a card made while «خط‌دار» was off) */
    lines?: boolean
  }
  let { side, size, crop = null, label, bare = false, onzoom, lines = true }: Props = $props()

  const LABEL_H = 40 // room kept free for the label when the card is fitted

  let frame: HTMLDivElement
  let layer: HTMLDivElement
  let fw = $state(0)
  let fh = $state(0)
  let view = $state<View>({ z: 1, x: 0, y: 0 })
  let touched = false // the user moved or zoomed: keep their view when the frame is resized

  const blocks = $derived(parseBlocks(side.html, size.w))

  /** a card saved without a cut-out: the box around its blocks (layout offsets) and widgets, with the same margin */
  let measured = $state<CropBox | null>(null)
  $effect(() => {
    void blocks
    const widgets = side.widgets
    if (crop) return
    tick().then(() => {
      let box = widgetsBox(widgets)
      for (const tb of Array.from(layer?.children ?? []) as HTMLElement[]) {
        const t = tb.firstElementChild as HTMLElement | null
        if (!t) continue
        const l = tb.offsetLeft + t.offsetLeft
        const tp = tb.offsetTop + t.offsetTop
        const b = { l, t: tp, r: l + t.offsetWidth, b: tp + t.offsetHeight }
        box = box ? { l: Math.min(box.l, b.l), t: Math.min(box.t, b.t), r: Math.max(box.r, b.r), b: Math.max(box.b, b.b) } : b
      }
      measured = box && { l: Math.floor(box.l - 20), t: Math.floor(box.t - 20), r: Math.ceil(box.r + 20), b: Math.ceil(box.b + 20) }
    })
  })

  /** the card: what the editor framed, never smaller than a couple of ruled lines */
  const card = $derived.by(() => {
    const c = crop ?? measured ?? { l: 0, t: 0, r: size.w, b: ROW * 3 }
    const padW = Math.max(0, 120 - (c.r - c.l)) / 2
    const padH = Math.max(0, ROW * 2 - (c.b - c.t)) / 2
    return { l: c.l - padW, t: c.t - padH, r: c.r + padW, b: c.b + padH }
  })

  function fit() {
    if (!fw || !fh) return
    // the card sits below the label at the top
    const top = label || bare ? LABEL_H : 0
    const v = fitView(card, fw, fh - top, { both: true })
    view = { ...v, y: v.y + top }
  }

  $effect(() => {
    // first layout and every resize (phone turned, window changed) refit, until the reader takes over
    void fw
    void fh
    void card
    if (!touched) fit()
  })

  onMount(() =>
    panzoom(frame, {
      get: () => view,
      set: (v) => {
        touched = true
        view = v
      },
      // one finger drags anywhere, except on the sound's own controls
      canPan: (e) => !(e.target as Element).closest('audio'),
    }),
  )

  let urls = $state<Record<string, string>>({})
  $effect(() => {
    for (const w of side.widgets) {
      if (w.kind === 'text' || urls[w.mediaId]) continue
      app.mediaUrl(w.mediaId).then((u) => {
        if (u) urls[w.mediaId] = u
      })
    }
  })

  function tap(e: MouseEvent, w: MediaWidget) {
    const url = urls[w.mediaId]
    if (!url || w.kind === 'text') return
    if (w.kind === 'image') onzoom?.(url)
    else if (!(e.target as Element).closest('audio')) {
      const a = (e.currentTarget as HTMLElement).querySelector('audio')
      if (a) a.paused ? a.play() : a.pause()
    }
  }

  // a text widget's height follows its text
  const place = (w: MediaWidget) =>
    `left:${w.x}px;top:${w.y}px;width:${w.w}px;${w.kind === 'text' ? '' : `height:${w.h}px;`}transform:rotate(${w.rot ?? 0}deg)`

  const stop = (e: Event) => e.stopPropagation() // the zoom buttons must not turn the card over

  /** the whole card in view again */
  export function reset() {
    touched = false
    fit()
  }
</script>

<div class="frame" class:bare bind:this={frame} bind:clientWidth={fw} bind:clientHeight={fh}>
  <div class="world" style:transform="translate({view.x}px, {view.y}px) scale({view.z})">
    <!-- the card: a ruled sheet exactly around everything on this side -->
    <div
      class="sheet"
      class:plain={!lines}
      style:left="{card.l}px"
      style:top="{card.t}px"
      style:width="{card.r - card.l}px"
      style:height="{card.b - card.t}px"
      style:background-position-y="{-card.t}px"
    ></div>
    <!-- everything outside the card is cut off -->
    <div class="cut" style:clip-path="polygon({card.l}px {card.t}px, {card.r}px {card.t}px, {card.r}px {card.b}px, {card.l}px {card.b}px)">
      <div class="layer" bind:this={layer}>
        {#each blocks as b, i (i)}
          <div class="tb" class:fixed={!!b.w} style:left="{b.x}px" style:top="{b.y}px" style:width={b.w ? `${b.w}px` : undefined}>
            <!-- parseBlocks() rebuilds the markup from plain text + <br> + dir + text size only -->
            <div class="tb-text" dir={b.dir}>{@html b.html}</div>
          </div>
        {/each}
      </div>
      {#each side.widgets as w (w.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="w {w.kind}" role="presentation" style={place(w)} onclick={(e) => tap(e, w)}>
          {#if w.kind === 'text'}
            <!-- cleanHtml() rebuilds the markup from plain text + <br> + dir + text size only -->
            <div class="tw" dir={w.dir ?? 'rtl'} style:font-size="{w.size ?? TEXT_SIZE}px" style:font-family={fontCss(w.font)} style:line-height={w.lh ? `${w.lh}px` : fontBox(w.font).lh} style:padding-inline={fontBox(w.font).pad} style:margin-block={w.lh ? undefined : fontBox(w.font).trim}>{@html cleanHtml(w.html ?? '')}</div>
          {:else if urls[w.mediaId]}
            {#if w.kind === 'image'}
              <img src={urls[w.mediaId]} alt="" draggable="false" />
            {:else}
              <audio controls src={urls[w.mediaId]}></audio>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  {#if !bare}
    {#if label}<p class="label">{label}</p>{/if}
    <!-- only the way back to the whole card; zooming and moving are done by hand -->
    <div class="ctl" dir="ltr" role="presentation" onclick={stop} onpointerdown={stop}>
      <button onclick={reset} aria-label="نمایش کامل" title="نمایش کامل">⤢</button>
    </div>
  {/if}
</div>

<style>
  .frame {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    touch-action: none;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 18px;
    background-image: radial-gradient(var(--line-2) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  /* review: the card is read, not edited; nothing on it can be selected or long-pressed */
  .frame,
  .frame :global(.tw),
  .frame :global(.tb-text) {
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .frame.bare {
    background: transparent;
    border-color: transparent;
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    transform-origin: 0 0;
    direction: rtl;
  }
  .cut,
  .layer {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
  }
  .sheet {
    position: absolute;
    background-color: var(--paper);
    background-image: linear-gradient(to bottom, transparent calc(100% - 1px), var(--rule) calc(100% - 1px));
    background-size: 100% 34px;
    border: 1px solid var(--line-2);
    border-radius: 12px;
    box-shadow: var(--shadow-md);
  }
  .sheet.plain {
    background-image: none;
  }
  .layer :global(.tb-text) {
    cursor: inherit;
  }
  .w {
    position: absolute;
    cursor: pointer;
  }
  .w.text {
    cursor: inherit;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: fill;
    border-radius: 8px;
    display: block;
  }
  .audio {
    display: flex;
    align-items: center;
  }
  audio {
    width: 100%;
    height: 40px;
  }

  .ctl {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-size: 11px;
    font-weight: 700;
    color: var(--text-dim);
  }
  .ctl button {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 16px;
    cursor: pointer;
  }
  .label {
    position: absolute;
    top: 8px;
    left: 50%;
    translate: -50% 0;
    padding: 5px 12px;
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
  }
</style>
