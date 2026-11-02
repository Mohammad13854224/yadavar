/**
 * Pan and zoom for a fixed-size frame showing a larger "world" (the card's paper and everything placed on it).
 * The world is drawn with `translate(x, y) scale(z)` (transform-origin 0 0). Panning is unlimited; zoom is 10%–300%.
 * Works with a mouse (drag, wheel, ctrl+wheel) and with touch (one finger where allowed, two fingers always).
 */
export type View = { z: number; x: number; y: number }
export type Box = { l: number; t: number; r: number; b: number }

export const MIN_Z = 0.1
export const MAX_Z = 3
/** "fit everything" may go below the manual minimum so that every widget is inside the frame */
export const FIT_MIN_Z = 0.1

/** keeps a zoom inside the allowed range; a view that is already below the minimum (after "fit") may not be pushed further down */
export const clampZ = (z: number, from = 1) => Math.min(MAX_Z, Math.max(Math.min(MIN_Z, from), z))

/** zoom to z, keeping the point (cx, cy) of the frame where it is */
export function zoomAt(v: View, z: number, cx: number, cy: number): View {
  const k = clampZ(z, v.z)
  const wx = (cx - v.x) / v.z
  const wy = (cy - v.y) / v.z
  return { z: k, x: cx - wx * k, y: cy - wy * k }
}

/** the smallest box around all widgets (rotated ones included), or null without widgets */
export function widgetsBox(widgets: { x: number; y: number; w: number; h: number; rot?: number }[]): Box | null {
  let box: Box | null = null
  for (const w of widgets) {
    const t = ((w.rot ?? 0) * Math.PI) / 180
    const c = Math.abs(Math.cos(t))
    const s = Math.abs(Math.sin(t))
    const hw = (w.w * c + w.h * s) / 2
    const hh = (w.w * s + w.h * c) / 2
    const cx = w.x + w.w / 2
    const cy = w.y + w.h / 2
    box = box
      ? { l: Math.min(box.l, cx - hw), t: Math.min(box.t, cy - hh), r: Math.max(box.r, cx + hw), b: Math.max(box.b, cy + hh) }
      : { l: cx - hw, t: cy - hh, r: cx + hw, b: cy + hh }
  }
  return box
}

/** the smallest box holding the paper and all widgets */
export function contentBox(paperW: number, paperH: number, widgets: { x: number; y: number; w: number; h: number; rot?: number }[]): Box {
  const wb = widgetsBox(widgets)
  return wb
    ? { l: Math.min(0, wb.l), t: Math.min(0, wb.t), r: Math.max(paperW, wb.r), b: Math.max(paperH, wb.b) }
    : { l: 0, t: 0, r: paperW, b: paperH }
}

/** a view showing the whole box; `both` also fits the height (review), otherwise the top is kept (editing) */
export function fitView(box: Box, vw: number, vh: number, o: { both?: boolean; maxZ?: number; pad?: number } = {}): View {
  const pad = o.pad ?? 10
  const cw = Math.max(1, box.r - box.l)
  const ch = Math.max(1, box.b - box.t)
  let z = (vw - pad * 2) / cw
  if (o.both) z = Math.min(z, (vh - pad * 2) / ch)
  z = Math.min(o.maxZ ?? MAX_Z, Math.max(FIT_MIN_Z, z))
  return {
    z,
    x: (vw - cw * z) / 2 - box.l * z,
    y: o.both ? (vh - ch * z) / 2 - box.t * z : pad - box.t * z,
  }
}

type Options = {
  get: () => View
  set: (v: View) => void
  /** may a single pointer that went down on this target start panning? (two fingers always zoom) */
  canPan: (e: PointerEvent) => boolean
}

export function panzoom(node: HTMLElement, o: Options): () => void {
  const THRESHOLD = 6 // px a pointer must travel before it counts as a drag (so taps still work)
  const ptrs = new Map<number, { x: number; y: number }>()
  let pan: { id: number; sx: number; sy: number; v: View; active: boolean } | null = null
  let pinch: { d0: number; mx: number; my: number; v: View } | null = null
  let moved = false

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = node.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    if (ptrs.size === 0) moved = false
    ptrs.set(e.pointerId, rel(e))
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()]
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v: { ...o.get() } }
      pan = null
      moved = true
      return
    }
    if (ptrs.size === 1 && (e.button === 1 || o.canPan(e))) {
      pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, v: { ...o.get() }, active: false }
      if (e.button === 1) e.preventDefault()
    }
  }

  function move(e: PointerEvent) {
    const p = ptrs.get(e.pointerId)
    if (!p) return
    Object.assign(p, rel(e))
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()]
      const z = clampZ((pinch.v.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d0, pinch.v.z)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const wx = (pinch.mx - pinch.v.x) / pinch.v.z
      const wy = (pinch.my - pinch.v.y) / pinch.v.z
      o.set({ z, x: mx - wx * z, y: my - wy * z })
      return
    }
    if (pan && e.pointerId === pan.id) {
      const dx = e.clientX - pan.sx
      const dy = e.clientY - pan.sy
      if (!pan.active) {
        if (Math.hypot(dx, dy) < THRESHOLD) return
        pan.active = true
        moved = true
        try {
          node.setPointerCapture(e.pointerId)
        } catch {
          /* the pointer is already gone */
        }
      }
      o.set({ ...pan.v, x: pan.v.x + dx, y: pan.v.y + dy })
    }
  }

  function up(e: PointerEvent) {
    ptrs.delete(e.pointerId)
    if (ptrs.size < 2) pinch = null
    if (pan && e.pointerId === pan.id) pan = null
  }

  function wheel(e: WheelEvent) {
    e.preventDefault()
    const v = o.get()
    if (e.ctrlKey || e.metaKey) {
      const r = rel(e)
      o.set(zoomAt(v, v.z * Math.exp(-e.deltaY * 0.01), r.x, r.y))
    } else {
      o.set({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
    }
  }

  /** a drag that panned must not also count as a tap (which would turn the card over) */
  function click(e: MouseEvent) {
    if (!moved) return
    moved = false
    e.stopPropagation()
    e.preventDefault()
  }

  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', up)
  node.addEventListener('wheel', wheel, { passive: false })
  node.addEventListener('click', click, true)
  return () => {
    node.removeEventListener('pointerdown', down)
    node.removeEventListener('pointermove', move)
    node.removeEventListener('pointerup', up)
    node.removeEventListener('pointercancel', up)
    node.removeEventListener('wheel', wheel)
    node.removeEventListener('click', click, true)
  }
}
