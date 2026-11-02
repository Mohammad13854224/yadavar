const faNum = new Intl.NumberFormat('fa-IR')
const faDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' })
const faWeekday = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long' })
const faWeekdayShort = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'short' })
const faMonth = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'long' })

export const fa = (n: number) => faNum.format(n)
export const formatDate = (t: number) => faDate.format(t)
export const weekday = (t: number) => faWeekday.format(t)
export const weekdayShort = (t: number) => faWeekdayShort.format(t)
export const monthName = (t: number) => faMonth.format(t)

export const DAY = 24 * 60 * 60 * 1000

export function startOfDay(t = Date.now()): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const endOfDay = (t = Date.now()) => startOfDay(t) + DAY - 1

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'شب بخیر'
  if (h < 12) return 'صبح بخیر'
  if (h < 17) return 'ظهر بخیر'
  if (h < 20) return 'عصر بخیر'
  return 'شب بخیر'
}

/** Human readable "when is this due" label, e.g. امروز / فردا / ۳ روز دیگر. */
export function dueLabel(due: number): string {
  const days = Math.round((startOfDay(due) - startOfDay()) / DAY)
  if (days < 0) return 'عقب‌افتاده'
  if (days === 0) return 'امروز'
  if (days === 1) return 'فردا'
  return `${fa(days)} روز دیگر`
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))

/**
 * Keeps only what the card editor can produce: one <div dir="rtl|ltr"> per line with plain text and <br>.
 * Used before putting saved card text back into the page. Nested lines inherit the direction of their parent.
 */
export function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = document.createElement('div')
  const dirOf = (n: Element, inherited: 'ltr' | 'rtl'): 'ltr' | 'rtl' => {
    const d = (n.getAttribute('dir') || '').toLowerCase()
    return d === 'ltr' || d === 'rtl' ? d : inherited
  }
  // a line may carry its own text size (font-size + a line-height that is a whole number of ruled rows)
  const copySize = (from: HTMLElement, to: HTMLElement) => {
    const fs = parseFloat(from.style.fontSize)
    if (!(fs >= 8 && fs <= 96)) return
    to.style.fontSize = `${Math.round(fs * 10) / 10}px`
    const lh = parseFloat(from.style.lineHeight)
    if (lh >= 34 && lh <= 340) {
      to.style.lineHeight = `${Math.round(lh)}px`
      to.style.setProperty('--lh', `${Math.round(lh)}px`)
    }
  }
  const inline = (node: Node, into: HTMLElement) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) into.append(n.textContent ?? '')
      else if (n.nodeName === 'BR') into.append(document.createElement('br'))
      else inline(n, into)
    })
  }
  const lines = (parent: Node, dir: 'ltr' | 'rtl') => {
    let current: HTMLElement | null = null
    const flush = () => {
      if (current) out.append(current)
      current = null
    }
    parent.childNodes.forEach((n) => {
      if (n instanceof HTMLElement && n.nodeName === 'DIV') {
        flush()
        const d = dirOf(n, dir)
        if (Array.from(n.children).some((c) => c.nodeName === 'DIV')) lines(n, d)
        else {
          const line = document.createElement('div')
          line.dir = d
          copySize(n, line)
          inline(n, line)
          out.append(line)
        }
      } else {
        if (!current) {
          current = document.createElement('div')
          current.dir = dir
        }
        if (n.nodeType === Node.TEXT_NODE) current.append(n.textContent ?? '')
        else if (n.nodeName === 'BR') current.append(document.createElement('br'))
        else inline(n, current)
      }
    })
    flush()
  }
  lines(doc.body, 'rtl')
  return out.innerHTML
}

/** "۱۰ دقیقه", "۳ روز", "۲ ماه"... for a delay in ms */
export function intervalLabel(delay: number): string {
  const min = Math.max(1, Math.round(delay / 60_000))
  if (min < 60) return `${fa(min)} دقیقه`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${fa(hours)} ساعت`
  const days = Math.round(delay / DAY)
  if (days < 30) return `${fa(days)} روز`
  if (days < 365) return `${fa(Math.round(days / 30))} ماه`
  return `${fa(Math.round((days / 365) * 10) / 10)} سال`
}
