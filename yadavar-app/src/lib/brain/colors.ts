import { KIND_LEARNING, KIND_NEW, KIND_PARKED } from './model'

export type RGB = [number, number, number]

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]

// at the user's goal a memory glows cool cyan; the moment it drops under the goal it turns amber (fading), then orange
// (being forgotten), then a dim red ember (forgotten) — health is measured from the goal (model.ts: FORGET_SPAN)
const STOPS: [number, RGB][] = [
  [0, hex(0xe0344f)],
  [1 / 3, hex(0xf0473f)],
  [0.4, hex(0xff7a3d)],
  [2 / 3, hex(0xff9a3d)],
  [0.72, hex(0xffc94d)],
  [0.995, hex(0xffd75e)],
  [1, hex(0x3fdcf2)],
]
const NEW = hex(0x8c93c9) // immature, silent: a pale lilac
const LEARNING = hex(0xffd75e) // early LTP: gold
const PARKED = hex(0x55607a) // suspended: grey

export function healthRGB(h: number): RGB {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]
    const [t0, c0] = STOPS[i - 1]
    if (h <= t1) return mix(c0, c1, (h - t0) / (t1 - t0))
  }
  return STOPS[STOPS.length - 1][1]
}

export function neuronRGB(h: number, s: number, kind: number): RGB {
  if (kind === KIND_NEW) return NEW
  if (kind === KIND_PARKED) return PARKED
  if (kind === KIND_LEARNING) return mix(LEARNING, healthRGB(h), 0.25)
  // long-lasting memories burn whiter
  return mix(healthRGB(h), [1, 1, 1], 0.22 * s * h)
}

/** links between cards reviewed close in time carry a violet tint (association), folder wiring their cells' colour */
export function linkRGB(a: RGB, b: RGB, temporal: boolean, silent: boolean): RGB {
  if (silent) return mix(NEW, [0.3, 0.32, 0.5], 0.4)
  const m = mix(a, b, 0.5)
  return temporal ? mix(m, hex(0xb48cff), 0.45) : m
}

/** a folder's colour: each top-level folder (lobe) has its own hue */
export function lobeRGB(lobe: number, depth: number): RGB {
  if (lobe < 0) return hex(0x5b8cd6)
  const hue = (205 + lobe * 137.508) % 360
  const l = 0.58 + Math.min(0.12, depth * 0.03)
  return hsl(hue, 0.62, l)
}

export function hsl(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4)]
}

export const css = (c: RGB, alpha = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`
