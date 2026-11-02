<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { cleanHtml } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import { fontBox, fontCss } from '../lib/fonts'
  import { EMPTY_LINE, TEXT_SIZE } from '../lib/textBlocks'
  import type { MediaWidget } from '../lib/types'
  import Icon from './Icon.svelte'

  type Props = {
    widget: MediaWidget
    selected: boolean
    /** a text widget whose text is being written (the keyboard is up) */
    editing?: boolean
    /** current zoom of the board the widget sits on (1 = 100%) */
    scale: () => number
    onselect: () => void
    /** a selected text widget was tapped again: its text is now being written */
    onedit?: () => void
    /** `typing`: the change is text being written in this widget (one undo step while it goes on) */
    onchange: (typing?: string) => void
    onremove: () => void
    /** a fixed card's page: the widget never leaves it, nor gets bigger than it (null: the endless page) */
    bounds?: { w: number; h: number } | null
  }
  let {
    widget = $bindable(),
    selected,
    editing = false,
    bounds = null,
    scale,
    onselect,
    onedit,
    onchange,
    onremove,
  }: Props = $props()

  // handles keep a usable size when the board is zoomed out
  const inv = $derived(Math.min(3, Math.max(0.8, 1 / scale())))
  const isText = $derived(widget.kind === 'text')

  const MIN_W = $derived(widget.kind === 'audio' ? 150 : widget.kind === 'text' ? 16 : 40)
  const MIN_H = $derived(widget.kind === 'audio' ? 56 : 30)

  // sx / sy: which side(s) the handle moves (-1 = left/top, 1 = right/bottom, 0 = none)
  const handles = [
    { id: 'nw', sx: -1, sy: -1 },
    { id: 'n', sx: 0, sy: -1 },
    { id: 'ne', sx: 1, sy: -1 },
    { id: 'e', sx: 1, sy: 0 },
    { id: 'se', sx: 1, sy: 1 },
    { id: 's', sx: 0, sy: 1 },
    { id: 'sw', sx: -1, sy: 1 },
    { id: 'w', sx: -1, sy: 0 },
  ] as const
  // a text widget's height follows its text: only its width can be dragged
  const shownHandles = $derived(isText ? handles.filter((h) => h.sy === 0) : handles)

  let url = $state<string | null>(null)

  $effect(() => {
    if (widget.kind === 'text') return
    const id = widget.mediaId
    let alive = true
    app.mediaUrl(id).then((u) => {
      if (alive) url = u
    })
    return () => (alive = false)
  })

  // ---------- text ----------

  let root: HTMLDivElement
  let tw: HTMLDivElement | undefined = $state()
  const dirOf = () => widget.dir ?? 'rtl'

  onMount(() => {
    if (!tw) return
    // the browser edits the text itself: it is put in once and read back on every change
    tw.innerHTML = cleanHtml(widget.html ?? '') || EMPTY_LINE(dirOf())
    // the height follows the text; review and the card frame need it
    const ro = new ResizeObserver(() => {
      const h = Math.round(root.offsetHeight)
      if (h && h !== widget.h) {
        widget.h = h
        keepInside() // a text growing at the bottom of a fixed page moves up
      }
    })
    ro.observe(root)
    return () => ro.disconnect()
  })

  /** on a fixed page: pushed back inside it (its turned outline counts), never wider or taller than the page */
  function keepInside() {
    const b = bounds
    if (!b) return
    if (widget.w > b.w) widget.w = b.w
    if (!isText && widget.h > b.h) widget.h = b.h
    const t = rad()
    const c = Math.abs(Math.cos(t))
    const s = Math.abs(Math.sin(t))
    const hw = (widget.w * c + widget.h * s) / 2
    const hh = (widget.w * s + widget.h * c) / 2
    const fit = (v: number, half: number, size: number) => (half * 2 >= size ? size / 2 : Math.min(size - half, Math.max(half, v)))
    // a text taller than the page keeps its top on the page (it can be made smaller)
    const cx = fit(widget.x + widget.w / 2, hw, b.w)
    const cy = hh * 2 >= b.h ? hh : fit(widget.y + widget.h / 2, hh, b.h)
    widget.x = Math.round(cx - widget.w / 2)
    widget.y = Math.round(cy - widget.h / 2)
  }

  function commit(typing = false) {
    if (!tw) return
    widget.html = tw.innerHTML
    onchange(typing ? widget.id : undefined)
  }

  // the text was put back from outside (undo / redo in the editor): show it
  $effect(() => {
    const html = widget.html ?? ''
    untrack(() => {
      if (!tw || editing || tw.innerHTML === html) return
      tw.innerHTML = cleanHtml(html) || EMPTY_LINE(dirOf())
    })
  })

  // the direction belongs to the widget: every line follows it
  $effect(() => {
    const d = dirOf()
    untrack(() => {
      if (!tw) return
      let changed = false
      for (const l of Array.from(tw.children) as HTMLElement[])
        if (l.dir !== d) {
          l.dir = d
          changed = true
        }
      if (changed) commit()
    })
  })

  // leaving the writing (a tap on the page, another widget...): the keyboard goes down and the box fits the text
  let wasEditing = false
  $effect(() => {
    const now = editing
    untrack(() => {
      if (!now && tw?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      if (wasEditing && !now) fitToText()
      wasEditing = now
    })
  })

  /** how wide the text is with no wrapping at all (box padding included) */
  function naturalWidth(): number {
    const keep = root.style.width
    root.style.width = 'max-content'
    const w = root.offsetWidth
    root.style.width = keep
    return Math.ceil(w) + 2
  }

  /** the narrowest the box can be without breaking a word in two (its longest word) */
  function wordWidth(): number {
    if (!tw) return MIN_W
    const keep = root.style.width
    tw.style.overflowWrap = 'normal'
    root.style.width = 'min-content'
    const w = root.offsetWidth
    root.style.width = keep
    tw.style.overflowWrap = ''
    return Math.ceil(w) + 2
  }

  /** a new width; the starting edge (right for right-to-left text) stays where it is, also when turned */
  function setWidth(w1: number) {
    const w0 = widget.w
    if (Math.abs(w1 - w0) < 1) return
    const t = rad()
    const shift = ((w0 - w1) / 2) * (dirOf() === 'rtl' ? 1 : -1)
    const cx = widget.x + w0 / 2 + shift * Math.cos(t)
    const cy = widget.y + widget.h / 2 + shift * Math.sin(t)
    widget.w = Math.round(w1)
    widget.x = Math.round(cx - w1 / 2)
    widget.y = Math.round(cy - widget.h / 2)
    keepInside()
  }

  /** the box exactly as wide as its text: narrower when there is room left, never so narrow that it wraps anew */
  function fitToText() {
    if (!tw || !isText || !root?.isConnected) return
    const w = Math.max(MIN_W, Math.min(widget.w, naturalWidth()))
    if (Math.abs(w - widget.w) < 1) return
    setWidth(w)
    onchange()
  }

  // a new text size or font: once the font's letters are there, the box takes the text's width again (it grows up to a
  // comfortable line length, or shrinks to the text) — the text never spills out of its box
  let lastLook = ''
  $effect(() => {
    if (!isText) return
    const look = `${widget.size ?? TEXT_SIZE}|${widget.font ?? ''}`
    untrack(() => {
      if (!lastLook) return void (lastLook = look) // first run: nothing changed yet
      if (look === lastLook) return
      lastLook = look
      const fam = widget.font ? `"${widget.font}"` : '"Vazirmatn Variable"'
      document.fonts.load(`${widget.size ?? TEXT_SIZE}px ${fam}`, tw?.textContent || 'ا').then(() => {
        if (!root?.isConnected) return
        setWidth(Math.max(MIN_W, Math.min(Math.max(widget.w, growMax()), naturalWidth())))
        onchange()
      })
    })
  })

  /** while writing, the box grows with the text (up to a comfortable line length, then the text wraps) */
  const GROW_MAX = 520
  /** on a fixed page a line wraps at the page's width */
  const growMax = () => (bounds ? Math.min(GROW_MAX, bounds.w) : GROW_MAX)
  function growToText() {
    if (!isText) return
    const want = Math.min(Math.max(widget.w, growMax()), naturalWidth())
    if (want > widget.w) setWidth(want)
  }

  function caretToEnd() {
    if (!tw) return
    const r = document.createRange()
    const line = tw.lastElementChild ?? tw
    r.selectNodeContents(line)
    r.collapse(false)
    const br = line.lastChild
    if (br && br.nodeName === 'BR') r.setStartBefore(br)
    r.collapse(true)
    const sel = getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  }

  /** Starts writing in this text widget, the caret where the finger was. Called during the tap so the keyboard comes up. */
  export function startWriting(x?: number, y?: number) {
    if (!tw) return
    tw.contentEditable = 'true'
    tw.focus({ preventScroll: true })
    const r = x !== undefined && y !== undefined ? document.caretRangeFromPoint?.(x, y) : null
    if (r && tw.contains(r.startContainer)) {
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    } else caretToEnd()
    onedit?.()
  }

  function onInput() {
    // everything must live in a line <div>; repair after select-all + delete
    if (tw && !tw.firstElementChild) {
      tw.innerHTML = EMPTY_LINE(dirOf())
      caretToEnd()
    }
    growToText()
    commit(true)
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault()
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '')
  }

  // ---------- moving, resizing, turning ----------

  const rad = () => ((widget.rot ?? 0) * Math.PI) / 180

  type Drag =
    | { kind: 'move'; dx: number; dy: number }
    | { kind: 'rotate'; w: number; h: number; cx: number; cy: number }
    | { kind: 'resize'; sx: number; sy: number; px: number; py: number; w: number; h: number; cx: number; cy: number; minW: number }
  let drag: Drag | null = null
  /** where the finger went down; until it travels a few px it is a tap, not a move */
  let tap: { x: number; y: number; wasSelected: boolean; moved: boolean } | null = null

  const frame = (e: PointerEvent) =>
    ((e.currentTarget as HTMLElement).closest('.widget') as HTMLElement).parentElement!.getBoundingClientRect()

  function onDown(e: PointerEvent) {
    if (editing) {
      e.stopPropagation() // in the text: the browser places the caret or selects, the board stays put
      return
    }
    if (widget.kind === 'audio' && selected) return // the player's own buttons work; the move handle moves it
    startMove(e)
  }

  function startMove(e: PointerEvent) {
    if (e.button !== 0) return
    const box = frame(e)
    tap = { x: e.clientX, y: e.clientY, wasSelected: selected, moved: false }
    onselect()
    drag = {
      kind: 'move',
      dx: (e.clientX - box.left) / scale() - (widget.x + widget.w / 2),
      dy: (e.clientY - box.top) / scale() - (widget.y + widget.h / 2),
    }
    ;(e.currentTarget as HTMLElement).closest('.widget')!.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  /** the move handle under a selected widget: drags it from anywhere, even while its text is being written */
  function startHandleMove(e: PointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const box = frame(e)
    tap = null
    drag = {
      kind: 'move',
      dx: (e.clientX - box.left) / scale() - (widget.x + widget.w / 2),
      dy: (e.clientY - box.top) / scale() - (widget.y + widget.h / 2),
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function startResize(e: PointerEvent, hd: (typeof handles)[number]) {
    e.stopPropagation()
    e.preventDefault()
    drag = {
      kind: 'resize',
      sx: hd.sx,
      sy: hd.sy,
      px: e.clientX,
      py: e.clientY,
      w: widget.w,
      h: widget.h,
      cx: widget.x + widget.w / 2,
      cy: widget.y + widget.h / 2,
      // text: the handles stop at its longest word
      minW: isText ? Math.min(widget.w, wordWidth()) : MIN_W,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function startRotate(e: PointerEvent) {
    e.stopPropagation()
    e.preventDefault()
    drag = {
      kind: 'rotate',
      w: widget.w,
      h: widget.h,
      cx: widget.x + widget.w / 2,
      cy: widget.y + widget.h / 2,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onMove(e: PointerEvent) {
    if (!drag) return
    const t = rad()
    const box = frame(e)
    const k = scale()
    if (drag.kind === 'move') {
      if (tap && !tap.moved) {
        if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 6) return
        tap.moved = true
      }
      // anywhere on the endless page; on a fixed one, only inside it
      widget.x = Math.round((e.clientX - box.left) / k - drag.dx - widget.w / 2)
      widget.y = Math.round((e.clientY - box.top) / k - drag.dy - widget.h / 2)
      keepInside()
    } else if (drag.kind === 'rotate') {
      const cx = box.left + (widget.x + widget.w / 2) * k
      const cy = box.top + (widget.y + widget.h / 2) * k
      let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90
      deg = ((deg % 360) + 360) % 360
      const snap = Math.round(deg / 15) * 15
      if (Math.abs(deg - snap) < 3 || e.shiftKey) deg = snap
      widget.rot = Math.round(deg) % 360
      keepInside()
    } else {
      const { sx, sy, w: w0, h: h0 } = drag
      const cos = Math.cos(t)
      const sin = Math.sin(t)
      const dpx = (e.clientX - drag.px) / k
      const dpy = (e.clientY - drag.py) / k
      // pointer movement expressed along the widget's own (rotated) axes
      const ldx = dpx * cos + dpy * sin
      const ldy = -dpx * sin + dpy * cos

      let w1 = w0
      let h1 = h0
      if (sx && sy) {
        // corners keep the proportions
        const k = Math.max((w0 + sx * ldx) / w0 / 2 + (h0 + sy * ldy) / h0 / 2, MIN_W / w0, MIN_H / h0)
        w1 = w0 * k
        h1 = h0 * k
      } else if (sx) {
        w1 = Math.max(MIN_W, drag.minW, w0 + sx * ldx)
      } else {
        h1 = Math.max(MIN_H, h0 + sy * ldy)
      }
      if (bounds) {
        // never bigger than the page (a corner keeps the proportions)
        const f = Math.min(1, bounds.w / w1, isText ? 1 : bounds.h / h1)
        w1 *= f
        h1 *= sx && sy ? f : 1
      }

      // keep the opposite side/corner where it was
      const fx = (-sx * w0) / 2
      const fy = (-sy * h0) / 2
      const gx = (-sx * w1) / 2
      const gy = (-sy * h1) / 2
      const cx = drag.cx + (fx * cos - fy * sin) - (gx * cos - gy * sin)
      const cy = drag.cy + (fx * sin + fy * cos) - (gx * sin + gy * cos)
      widget.w = Math.round(w1)
      widget.h = Math.round(h1)
      widget.x = Math.round(cx - w1 / 2)
      widget.y = Math.round(cy - h1 / 2)
      keepInside()
    }
  }

  function end() {
    const t = tap
    tap = null
    if (!drag) return
    const wasMove = drag.kind === 'move'
    drag = null
    const plainTap = wasMove && !!t && !t.moved
    // the second tap on a selected text widget: write in it
    if (plainTap && isText && t!.wasSelected) startWriting(t!.x, t!.y)
    else if (!plainTap) onchange()
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={root}
  class="widget"
  class:audio={widget.kind === 'audio'}
  class:text={isText}
  class:selected
  class:editing
  style:left="{widget.x}px"
  style:top="{widget.y}px"
  style:width="{widget.w}px"
  style:height={isText ? undefined : `${widget.h}px`}
  style:transform="rotate({widget.rot ?? 0}deg)"
  style:--inv={inv}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={end}
  onpointercancel={end}
>
  <div class="content">
    {#if widget.kind === 'image'}
      {#if url}<img src={url} alt="" draggable="false" />{/if}
    {:else if widget.kind === 'audio'}
      <div class="audio-wrap">{#if url}<audio controls src={url}></audio>{/if}</div>
      <!-- not selected: a tap anywhere on the player selects it (its own buttons would swallow the tap) -->
      {#if !selected}<div class="audio-cover"></div>{/if}
    {:else}
      <div
        bind:this={tw}
        class="tw"
        dir={widget.dir ?? 'rtl'}
        role="textbox"
        aria-multiline="true"
        tabindex="-1"
        spellcheck="false"
        contenteditable={editing ? 'true' : 'false'}
        style:font-size="{widget.size ?? TEXT_SIZE}px"
        style:font-family={fontCss(widget.font)}
        style:line-height={widget.lh ? `${widget.lh}px` : fontBox(widget.font).lh}
        style:padding-inline={fontBox(widget.font).pad}
        style:margin-block={widget.lh ? undefined : fontBox(widget.font).trim}
        oninput={onInput}
        onpaste={onPaste}
      ></div>
    {/if}
  </div>

  {#if selected}
    <div class="frame"></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="move-handle"
      title="جابه‌جایی"
      onpointerdown={startHandleMove}
      onmousedown={(e) => e.preventDefault()}
    >
      <Icon name="move" size={14} stroke={2.4} />
    </div>
    {#if !editing}
      {#each shownHandles as hd (hd.id)}
        <div class="handle {hd.id}" onpointerdown={(e) => startResize(e, hd)}></div>
      {/each}
      <div class="rot-stem"></div>
      <div class="rot-handle" onpointerdown={startRotate} title="چرخاندن"></div>
      <button class="del" aria-label="حذف" onpointerdown={(e) => e.stopPropagation()} onclick={onremove}>
        <Icon name="close" size={12} stroke={3} />
      </button>
    {/if}
  {/if}
</div>

<style>
  .widget {
    position: absolute;
    z-index: 5;
    user-select: none;
    touch-action: none;
    cursor: move;
  }
  .widget.selected {
    z-index: 6;
  }
  .widget.editing {
    cursor: text;
  }
  .content {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .widget.text .content {
    height: auto;
    overflow: visible;
    border-radius: 0;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: fill;
    display: block;
    pointer-events: none;
  }
  .audio .content {
    position: relative;
    cursor: default;
  }
  .audio-cover {
    position: absolute;
    inset: 0;
    cursor: move;
  }
  .audio-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    padding: 0 5px;
  }
  audio {
    width: 100%;
    height: 40px;
  }

  /* selection: purple frame + handles + rotation knob; dashed while the text is being written */
  .frame {
    position: absolute;
    inset: -1px;
    border: 1.5px solid var(--primary);
    border-radius: 9px;
    pointer-events: none;
  }
  .widget.editing .frame {
    border-style: dashed;
  }
  .handle {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    background: #fff;
    border: 1.5px solid var(--primary);
    border-radius: 3px;
    touch-action: none;
    z-index: 2;
    transform: scale(var(--inv, 1));
  }
  .handle::before {
    content: '';
    position: absolute;
    inset: -9px;
  }
  .nw {
    left: 0;
    top: 0;
    cursor: nwse-resize;
  }
  .n {
    left: 50%;
    top: 0;
    cursor: ns-resize;
  }
  .ne {
    left: 100%;
    top: 0;
    cursor: nesw-resize;
  }
  .e {
    left: 100%;
    top: 50%;
    cursor: ew-resize;
  }
  .se {
    left: 100%;
    top: 100%;
    cursor: nwse-resize;
  }
  .s {
    left: 50%;
    top: 100%;
    cursor: ns-resize;
  }
  .sw {
    left: 0;
    top: 100%;
    cursor: nesw-resize;
  }
  .w {
    left: 0;
    top: 50%;
    cursor: ew-resize;
  }
  .rot-stem {
    position: absolute;
    left: 50%;
    top: -22px;
    width: 1.5px;
    height: 22px;
    margin-left: -0.75px;
    background: var(--primary);
    pointer-events: none;
  }
  .rot-handle {
    position: absolute;
    left: 50%;
    top: -34px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    background: var(--primary-2);
    border: 2px solid #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    cursor: grab;
    touch-action: none;
    z-index: 2;
    transform: scale(var(--inv, 1));
  }
  .rot-handle::before {
    content: '';
    position: absolute;
    inset: -10px;
  }
  /* above the widget, left of the rotation knob: grab it to move the widget */
  .move-handle {
    position: absolute;
    left: calc(50% - 28px);
    top: -27px;
    width: 26px;
    height: 26px;
    margin: -13px 0 0 -13px;
    border-radius: 50%;
    background: var(--primary);
    color: #fff;
    border: 2px solid #fff;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
    display: grid;
    place-items: center;
    cursor: move;
    touch-action: none;
    z-index: 3;
    transform: scale(var(--inv, 1));
  }
  .move-handle::before {
    content: '';
    position: absolute;
    inset: -10px;
  }
  .del {
    position: absolute;
    left: calc(50% + 24px);
    top: -36px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 0;
    background: #ef4444;
    color: #fff;
    cursor: pointer;
    display: grid;
    place-items: center;
    z-index: 2;
    transform: scale(var(--inv, 1));
  }
  .del::before {
    content: '';
    position: absolute;
    inset: -8px;
  }
</style>
