<script lang="ts">
  import BrainView from './components/BrainView.svelte'
  import CardEditor from './components/CardEditor.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import InfoTab from './components/InfoTab.svelte'
  import ReviewSession from './components/ReviewSession.svelte'
  import ReviewsTab from './components/ReviewsTab.svelte'
  import SettingsTab from './components/SettingsTab.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import StatusTab from './components/StatusTab.svelte'
  import { app } from './lib/store.svelte'
  import type { TabId } from './lib/types'

  let tab = $state<TabId>('reviews')
  let path = $state<string[]>([])
  let openCardId = $state<string | null>(null)
  /** the folder being reviewed (id null = the cards at the top level); null = no review open */
  let review = $state<{ id: string | null; cardId?: string } | null>(null)
  /** the brain map is open (from the forgetting-risk strip) */
  let brain = $state(false)
  let confirm = $state<{ message: string; action: () => void; yes?: string; danger?: boolean } | null>(null)

  // drop path entries that no longer exist (e.g. after a delete or a reset)
  $effect(() => {
    const ok = path.findIndex((id) => !app.node(id))
    if (ok !== -1) path = path.slice(0, ok)
  })

  // theme + text size
  let systemDark = $state(matchMedia('(prefers-color-scheme: dark)').matches)
  $effect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => (systemDark = e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  })
  $effect(() => {
    const t = app.settings.theme
    const dark = t === 'dark' || (t === 'system' && systemDark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.setProperty('--font-scale', String(app.settings.fontScale))
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0c14' : '#f1f3fb')
  })

  // going to the background (another app, the phone locked, the app closed): edits still waiting are saved at once;
  // coming back: a new Anki day may have started meanwhile
  $effect(() => {
    const on = () => {
      if (document.hidden) app.flush()
      else if (!review && !openCardId) app.refresh()
    }
    const leave = () => app.flush()
    document.addEventListener('visibilitychange', on)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', on)
      window.removeEventListener('pagehide', leave)
    }
  })

  // while the app stays open: a card answered "again" becomes ready again minutes later, and a new Anki day can start
  $effect(() => {
    const t = setInterval(() => {
      if (document.hidden || review || openCardId || app.working) return
      if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return // typing a name: later
      const now = Date.now()
      const back = app.cards.some((c) => c.state === 'learning' && !c.ready && c.due > app.snapAt && c.due <= now)
      if (back || now >= app.dayStart + 86_400_000) app.refresh()
    }, 30_000)
    return () => clearInterval(t)
  })

  const ask = (message: string, action: () => void, yes?: string, danger?: boolean) => (confirm = { message, action, yes, danger })
</script>

{#if app.offline}
  <div class="offline" role="alert">
    <b>موتور انکی در دسترس نیست</b>
    <span>چند لحظه بعد دوباره امتحان کن؛ اگر درست نشد، برنامه را ببند و دوباره باز کن.</span>
    <button class="btn btn-primary" onclick={() => app.refresh()}>تلاش دوباره</button>
  </div>
{/if}

<div class="layout">
  <Sidebar
    {tab}
    onselect={(t) => {
      // the info tab opens where it was left; tapped again while open, it goes home
      if (t === 'info' && tab === 'info') path = []
      tab = t
    }}
  />

  <main class="main">
    {#key tab}
      {#if tab === 'reviews'}
        <ReviewsTab onstart={(id) => (review = { id })} onbrain={() => (brain = true)} paused={!!review || !!openCardId || brain} />
      {:else if tab === 'info'}
        <InfoTab {path} onpath={(p) => (path = p)} onopencard={async (id) => {
            try {
              await app.ensureCard(id) // the lists carry only names and schedules
              openCardId = id
            } catch {
              app.toast('باز کردن کارت انجام نشد')
            }
          }} onconfirm={ask} />
      {:else if tab === 'status'}
        <StatusTab />
      {:else}
        <SettingsTab onconfirm={ask} />
      {/if}
    {/key}
  </main>
</div>

{#if openCardId}
  <CardEditor cardId={openCardId} onclose={() => (openCardId = null)} />
{/if}

{#if brain}
  <BrainView onclose={() => (brain = false)} onreview={(cardId, id) => (review = { id, cardId })} paused={!!review} />
{/if}

{#if review}
  <ReviewSession folderId={review.id} cardId={review.cardId ?? null} onclose={() => (review = null)} />
{/if}

{#if confirm}
  <ConfirmDialog
    message={confirm.message}
    yes={confirm.yes}
    danger={confirm.danger}
    onno={() => (confirm = null)}
    onyes={() => {
      confirm?.action()
      confirm = null
    }}
  />
{/if}

{#if app.working || app.toastText}
  <div class="toast" role="status">{app.working || app.toastText}</div>
{/if}

<style>
  .toast {
    position: fixed;
    inset-inline: 16px;
    margin-inline: auto;
    width: fit-content;
    max-width: calc(100% - 32px);
    bottom: calc(24px + var(--safe-bottom));
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--line-2);
    padding: 12px 20px;
    border-radius: 14px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: var(--shadow-lg);
    z-index: 600;
    animation: up 0.3s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  @keyframes up {
    from {
      transform: translateY(16px);
      opacity: 0;
    }
  }
  @media (max-width: 860px) {
    .toast {
      bottom: calc(96px + var(--safe-bottom));
    }
  }

  .offline {
    position: fixed;
    inset-inline: 0;
    top: 0;
    z-index: 600;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    background: var(--surface);
    border-bottom: 2px solid #f43f5e;
    box-shadow: var(--shadow-md);
    font-size: 13px;
  }
  .offline span {
    color: var(--muted);
    flex: 1;
  }
</style>
