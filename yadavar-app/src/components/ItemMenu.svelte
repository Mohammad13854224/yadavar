<script lang="ts">
  import Icon from './Icon.svelte'
  import { onBack } from '../lib/back'

  type Props = { name: string; limitLabel?: string; onlimit?: () => void; onrename?: () => void; oncopy: () => void; oncut: () => void; ondelete: () => void; onclose: () => void }
  let { name, limitLabel, onlimit, onrename, oncopy, oncut, ondelete, onclose }: Props = $props()
  $effect(() => onBack(() => (onclose(), true)))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="box" role="dialog" aria-modal="true" aria-label={name}>
    <h3>{name}</h3>
    {#if onrename}<button class="btn btn-soft" onclick={onrename}><Icon name="edit" size={17} />تغییر نام</button>{/if}
    {#if onlimit}<button class="btn btn-soft" onclick={onlimit}><Icon name="clock" size={17} />کارت جدید در روز: {limitLabel}</button>{/if}
    <button class="btn btn-soft" onclick={oncopy}><Icon name="copy" size={17} />کپی</button>
    <button class="btn btn-soft" onclick={oncut}><Icon name="cut" size={17} />کات</button>
    <button class="btn btn-danger" onclick={ondelete}><Icon name="trash" size={17} />حذف</button>
    <button class="cancel" onclick={onclose}>بستن</button>
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
    z-index: 500;
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
    gap: 10px;
  }
  h3 {
    font-size: 14px;
    font-weight: 700;
    line-height: 1.7;
    text-align: center;
    margin-bottom: 6px;
    overflow-wrap: anywhere;
  }
  .box .btn {
    justify-content: center;
    padding: 14px;
  }
  .cancel {
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    padding: 10px;
    cursor: pointer;
  }
</style>
