<script lang="ts">
  import { onMount } from 'svelte'

  export type Point = { label: string; sub?: string; value: number; text?: string; tip?: string; hot?: boolean }
  /**
   * `split`: index of today. The line up to it is drawn in `color` (what happened), the rest in `futureColor` and dashed
   * (what is expected), and a red line stands on today. The chart opens scrolled so today is in the middle.
   */
  type Props = { points: Point[]; height?: number; color?: string; split?: number; futureColor?: string; step?: number }
  let { points, height = 190, color = 'var(--amber)', split, futureColor = 'var(--green)', step = 42 }: Props = $props()

  const TOP = 28
  const BOTTOM = 40
  const W = $derived(points.length * step)
  const max = $derived(Math.max(1, ...points.map((p) => p.value)))
  const xy = $derived(
    points.map((p, i) => [(i + 0.5) * step, TOP + (1 - p.value / max) * (height - TOP - BOTTOM)] as const),
  )
  const pathOf = (pts: (readonly [number, number])[]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')
  const areaOf = (pts: (readonly [number, number])[]) =>
    pts.length ? `${pathOf(pts)} L${pts[pts.length - 1][0]},${height - BOTTOM} L${pts[0][0]},${height - BOTTOM} Z` : ''
  const past = $derived(split === undefined ? xy : xy.slice(0, split + 1))
  const future = $derived(split === undefined ? [] : xy.slice(split))
  const colorAt = (i: number) => (split !== undefined && i > split ? futureColor : color)

  let wrap: HTMLDivElement
  onMount(() => {
    if (split === undefined || !wrap) return
    wrap.scrollLeft = (split + 0.5) * step - wrap.clientWidth / 2
  })
</script>

<div class="wrap" dir="ltr" bind:this={wrap}>
  <svg viewBox="0 0 {W} {height}" style:min-width="{W}px" style:height="{height}px" role="img">
    <line x1="0" x2={W} y1={height - BOTTOM} y2={height - BOTTOM} class="axis" />
    <path d={areaOf(past)} style="fill:{color}" class="area" />
    <path d={pathOf(past)} style="stroke:{color}" class="stroke" />
    {#if future.length > 1}
      <path d={areaOf(future)} style="fill:{futureColor}" class="area" />
      <path d={pathOf(future)} style="stroke:{futureColor}" class="stroke dashed" />
    {/if}
    {#if split !== undefined && xy[split]}
      <line x1={xy[split][0]} x2={xy[split][0]} y1="4" y2={height - BOTTOM + 4} class="today" />
    {/if}
    {#each points as p, i (i)}
      <g>
        <title>{p.tip ?? ''}</title>
        <circle cx={xy[i][0]} cy={xy[i][1]} r={p.hot ? 5 : 3.5} style="fill:{i === split ? '#ef4444' : colorAt(i)}" />
        {#if p.text}<text x={xy[i][0]} y={xy[i][1] - 10} class="val">{p.text}</text>{/if}
        <text x={xy[i][0]} y={height - 22} class="lab">{p.label}</text>
        {#if p.sub}<text x={xy[i][0]} y={height - 8} class="sub">{p.sub}</text>{/if}
      </g>
    {/each}
  </svg>
</div>

<style>
  .wrap {
    overflow-x: auto;
    scrollbar-width: none;
  }
  .wrap::-webkit-scrollbar {
    display: none;
  }
  svg {
    display: block;
    width: 100%;
  }
  .axis {
    stroke: var(--line);
    stroke-width: 1;
  }
  .area {
    opacity: 0.12;
  }
  .stroke {
    fill: none;
    stroke-width: 2.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .stroke.dashed {
    stroke-dasharray: 6 5;
  }
  .today {
    stroke: #ef4444;
    stroke-width: 2;
  }
  text {
    text-anchor: middle;
    font-family: inherit;
  }
  .val {
    font-size: 11px;
    font-weight: 700;
    fill: var(--text);
  }
  .lab {
    font-size: 11px;
    fill: var(--muted);
    font-weight: 600;
  }
  .sub {
    font-size: 10px;
    fill: #ef4444;
    font-weight: 700;
  }
</style>
