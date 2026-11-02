<script lang="ts">
  import { onBack } from '../lib/back'
  type Props = { message: string; onyes: () => void; onno: () => void; yes?: string; danger?: boolean }
  let { message, onyes, onno, yes = 'حذف', danger = true }: Props = $props()
  $effect(() => onBack(() => (onno(), true)))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onno()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onno()}>
  <div class="box" role="alertdialog" aria-modal="true" aria-label={message}>
    <p>{message}</p>
    <div class="row">
      <button class="btn btn-soft" onclick={onno}>انصراف</button>
      <button class="btn {danger ? 'btn-danger' : 'btn-primary'}" onclick={onyes}>{yes}</button>
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
    z-index: 500;
  }
  .box {
    background: var(--modal);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 22px;
    width: min(400px, 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  p {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.9;
  }
  .row {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  .row .btn {
    flex: 1;
  }
</style>
