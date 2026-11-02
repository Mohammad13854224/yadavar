<script lang="ts">
  import { onBack } from '../lib/back'
  import { fa } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import Icon from './Icon.svelte'

  type Props = { onclose: () => void }
  let { onclose }: Props = $props()

  const names = { 1: 'دوباره', 2: 'سخت', 3: 'خوب', 4: 'آسان' } as const
  const tones = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' } as const

  /** folders (and the top level) with the cards reviewed today (the last grade given) */
  const groups = $derived.by(() => {
    const since = app.dayStart
    const byFolder = new Map<string | null, Map<string, number[]>>()
    for (const r of app.revlog) {
      if (r.at < since) continue
      const card = app.card(r.cardId)
      if (!card) continue
      const cards = byFolder.get(card.folderId) ?? new Map<string, number[]>()
      cards.set(card.id, [...(cards.get(card.id) ?? []), r.rating])
      byFolder.set(card.folderId, cards)
    }
    return [...byFolder].map(([folderId, cards]) => ({
      key: folderId ?? 'home',
      name: folderId ? (app.node(folderId)?.name ?? '') : 'کارت‌های بیرون پوشه‌ها',
      path: folderId ? ['خانه', ...app.pathOf(folderId).slice(0, -1).map((n) => n.name)].join(' / ') : 'خانه',
      cards: [...cards].map(([id, ratings]) => ({ card: app.card(id)!, ratings })),
    }))
  })

  let open = $state<string | null>(null)
  $effect(() => onBack(() => (onclose(), true)))
  const total = $derived(groups.reduce((s, g) => s + g.cards.length, 0))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="box" role="dialog" aria-modal="true" aria-label="مرور شده‌ی امروز">
    <div class="head">
      <div>
        <h3>مرور شده‌ی امروز</h3>
        <p>{fa(total)} کارت در {fa(groups.length)} پوشه</p>
      </div>
      <button class="x" onclick={onclose} aria-label="بستن"><Icon name="close" size={16} stroke={2.4} /></button>
    </div>

    <div class="list">
      {#each groups as g (g.key)}
        <div class="item" class:open={open === g.key}>
          <button class="row" aria-expanded={open === g.key} onclick={() => (open = open === g.key ? null : g.key)}>
            <span class="ic"><Icon name="reviews" size={17} /></span>
            <span class="nm"><b>{g.name}</b>{#if g.path}<small>{g.path}</small>{/if}</span>
            <span class="pill">{fa(g.cards.length)} کارت</span>
            <span class="chev"><Icon name="chevron" size={16} stroke={2.4} /></span>
          </button>
          <div class="drawer">
            <ul>
              {#each g.cards as c (c.card.id)}
                {@const last = c.ratings[c.ratings.length - 1] as 1 | 2 | 3 | 4}
                <li>
                  <span class="cn">{c.card.name}</span>
                  <span class="rs">
                    <!-- one grade per card: the last answer decides where the card goes -->
                    <em class="tag {tones[last]}">{names[last]}</em>
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        </div>
      {:else}
        <div class="empty">امروز هنوز کارتی مرور نکرده‌ای.</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: var(--overlay); backdrop-filter: blur(10px); display: grid; place-items: center; padding: 20px; z-index: 250; animation: fade 0.25s ease; }
  @keyframes fade { from { opacity: 0; } }
  .box { background: var(--modal); border: 1px solid var(--line-2); border-radius: 24px; padding: 20px; width: min(560px, 100%); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; gap: 16px; box-shadow: var(--shadow-lg); }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  h3 { font-size: 17px; font-weight: 800; }
  .head p { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .x { width: 36px; height: 36px; border-radius: 11px; border: 1px solid var(--line); background: var(--surface-2); color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .list { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 2px; scrollbar-width: thin; }
  /* full height always: the list scrolls (a squeezed row would cut its open drawer off) */
  .item { flex-shrink: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; transition: border-color 0.25s; }
  .item.open { border-color: var(--primary); }
  .row { width: 100%; border: 0; background: transparent; display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; text-align: start; font: inherit; color: inherit; }
  .ic { width: 36px; height: 36px; border-radius: 11px; background: linear-gradient(135deg, var(--amber-2), var(--amber)); color: #fff; display: grid; place-items: center; flex-shrink: 0; }
  .nm { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .nm b { font-size: 13.5px; overflow-wrap: anywhere; }
  .nm small { font-size: 11px; color: var(--muted); }
  .chev { color: var(--muted); transition: transform 0.3s; transform: rotate(0deg); }
  .open .chev { transform: rotate(-90deg); }
  /* animated drawer: grid row grows from 0 to its content */
  .drawer { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.3s ease; }
  .open .drawer { grid-template-rows: 1fr; }
  .drawer ul { overflow: hidden; list-style: none; min-height: 0; }
  .open .drawer ul { border-top: 1px dashed var(--line); padding: 6px 14px 10px; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; font-size: 13px; }
  li + li { border-top: 1px solid var(--line); }
  .cn { overflow-wrap: anywhere; font-weight: 600; }
  .rs { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
  .tag { font-style: normal; font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 20px; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .again { --tone: var(--red); } .hard { --tone: var(--amber); } .good { --tone: var(--green); } .easy { --tone: #38bdf8; }
  .empty { text-align: center; padding: 36px 10px; color: var(--muted); font-size: 13px; }
</style>
