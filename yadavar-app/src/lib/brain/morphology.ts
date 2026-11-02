import { KIND_NEW, KIND_REVIEW, rng } from './model'

/**
 * One neuron up close, grown from its card's numbers (the same card always grows the same cell):
 *
 * - a pyramidal cell body with one apical dendrite (side branches and a tuft at its end) and four to six basal ones,
 *   forking two or three times and thinning as they go;
 * - dendritic spines along them: as many and as big (mushroom heads) as the memory is strong and healthy; a fading
 *   memory keeps only a few, small ones (spine loss after LTD); a card never studied has thin filopodia only;
 * - the axon, towards the neuron it is most strongly wired to: an initial segment, then myelin sheaths (internodes)
 *   with nodes of Ranvier between them, more of them the longer the memory has lasted; when it fades some sheaths are
 *   gone and the rest are uneven; a card never studied has a bare axon. The axon ends in terminal branches with boutons.
 *
 * Everything comes out as flat arrays for one mesh (tubes) and one point cloud (spines, boutons).
 */

export const PART_DENDRITE = 0
export const PART_MYELIN = 1
export const PART_AXON = 2
export const PART_SOMA = 3

export interface Morph {
  pos: Float32Array
  normal: Float32Array
  /** part (above) and, for the axon, how far along it (0..1; -1 elsewhere) */
  part: Float32Array
  ax: Float32Array
  index: Uint32Array
  /** spines and boutons: x, y, z, size, kind (0 spine, 1 bouton) */
  dots: Float32Array
  /** nodes of Ranvier on the axon (for the jumping signal) */
  nodes: number
}

type V = [number, number, number]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V): V => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

class Builder {
  pos: number[] = []
  normal: number[] = []
  part: number[] = []
  ax: number[] = []
  index: number[] = []
  dots: number[] = []

  /** a tube along the points, `sides` around, radius per point */
  tube(pts: V[], radii: number[], part: number, axFrom = -1, axTo = -1, sides = 6) {
    if (pts.length < 2) return
    const base = this.pos.length / 3
    let n: V | null = null
    for (let i = 0; i < pts.length; i++) {
      const t = norm(i === 0 ? sub(pts[1], pts[0]) : i === pts.length - 1 ? sub(pts[i], pts[i - 1]) : sub(pts[i + 1], pts[i - 1]))
      // a frame carried along the tube so it does not twist
      if (!n) n = norm(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
      else n = norm(sub(n, mul(t, dot(n, t))))
      const b = cross(t, n)
      const along = axFrom < 0 ? -1 : axFrom + ((axTo - axFrom) * i) / (pts.length - 1)
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2
        const d = add(mul(n, Math.cos(a)), mul(b, Math.sin(a)))
        const p = add(pts[i], mul(d, radii[i]))
        this.pos.push(p[0], p[1], p[2])
        this.normal.push(d[0], d[1], d[2])
        this.part.push(part)
        this.ax.push(along)
      }
    }
    for (let i = 0; i < pts.length - 1; i++)
      for (let k = 0; k < sides; k++) {
        const a = base + i * sides + k
        const b = base + i * sides + ((k + 1) % sides)
        const c = a + sides
        const d = b + sides
        this.index.push(a, c, b, b, c, d)
      }
  }

  /** a cell body: a ball drawn out towards the apical dendrite (a pyramid's tip) */
  soma(r: number, up: V) {
    const base = this.pos.length / 3
    const rings = 9
    const sides = 10
    const side = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
    const side2 = cross(up, side)
    for (let i = 0; i <= rings; i++) {
      const v = i / rings
      const th = v * Math.PI
      // wider at the base, pointed towards the apex
      const k = Math.sin(th) * (1 - 0.35 * v)
      const h = -Math.cos(th) * (1 + 0.45 * v)
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2
        const d = add(add(mul(side, Math.cos(a) * k), mul(side2, Math.sin(a) * k)), mul(up, h))
        this.pos.push(d[0] * r, d[1] * r, d[2] * r)
        const nn = norm(d)
        this.normal.push(nn[0], nn[1], nn[2])
        this.part.push(PART_SOMA)
        this.ax.push(-1)
      }
    }
    for (let i = 0; i < rings; i++)
      for (let j = 0; j < sides; j++) {
        const a = base + i * sides + j
        const b = base + i * sides + ((j + 1) % sides)
        this.index.push(a, a + sides, b, b, a + sides, b + sides)
      }
  }

  dot(p: V, size: number, kind: number) {
    this.dots.push(p[0], p[1], p[2], size, kind)
  }
}

/**
 * h: health 0..1, s: strength 0..1, kind: the card's kind, seed: 0..1,
 * toward: direction of the strongest partner (or null) and how far it is.
 */
export function growNeuron(h: number, s: number, kind: number, seed: number, toward: V | null, farness: number): Morph {
  const r = rng(seed)
  const B = new Builder()
  const young = kind === KIND_NEW
  const learned = kind === KIND_REVIEW
  const vigor = young ? 0.5 : 0.7 + 0.3 * s // how far the tree reaches
  const maxDepth = young ? 1 : s > 0.45 ? 3 : 2
  const rv = (k: number): V => [(r() - 0.5) * k, (r() - 0.5) * k, (r() - 0.5) * k]

  // the apical dendrite points away from the axon
  const axDir = toward ? norm(toward) : norm([r() - 0.5, -1, r() - 0.5])
  const up = norm(add(mul(axDir, -1), rv(0.6)))
  const somaR = 0.05 + 0.025 * (young ? 0 : s)
  B.soma(somaR, up)

  const spineDensity = young ? 18 : (40 + 80 * s) * (0.2 + 0.8 * h) // per unit of dendrite
  function spines(pts: V[], radii: number[], from: number) {
    let L = 0
    for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1]))
    const n = Math.round(L * spineDensity * (0.7 + r() * 0.6))
    for (let k = 0; k < n; k++) {
      const i = from + Math.floor(r() * (pts.length - 1 - from))
      if (i < 0 || i >= pts.length - 1) continue
      const u = r()
      const p = add(mul(pts[i], 1 - u), mul(pts[i + 1], u))
      const t = norm(sub(pts[i + 1], pts[i]))
      const o = norm(sub(rv(2), mul(t, dot(rv(2), t))))
      const neck = young ? 0.02 + r() * 0.02 : 0.008 + r() * 0.012 // filopodia are long and thin
      const head = young ? 0.25 : (0.35 + 0.65 * s * r()) * (0.45 + 0.55 * h)
      B.dot(add(p, mul(o, radii[i] + neck)), head, 0)
    }
  }

  function branch(start: V, dir: V, L: number, r0: number, depth: number) {
    const steps = Math.max(3, Math.round(L / 0.03))
    const pts: V[] = [start]
    const radii: number[] = [r0]
    let p = start
    let d = dir
    for (let k = 1; k <= steps; k++) {
      d = norm(add(d, rv(0.5)))
      p = add(p, mul(d, L / steps))
      pts.push(p)
      radii.push(Math.max(0.0028, r0 * (1 - (0.5 * k) / steps)))
    }
    B.tube(pts, radii, PART_DENDRITE, -1, -1, depth === 0 ? 6 : 5)
    spines(pts, radii, depth === 0 ? Math.floor(steps / 2) : 0)
    if (depth >= maxDepth) return
    const kids = r() < 0.15 ? 3 : 2
    for (let c = 0; c < kids; c++) {
      const bend = norm(add(d, rv(1.5)))
      branch(p, bend, L * (0.62 + r() * 0.2), radii[radii.length - 1] * 0.85, depth + 1)
    }
  }

  // apical: long and thick, with oblique side branches and a tuft
  {
    const L = (0.42 + 0.2 * r()) * vigor
    const steps = 10
    const pts: V[] = [mul(up, somaR * 1.3)]
    const radii: number[] = [young ? 0.012 : 0.018]
    let p = pts[0]
    let d = up
    for (let k = 1; k <= steps; k++) {
      d = norm(add(d, rv(0.18)))
      p = add(p, mul(d, L / steps))
      pts.push(p)
      radii.push(radii[0] * (1 - (0.55 * k) / steps))
      if (!young && (k === 3 || k === 5 || k === 7)) branch(p, norm(add(rv(2), mul(d, 0.3))), 0.12 + r() * 0.08, radii[k] * 0.6, Math.max(1, maxDepth - 1))
    }
    B.tube(pts, radii, PART_DENDRITE, -1, -1, 7)
    spines(pts, radii, 2)
    for (let c = 0; c < (young ? 2 : 3); c++) branch(p, norm(add(d, rv(1.6))), 0.12 * vigor + r() * 0.05, radii[radii.length - 1], Math.max(1, maxDepth - 1))
  }

  // basal dendrites around the base of the body
  const basal = young ? 3 : 4 + Math.floor(r() * 3)
  for (let i = 0; i < basal; i++) {
    let d = norm(add(mul(up, -0.35), rv(2)))
    if (dot(d, axDir) > 0.7) d = norm(add(d, mul(axDir, -1.2))) // leave the axon's way free
    branch(mul(d, somaR * 0.9), d, (0.14 + r() * 0.08) * vigor, young ? 0.008 : 0.012, 0)
  }

  // the axon
  const La = Math.min(Math.max(0.35, farness * 0.85), 0.45 + 0.5 * s)
  const steps = 26
  const path: V[] = []
  let p = mul(axDir, -somaR * -1)
  let d = axDir
  for (let k = 0; k <= steps; k++) {
    path.push(p)
    d = norm(add(d, rv(0.08)))
    p = add(p, mul(d, La / steps))
  }
  const axR = young ? 0.0035 : 0.0045 + 0.002 * s
  B.tube(path, path.map(() => axR), PART_AXON, 0, 1, 5)
  // myelin: internodes after the initial segment, with nodes of Ranvier between them
  const internodes = learned ? Math.round(1 + 6 * s) : kind === KIND_NEW ? 0 : 1
  let nodes = 0
  if (internodes) {
    const startK = 3
    const each = (steps - startK) / internodes
    for (let m = 0; m < internodes; m++) {
      const a = Math.round(startK + m * each) + 1
      const b = Math.round(startK + (m + 1) * each) - 1
      nodes++
      if (b - a < 1) continue
      if (learned && r() < (1 - h) * 0.6) continue // broken up: this sheath is gone
      const wob = (1 - h) * 0.5
      const seg = path.slice(a, b + 1)
      const radii = seg.map((_, i) => {
        const e = Math.min(i, seg.length - 1 - i)
        return axR * (2.3 + s * 0.6) * (e === 0 ? 0.6 : 1) * (1 + (r() - 0.5) * wob)
      })
      B.tube(seg, radii, PART_MYELIN, a / steps, b / steps, 6)
    }
  }
  // terminal branches with boutons
  const end = path[path.length - 1]
  const tb = 3 + Math.floor(r() * 3)
  for (let i = 0; i < tb; i++) {
    const dd = norm(add(d, rv(1.6)))
    const L = 0.05 + r() * 0.06
    const tp: V[] = [end, add(end, mul(dd, L * 0.5)), add(end, mul(norm(add(dd, rv(0.5))), L))]
    B.tube(tp, [axR, axR * 0.8, axR * 0.6], PART_AXON, 1, 1.1, 4)
    B.dot(tp[2], young ? 0.4 : 0.6 + 0.6 * s * h, 1)
  }

  return {
    pos: new Float32Array(B.pos),
    normal: new Float32Array(B.normal),
    part: new Float32Array(B.part),
    ax: new Float32Array(B.ax),
    index: new Uint32Array(B.index),
    dots: new Float32Array(B.dots),
    nodes: Math.max(1, nodes),
  }
}
