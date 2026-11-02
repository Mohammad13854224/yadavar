<script lang="ts">
  import Icon from './Icon.svelte'
  import Art from './Art.svelte'
  import ReviewedToday from './ReviewedToday.svelte'
  import RiskBar from './RiskBar.svelte'
  import VirtualGrid from './VirtualGrid.svelte'
  import { phone } from '../lib/phone.svelte'
  import { fa } from '../lib/format'
  import { app } from '../lib/store.svelte'

  /** id null = the cards at the top level (home) */
  type Props = {
    onstart: (folderId: string | null) => void
    /** the forgetting-risk strip was tapped: the brain map opens */
    onbrain: () => void
    /** something covers the tab (a review, the editor, the brain) */
    paused?: boolean
  }
  let { onstart, onbrain, paused = false }: Props = $props()

  let showDone = $state(false)
  const places = $derived(app.duePlaces)
  const progress = $derived(app.todayProgress)
  const risk = $derived(app.todayRisk)

  const pathText = (id: string | null) => ['خانه', ...(id ? app.pathOf(id).slice(0, -1).map((n) => n.name) : [])].join(' / ')
</script>

<section class="panel">
  <div class="toolbar">
    <div class="toolbar-title">
      مرورهای امروز
      <span class="pill">{fa(places.length)} پوشه</span>
      <button class="done-btn" onclick={() => (showDone = true)}>
        <span class="frac" dir="ltr">
          <b>{fa(progress.done)}</b>
          <i></i>
          <b>{fa(progress.total)}</b>
        </span>
        <small>کل کارت‌های امروز</small>
      </button>
    </div>
  </div>

  <RiskBar percent={risk.percent} cards={risk.cards} {paused} onopen={onbrain} />

  <div class="scroll">
    {#if places.length}
      <!-- only the tiles near the visible area exist (a thousand due folders stay smooth) -->
      <VirtualGrid items={places} minW={phone.on ? 100000 : 230} rowH={phone.on ? 76 : 160} gap={phone.on ? 10 : 14} tile={placeTile} />
    {:else}
      <div class="rem-grid">
        <div class="empty">
          <b>امروز مروری نداری</b><br />
          هر وقت زمان مرور یک کارت برسد، پوشه‌اش اینجا نشان داده می‌شود.
        </div>
      </div>
    {/if}
  </div>
</section>

{#snippet placeTile(f: (typeof places)[number])}
<button class="rem-card" onclick={() => onstart(f.id)}>
  <div class="rem-head">
    <span class="rem-icon"><Icon name={f.id ? 'info' : 'home'} size={20} /></span>
    <span class="rem-art"><Art kind="folder" /></span>
    <span class="rem-name">{f.id ? f.name : 'کارت‌های بیرون پوشه‌ها'}</span>
  </div>
  <div class="rem-badges">
    <span class="badge due"><Icon name="clock" size={12} stroke={2.4} />تعداد کارت‌ها: {fa(f.due + f.fresh)}</span>
  </div>
  <div class="rem-path">
    <Icon name="home" size={13} stroke={2.2} />
    <span>{f.id ? pathText(f.id) : 'خانه'}</span>
  </div>
</button>
{/snippet}

{#if showDone}
  <ReviewedToday onclose={() => (showDone = false)} />
{/if}

<style>
  .done-btn {
    font: inherit;
    color: inherit;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 6px 14px;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition: all 0.25s;
  }
  .done-btn:hover {
    border-color: var(--primary);
    box-shadow: var(--shadow-md);
  }
  .done-btn small {
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
  }
  .frac {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    line-height: 1.15;
    min-width: 26px;
  }
  .frac b {
    font-size: calc(15px * var(--font-scale));
    font-weight: 800;
  }
  .frac i {
    align-self: stretch;
    height: 2px;
    border-radius: 2px;
    background: var(--text);
    margin: 2px 0;
  }

  .rem-art {
    display: none;
  }
  .rem-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    grid-auto-rows: 1fr; /* every tile has the same size, long names wrap onto more lines */
    gap: 14px;
  }
  .rem-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition: all 0.3s cubic-bezier(0.2, 0.8, 0.3, 1);
    position: relative;
    overflow: hidden;
    min-height: 150px;
    text-align: start;
    font: inherit;
    width: 100%;
  }
  .rem-card::before {
    content: '';
    position: absolute;
    top: 0;
    inset-inline: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--amber-2), var(--amber));
    opacity: 0.8;
  }
  .rem-card:hover {
    transform: translateY(-5px);
    border-color: var(--line-2);
    box-shadow: var(--shadow-md);
  }
  .rem-card:active {
    transform: translateY(-2px) scale(0.99);
  }
  .rem-head {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .rem-icon {
    width: 42px;
    height: 42px;
    border-radius: 13px;
    flex-shrink: 0;
    background: linear-gradient(135deg, var(--amber-2), var(--amber));
    color: #fff;
    display: grid;
    place-items: center;
    box-shadow:
      0 10px 20px -12px var(--amber),
      inset 0 1px 0 rgba(255, 255, 255, 0.35);
  }
  .rem-name {
    font-size: calc(14px * var(--font-scale));
    font-weight: 700;
    line-height: 1.55;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rem-badges {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 11px;
    font-weight: 700;
    border-radius: 20px;
    padding: 5px 11px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .badge.due {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 13%, transparent);
    border: 1px solid color-mix(in srgb, var(--amber) 35%, transparent);
  }
  .rem-path {
    font-size: 11px;
    color: var(--muted);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px dashed var(--line);
    margin-top: auto;
    min-width: 0;
  }
  .rem-path span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* phones: one file per row — the picture on the right, the rest on the left, never taller than the picture */
  @media (max-width: 860px) {
    .rem-grid {
      grid-template-columns: 1fr;
      grid-auto-rows: auto;
      gap: 10px;
    }
    .rem-card {
      min-height: 0;
      flex-direction: row;
      align-items: center;
      padding: 10px 12px;
      gap: 12px;
      border-radius: 16px;
    }
    .rem-card:hover {
      transform: none;
    }
    .rem-card::before {
      display: none;
    }
    .rem-head {
      display: contents;
    }
    .rem-icon {
      display: none;
    }
    .rem-art {
      display: grid;
      order: 0;
      width: 54px;
      height: 54px;
      flex: none;
      filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.25));
    }
    .rem-name {
      order: 1;
      flex: 1;
      min-width: 0;
      font-size: calc(13.5px * var(--font-scale));
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .rem-badges {
      order: 2;
      flex: none;
    }
    .badge {
      font-size: 10.5px;
      padding: 4px 9px;
      white-space: nowrap;
    }
    .badge :global(svg) {
      display: none;
    }
    .rem-path {
      display: none;
    }
  }
</style>
