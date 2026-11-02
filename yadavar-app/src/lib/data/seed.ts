import { DAY, startOfDay, uid } from '../format'
import { defaultSettings, type Card, type CardSide, type ReviewLogEntry, type Snapshot, type TreeNode } from '../types'

const side = (text: string): CardSide => ({
  html: text
    .split('\n')
    .map((l) => `<div dir="${/[a-z]/i.test(l) ? 'ltr' : 'rtl'}">${l || '<br>'}</div>`)
    .join(''),
  widgets: [],
})

/** Sample content shown on first launch so every screen has something to show. */
export function demoSnapshot(): Snapshot {
  const now = Date.now()
  const today = startOfDay(now)
  const nodes: TreeNode[] = []
  const cards: Card[] = []

  const folder = (name: string, parentId: string | null) => {
    const n: TreeNode = { id: uid(), parentId, name, createdAt: now }
    nodes.push(n)
    return n
  }
  // dueInDays: negative/0 = due now, positive = future, null = new card
  const card = (folderId: string | null, name: string, front: string, back: string, dueInDays: number | null) => {
    const isNew = dueInDays === null
    cards.push({
      id: uid(),
      folderId,
      name,
      front: side(front),
      back: side(back),
      ready: true,
      state: isNew ? 'new' : 'review',
      due: isNew ? today : today + dueInDays * DAY + 9 * 60 * 60 * 1000,
      interval: isNew ? 0 : Math.max(1, Math.abs(dueInDays) + 2),
      reps: isNew ? 0 : 3,
      lapses: 0,
      createdAt: now + cards.length,
    })
  }

  const english = folder('زبان انگلیسی', null)
  const daily = folder('لغات روزمره', english.id)
  card(daily.id, 'Reluctant', 'Reluctant', 'ناخواسته، بی‌میل', -1)
  card(daily.id, 'Thrive', 'Thrive', 'شکوفا شدن، رشد کردن', 0)
  card(daily.id, 'Postpone', 'Postpone', 'به تعویق انداختن', 4)
  card(daily.id, 'Ambiguous', 'Ambiguous', 'مبهم، دو پهلو', 9)
  const idioms = folder('اصطلاحات', english.id)
  card(idioms.id, 'Break the ice', 'Break the ice', 'شروع صحبت و از بین بردن سردی جمع', null)
  card(idioms.id, 'Piece of cake', 'Piece of cake', 'کار خیلی آسان', 6)

  const uni = folder('درس‌های دانشگاه', null)
  const physics = folder('فیزیک ۱', uni.id)
  const kin = folder('سینماتیک', physics.id)
  card(kin.id, 'سرعت متوسط', 'سرعت متوسط چگونه محاسبه می‌شود؟', 'جابه‌جایی تقسیم بر مدت زمان', 0)
  card(kin.id, 'شتاب', 'تعریف شتاب', 'آهنگ تغییر سرعت نسبت به زمان', 3)
  const dyn = folder('دینامیک', physics.id)
  card(dyn.id, 'قانون دوم نیوتون', 'قانون دوم نیوتون', 'F = m × a', 12)

  card(null, 'قاعده ۲۰ دقیقه', 'قاعده ۲۰ دقیقه برای مرور', 'هر روز ۲۰ دقیقه مرور از یک شب مطالعه‌ی طولانی بهتر است', -2)

  // a believable 30-day review history
  const revlog: ReviewLogEntry[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let d = 30; d >= 1; d--) {
    const count = Math.floor(rnd() * 14) + (d % 7 === 5 ? 0 : 4)
    for (let i = 0; i < count; i++) {
      const r = rnd()
      revlog.push({
        cardId: cards[Math.floor(rnd() * cards.length)].id,
        at: today - d * DAY + 8 * 3600_000 + i * 60_000,
        rating: r < 0.1 ? 1 : r < 0.25 ? 2 : r < 0.85 ? 3 : 4,
      })
    }
  }

  return { version: 1, nodes, cards, revlog, settings: defaultSettings() }
}
