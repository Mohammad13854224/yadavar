<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { onBack } from '../lib/back'

  /** A photo just taken: the part to keep is chosen by dragging the frame's corners and edges (or the frame itself). */
  type Props = { blob: Blob; ondone: (b: Blob) => void; oncancel: () => void }
  let { blob, ondone, oncancel }: Props = $props()

  const url = URL.createObjectURL(untrack(() => blob)) // a new photo opens a new crop screen
  onDestroy(() => URL.revokeObjectURL(url))

  let img: HTMLImageElement | undefined = $state()
  /** shown size of the picture (CSS px) */
  let iw = $state(0)
  let ih = $state(0)
  /** the frame, as fractions (0..1) of the picture */
  let box = $state({ l: 0, t: 0, r: 1, b: 1 })
  let busy = $state(false)

  const MIN = 0.06 // the frame never gets smaller than this part of the picture

  function measure() {
    if (!img) return
    iw = img.clientWidth
    ih = img.clientHeight
  }

  type Edge = { l?: boolean; t?: boolean; r?: boolean; b?: boolean }
  const handles: { id: string; e: Edge }[] = [
    { id: 'nw', e: { l: true, t: true } },
    { id: 'n', e: { t: true } },
    { id: 'ne', e: { r: true, t: true } },
    { id: 'e', e: { r: true } },
    { id: 'se', e: { r: true, b: true } },
    { id: 's', e: { b: true } },
    { id: 'sw', e: { l: true, b: true } },
    { id: 'w', e: { l: true } },
  ]

  let drag: { e: Edge | null; x: number; y: number; start: typeof box } | null = null

  function down(ev: PointerEvent, e: Edge | null) {
    ev.preventDefault()
    ev.stopPropagation()
    drag = { e, x: ev.clientX, y: ev.clientY, start: { ...box } }
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  }

  function move(ev: PointerEvent) {
    if (!drag || !iw || !ih) return
    const dx = (ev.clientX - drag.x) / iw
    const dy = (ev.clientY - drag.y) / ih
    const s = drag.start
    if (!drag.e) {
      // the whole frame moves, inside the picture
      const w = s.r - s.l
      const h = s.b - s.t
      const l = Math.min(1 - w, Math.max(0, s.l + dx))
      const t = Math.min(1 - h, Math.max(0, s.t + dy))
      box = { l, t, r: l + w, b: t + h }
      return
    }
    const n = { ...s }
    if (drag.e.l) n.l = Math.min(s.r - MIN, Math.max(0, s.l + dx))
    if (drag.e.r) n.r = Math.max(s.l + MIN, Math.min(1, s.r + dx))
    if (drag.e.t) n.t = Math.min(s.b - MIN, Math.max(0, s.t + dy))
    if (drag.e.b) n.b = Math.max(s.t + MIN, Math.min(1, s.b + dy))
    box = n
  }

  const up = () => (drag = null)

  async function confirm() {
    if (!img || busy) return
    busy = true
    const full = box.l <= 0.001 && box.t <= 0.001 && box.r >= 0.999 && box.b >= 0.999
    if (full) return ondone(blob)
    const W = img.naturalWidth
    const H = img.naturalHeight
    const sx = Math.round(box.l * W)
    const sy = Math.round(box.t * H)
    const sw = Math.max(1, Math.round((box.r - box.l) * W))
    const sh = Math.max(1, Math.round((box.b - box.t) * H))
    const c = document.createElement('canvas')
    c.width = sw
    c.height = sh
    c.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92))
    ondone(out ?? blob)
  }

  // the back button: the photo is dropped (as with Cancel)
  $effect(() => onBack(() => (oncancel(), true)))
</script>

<svelte:window onresize={measure} />

<div class="crop-overlay" role="dialog" aria-modal="true" aria-label="برش عکس">
  <div class="crop-box">
    <h3>برش عکس</h3>
    <p>گوشه‌ها و لبه‌های کادر را بکش تا فقط بخشی که می‌خواهی بماند.</p>
    <div class="stage">
      <div class="pic">
        <img bind:this={img} src={url} alt="" draggable="false" onload={measure} />
        {#if iw}
          <!-- the part that is cut away is dimmed; the frame is what stays -->
          <div
            class="frame"
            role="presentation"
            style:left="{box.l * 100}%"
            style:top="{box.t * 100}%"
            style:width="{(box.r - box.l) * 100}%"
            style:height="{(box.b - box.t) * 100}%"
            onpointerdown={(e) => down(e, null)}
            onpointermove={move}
            onpointerup={up}
            onpointercancel={up}
          >
            <i class="grid v1"></i><i class="grid v2"></i><i class="grid h1"></i><i class="grid h2"></i>
            {#each handles as h (h.id)}
              <span
                class="handle {h.id}"
                role="presentation"
                onpointerdown={(e) => down(e, h.e)}
                onpointermove={move}
                onpointerup={up}
                onpointercancel={up}
              ></span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" disabled={busy || !iw} onclick={confirm}>تایید</button>
      <button class="btn btn-soft" onclick={() => (box = { l: 0, t: 0, r: 1, b: 1 })}>همه‌ی عکس</button>
      <button class="btn btn-soft" onclick={oncancel}>انصراف</button>
    </div>
  </div>
</div>

<style>
  .crop-overlay {
    position: fixed;
    inset: 0;
    z-index: 420;
    background: rgba(5, 7, 14, 0.92);
    display: grid;
    place-items: center;
    padding: calc(12px + var(--safe-top)) 12px calc(12px + var(--safe-bottom));
  }
  .crop-box {
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 16px;
    width: min(640px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
  h3 {
    font-size: 15px;
    font-weight: 800;
  }
  p {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.8;
  }
  .stage {
    min-height: 0;
    display: grid;
    place-items: center;
    /* room around the picture so the corner handles can be grabbed */
    padding: 12px;
    background: #000;
    border-radius: 14px;
  }
  .pic {
    position: relative;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  img {
    display: block;
    max-width: 100%;
    max-height: 58vh;
    pointer-events: none;
  }
  .frame {
    position: absolute;
    border: 2px solid #fff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    cursor: move;
    touch-action: none;
  }
  .grid {
    position: absolute;
    background: rgba(255, 255, 255, 0.35);
    pointer-events: none;
  }
  .v1,
  .v2 {
    top: 0;
    bottom: 0;
    width: 1px;
  }
  .v1 {
    left: 33.3%;
  }
  .v2 {
    left: 66.6%;
  }
  .h1,
  .h2 {
    left: 0;
    right: 0;
    height: 1px;
  }
  .h1 {
    top: 33.3%;
  }
  .h2 {
    top: 66.6%;
  }
  .handle {
    position: absolute;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
    touch-action: none;
  }
  .handle::before {
    content: '';
    position: absolute;
    inset: -12px;
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
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions .btn {
    flex: 1;
    justify-content: center;
  }
</style>
