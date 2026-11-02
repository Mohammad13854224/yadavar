<script lang="ts">
  import { untrack } from 'svelte'
  import { fa } from '../lib/format'
  import { onBack } from '../lib/back'

  /** A folder's daily limit of new cards (Anki's "new cards per day" for that one folder); null = no limit. */
  type Props = { name: string; limit: number | null; onsave: (limit: number | null) => void; onclose: () => void }
  let { name, limit, onsave, onclose }: Props = $props()
  $effect(() => onBack(() => (onclose(), true)))

  // the dialog edits its own copy of the limit it opened with
  let on = $state(untrack(() => limit !== null))
  let perDay = $state(untrack(() => limit ?? 20))
  // one at a time up to 10, then by 5 (10, 15, 20 …)
  const step = (d: number) => (perDay = Math.min(500, Math.max(1, perDay + (perDay + d < 10 || (perDay < 10 && d > 0) ? Math.sign(d) : d))))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="box" role="dialog" aria-modal="true" aria-label="کارت جدید در روز">
    <h3>{name}</h3>
    <div class="seg" role="radiogroup" aria-label="سقف کارت جدید">
      <button role="radio" aria-checked={!on} class:on={!on} onclick={() => (on = false)}>بدون سقف</button>
      <button role="radio" aria-checked={on} class:on onclick={() => (on = true)}>سقف روزانه</button>
    </div>
    {#if on}
      <div class="field">
        <span>کارت جدید در روز</span>
        <div class="stepper">
          <button onclick={() => step(-5)} aria-label="کمتر">−</button>
          <b>{fa(perDay)}</b>
          <button onclick={() => step(5)} aria-label="بیشتر">+</button>
        </div>
      </div>
    {/if}
    <div class="row">
      <button class="btn btn-soft" onclick={onclose}>انصراف</button>
      <button class="btn btn-primary" onclick={() => onsave(on ? perDay : null)}>ذخیره</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: grid;
    place-items: center;
    padding: 20px;
    z-index: 510;
  }
  .box {
    background: var(--modal);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 20px;
    width: min(340px, 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h3 {
    font-size: 14px;
    font-weight: 800;
    text-align: center;
    overflow-wrap: anywhere;
  }
  .seg {
    display: flex;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 3px;
    gap: 3px;
  }
  .seg button {
    flex: 1;
    border: 0;
    border-radius: 9px;
    padding: 9px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--primary);
    color: #fff;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 700;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 3px;
  }
  .stepper button {
    width: 34px;
    height: 30px;
    border: 0;
    border-radius: 9px;
    background: var(--surface);
    color: var(--text);
    font-size: 17px;
    cursor: pointer;
  }
  .stepper b {
    min-width: 34px;
    text-align: center;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .row .btn {
    flex: 1;
    justify-content: center;
  }
</style>
