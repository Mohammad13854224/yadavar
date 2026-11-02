<script lang="ts" generics="T">
  import type { Snippet } from 'svelte'
  import { onMount, untrack } from 'svelte'

  /**
   * A grid of equally sized tiles that only builds the tiles near the visible area, so a folder with 10 000 items
   * costs about as much as one with 30. Every tile is exactly `rowH` high; `minW` is the narrowest a tile gets.
   */
  type Props = { items: T[]; minW: number; rowH: number; gap: number; tile: Snippet<[T]> }
  let { items, minW, rowH, gap, tile }: Props = $props()

  let host: HTMLDivElement
  let width = $state(0)
  let first = $state(0) // first row built
  let last = $state(30) // one past the last row built
  const cols = $derived(Math.max(1, Math.floor((width + gap) / (minW + gap))))
  const rows = $derived(Math.ceil(items.length / cols))
  const step = $derived(rowH + gap)
  const visible = $derived(items.slice(first * cols, last * cols))

  /** the nearest ancestor that scrolls (the list scrolls itself on desktop, the whole page on phones) */
  function scrollParent(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY
      if (o === 'auto' || o === 'scroll') return p
    }
    return null
  }

  function update() {
    if (!host) return
    const sp = scrollParent(host)
    const view = sp ? sp.getBoundingClientRect() : { top: 0, height: innerHeight }
    const y0 = Math.max(0, view.top - host.getBoundingClientRect().top)
    const a = Math.max(0, Math.floor(y0 / step) - 2)
    const b = Math.min(rows, Math.ceil((y0 + view.height) / step) + 2)
    if (a !== first) first = a
    if (b !== last) last = b
  }

  /** Brings item i on screen (and so builds its tile), e.g. one just added at the end of a long list. */
  export function reveal(i: number) {
    if (!host) return
    const sp = scrollParent(host)
    const view = sp ? sp.getBoundingClientRect() : { top: 0, height: innerHeight }
    const top = host.getBoundingClientRect().top + Math.floor(i / cols) * step
    if (top < view.top || top + rowH > view.top + view.height) {
      const dy = top - view.top - Math.max(0, (view.height - rowH) / 2)
      if (sp) sp.scrollTop += dy
      else scrollBy(0, dy)
    }
    update()
  }

  onMount(() => {
    const sp = scrollParent(host)
    const targets: (HTMLElement | Window)[] = [window]
    if (sp) targets.push(sp)
    // scroll events fire very often: they are merged into one update per task
    let queued = false
    const onScroll = () => {
      if (queued) return
      queued = true
      setTimeout(() => {
        queued = false
        update()
      }, 0)
    }
    for (const t of targets) t.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => {
      width = host.clientWidth
      update()
    })
    ro.observe(host)
    width = host.clientWidth
    update()
    return () => {
      for (const t of targets) t.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  })

  // the list or the column count changed: rebuild the visible window
  $effect(() => {
    void items.length
    void cols
    void rowH
    untrack(update)
  })
</script>

<div class="vg" bind:this={host} style:height="{Math.max(0, rows * step - gap)}px">
  <div
    class="vg-in"
    style:top="{first * step}px"
    style:gap="{gap}px"
    style:grid-template-columns="repeat({cols}, minmax(0, 1fr))"
    style:grid-auto-rows="{rowH}px"
  >
    {#each visible as item, i (first * cols + i)}
      {@render tile(item)}
    {/each}
  </div>
</div>

<style>
  .vg {
    position: relative;
    width: 100%;
  }
  .vg-in {
    position: absolute;
    inset-inline: 0;
    display: grid;
  }
  .vg-in > :global(*) {
    height: 100%;
    min-height: 0;
  }
</style>
