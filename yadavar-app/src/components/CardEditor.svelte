<script lang="ts">
  import { untrack } from 'svelte'
  import { onBack } from '../lib/back'
  import { fontInfo } from '../lib/fonts'
  import { fa } from '../lib/format'
  import type { View } from '../lib/panzoom'
  import { DEFAULT_SIDE } from '../lib/sides'
  import { app } from '../lib/store.svelte'
  import type { CardLayout, CardSide } from '../lib/types'
  import FontPicker from './FontPicker.svelte'
  import ImageCrop from './ImageCrop.svelte'
  import Icon from './Icon.svelte'
  import NoteSide from './NoteSide.svelte'

  type Props = { cardId: string; onclose: () => void }
  let { cardId, onclose }: Props = $props()

  const card = $derived(app.card(cardId))
  const folder = $derived(app.node(card?.folderId))

  let shown = $state<'front' | 'back'>('front')
  let recording = $state(false)
  let seconds = $state(0)
  /** size and font of the selected text widget; null = no text widget selected */
  let textSel = $state<{ size: number; font: string } | null>(null)
  const textSize = $derived(textSel?.size ?? null)
  let fontsOpen = $state(false)
  /** a photo just taken, waiting on the crop screen (and the side it goes on) */
  let photo = $state<{ blob: Blob; which: 'front' | 'back' } | null>(null)
  /** each side's own undo / redo */
  let hist = $state({ front: { undo: false, redo: false }, back: { undo: false, redo: false } })
  const sideHist = $derived(hist[shown])

  function pickFont(id: string) {
    tool()?.setFont(id)
    app.settings.recentFonts = [id, ...(app.settings.recentFonts ?? []).filter((f) => f !== id)].slice(0, 3)
    app.saveSettings()
    fontsOpen = false
  }
  let frontRef = $state<NoteSide>()
  let backRef = $state<NoteSide>()
  let views = $state<{ front: View; back: View }>({ front: { z: 1, x: 0, y: 0 }, back: { z: 1, x: 0, y: 0 } })
  const tool = () => (shown === 'front' ? frontRef : backRef)

  // Each side keeps the width/height of its old sheet (the text of cards made before text widgets).
  const side = (which: 'front' | 'back') => {
    const r = card?.layout?.v === 2 ? card.layout[which] : undefined
    return { x: 0, y: 0, w: r?.w ?? DEFAULT_SIDE.w, h: r?.h ?? DEFAULT_SIDE.h }
  }
  const savedCrop = (which: 'front' | 'back') => card?.layout?.crops?.[which] ?? null
  // a fixed card and a page without lines stay so for good (they were chosen when the card was made)
  const fixed = untrack(() => app.card(cardId)?.layout?.fixed ?? null)
  const lines = untrack(() => app.card(cardId)?.layout?.lines !== false)
  let layout = $state<CardLayout & { crops: NonNullable<CardLayout['crops']> }>({
    v: 2,
    stageW: 0,
    front: side('front'),
    back: side('back'),
    crops: { front: savedCrop('front'), back: savedCrop('back') },
    ...(fixed ? { fixed } : {}),
    ...(lines ? {} : { lines: false }),
  })

  /** the card as it was when the editor opened: Cancel puts it back */
  const original = untrack(() => {
    const c = app.card(cardId)
    return c
      ? {
          front: $state.snapshot(c.front) as CardSide,
          back: $state.snapshot(c.back) as CardSide,
          layout: c.layout ? ($state.snapshot(c.layout) as CardLayout) : null,
        }
      : null
  })
  let sidesChanged = false
  let layoutChanged = false

  function saveLayout() {
    layoutChanged = true
    app.setLayout(cardId, $state.snapshot(layout) as CardLayout)
  }

  function save(which: 'front' | 'back', s: CardSide) {
    sidesChanged = true
    app.setSide(cardId, which, s)
  }

  function flip() {
    void tool()?.stopRecording() // the sound is kept on the side it was recorded on
    shown = shown === 'front' ? 'back' : 'front'
  }

  /** Done: everything is kept; review shows only the frame around everything on each side (plus a margin). */
  async function close() {
    // a recording still running is kept: it is on the card before anything is saved
    await Promise.all([frontRef?.stopRecording(), backRef?.stopRecording()])
    frontRef?.deselect()
    backRef?.deselect()
    // pictures / sounds still being stored are waited for, so the card never points at a missing file
    await Promise.all([frontRef?.settled(), backRef?.settled()])
    layout.crops = { front: frontRef?.cropBox() ?? null, back: backRef?.cropBox() ?? null }
    saveLayout()
    app.flush()
    onclose()
  }

  /** Cancel: the card goes back to how it was when the editor opened. */
  function cancel() {
    void frontRef?.stopRecording(false)
    void backRef?.stopRecording(false)
    if (original) {
      if (sidesChanged) {
        app.setSide(cardId, 'front', original.front)
        app.setSide(cardId, 'back', original.back)
      }
      if (layoutChanged)
        app.setLayout(
          cardId,
          original.layout ?? {
            v: 2,
            stageW: 0,
            front: side('front'),
            back: side('back'),
            crops: { front: null, back: null },
            ...(fixed ? { fixed } : {}),
            ...(lines ? {} : { lines: false }),
          },
        )
    }
    app.flush()
    onclose()
  }

  function onKey(e: KeyboardEvent) {
    if (photo) return // the crop screen has its own way out
    if (e.key === 'Escape') close()
  }
  // the back button: the font list first, then the editor itself (everything kept, as with Escape)
  $effect(() => onBack(() => (photo ? (photo = null) : fontsOpen ? (fontsOpen = false) : close(), true)))

  // A tap on these buttons never takes the focus: the text being written keeps its caret, and no keyboard comes up
  const keepFocus = {
    onmousedown: (e: MouseEvent) => e.preventDefault(),
    onpointerdown: (e: PointerEvent) => e.preventDefault(),
  }

  const clock = (s: number) => `${fa(Math.floor(s / 60))}:${fa(s % 60).padStart(2, '۰')}`
</script>

<svelte:window onkeydown={onKey} />

{#if card}
  <div class="overlay">
    <div class="modal" role="dialog" aria-modal="true" aria-label="ویرایش کارت">
      <!-- right: every tool lives here -->
      <aside class="panel">
        <div class="who">
          <h3>{card.name}</h3>
          <p>پوشه: <b>{folder?.name ?? 'خانه'}</b></p>
        </div>

        <div class="group">
          <div class="tools">
            <button class="tool text" onclick={() => tool()?.addText()}><Icon name="plus" size={17} stroke={2.4} />متن</button>
            <button class="tool" onclick={() => tool()?.pickImage()}><Icon name="image" size={17} />عکس</button>
            <button class="tool" onclick={() => tool()?.pickAudio()}><Icon name="audio" size={17} />صدا</button>
            <button class="tool" class:rec={recording} {...keepFocus} onclick={() => tool()?.toggleRecord()}>
              <Icon name="mic" size={17} />{recording ? clock(seconds) : 'ضبط صدا'}
            </button>
            <button class="tool" onclick={() => tool()?.openCamera()}><Icon name="camera" size={17} />دوربین</button>
          </div>
          <!-- these work on the selected text, one step at a time, without the keyboard -->
          <div class="size">
            <button class="add-text" {...keepFocus} onclick={() => tool()?.toggleDirection()} title="جهت نوشتن">
              <Icon name="dir" size={14} />جهت
            </button>
            <div class="stepper" class:off={textSize === null} role="group" aria-label="اندازه‌ی متن">
              <button {...keepFocus} onclick={() => tool()?.stepTextSize(-1)} disabled={textSize === null} aria-label="کوچک‌تر">−</button>
              <span class="num">{textSize === null ? '—' : fa(textSize)}</span>
              <button {...keepFocus} onclick={() => tool()?.stepTextSize(1)} disabled={textSize === null} aria-label="بزرگ‌تر">+</button>
            </div>
            <button class="font-btn" {...keepFocus} disabled={!textSel} onclick={() => (fontsOpen = true)} title="فونت">
              <small>فونت</small><b>{textSel ? fontInfo(textSel.font).name.replace(/ \(.*\)$/, '') : '—'}</b>
            </button>
            <button class="act done" onclick={close}><span class="ok"><Icon name="check" size={14} stroke={2.6} /></span>تمام</button>
            <button class="act cancel" onclick={cancel}>انصراف</button>
          </div>
        </div>

      </aside>

      <!-- left: the card, with all the space that is left -->
      <section class="board">
        <div class="stage">
          <NoteSide
            bind:this={frontRef}
            side={card.front}
            label="روی کارت"
            which="front"
            active={shown === 'front'}
            bind:rect={layout.front}
            bind:crop={layout.crops.front}
            bind:view={views.front}
            bind:recording
            bind:seconds
            onchange={(s) => save('front', s)}
            onlayout={saveLayout}
            onselection={(s) => (textSel = s)}
            onhistory={(h) => (hist.front = h)}
            onphoto={(blob) => (photo = { blob, which: 'front' })}
            {fixed}
            {lines}
          />
          <NoteSide
            bind:this={backRef}
            side={card.back}
            label="پشت کارت"
            which="back"
            active={shown === 'back'}
            bind:rect={layout.back}
            bind:crop={layout.crops.back}
            bind:view={views.back}
            bind:recording
            bind:seconds
            onchange={(s) => save('back', s)}
            onlayout={saveLayout}
            onselection={(s) => (textSel = s)}
            onhistory={(h) => (hist.back = h)}
            onphoto={(blob) => (photo = { blob, which: 'back' })}
            {fixed}
            {lines}
          />

          <!-- inside the card: turning it over (top right) and everything in view (bottom right) -->
          <div class="top-ctl">
            <button class="side-btn" {...keepFocus} onclick={flip} title="چرخاندن کارت">
              <Icon name="flip" size={14} />
              <b>{shown === 'front' ? 'روی کارت' : 'پشت کارت'}</b>
            </button>
            <!-- this side's last change taken back / done again (a widget removed by mistake...) -->
            <button class="hist-btn" {...keepFocus} disabled={!sideHist.undo} onclick={() => tool()?.undo()} title="یک مرحله عقب" aria-label="یک مرحله عقب">
              <Icon name="undo" size={16} />
            </button>
            <button class="hist-btn" {...keepFocus} disabled={!sideHist.redo} onclick={() => tool()?.redo()} title="یک مرحله جلو" aria-label="یک مرحله جلو">
              <Icon name="redo" size={16} />
            </button>
          </div>
          {#if !fixed}
            <!-- (a fixed card is always shown whole) -->
            <div class="stage-ctl">
              <button {...keepFocus} onclick={() => tool()?.fit()} title="نمایش همه" aria-label="نمایش همه">⤢</button>
            </div>
          {/if}
        </div>
      </section>
    </div>
  </div>
  {#if photo}
    <ImageCrop
      blob={photo.blob}
      oncancel={() => (photo = null)}
      ondone={(b) => {
        const which = photo!.which
        photo = null
        void (which === 'front' ? frontRef : backRef)?.placeImage(b)
      }}
    />
  {/if}
  {#if fontsOpen && textSel}
    <FontPicker current={textSel.font} recent={app.settings.recentFonts ?? []} onpick={pickFont} onclose={() => (fontsOpen = false)} />
  {/if}
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: var(--modal);
    animation: fade 0.2s ease;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  /* full screen: the panel on the right, the card takes all the rest */
  .modal {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 14px;
    padding: calc(14px + var(--safe-top)) 14px calc(14px + var(--safe-bottom));
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: auto;
    min-height: 0;
  }
  .who h3 {
    font-size: calc(17px * var(--font-scale));
    font-weight: 800;
    letter-spacing: -0.2px;
    overflow-wrap: anywhere;
  }
  .who p {
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
    font-weight: 500;
  }
  .who b {
    color: var(--primary-text);
    font-weight: 700;
  }
  .tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .tool {
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text-dim);
    border-radius: 13px;
    padding: 12px 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    font-weight: 600;
    transition: all 0.25s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .tool:hover {
    border-color: var(--primary);
    color: var(--primary-text);
    background: var(--surface);
  }
  .tool:active {
    transform: scale(0.97);
  }
  .tool.text {
    color: var(--primary-text);
    border-color: var(--primary);
    background: var(--primary-soft);
    font-weight: 800;
  }
  .tool.rec {
    color: #fff;
    background: #ef4444;
    border-color: #ef4444;
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
    }
    70% {
      box-shadow: 0 0 0 10px rgba(239, 68, 68, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
    }
  }
  /* one row on every phone, always as wide as the panel: the buttons share the room that is left; on a narrow
     screen only the font button gives way, and the tick on "تمام" shows only when there is room for it */
  .size {
    container-type: inline-size;
    margin-top: 10px;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
  }
  .add-text,
  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--primary);
    border-radius: 10px;
    background: var(--primary-soft);
    color: var(--primary-text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
  }
  .add-text,
  .act {
    flex: 1 0 auto;
  }
  .act .ok {
    display: none;
  }
  @container (min-width: 332px) {
    .act .ok {
      display: inline-flex;
    }
  }
  .act.done {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
  }
  .act.done:hover {
    background: #15803d;
  }
  .act.cancel {
    background: var(--surface-2);
    border-color: var(--line-2);
    color: var(--text-dim);
  }
  .font-btn {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 32px;
    min-width: 46px;
    flex: 1 1 58px;
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    line-height: 1.15;
  }
  .font-btn small {
    font-size: 9px;
    color: var(--muted);
    font-weight: 600;
  }
  .font-btn b {
    font-size: 11px;
    font-weight: 700;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .font-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .stepper {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 2px;
  }
  .stepper button {
    width: 28px;
    height: 26px;
    border: 0;
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font-size: 16px;
    cursor: pointer;
  }
  .stepper button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .num {
    min-width: 24px;
    text-align: center;
    font-size: 12px;
    font-weight: 700;
    color: var(--text);
    user-select: none;
  }
  .stepper.off .num {
    color: var(--muted);
  }

  .board {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .top-ctl {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 10;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .hist-btn {
    width: 34px;
    height: 32px;
    border-radius: 10px;
    border: 1px solid var(--line-2);
    background: color-mix(in srgb, var(--surface) 90%, transparent);
    color: var(--text);
    display: grid;
    place-items: center;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .hist-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .side-btn {
    border: 1px solid var(--line-2);
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    color: #fff;
    border-radius: 11px;
    padding: 7px 12px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    font-size: 12px;
    box-shadow: 0 10px 20px -12px var(--primary);
  }
  .side-btn b {
    font-weight: 800;
  }
  /* the card frame takes all the height that is left */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .stage-ctl {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 10;
    display: flex;
    gap: 6px;
    padding: 4px;
    border-radius: 13px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .stage-ctl button {
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 18px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  /* phones: the card on top with all the room, the tools in a compact strip below */
  @media (max-width: 860px) {
    .modal {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 8px;
      padding: calc(8px + var(--safe-top)) 8px calc(8px + var(--safe-bottom));
    }
    .board {
      order: 1;
    }
    .panel {
      order: 2;
      gap: 8px;
      padding: 8px;
      border-radius: 14px;
      overflow: visible;
    }
    .who {
      display: none;
    }
    .tools {
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
    }
    .tool {
      padding: 8px 2px;
      gap: 4px;
      font-size: 10px;
      border-radius: 11px;
      white-space: nowrap;
    }
    .size {
      margin-top: 6px;
    }
  }
  /* very narrow phones: everything a little tighter, still one row */
  @media (max-width: 360px) {
    .size {
      gap: 4px;
    }
    .add-text,
    .act {
      padding: 0 6px;
    }
    .stepper {
      gap: 2px;
    }
    .stepper button {
      width: 24px;
    }
  }
</style>
