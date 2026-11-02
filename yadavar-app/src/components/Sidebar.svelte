<script lang="ts">
  import Icon from './Icon.svelte'
  import { fa } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import type { TabId } from '../lib/types'

  type Props = { tab: TabId; onselect: (t: TabId) => void }
  let { tab, onselect }: Props = $props()

  const tabs: { id: TabId; label: string; hint: string; icon: 'reviews' | 'info' | 'status' | 'settings' }[] = [
    { id: 'reviews', label: 'مرورها', hint: 'مرورهای امروز', icon: 'reviews' },
    { id: 'info', label: 'اطلاعات', hint: 'پوشه‌ها و کارت‌ها', icon: 'info' },
    { id: 'status', label: 'وضعیت', hint: 'نمودار و آمار', icon: 'status' },
    { id: 'settings', label: 'تنظیمات', hint: 'ظاهر و مرور', icon: 'settings' },
  ]

  const dueCount = $derived(app.duePlaces.length)
</script>

<aside class="sidebar">
  <div class="brand">
    <div class="logo"><Icon name="reviews" size={22} /></div>
    <div>
      <h1>یادآور</h1>
      <p>مرور هوشمند با تکرار فاصله‌دار</p>
    </div>
  </div>

  <div class="nav-wrap">
    <div class="label">منوی اصلی</div>
    <nav class="tabs" aria-label="منوی اصلی">
      {#each tabs as t (t.id)}
        <button class="tab" class:active={tab === t.id} onclick={() => onselect(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
          <span class="tab-icon">
            <Icon name={t.icon} size={17} />
            {#if t.id === 'reviews' && dueCount > 0}<i class="dot"></i>{/if}
          </span>
          <span class="tab-text">
            {t.label}
            <small>{t.hint}</small>
          </span>
          {#if t.id === 'reviews' && dueCount > 0}<span class="badge">{fa(dueCount)}</span>{/if}
        </button>
      {/each}
    </nav>
  </div>
</aside>

<style>
  .sidebar {
    grid-column: 2;
    grid-row: 1;
    background: var(--sidebar);
    border: 1px solid var(--line);
    box-shadow:
      var(--shadow-md),
      inset 0 1px 0 rgba(255, 255, 255, 0.03);
    border-radius: 24px;
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 4px 18px;
    border-bottom: 1px solid var(--line);
  }
  .logo {
    width: 46px;
    height: 46px;
    border-radius: 14px;
    flex-shrink: 0;
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    display: grid;
    place-items: center;
    color: #fff;
    box-shadow:
      0 10px 22px -8px var(--primary),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }
  h1 {
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.2px;
  }
  .brand p {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
    font-weight: 500;
  }
  .label {
    font-size: 10.5px;
    font-weight: 700;
    color: var(--muted);
    padding: 0 6px;
    margin-bottom: 8px;
  }
  .nav-wrap {
    flex: 1;
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tab {
    border: 0;
    background: transparent;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-dim);
    padding: 12px 14px;
    border-radius: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: all 0.28s cubic-bezier(0.2, 0.8, 0.3, 1);
    text-align: start;
    width: 100%;
    position: relative;
  }
  .tab-icon {
    width: 34px;
    height: 34px;
    border-radius: 11px;
    background: var(--surface-2);
    color: var(--muted);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    transition: all 0.28s cubic-bezier(0.2, 0.8, 0.3, 1);
    position: relative;
  }
  .tab-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }
  .tab-text small {
    font-size: 10.5px;
    font-weight: 500;
    color: var(--muted);
    transition: 0.28s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .tab:hover .tab-icon {
    background: var(--surface-3);
    color: var(--primary);
  }
  .tab.active {
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    color: #fff;
    box-shadow:
      0 14px 26px -14px var(--primary),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }
  .tab.active .tab-icon {
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
  }
  .tab.active .tab-text small {
    color: rgba(255, 255, 255, 0.78);
  }
  .badge {
    min-width: 24px;
    height: 22px;
    padding: 0 7px;
    border-radius: 20px;
    background: var(--amber-2);
    color: #3b2400;
    font-size: 11px;
    font-weight: 800;
    display: grid;
    place-items: center;
  }
  .dot {
    display: none;
  }

  /* phones / narrow windows: bottom navigation bar (easy to reach with a thumb) */
  @media (max-width: 860px) {
    .sidebar {
      position: fixed;
      inset-inline: 10px;
      bottom: calc(10px + var(--safe-bottom));
      top: auto;
      height: auto;
      min-height: 0;
      padding: 8px;
      border-radius: 22px;
      z-index: 100;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .brand,
    .label {
      display: none;
    }
    .tabs {
      flex-direction: row;
      gap: 4px;
    }
    .tab {
      flex: 1;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 8px 4px 7px;
      font-size: 11px;
      border-radius: 16px;
      text-align: center;
    }
    .tab-text {
      align-items: center;
      flex: none;
    }
    .tab-text small,
    .badge {
      display: none;
    }
    .tab-icon {
      width: 30px;
      height: 30px;
      background: transparent;
    }
    .tab:hover .tab-icon {
      background: transparent;
    }
    .dot {
      display: block;
      position: absolute;
      top: 2px;
      inset-inline-end: 2px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--amber-2);
      box-shadow: 0 0 0 2px var(--surface);
    }
  }
</style>
