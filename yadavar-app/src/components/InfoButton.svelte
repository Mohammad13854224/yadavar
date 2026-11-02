<script lang="ts">
  import { onBack } from '../lib/back'

  type Props = { title: string; lines: string[] }
  let { title, lines }: Props = $props()
  let open = $state(false)
  $effect(() => (open ? onBack(() => ((open = false), true)) : undefined))
</script>

<button class="i" onclick={() => (open = true)} aria-label="توضیح نمودار: {title}">i</button>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && (open = false)}>
    <div class="box" role="dialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      {#each lines as l, i (i)}<p>{l}</p>{/each}
      <button class="btn btn-soft" onclick={() => (open = false)}>بستن</button>
    </div>
  </div>
{/if}

<style>
  .i {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line-2);
    background: var(--surface-2);
    color: var(--text-dim);
    font: italic 700 12px/1 Georgia, serif;
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    padding: 0;
    margin-inline-start: 8px;
    vertical-align: middle;
    transition: 0.2s;
  }
  .i:hover {
    color: var(--primary-text);
    border-color: var(--primary);
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: grid;
    place-items: center;
    padding: 20px;
    z-index: 500;
  }
  .box {
    background: var(--modal);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 20px;
    width: min(420px, 100%);
    max-height: 86dvh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h3 {
    font-size: 15px;
    font-weight: 800;
  }
  p {
    font-size: 13px;
    line-height: 2;
    color: var(--text-dim);
    font-weight: 500;
  }
</style>
