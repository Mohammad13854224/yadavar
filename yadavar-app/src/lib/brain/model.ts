import type { Card, ReviewLogEntry, TreeNode } from '../types'

/**
 * The user's cards as a brain: every card is a neuron, every folder a region, and the regions sit inside each other as
 * the folders do. Plain data (no drawing) so it can be built for tens of thousands of cards in a few milliseconds.
 *
 * What the picture follows (each rule comes from a lab finding, see BrainView's explanation):
 * - A card's chance of being recalled now (Anki's / FSRS' retrievability) is the health of its neuron. A memory that
 *   fades loses its dendritic spines and synapses (LTD: spines shrink and are taken away), but the engram cells stay:
 *   the memory is mostly not erased, it becomes hard to reach ("silent engram") and a review reaches it again.
 * - The card's interval (how long it has lasted) is the neuron's strength: more and larger spines, a thicker and better
 *   myelinated axon (myelin is added to circuits that are used again and again).
 * - A card never studied is an immature neuron with silent synapses (receptors not yet in place).
 * - A card still in its learning steps is early LTP: bright but unstable, not yet consolidated.
 * - Cards of the same folder are one network: each neuron is wired to its nearest neighbours there.
 * - Cards reviewed close in time are linked: memories made within hours share neurons (raised excitability after
 *   learning lets the next memory use the same cells), so each review is linked with the few before it, more strongly
 *   the closer they were. Every new such pair strengthens the link (Hebb: cells that fire together wire together).
 */

export const KIND_NEW = 0
export const KIND_LEARNING = 1
export const KIND_REVIEW = 2
export const KIND_PARKED = 3

export interface BrainRegion {
  /** null = the whole brain (home) */
  id: string | null
  name: string
  x: number
  y: number
  z: number
  r: number
  depth: number
  /** index of the top-level folder it belongs to (its colour); -1 for the whole brain */
  lobe: number
  /** neurons in it and in all the regions inside it */
  total: number
}

export interface BrainModel {
  count: number
  ids: string[]
  /** x, y, z per neuron */
  pos: Float32Array
  /** health 0..1 (how near it is to its goal of being recalled), strength 0..1, kind, a random 0..1 per neuron */
  info: Float32Array
  /** recall 0..1 per neuron (-1 = never studied) */
  recall: Float32Array
  /** region index per neuron */
  region: Int32Array
  regions: BrainRegion[]
  /** pairs of neuron indices */
  linkA: Int32Array
  linkB: Int32Array
  /** strength 0..1 */
  linkS: Float32Array
  /** 0 = same folder, 1 = reviewed close in time */
  linkKind: Uint8Array
  /** last time (ms) the two were active together (0 for folder wiring) */
  linkLast: Float64Array
  /** the whole brain's radius */
  radius: number
  /** learned neurons from the weakest up (for "the next weak neuron") */
  weakOrder: Int32Array
  /** neurons whose recall is below the goal */
  weakCount: number
  /** when each card was last reviewed (ms, 0 = never) */
  lastReview: Float64Array
}

const SPACING = 1 // distance between neighbouring neurons
const GAP = 0.6 // room between regions

/** a stable 0..1 number for a string */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** small seeded random numbers (mulberry32) */
export function rng(seed: number) {
  let a = Math.floor(seed * 4294967296) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 26 directions around a point (cube neighbours) + 20 more: where the next sibling region may sit
const DIRS: [number, number, number][] = (() => {
  const out: [number, number, number][] = []
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue
        const l = Math.hypot(x, y, z)
        out.push([x / l, y / l, z / l])
      }
  const n = 20
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    const a = i * 2.399963229728653
    out.push([Math.cos(a) * r, y, Math.sin(a) * r])
  }
  return out
})()

type Item = { r: number; x: number; y: number; z: number }

/** the directions, turned by a rotation picked from the seed */
function turned(seed: number): [number, number, number][] {
  const r = rng((seed * 0.6180339887) % 1)
  const a = r() * Math.PI * 2
  const b = Math.acos(2 * r() - 1)
  const c = r() * Math.PI * 2
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)]
  return DIRS.map(([x, y, z]) => {
    const x1 = ca * x - sa * y
    const y1 = sa * x + ca * y
    const y2 = cb * y1 - sb * z
    const z2 = sb * y1 + cb * z
    return [cc * x1 - sc * z2, y2, sc * x1 + cc * z2]
  })
}

/**
 * Siblings in their order, each touching the one before it (so folders next to each other in the list are next to each
 * other in the brain), pulled as close to the middle as they fit without overlapping. Returns the radius around them.
 */
function pack(items: Item[]): number {
  if (!items.length) return 0
  items[0].x = items[0].y = items[0].z = 0
  let cx = 0
  let cy = 0
  let cz = 0
  let mass = items[0].r ** 3
  // placed items in a grid, so a place is checked against its neighbours only (thousands of sibling folders stay quick);
  // items much bigger than a cell are few and are always checked
  const avg = items.reduce((s, it) => s + it.r, 0) / items.length
  const C = 2 * avg + GAP
  const grid = new Map<number, number[]>()
  const big: number[] = []
  const stamp = new Int32Array(items.length)
  let mark = 0
  const cellKey = (a: number, b: number, c: number) => ((a + 4096) * 8192 + (b + 4096)) * 8192 + (c + 4096)
  const insert = (k: number) => {
    const q = items[k]
    if (q.r > 2 * C) return void big.push(k)
    const e = q.r + GAP
    for (let a = Math.floor((q.x - e) / C); a <= Math.floor((q.x + e) / C); a++)
      for (let b = Math.floor((q.y - e) / C); b <= Math.floor((q.y + e) / C); b++)
        for (let c = Math.floor((q.z - e) / C); c <= Math.floor((q.z + e) / C); c++) {
          const key = cellKey(a, b, c)
          const list = grid.get(key)
          if (list) list.push(k)
          else grid.set(key, [k])
        }
  }
  const clash = (q: Item, x: number, y: number, z: number, r: number) => {
    const m = q.r + r + GAP * 0.98
    return (q.x - x) ** 2 + (q.y - y) ** 2 + (q.z - z) ** 2 < m * m
  }
  const free = (i: number, x: number, y: number, z: number, r: number) => {
    if (r > 2 * C) {
      for (let k = 0; k < i; k++) if (clash(items[k], x, y, z, r)) return false
      return true
    }
    for (const k of big) if (clash(items[k], x, y, z, r)) return false
    mark++
    // the cells this place's ball touches (each item is in every cell its ball, plus the gap, touches)
    for (let a = Math.floor((x - r) / C); a <= Math.floor((x + r) / C); a++)
      for (let b = Math.floor((y - r) / C); b <= Math.floor((y + r) / C); b++)
        for (let c = Math.floor((z - r) / C); c <= Math.floor((z + r) / C); c++) {
          const list = grid.get(cellKey(a, b, c))
          if (!list) continue
          for (const k of list) {
            if (stamp[k] === mark) continue
            stamp[k] = mark
            if (clash(items[k], x, y, z, r)) return false
          }
        }
    return true
  }
  insert(0)
  const dirs = turned(items.length * 7.31 + items[0].r)
  for (let i = 1; i < items.length; i++) {
    const it = items[i]
    let best: [number, number, number] | null = null
    let bestD = Infinity
    // touching one of the last few placed (or the folder's own cards in the middle), as close to the middle as it fits
    // and near the sibling before it: compact, and neighbours in the list stay neighbours
    const prev = items[i - 1]
    const near = [0]
    for (let j = Math.max(1, i - 8); j < i; j++) near.push(j)
    for (const j of near) {
      const p = items[j]
      const d = p.r + it.r + GAP
      for (const [dx, dy, dz] of dirs) {
        const x = p.x + dx * d
        const y = p.y + dy * d
        const z = p.z + dz * d
        const score = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 + 0.6 * ((x - prev.x) ** 2 + (y - prev.y) ** 2 + (z - prev.z) ** 2)
        if (score >= bestD || !free(i, x, y, z, it.r)) continue
        bestD = score
        best = [x, y, z]
      }
    }
    for (let j = i - 9; j >= 1 && !best; j--) {
      // all of those are closed in: touching an earlier one
      const p = items[j]
      const d = p.r + it.r + GAP
      for (const [dx, dy, dz] of dirs) {
        const x = p.x + dx * d
        const y = p.y + dy * d
        const z = p.z + dz * d
        if (!free(i, x, y, z, it.r)) continue
        best = [x, y, z]
        break
      }
      if (i - j > 40) break
    }
    if (!best) {
      // nothing touching is free: just outside everything placed so far
      let R = 0
      for (let k = 0; k < i; k++) R = Math.max(R, Math.hypot(items[k].x - cx, items[k].y - cy, items[k].z - cz) + items[k].r)
      const [dx, dy, dz] = DIRS[i % DIRS.length]
      best = [cx + dx * (R + it.r + GAP), cy + dy * (R + it.r + GAP), cz + dz * (R + it.r + GAP)]
    }
    ;[it.x, it.y, it.z] = best
    insert(i)
    const m = it.r ** 3
    cx = (cx * mass + it.x * m) / (mass + m)
    cy = (cy * mass + it.y * m) / (mass + m)
    cz = (cz * mass + it.z * m) / (mass + m)
    mass += m
  }
  // centre them on the smallest sphere around them (Bădoiu–Clarkson: step towards the farthest point, less each time)
  let ox = 0
  let oy = 0
  let oz = 0
  for (const it of items) {
    ox += it.x / items.length
    oy += it.y / items.length
    oz += it.z / items.length
  }
  let R = 0
  const rounds = items.length > 1 ? 40 : 0
  for (let k = 0; k <= rounds; k++) {
    let far: Item = items[0]
    R = 0
    for (const it of items) {
      const e = Math.hypot(it.x - ox, it.y - oy, it.z - oz) + it.r
      if (e > R) ((R = e), (far = it))
    }
    if (k === rounds) break
    const d = Math.hypot(far.x - ox, far.y - oy, far.z - oz) || 1
    const px = far.x + ((far.x - ox) / d) * far.r
    const py = far.y + ((far.y - oy) / d) * far.r
    const pz = far.z + ((far.z - oz) / d) * far.r
    ox += (px - ox) / (k + 2)
    oy += (py - oy) / (k + 2)
    oz += (pz - oz) / (k + 2)
  }
  for (const it of items) {
    it.x -= ox
    it.y -= oy
    it.z -= oz
  }
  return R
}

export interface BrainInput {
  nodes: TreeNode[]
  cards: Card[]
  revlog: ReviewLogEntry[]
  children: (id: string | null) => TreeNode[]
  cardsOf: (id: string | null) => Card[]
  /** the recall goal (desired retention) */
  retention: number
  now?: number
}

/** how far under the goal (in recall) a memory counts as forgotten: health 0 */
export const FORGET_SPAN = 0.3
/** health bands: under the goal by up to a third of the span "fading", up to two thirds "being forgotten", then "forgotten" */
export const FADING = 2 / 3
export const FORGETTING = 1 / 3

/** how the card's memory stands: health, strength, kind, recall */
export function neuronState(c: Card, retention: number): [number, number, number, number] {
  if (c.parked) return [0.35, 0.2, KIND_PARKED, c.recall ?? -1]
  if (c.state === 'new') return [0, 0, KIND_NEW, -1]
  // measured against the user's own goal (the retention set in the settings): at the goal or above it is healthy; below
  // it, it fades with the distance from the goal, and FORGET_SPAN under it the memory counts as forgotten
  const goal = retention
  const recall = c.recall ?? (c.ready ? goal : Math.min(0.99, goal + 0.05))
  const health = recall >= goal ? 1 : Math.max(0, 1 - (goal - recall) / FORGET_SPAN)
  if (c.state === 'learning') return [health, 0.04, KIND_LEARNING, recall]
  const strength = 1 - Math.exp(-Math.max(0, c.interval) / 30) // 1 day ≈ 0.03, 3 weeks ≈ 0.5, 3 months ≈ 0.95
  return [health, strength, KIND_REVIEW, recall]
}


/** Where everything sits, and which neighbours each neuron is wired to in its folder: only the tree decides this. */
interface Layout {
  sig: string
  ids: string[]
  pos: Float32Array
  region: Int32Array
  regions: BrainRegion[]
  localA: Int32Array
  localB: Int32Array
  radius: number
}

// the last layout: a review, a renamed card or a new recall changes no place, so the places are kept (fast updates)
let cached: Layout | null = null
// the pairs of cards reviewed close in time, counted up to `done` reviews (for the same tree)
let pairCache: {
  sig: string
  done: number
  firstAt: number
  lastAt: number
  pairs: Map<number, { w: number; last: number }>
  recent: { i: number; at: number }[]
  lastReview: Float64Array
} | null = null

/** the tree in the order it is drawn: folders (id, name) and their cards; any move, delete or new card changes it */
function signature(input: BrainInput): string {
  const out: string[] = []
  const visiting = new Set<string | null>()
  const walk = (id: string | null, name: string) => {
    visiting.add(id)
    out.push('[', id ?? '', name)
    for (const c of input.cardsOf(id)) out.push(c.id)
    for (const n of input.children(id)) if (!visiting.has(n.id)) walk(n.id, n.name)
    out.push(']')
  }
  walk(null, '')
  return out.join(',')
}

function layout(input: BrainInput, sig: string): Layout {
  const regions: BrainRegion[] = []
  const ids: string[] = []

  // ---- sizes, from the innermost folders out ----
  type Lay = { id: string | null; core: number; coreCards: Card[]; kids: Lay[]; items: Item[]; r: number; total: number }
  const visiting = new Set<string | null>()
  function measure(id: string | null): Lay {
    visiting.add(id)
    const coreCards = input.cardsOf(id)
    // the folder's own cards fill a ball in its middle
    const core = coreCards.length ? 0.78 * Math.cbrt(coreCards.length) * SPACING + 0.35 : 0
    const kids = input.children(id).filter((n) => !visiting.has(n.id)).map((n) => measure(n.id))
    const items: Item[] = []
    if (core) items.push({ r: core, x: 0, y: 0, z: 0 })
    for (const k of kids) items.push({ r: k.r, x: 0, y: 0, z: 0 })
    const r = Math.max(0.9, pack(items) + (kids.length ? 0.4 : 0.2))
    const total = coreCards.length + kids.reduce((s, k) => s + k.total, 0)
    return { id, core, coreCards, kids, items, r, total }
  }
  const root = measure(null)

  // ---- places, from the whole brain in ----
  const regionOfCard: number[] = []
  const posList: number[] = []
  const nodeName = new Map(input.nodes.map((n) => [n.id, n.name]))
  function place(l: Lay, x: number, y: number, z: number, depth: number, lobe: number) {
    const ri = regions.length
    regions.push({ id: l.id, name: l.id ? (nodeName.get(l.id) ?? '') : 'خانه', x, y, z, r: l.r, depth, lobe, total: l.total })
    let k = 0
    if (l.core) {
      const c = l.items[k++]
      const n = l.coreCards.length
      const inner = l.core - 0.3
      for (let i = 0; i < n; i++) {
        const card = l.coreCards[i]
        const rand = rng(hash01(card.id))
        // even spread through the whole ball (a 3D low-discrepancy sequence: distance, height and angle each take their
        // own step, so no two of them line up), with a little jitter so it looks grown
        const rr = inner * Math.cbrt((0.5 + (i + 1) * 0.8191725134) % 1)
        const yy = 2 * ((0.5 + (i + 1) * 0.6710436067) % 1) - 1
        const s = Math.sqrt(Math.max(0, 1 - yy * yy))
        const a = 2 * Math.PI * ((0.5 + (i + 1) * 0.5497004779) % 1)
        const j = 0.22 * SPACING
        posList.push(
          x + c.x + Math.cos(a) * s * rr + (rand() - 0.5) * j,
          y + c.y + yy * rr + (rand() - 0.5) * j,
          z + c.z + Math.sin(a) * s * rr + (rand() - 0.5) * j,
        )
        ids.push(card.id)
        regionOfCard.push(ri)
      }
    }
    l.kids.forEach((kid, i) => {
      const it = l.items[k++]
      place(kid, x + it.x, y + it.y, z + it.z, depth + 1, depth === 0 ? i : lobe)
    })
  }
  place(root, 0, 0, 0, 0, -1)
  const count = ids.length
  const pos = new Float32Array(posList)

  // same folder: each neuron to its two nearest neighbours (a grid keeps this linear in the number of cards)
  const la: number[] = []
  const lb: number[] = []
  const seen = new Set<number>()
  const cell = 1.6 * SPACING
  const key = (x: number, y: number, z: number) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096)
  const cellOf = (v: number) => Math.floor(v / cell)
  let from = 0
  while (from < count) {
    let to = from + 1
    while (to < count && regionOfCard[to] === regionOfCard[from]) to++
    const grid = new Map<number, number[]>()
    for (let i = from; i < to; i++) {
      const k = key(cellOf(pos[i * 3]), cellOf(pos[i * 3 + 1]), cellOf(pos[i * 3 + 2]))
      const b = grid.get(k)
      if (b) b.push(i)
      else grid.set(k, [i])
    }
    for (let i = from; i < to && to - from > 1; i++) {
      const gx = cellOf(pos[i * 3])
      const gy = cellOf(pos[i * 3 + 1])
      const gz = cellOf(pos[i * 3 + 2])
      let b1 = -1
      let d1 = Infinity
      let b2 = -1
      let d2 = Infinity
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) {
            const b = grid.get(key(gx + ox, gy + oy, gz + oz))
            if (!b) continue
            for (const j of b) {
              if (j === i) continue
              const d = (pos[j * 3] - pos[i * 3]) ** 2 + (pos[j * 3 + 1] - pos[i * 3 + 1]) ** 2 + (pos[j * 3 + 2] - pos[i * 3 + 2]) ** 2
              if (d < d1) {
                b2 = b1
                d2 = d1
                b1 = j
                d1 = d
              } else if (d < d2) {
                b2 = j
                d2 = d
              }
            }
          }
      for (const j of [b1, b2]) {
        if (j < 0) continue
        const a = Math.min(i, j)
        const b = Math.max(i, j)
        const k = a * count + b
        if (seen.has(k)) continue
        seen.add(k)
        la.push(a)
        lb.push(b)
      }
    }
    from = to
  }

  return {
    sig,
    ids,
    pos,
    region: Int32Array.from(regionOfCard),
    regions,
    localA: Int32Array.from(la),
    localB: Int32Array.from(lb),
    radius: Math.max(2, root.r),
  }
}

export function buildBrain(input: BrainInput): BrainModel {
  const now = input.now ?? Date.now()
  const sig = signature(input)
  const L = cached?.sig === sig ? cached : (cached = layout(input, sig))
  const { ids } = L
  const count = ids.length

  // ---- how each memory stands ----
  const byId = new Map(input.cards.map((c) => [c.id, c]))
  const info = new Float32Array(count * 4)
  const recall = new Float32Array(count)
  const index = new Map<string, number>()
  let weakCount = 0
  const learned: number[] = []
  for (let i = 0; i < count; i++) {
    const c = byId.get(ids[i])!
    index.set(c.id, i)
    const [h, s, kind, rc] = neuronState(c, input.retention)
    info[i * 4] = h
    info[i * 4 + 1] = s
    info[i * 4 + 2] = kind
    info[i * 4 + 3] = hash01(c.id + '#')
    recall[i] = rc
    if (kind === KIND_REVIEW || kind === KIND_LEARNING) {
      learned.push(i)
      if (h < 1) weakCount++
    }
  }
  learned.sort((a, b) => recall[a] - recall[b])

  // ---- wiring ----
  const la: number[] = []
  const lb: number[] = []
  const ls: number[] = []
  const lk: number[] = []
  const ll: number[] = []
  const health = (i: number) => (info[i * 4 + 2] === KIND_NEW ? 0 : info[i * 4])
  const studied = (i: number) => info[i * 4 + 2] !== KIND_NEW

  // same folder: two studied neurons have a working synapse as strong as the weaker one; never studied: silent. A
  // fading cell loses its spines and the synapses on them (LTD), and one just learned has hardly built any yet (early
  // LTP is weak until it is consolidated): both stay faint, the strength grows with how long the memory has lasted
  const strength = (i: number) => info[i * 4 + 1]
  for (let l = 0; l < L.localA.length; l++) {
    const a = L.localA[l]
    const b = L.localB[l]
    const h = Math.min(health(a), health(b))
    const s = studied(a) && studied(b) ? 0.04 + 0.55 * h * h * (0.15 + 0.85 * Math.sqrt(Math.min(strength(a), strength(b)))) : 0.04
    la.push(a)
    lb.push(b)
    ls.push(s)
    lk.push(0)
    ll.push(0)
  }

  // reviewed close in time: each review with the (up to four) different cards reviewed in the six hours before it
  const WINDOW = 6 * 3600_000
  const TAU = 2 * 3600_000
  // the reviews only grow: what was already counted is kept and only the new ones are added (one review: instant)
  const log = input.revlog
  const P =
    pairCache &&
    pairCache.sig === sig &&
    log.length >= pairCache.done &&
    (!pairCache.done || (log[0].at === pairCache.firstAt && log[pairCache.done - 1].at === pairCache.lastAt))
      ? pairCache
      : (pairCache = { sig, done: 0, firstAt: 0, lastAt: 0, pairs: new Map(), recent: [] as { i: number; at: number }[], lastReview: new Float64Array(count) })
  const { pairs, recent } = P
  for (let n = P.done; n < log.length; n++) {
    const r = log[n]
    const i = index.get(r.cardId)
    if (i === undefined) continue
    P.lastReview[i] = r.at
    for (const p of recent) {
      if (p.i === i || r.at - p.at > WINDOW) continue
      const a = Math.min(i, p.i)
      const b = Math.max(i, p.i)
      const k = a * count + b
      const w = Math.exp(-(r.at - p.at) / TAU)
      const e = pairs.get(k)
      if (e) {
        e.w += w
        e.last = r.at
      } else pairs.set(k, { w, last: r.at })
    }
    const j = recent.findIndex((p) => p.i === i)
    if (j >= 0) recent.splice(j, 1)
    recent.push({ i, at: r.at })
    if (recent.length > 4) recent.shift()
  }
  P.done = log.length
  P.firstAt = log[0]?.at ?? 0
  P.lastAt = log[log.length - 1]?.at ?? 0
  const lastReview = P.lastReview.slice()

  const strengths = new Float32Array(pairs.size)
  let q = 0
  for (const [k, e] of pairs) {
    const a = Math.floor(k / count)
    const b = k - a * count
    // more pairings: stronger (saturating); a link lasts as long as both memories do (a fading cell drops it), only
    // becomes solid as the two memories are consolidated (cards just learned: a faint, silent synapse), and slowly
    // loosens unused
    const days = (now - e.last) / 86_400_000
    const h = Math.sqrt(health(a) * health(b))
    const c = Math.sqrt(Math.min(strength(a), strength(b)))
    const s = (1 - Math.exp(-e.w / 1.4)) * h * h * (0.12 + 0.88 * c) * (0.55 + 0.45 * Math.exp(-days / 60))
    strengths[q++] = Math.min(1, s)
  }
  // at most this many are drawn: the strongest; the faintest are not drawn at all
  const MAX = 16000
  const floor = Math.max(0.03, strengths.length > MAX ? strengths.slice().sort()[strengths.length - MAX] : 0)
  q = 0
  for (const [k, e] of pairs) {
    const s = strengths[q++]
    if (s < floor || lk.length - L.localA.length >= MAX) continue
    const a = Math.floor(k / count)
    la.push(a)
    lb.push(k - a * count)
    ls.push(Math.max(0.04, s))
    lk.push(1)
    ll.push(e.last)
  }

  return {
    count,
    ids,
    pos: L.pos,
    info,
    recall,
    region: L.region,
    regions: L.regions,
    linkA: Int32Array.from(la),
    linkB: Int32Array.from(lb),
    linkS: Float32Array.from(ls),
    linkKind: Uint8Array.from(lk),
    linkLast: Float64Array.from(ll),
    radius: L.radius,
    weakOrder: Int32Array.from(learned),
    weakCount,
    lastReview,
  }
}
