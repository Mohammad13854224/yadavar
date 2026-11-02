/**
 * The phone's back button: the latest thing opened that wants it handles it (a menu or dialog closes, the card editor
 * closes, the info tab goes one folder up). Nothing left to handle: the app leaves as usual.
 *
 * Android (Capacitor) asks `window.yadavarBack()` from MainActivity; in a browser on the phone the back gesture arrives
 * as `popstate`, kept from leaving the page by one history entry of our own.
 */
const handlers: (() => boolean)[] = []

/** Registers a handler (returns true when it used the press); the returned function removes it — fits `$effect`. */
export function onBack(fn: () => boolean): () => void {
  handlers.push(fn)
  return () => {
    const i = handlers.lastIndexOf(fn)
    if (i >= 0) handlers.splice(i, 1)
  }
}

/** One press of the back button; false = nothing in the app used it. */
export function back(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i]()) return true
  return false
}

declare global {
  interface Window {
    yadavarBack?: () => boolean
  }
}
window.yadavarBack = back

// browser: an entry of our own catches the back gesture (added on a tap: entries made without one may be skipped)
let armed = false
const arm = () => {
  if (armed) return
  armed = true
  history.pushState({ yadavarBack: true }, '')
}
window.addEventListener('pointerdown', arm, true)
window.addEventListener('popstate', () => {
  armed = false
  if (back()) arm()
  else history.back() // nothing to close: really go back
})
