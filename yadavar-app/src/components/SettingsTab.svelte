<script lang="ts">
  import { onMount } from 'svelte'
  import { fa } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import type { ThemeChoice } from '../lib/types'
  import Icon from './Icon.svelte'

  type Props = { onconfirm: (message: string, action: () => void, yes?: string, danger?: boolean) => void }
  let { onconfirm }: Props = $props()

  const themes: { id: ThemeChoice; label: string; icon: 'moon' | 'sun' | 'monitor' }[] = [
    { id: 'dark', label: 'تیره', icon: 'moon' },
    { id: 'light', label: 'روشن', icon: 'sun' },
    { id: 'system', label: 'مثل سیستم', icon: 'monitor' },
  ]

  const s = app.settings
  const fsrs = $derived(app.fsrs)

  // permissions exist only inside the Android app
  type Perm = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  let perms = $state<{ microphone: Perm; camera: Perm } | null>(null)
  let nativePerms = $state<(typeof import('../lib/engine/native'))['permissions'] | null>(null)
  onMount(() => void app.checkFsrs()) // the review count as it is now
  onMount(async () => {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (!cap?.isNativePlatform?.()) return
    nativePerms = (await import('../lib/engine/native')).permissions
    perms = await nativePerms.check()
  })
  // back from Android's own settings screen: show what was changed there
  onMount(() => {
    const recheck = async () => {
      if (document.visibilityState === 'visible' && nativePerms) perms = await nativePerms.check()
    }
    document.addEventListener('visibilitychange', recheck)
    return () => document.removeEventListener('visibilitychange', recheck)
  })
  const permText = (p: Perm) => (p === 'granted' ? 'داده شده' : p === 'denied' ? 'رد شده' : 'هنوز پرسیده نشده')
  const allGranted = $derived(!!perms && perms.microphone === 'granted' && perms.camera === 'granted')

  let shrunk = $state<string | null>(null)
  async function shrink() {
    const r = await app.shrinkSounds()
    if (!r) return
    const mb = (b: number) => fa(Math.round((b / 1e6) * 10) / 10)
    shrunk = r.count ? `${fa(r.count)} صدا فشرده شد: از ${mb(r.before)} به ${mb(r.after)} مگابایت` : 'صدای حجیمی پیدا نشد؛ همه چیز بهینه است'
  }

  function set<K extends keyof typeof s>(key: K, value: (typeof s)[K]) {
    app.settings[key] = value
    app.saveSettings()
  }

</script>

<section class="panel">
  <header class="page-head">
    <div>
      <h2>تنظیمات</h2>
    </div>
  </header>

  <div class="scroll">
  <div class="cards">
    <div class="box">
      <h4>ظاهر</h4>
      <div class="row">
        <div class="row-text"><b>پوسته</b></div>
        <div class="seg" role="radiogroup" aria-label="پوسته">
          {#each themes as t (t.id)}
            <button
              class:on={app.settings.theme === t.id}
              role="radio"
              aria-checked={app.settings.theme === t.id}
              onclick={() => set('theme', t.id)}
            >
              <Icon name={t.icon} size={15} />{t.label}
            </button>
          {/each}
        </div>
      </div>
      <div class="row">
        <div class="row-text"><b>اندازه‌ی متن</b><small>{fa(Math.round(app.settings.fontScale * 100))}٪</small></div>
        <input
          class="range"
          type="range"
          min="0.85"
          max="1.4"
          step="0.05"
          value={app.settings.fontScale}
          oninput={(e) => set('fontScale', +e.currentTarget.value)}
          aria-label="اندازه‌ی متن"
        />
      </div>
    </div>

    <div class="box">
      <h4>مرور</h4>
      <div class="row">
        <div class="row-text">
          <b>احتمال یادآوری مطلوب</b><small>{fa(Math.round(app.settings.retention * 100))}٪</small>
          {#if fsrs && !fsrs.enabled}<small>از وقتی FSRS روشن شود اثر می‌کند</small>{/if}
        </div>
        <input
          class="range"
          type="range"
          min="0.7"
          max="0.97"
          step="0.01"
          value={app.settings.retention}
          oninput={(e) => set('retention', +e.currentTarget.value)}
          aria-label="احتمال یادآوری مطلوب"
        />
      </div>
    </div>

    <!-- how the cards made from now on look; cards made before keep how they were made -->
    <div class="box">
      <h4>کارت ثابت و محدود</h4>
      <div class="row">
        <div class="row-text">
          <b>ثابت و هم‌اندازه</b>
          <small>صفحه‌ی کارت جابه‌جا و بزرگ‌وکوچک نمی‌شود و همه‌ی کارت‌ها یک اندازه‌اند؛ متن و عکس فقط داخل همان صفحه جا می‌گیرند</small>
        </div>
        <button
          class="switch"
          class:on={!!app.settings.fixedCards}
          role="switch"
          aria-checked={!!app.settings.fixedCards}
          aria-label="کارت ثابت و محدود"
          onclick={() => set('fixedCards', !app.settings.fixedCards)}
        ><i></i></button>
      </div>
      <div class="row">
        <div class="row-text">
          <b>خط‌دار بودن</b>
          <small>صفحه‌ی کارت‌ها خط‌های راهنمای نوشتن داشته باشد</small>
        </div>
        <button
          class="switch"
          class:on={app.settings.ruledCards !== false}
          role="switch"
          aria-checked={app.settings.ruledCards !== false}
          aria-label="خط‌دار بودن"
          onclick={() => set('ruledCards', app.settings.ruledCards === false)}
        ><i></i></button>
      </div>
      <p class="note">فقط روی کارت‌هایی اثر دارد که از این به بعد ساخته یا وارد می‌شوند؛ کارت‌های قبلی همان‌طور که ساخته شده‌اند می‌مانند.</p>
    </div>

    {#if perms && nativePerms}
      <div class="box">
        <h4>دسترسی‌ها</h4>
        <div class="row">
          <div class="row-text"><b>میکروفون</b></div>
          <span class="pill-state" class:on={perms.microphone === 'granted'}>{permText(perms.microphone)}</span>
        </div>
        <div class="row">
          <div class="row-text"><b>دوربین</b></div>
          <span class="pill-state" class:on={perms.camera === 'granted'}>{permText(perms.camera)}</span>
        </div>
        {#if !allGranted}
          <div class="row">
            <div class="btns">
              <button class="btn btn-primary" onclick={async () => (perms = await nativePerms!.request())}>درخواست دسترسی</button>
              <button class="btn btn-soft" onclick={() => nativePerms!.openSettings()}>تنظیمات اندروید</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <div class="box">
      <h4>الگوریتم مرور</h4>
      {#if fsrs}
        <div class="row">
          <div class="row-text">
            <b>{fsrs.enabled ? 'FSRS' : 'کلاسیک انکی (SM-2)'}</b>
            {#if !fsrs.enabled}<small>{fa(fsrs.reviews)} از {fa(fsrs.hardLimit)} مرور</small>{/if}
          </div>
          <span class="pill-state" class:on={fsrs.enabled}>{fsrs.enabled ? 'روشن' : 'خاموش'}</span>
        </div>
        {#if !fsrs.enabled}
          <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax={fsrs.hardLimit} aria-valuenow={Math.min(fsrs.reviews, fsrs.hardLimit)}>
            <span style:width="{Math.min(100, (fsrs.reviews / fsrs.hardLimit) * 100)}%"></span>
          </div>
        {/if}
      {:else}
        <div class="row"><div class="row-text"><small>وضعیت الگوریتم هنوز از انکی خوانده نشده</small></div></div>
      {/if}
    </div>

    <div class="box">
      <h4>حجم برنامه</h4>
      <div class="row">
        <div class="row-text">
          <b>فشرده کردن صداهای قدیمی</b>
          <small>صداهایی که با نسخه‌های قبلی ضبط شده‌اند بی‌فشرده‌اند (هر دقیقه حدود ۶ مگابایت). همان صدا با حدود یک‌دهم حجم ذخیره می‌شود و فایل‌های قدیمی پاک می‌شوند. صداهای تازه از قبل فشرده‌اند.</small>
          {#if shrunk}<small class="done">{shrunk}</small>{/if}
        </div>
      </div>
      <div class="btns grow">
        <button class="btn btn-primary" disabled={!!app.working} onclick={shrink}>کم کردن حجم صداها</button>
      </div>
    </div>

    <div class="box">
      <h4>پشتیبان</h4>
      <!-- which build is installed (the APK's version is 1.1.<this number>) -->
      <p class="note">نسخه‌ی برنامه: <b dir="ltr">1.1.{__BUILD__}</b></p>
      <!-- the AGPL asks that everyone who gets the app can get its source -->
      <p class="note">
        یادآور متن‌باز است (مجوز AGPL-3.0) و با موتور متن‌باز انکی کار می‌کند؛ وابسته به انکی نیست.
        <a href="https://github.com/Mohammad13854224/yadavar" target="_blank" rel="noopener">کد منبع</a>
      </p>
      <div class="btns grow">
        <button class="btn btn-primary" onclick={() => app.exportBackup()}>خروجی گرفتن</button>
        <button
          class="btn btn-soft"
          onclick={() => onconfirm('همه‌ی اطلاعات فعلی با فایل پشتیبان جایگزین شود؟', () => app.importBackup(), 'جایگزین کن', false)}
        >
          وارد کردن
        </button>
      </div>
    </div>

    <div class="box">
      <h4>داده‌ها</h4>
      <div class="btns grow">
        <button class="btn btn-danger" onclick={() => onconfirm('همه‌ی پوشه‌ها و کارت‌ها برای همیشه حذف شوند؟', () => app.resetAll(false))}>
          <Icon name="trash" size={16} />پاک‌کردن همه‌چیز
        </button>
      </div>
    </div>
  </div>
  </div>
</section>

<style>
  .btns {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .btns.grow > .btn {
    flex: 1;
    justify-content: center;
  }
  .pill-state {
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 20px;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
  }
  .pill-state.on {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 14%, transparent);
    border-color: color-mix(in srgb, var(--green) 40%, transparent);
  }
  .meter {
    height: 10px;
    background: var(--surface-3);
    border-radius: 20px;
    overflow: hidden;
    margin: 4px 0 8px;
  }
  .meter span {
    display: block;
    height: 100%;
    border-radius: 20px;
    background: linear-gradient(90deg, var(--primary-2), var(--primary));
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 760px;
  }
  .box {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 6px 20px 8px;
    box-shadow: var(--shadow-sm);
  }
  h4 {
    font-size: 13px;
    font-weight: 700;
    color: var(--primary-text);
    padding: 16px 0 6px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-top: 1px solid var(--line);
  }
  h4 + .row {
    border-top: 0;
  }
  .row-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .row-text b {
    font-size: calc(13.5px * var(--font-scale));
    font-weight: 700;
  }
  .row-text small {
    font-size: 11.5px;
    color: var(--muted);
    font-weight: 500;
    line-height: 1.7;
  }

  /* an on / off switch */
  .switch {
    flex: none;
    width: 46px;
    height: 26px;
    border-radius: 999px;
    border: 1px solid var(--line-2);
    background: var(--surface-3);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
  }
  .switch i {
    position: absolute;
    top: 2px;
    inset-inline-start: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    transition: inset-inline-start 0.2s;
  }
  .switch.on {
    background: var(--primary);
    border-color: var(--primary);
  }
  .switch.on i {
    inset-inline-start: 22px;
  }
  .done {
    color: var(--green);
    font-weight: 700;
  }
  .note {
    font-size: 11.5px;
    line-height: 1.8;
    color: var(--muted);
  }
  .seg {
    display: flex;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 4px;
    gap: 2px;
    flex-shrink: 0;
  }
  .seg button {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 12.5px;
    font-weight: 600;
    padding: 8px 12px;
    border-radius: 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: 0.2s;
    white-space: nowrap;
  }
  .seg button.on {
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    color: #fff;
    box-shadow: 0 8px 16px -8px var(--primary);
  }

  .range {
    width: min(220px, 45%);
    accent-color: var(--primary);
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .row {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }
    .seg {
      width: 100%;
    }
    .seg button {
      flex: 1;
      justify-content: center;
      padding: 10px 6px;
    }
    .range {
      width: 100%;
    }
  }
</style>
