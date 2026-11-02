<script lang="ts">
  import { untrack } from 'svelte'
  import { fa } from '../lib/format'
  import type { ImportRow } from '../lib/importCards'
  import Icon from './Icon.svelte'
  import { onBack } from '../lib/back'

  /** Cards found in a file: the new folder's name and how many new cards a day it shows. */
  type Props = {
    fileName: string
    rows: ImportRow[]
    skipped: number
    onconfirm: (name: string, perDay: number) => void
    onclose: () => void
  }
  let { fileName, rows, skipped, onconfirm, onclose }: Props = $props()
  $effect(() => onBack(() => (onclose(), true)))

  let name = $state(untrack(() => fileName.replace(/\.[^.]+$/, '')) || 'کارت‌های وارد شده')
  let perDay = $state(20)
  const days = $derived(Math.ceil(rows.length / perDay))
  // one at a time up to 10, then by 5 (10, 15, 20 …)
  const step = (d: number) => (perDay = Math.min(500, Math.max(1, perDay + (perDay + d < 10 || (perDay < 10 && d > 0) ? Math.sign(d) : d))))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="box" role="dialog" aria-modal="true" aria-label="وارد کردن کارت‌ها">
    <div class="head">
      <h3>وارد کردن کارت‌ها</h3>
      <button class="x" onclick={onclose} aria-label="بستن"><Icon name="close" size={16} stroke={2.4} /></button>
    </div>

    {#if rows.length}
      <p class="found">
        <b>{fa(rows.length)}</b> کارت پیدا شد{#if skipped}<small> · {fa(skipped)} خط بدون پشت کارت کنار گذاشته شد</small>{/if}
      </p>
      <ul class="preview">
        {#each rows.slice(0, 3) as r, i (i)}
          <li><span dir="auto">{r.front}</span><i>←</i><span dir="auto">{r.back}</span></li>
        {/each}
      </ul>

      <label class="field">
        <span>نام پوشه‌ی جدید</span>
        <input bind:value={name} spellcheck="false" autocomplete="off" />
      </label>

      <div class="field">
        <span>کارت جدید در روز</span>
        <div class="stepper">
          <button onclick={() => step(-5)} aria-label="کمتر">−</button>
          <b>{fa(perDay)}</b>
          <button onclick={() => step(5)} aria-label="بیشتر">+</button>
        </div>
      </div>
      <p class="hint">همه‌ی کارت‌ها در حدود {fa(days)} روز شروع می‌شوند. مرور کارت‌هایی که قبلاً دیده‌ای جداست و محدود نمی‌شود.</p>

      <div class="row">
        <button class="btn btn-soft" onclick={onclose}>انصراف</button>
        <button class="btn btn-primary" disabled={!name.trim()} onclick={() => onconfirm(name.trim(), perDay)}>
          <Icon name="import" size={16} />وارد کن
        </button>
      </div>
    {:else}
      <p class="found">کارتی در این فایل پیدا نشد. هر خط یک کارت است: روی کارت، یک Tab (یا ; یا ,)، پشت کارت.</p>
      <div class="row"><button class="btn btn-soft" onclick={onclose}>بستن</button></div>
    {/if}
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
    padding: 16px;
    z-index: 500;
  }
  .box {
    background: var(--modal);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 18px;
    width: min(420px, 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h3 {
    font-size: 15px;
    font-weight: 800;
  }
  .x {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text-dim);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .found {
    font-size: 13px;
    line-height: 1.8;
  }
  .found small {
    color: var(--muted);
  }
  .preview {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }
  .preview li {
    display: flex;
    gap: 8px;
    align-items: center;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 7px 10px;
    min-width: 0;
  }
  .preview span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview i {
    font-style: normal;
    color: var(--muted);
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
    font-weight: 700;
  }
  .field input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
    outline: none;
  }
  .field input:focus {
    border-color: var(--primary);
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
  .hint {
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.8;
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
