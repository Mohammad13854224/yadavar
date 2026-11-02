/** Svelte action: calls `cb` when the element is pressed for ~0.5 s (or the system long-press menu fires). */
export function hold(node: HTMLElement, cb: (() => void) | null) {
  let fire = cb
  let timer: ReturnType<typeof setTimeout> | undefined
  let sx = 0
  let sy = 0
  let held = false

  const cancel = () => clearTimeout(timer)
  const down = (e: PointerEvent) => {
    if (!fire || e.button > 0) return
    held = false
    sx = e.clientX
    sy = e.clientY
    cancel()
    timer = setTimeout(() => {
      held = true
      navigator.vibrate?.(15)
      fire?.()
    }, 480)
  }
  const move = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel()
  }
  // the click that ends a long press must not open the item
  const click = (e: MouseEvent) => {
    if (held) {
      e.stopImmediatePropagation()
      e.preventDefault()
      held = false
    }
  }
  const menu = (e: Event) => {
    if (!fire) return
    e.preventDefault()
    if (!held) {
      held = true
      fire()
    }
  }

  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('pointerleave', cancel)
  node.addEventListener('click', click, true)
  node.addEventListener('contextmenu', menu)
  return {
    update(next: (() => void) | null) {
      fire = next
    },
    destroy() {
      cancel()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', cancel)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('pointerleave', cancel)
      node.removeEventListener('click', click, true)
      node.removeEventListener('contextmenu', menu)
    },
  }
}
