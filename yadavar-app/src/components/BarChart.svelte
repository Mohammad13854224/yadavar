<script lang="ts">
  export type Bar = { label: string; sub?: string; value: number; extra?: number; text?: string; tip?: string; mark?: boolean }
  type Props = { bars: Bar[]; height?: number; color?: string; extraColor?: string; labelEvery?: number }
  let { bars, height = 170, color = 'var(--primary)', extraColor = 'var(--green)', labelEvery = 1 }: Props = $props()

  const max = $derived(Math.max(1, ...bars.map((b) => b.value + (b.extra ?? 0))))
</script>

<div class="bars" dir="ltr" style:height="{height}px">
  {#each bars as b, i (i)}
    <div class="col" title={b.tip}>
      <span class="val">{b.text ?? ''}</span>
      <div class="track">
        {#if b.extra}<div class="fill extra" style="height:{(b.extra / max) * 100}%; background:{extraColor}"></div>{/if}
        <div class="fill" style="height:{(b.value / max) * 100}%; background:{color}"></div>
      </div>
      <span class="lab">{i % labelEvery === 0 ? b.label : ''}</span>
      <span class="sub">{i % labelEvery === 0 ? (b.sub ?? '') : ''}</span>
    </div>
  {/each}
</div>

<style>
  .bars {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding-bottom: 4px;
  }
  .col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    border-radius: 8px;
  }
  .track {
    flex: 1;
    width: 100%;
    max-width: 26px;
    display: flex;
    flex-direction: column-reverse;
    background: var(--surface-2);
    border-radius: 7px;
    overflow: hidden;
    min-height: 0;
  }
  .fill {
    width: 100%;
    flex: none;
    min-height: 0;
    transition: height 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .val {
    font-size: 10px;
    font-weight: 700;
    color: var(--text-dim);
    height: 14px;
    line-height: 14px;
    white-space: nowrap;
  }
  .lab {
    font-size: 10px;
    color: var(--muted);
    font-weight: 600;
    height: 13px;
    white-space: nowrap;
  }
  .sub {
    font-size: 9.5px;
    color: var(--muted);
    height: 12px;
    white-space: nowrap;
    opacity: 0.8;
  }
</style>
