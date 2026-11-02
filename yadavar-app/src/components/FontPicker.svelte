<script lang="ts">
  import { FONTS, GROUP_NAMES, fontCss, fontInfo, type FontGroup, type FontInfo } from '../lib/fonts'
  import Icon from './Icon.svelte'

  /** The font list: the last three fonts used on top, then every font by group, each shown in itself; a search box filters. */
  type Props = { current: string; recent: string[]; onpick: (id: string) => void; onclose: () => void }
  let { current, recent, onpick, onclose }: Props = $props()

  let query = $state('')
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const matches = (f: FontInfo) => !query.trim() || norm(f.name + f.id).includes(norm(query))

  const recentFonts = $derived(
    recent
      .slice(0, 3)
      .map((id) => FONTS.find((f) => f.id === id))
      .filter((f): f is FontInfo => !!f && matches(f)),
  )
  const groups = $derived(
    (Object.keys(GROUP_NAMES) as FontGroup[])
      .map((g) => ({ g, fonts: FONTS.filter((f) => f.group === g && matches(f)) }))
      .filter((x) => x.fonts.length),
  )

  // a tap on a font must not take the focus from the text being written
  const keep = { onmousedown: (e: MouseEvent) => e.preventDefault() }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

{#snippet row(f: FontInfo)}
  <button class="font" class:on={f.id === current} {...keep} onclick={() => onpick(f.id)}>
    <span class="nm" style:font-family={fontCss(f.id)}>{f.name}</span>
    <span class="sample" dir={f.group === 'en-art' ? 'ltr' : 'rtl'} style:font-family={fontCss(f.id)}>
      {f.group === 'en-art' ? 'The quick brown fox' : 'نمونه‌ی متن فارسی'}
    </span>
    {#if f.id === current}<span class="tick"><Icon name="check" size={14} stroke={3} /></span>{/if}
  </button>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="box" role="dialog" aria-modal="true" aria-label="انتخاب فونت">
    <div class="head">
      <h3>فونت <small>{fontInfo(current).name}</small></h3>
      <button class="x" {...keep} onclick={onclose} aria-label="بستن"><Icon name="close" size={16} stroke={2.4} /></button>
    </div>
    <input class="search" type="search" placeholder="جست‌وجوی فونت…" bind:value={query} spellcheck="false" autocomplete="off" />
    <div class="list">
      {#if recentFonts.length}
        <p class="g">اخیر</p>
        {#each recentFonts as f (f.id)}{@render row(f)}{/each}
      {/if}
      {#each groups as x (x.g)}
        <p class="g">{GROUP_NAMES[x.g]}</p>
        {#each x.fonts as f (f.id)}{@render row(f)}{/each}
      {/each}
      {#if !recentFonts.length && !groups.length}
        <p class="none">فونتی با این نام نیست</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
    padding: 16px;
    z-index: 600;
  }
  .box {
    background: var(--modal);
    border: 1px solid var(--line-2);
    border-radius: 20px;
    padding: 14px;
    width: min(420px, 100%);
    max-height: min(640px, 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h3 {
    font-size: 15px;
    font-weight: 800;
  }
  h3 small {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    margin-inline-start: 6px;
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
  .search {
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    outline: none;
  }
  .search:focus {
    border-color: var(--primary);
  }
  .list {
    overflow: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-inline-end: 2px;
  }
  .g {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    margin: 6px 4px 0;
  }
  .font {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: start;
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 9px 12px;
    padding-inline-end: 36px;
    cursor: pointer;
  }
  .font:hover {
    border-color: var(--primary);
  }
  .font.on {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .nm {
    font-size: 15px;
    line-height: 1.7;
  }
  .sample {
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.7;
    align-self: stretch;
  }
  .tick {
    position: absolute;
    top: 10px;
    inset-inline-end: 10px;
    color: var(--primary-text);
  }
  .none {
    text-align: center;
    color: var(--muted);
    font-size: 12.5px;
    padding: 20px;
  }
</style>
