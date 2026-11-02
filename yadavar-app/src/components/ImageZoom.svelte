<script lang="ts">
  import { onMount } from 'svelte'
  import { fitView, panzoom, type View } from '../lib/panzoom'
  import Icon from './Icon.svelte'

  /** A picture full screen: two fingers (or the wheel) zoom, one finger moves it, a double tap shows it whole again. */
  type Props = { url: string; onclose: () => void }
  let { url, onclose }: Props = $props()

  let stage: HTMLDivElement
  let sw = $state(0)
  let sh = $state(0)
  let iw = $state(0)
  let ih = $state(0)
  let view = $state<View>({ z: 1, x: 0, y: 0 })
  let touched = false // the user zoomed or moved: a resize keeps their view

  function fit() {
    if (!sw || !sh || !iw || !ih) return
    view = fitView({ l: 0, t: 0, r: iw, b: ih }, sw, sh, { both: true, maxZ: 1, pad: 16 })
  }

  $effect(() => {
    void sw
    void sh
    void iw
    void ih
    if (!touched) fit()
  })

  onMount(() =>
    panzoom(stage, {
      get: () => view,
      set: (v) => {
        touched = true
        view = v
      },
      canPan: () => true,
    }),
  )

  function onLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement
    iw = img.naturalWidth
    ih = img.naturalHeight
  }

  function reset() {
    touched = false
    fit()
  }

  // a double tap (two taps close together) shows the whole picture again
  let lastTap = 0
  function onTap() {
    const now = Date.now()
    if (now - lastTap < 320) reset()
    lastTap = now
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="zoom" role="dialog" aria-modal="true" aria-label="نمایش بزرگ عکس">
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="stage" role="presentation" bind:this={stage} bind:clientWidth={sw} bind:clientHeight={sh} onclick={onTap}>
    <img
      src={url}
      alt=""
      draggable="false"
      onload={onLoad}
      style:width={iw ? `${iw}px` : undefined}
      style:transform="translate({view.x}px, {view.y}px) scale({view.z})"
      style:visibility={iw ? 'visible' : 'hidden'}
    />
  </div>
  <button class="close" onclick={onclose} aria-label="بستن"><Icon name="close" size={18} stroke={2.4} /></button>
</div>

<style>
  .zoom {
    position: fixed;
    inset: 0;
    z-index: 450;
    background: rgba(4, 6, 12, 0.94);
    animation: fade 0.2s ease;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
  }
  img {
    position: absolute;
    left: 0;
    top: 0;
    max-width: none;
    transform-origin: 0 0;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: none;
  }
  .close {
    position: absolute;
    top: calc(14px + var(--safe-top));
    left: 14px;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: 1px solid var(--line-2);
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    color: var(--text);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
</style>
