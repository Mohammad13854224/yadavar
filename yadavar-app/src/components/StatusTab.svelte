<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Buttons, type Retention, type Stats } from '../lib/data/api'
  import { DAY, fa, formatDate } from '../lib/format'
  import { app } from '../lib/store.svelte'
  import InfoButton from './InfoButton.svelte'
  import LineChart, { type Point } from './LineChart.svelte'

  let stats = $state<Stats | null>(null)
  let failed = $state(false)

  onMount(() => {
    api.stats().then(
      (s) => (stats = s),
      () => (failed = true),
    )
  })

  const info = {
    reviews: { title: 'مرورهای هر روز', lines: ['۱۵ روز گذشته (آبی)، امروز (خط قرمز) و ۱۵ روز آینده (سبز). برای گذشته نشان می‌دهد چند پوشه، چند کارت و چقدر زمان مرور کرده‌ای؛ برای آینده پیش‌بینی می‌کند: کارت‌هایی که موعد مرورشان آن روز می‌رسد (زمان از میانگین زمان هر کارت در روزهای اخیر).', 'در پایین مجموع ۱۵ روز گذشته و امروز را می‌بینی. زمان از لحظه‌ی دیدن کارت تا نمره‌دادن حساب می‌شود (حداکثر ۶۰ ثانیه برای هر کارت).'] },
    counts: { title: 'تعداد کارت‌ها', lines: ['کارت‌ها را بر اساس مرحله‌ی یادگیری دسته‌بندی می‌کند: جدید (هنوز مرور نشده)، در حال یادگیری (در گام‌های دقیقه‌ای اولیه)، یادگیری مجدد (فراموش‌شده و دوباره در گام‌ها)، جوان (فاصله‌ی مرور کمتر از ۲۱ روز) و بالغ (۲۱ روز یا بیشتر).', 'هر چه کارت‌های «بالغ» بیشتر شود، یعنی مطالب در حافظه‌ی بلندمدت جا افتاده‌اند.'] },
    buttons: { title: 'درصد انتخاب هر سختی', lines: ['نشان می‌دهد چند درصد مرورها را «دوباره»، «سخت»، «خوب» و «آسان» زده‌ای.', 'اگر «دوباره» زیاد است، مطلب سخت است یا خیلی زود مرور می‌شود؛ اگر «آسان» خیلی زیاد است، می‌توانی کمی صادق‌تر نمره بدهی تا فاصله‌ها درست تنظیم شوند.'] },
    retention: { title: 'میزان یادآوری واقعی', lines: ['از میان مرورهایی که کارت قبلاً یاد گرفته شده بود، چند درصد را درست یادآوری کردی (نمره‌ی «دوباره» نگرفتی). جوان و بالغ جدا حساب می‌شوند.', 'هدف معمول بین ۸۵ تا ۹۰ درصد است. خیلی بالاتر یعنی مرورها بیش از نیاز زود به زود می‌آیند؛ خیلی پایین‌تر یعنی فراموشی زیاد است.'] },
  }

  // ---------- helpers ----------
  const dateOf = (s: Stats, off: number) => s.dayStart + off * DAY + 12 * 3600_000
  const dayNo = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric' })
  const monthDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric' })
  const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0)
  const fpct = (n: number) => `${fa(n)}٪`
  const duration = (min: number) => {
    const total = Math.round(min)
    if (total < 60) return `${fa(total)} دقیقه`
    const h = Math.floor(total / 60)
    const m = total % 60
    return m ? `${fa(h)} ساعت و ${fa(m)} دقیقه` : `${fa(h)} ساعت`
  }

  // ---------- reviews per day: 15 days back, today, 15 days ahead ----------
  type Metric = 'files' | 'cards' | 'minutes'
  let metric = $state<Metric>('files')
  const metrics: { id: Metric; label: string }[] = [
    { id: 'files', label: 'پوشه' },
    { id: 'cards', label: 'کارت' },
    { id: 'minutes', label: 'زمان' },
  ]
  const DAYS = 15
  const reviewDays = $derived(stats ? stats.days.filter((d) => d.day >= -DAYS && d.day <= 0) : [])
  const sumCards = $derived(reviewDays.reduce((a, d) => a + d.cards, 0))
  const sumMinutes = $derived(reviewDays.reduce((a, d) => a + d.minutes, 0))
  const activeDays = $derived(reviewDays.filter((d) => d.cards > 0).length)
  /** what the coming days hold, from each card's due date: the cards (and their folders) that come up that day */
  const ahead = $derived.by(() => {
    const out = Array.from({ length: DAYS + 1 }, () => ({ cards: 0, folders: new Set<string>() }))
    if (!stats) return out
    for (const c of app.cards) {
      if (c.state === 'new' || c.parked) continue
      const off = Math.max(0, Math.floor((c.due - stats.dayStart) / DAY))
      if (off > DAYS) continue
      out[off].cards++
      out[off].folders.add(c.folderId ?? '')
    }
    return out
  })
  /** minutes a review takes on average lately (for the expected time) */
  const perCard = $derived.by(() => {
    const recent = stats ? stats.days.filter((d) => d.day >= -29) : []
    const n = recent.reduce((a, d) => a + d.cards, 0)
    return n ? recent.reduce((a, d) => a + d.minutes, 0) / n : 0
  })
  const reviewPoints = $derived.by<Point[]>(() => {
    if (!stats) return []
    const s = stats
    const done = reviewDays.map((d) => {
      const v = d[metric]
      return {
        label: d.day === 0 ? monthDay.format(dateOf(s, d.day)) : dayNo.format(dateOf(s, d.day)),
        sub: d.day === 0 ? 'امروز' : '',
        hot: d.day === 0,
        value: v,
        text: metric === 'minutes' ? fa(Math.round(v)) : fa(v),
        tip:
          `${d.day === 0 ? 'امروز' : formatDate(dateOf(s, d.day))}: ${fa(d.files)} پوشه · ${fa(d.cards)} کارت · ${duration(d.minutes)}` +
          (d.day === 0 && ahead[0].cards ? ` (${fa(ahead[0].cards)} کارت مانده)` : ''),
      }
    })
    const next = ahead.slice(1).map((a, i) => {
      const day = i + 1
      const minutes = a.cards * perCard
      const v = metric === 'files' ? a.folders.size : metric === 'cards' ? a.cards : minutes
      return {
        label: dayNo.format(dateOf(s, day)),
        value: v,
        text: v ? (metric === 'minutes' ? fa(Math.round(v)) : fa(v)) : '',
        tip: `${formatDate(dateOf(s, day))} (پیش‌بینی): ${fa(a.folders.size)} پوشه · ${fa(a.cards)} کارت · حدود ${duration(minutes)}`,
      }
    })
    return [...done, ...next]
  })

  // ---------- 3. card counts ----------
  const kinds = [
    // rule: what puts a card in the row, as a short inequality (reviews so far, or the gap to its next review) + unit
    { key: 'new', label: 'جدید', color: '#60a5fa', hint: 'هنوز مرور نشده', rule: ['=۰', 'مرور'] },
    { key: 'learn', label: 'در حال یادگیری', color: '#fb923c', hint: 'اولین بار است که در مراحل یادگیری (دقیقه‌ای) هستند', rule: ['<۱', 'روز'] },
    { key: 'relearn', label: 'یادگیری مجدد', color: '#f87171', hint: 'فراموش شده و دوباره در مراحل یادگیری هستند', rule: ['<۱', 'روز'] },
    { key: 'young', label: 'مروری جوان', color: '#86efac', hint: 'فاصله‌ی مرور کمتر از ۲۱ روز', rule: ['<۲۱', 'روز'] },
    { key: 'mature', label: 'مروری بالغ', color: '#22c55e', hint: 'فاصله‌ی مرور ۲۱ روز یا بیشتر', rule: ['≥۲۱', 'روز'] },
    { key: 'suspended', label: 'متوقف‌شده', color: '#facc15', hint: 'از مرور کنار گذاشته شده', rule: ['∞', ''] },
    { key: 'buried', label: 'پنهان تا فردا', color: '#94a3b8', hint: 'موقتاً تا فردا کنار رفته', rule: ['<۱', 'روز'] },
  ] as const
  const countTotal = $derived(stats ? kinds.reduce((a, k) => a + stats!.cardCounts[k.key], 0) : 0)

  // ---------- 4. answer buttons ----------
  type Range = 'month' | 'quarter' | 'year' | 'all'
  let range = $state<Range>('month')
  const ranges: { id: Range; label: string }[] = [
    { id: 'month', label: 'یک ماه' },
    { id: 'quarter', label: 'سه ماه' },
    { id: 'year', label: 'یک سال' },
    { id: 'all', label: 'همه' },
  ]
  const buttons = [
    { name: 'دوباره', color: 'var(--red)' },
    { name: 'سخت', color: 'var(--amber)' },
    { name: 'خوب', color: 'var(--green)' },
    { name: 'آسان', color: '#38bdf8' },
  ]
  const sumButtons = (b: Buttons) => [0, 1, 2, 3].map((i) => (b.learning[i] ?? 0) + (b.young[i] ?? 0) + (b.mature[i] ?? 0))
  const btnTotals = $derived(stats ? sumButtons(stats.buttons[range]) : [0, 0, 0, 0])
  const btnAll = $derived(btnTotals.reduce((a, b) => a + b, 0))
  const byType = $derived.by(() => {
    if (!stats) return []
    const b = stats.buttons[range]
    return [
      { label: 'در حال یادگیری', v: b.learning },
      { label: 'مروری جوان', v: b.young },
      { label: 'مروری بالغ', v: b.mature },
    ].map((r) => ({ ...r, total: r.v.reduce((a, c) => a + c, 0) }))
  })

  // ---------- 5. true retention ----------
  const periods = [
    { key: 'today', label: 'امروز' },
    { key: 'yesterday', label: 'دیروز' },
    { key: 'week', label: 'هفته‌ی اخیر' },
    { key: 'month', label: 'ماه اخیر' },
    { key: 'year', label: 'سال اخیر' },
    { key: 'all', label: 'همه' },
  ] as const
  const rate = (pass: number, fail: number) => ({ pass, total: pass + fail, p: pct(pass, pass + fail) })
  const retentionRows = $derived(
    stats
      ? periods.map((p) => {
          const r: Retention = stats!.retention[p.key]
          return {
            label: p.label,
            young: rate(r.youngPassed, r.youngFailed),
            mature: rate(r.maturePassed, r.matureFailed),
            all: rate(r.youngPassed + r.maturePassed, r.youngFailed + r.matureFailed),
          }
        })
      : [],
  )
</script>

<section class="panel">
  <header class="page-head">
    <div>
      <h2>وضعیت</h2>
      <p>آمار واقعی انکی از مرورهای تو</p>
    </div>
  </header>

  <div class="scroll">
    {#if failed}
      <div class="empty"><b>آمار در دسترس نیست</b><br />سرور انکی جواب نداد.</div>
    {:else if !stats}
      <div class="empty">در حال خواندن آمار…</div>
    {:else}
      <div class="charts">
        <!-- 3 -->
        <div class="card">
          <div class="head"><h4>تعداد کارت‌ها<InfoButton {...info.counts} /></h4><span class="chip">{fa(countTotal)} کارت</span></div>
          <div class="stack" role="img" aria-label="سهم هر دسته">
            {#each kinds as k (k.key)}
              {#if stats.cardCounts[k.key]}
                <span style="width:{pct(stats.cardCounts[k.key], countTotal)}%; background:{k.color}" title="{k.label}: {fa(stats.cardCounts[k.key])}"></span>
              {/if}
            {/each}
          </div>
          <ul class="rows">
            {#each kinds as k (k.key)}
              <li title={k.hint}>
                <i style="background:{k.color}"></i>
                <span>{k.label}</span>
                <em class="rule"><bdi dir="ltr">{k.rule[0]}</bdi> {k.rule[1]}</em>
                <b>{fa(stats.cardCounts[k.key])}</b>
                <small>{fpct(pct(stats.cardCounts[k.key], countTotal))}</small>
              </li>
            {/each}
          </ul>
        </div>

        <!-- 2 -->
        <div class="card wide">
          <div class="head">
            <h4>مرورهای هر روز<InfoButton {...info.reviews} /></h4>
            <div class="seg" role="tablist">
              {#each metrics as m (m.id)}
                <button class:on={metric === m.id} onclick={() => (metric = m.id)}>{m.label}</button>
              {/each}
            </div>
          </div>
          <LineChart points={reviewPoints} height={190} step={36} split={DAYS} color="#3b82f6" futureColor="#22c55e" />
          <div class="legend">
            <span><i style="background:#3b82f6"></i>مرور شده</span>
            <span><i style="background:#ef4444"></i>امروز</span>
            <span><i style="background:#22c55e"></i>پیش‌بینی</span>
          </div>
          <p class="unit">{metric === 'files' ? 'تعداد پوشه‌هایی که آن روز مرور شدند' : metric === 'cards' ? 'تعداد کارت‌هایی که آن روز مرور شدند' : 'دقیقه‌ی صرف‌شده برای مرور'}</p>
          <div class="sums">
            <div><b>{fa(sumCards)}</b><small>کارت مرور شد</small></div>
            <div><b>{duration(sumMinutes)}</b><small>زمان مرور</small></div>
            <div><b>{fa(activeDays)}</b><small>روز فعال از {fa(DAYS + 1)}</small></div>
            <div><b>{activeDays ? duration(sumMinutes / activeDays) : '—'}</b><small>میانگین هر روز فعال</small></div>
          </div>
        </div>

        <!-- 4 -->
        <div class="card">
          <div class="head">
            <h4>درصد انتخاب هر سختی<InfoButton {...info.buttons} /></h4>
            <span class="chip">{fa(btnAll)} نمره</span>
          </div>
          <div class="seg small" role="tablist">
            {#each ranges as r (r.id)}
              <button class:on={range === r.id} onclick={() => (range = r.id)}>{r.label}</button>
            {/each}
          </div>
          {#if btnAll}
            <div class="hb">
              {#each buttons as b, i (b.name)}
                <div>
                  <div class="hb-top"><span>{b.name}</span><span><b>{fpct(pct(btnTotals[i], btnAll))}</b> · {fa(btnTotals[i])}</span></div>
                  <div class="hb-track"><div style="width:{pct(btnTotals[i], btnAll)}%; background:{b.color}"></div></div>
                </div>
              {/each}
            </div>
            <table class="tbl">
              <thead>
                <tr><th></th>{#each buttons as b (b.name)}<th>{b.name}</th>{/each}</tr>
              </thead>
              <tbody>
                {#each byType as r (r.label)}
                  <tr>
                    <td>{r.label}</td>
                    {#each r.v as n, i (i)}<td>{r.total ? fpct(Math.round(pct(n, r.total))) : '—'}</td>{/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <div class="none">در این بازه هنوز نمره‌ای ثبت نشده</div>
          {/if}
        </div>

        <!-- 5 -->
        <div class="card wide">
          <div class="head">
            <h4>میزان یادآوری واقعی<InfoButton {...info.retention} /></h4>
            <span class="chip">نمره‌ی «دوباره» نگرفتن = یادآوری موفق</span>
          </div>
          <div class="tbl-wrap">
            <table class="tbl big">
              <thead>
                <tr><th></th><th>مروری جوان</th><th>مروری بالغ</th><th>مجموع</th></tr>
              </thead>
              <tbody>
                {#each retentionRows as r (r.label)}
                  <tr>
                    <td>{r.label}</td>
                    {#each [r.young, r.mature, r.all] as c, i (i)}
                      <td class:strong={i === 2}>
                        {#if c.total}
                          <b>{fpct(c.p)}</b><small>{fa(c.pass)} از {fa(c.total)}</small>
                        {:else}—{/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="note">هدف معمول انکی حدود ۸۵ تا ۹۰٪ است.</p>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 18px;
    padding-bottom: 8px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 18px;
    box-shadow: var(--shadow-sm);
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  h4 {
    font-size: calc(14px * var(--font-scale));
    font-weight: 700;
  }
  .chip {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 4px 10px;
  }
  .seg {
    display: inline-flex;
    gap: 3px;
    padding: 3px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    align-self: flex-start;
  }
  .seg button {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 9px;
    cursor: pointer;
    transition: 0.2s;
  }
  .seg button.on {
    background: var(--primary-soft);
    color: var(--primary-text);
  }
  .unit,
  .note {
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.9;
  }
  .sums {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
  }
  .sums div {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sums b {
    font-size: calc(15px * var(--font-scale));
    font-weight: 800;
  }
  .sums small {
    font-size: 11px;
    color: var(--muted);
  }
  .stack {
    display: flex;
    height: 16px;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-3);
  }
  .stack span {
    display: block;
    height: 100%;
  }
  .rows {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .rows i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
  }
  .rows span {
    flex: 1;
  }
  .rows b {
    color: var(--text);
  }
  .rows .rule {
    font-style: normal;
    font-size: 11.5px;
    color: var(--muted);
    min-width: 56px;
  }
  .rows .rule bdi {
    font-weight: 800;
    color: var(--text-dim);
  }
  .rows small {
    width: 52px;
    text-align: end;
    color: var(--muted);
  }
  .hb {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hb-top {
    display: flex;
    justify-content: space-between;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-dim);
    margin-bottom: 5px;
  }
  .hb-top b {
    color: var(--text);
  }
  .hb-track {
    height: 12px;
    background: var(--surface-3);
    border-radius: 10px;
    overflow: hidden;
  }
  .hb-track div {
    height: 100%;
    border-radius: 10px;
    transition: width 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .tbl-wrap {
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .tbl th {
    color: var(--muted);
    font-weight: 600;
    padding: 6px 4px;
    text-align: center;
  }
  .tbl td {
    padding: 8px 4px;
    text-align: center;
    border-top: 1px dashed var(--line);
    color: var(--text-dim);
    font-weight: 600;
  }
  .tbl td:first-child {
    text-align: start;
    white-space: nowrap;
  }
  .tbl.big td {
    font-size: 13px;
  }
  .tbl td b {
    display: block;
    color: var(--text);
    font-size: 14px;
  }
  .tbl td small {
    display: block;
    font-size: 10.5px;
    color: var(--muted);
    font-weight: 500;
  }
  .tbl td.strong b {
    color: var(--primary-text);
  }
  .none {
    text-align: center;
    padding: 24px 0;
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
