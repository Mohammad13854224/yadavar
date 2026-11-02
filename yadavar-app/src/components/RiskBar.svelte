<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { fa } from '../lib/format'
  import InfoButton from './InfoButton.svelte'

  /**
   * Today's forgetting risk as living tissue: a chain of pyramidal neurons, each one's axon reaching the next one's
   * dendrites. Every healthy cell fires now and then by itself; the action potential runs down its myelinated axon,
   * jumping from one node of Ranvier to the next, splits into the terminal branches, the transmitter crosses the
   * synaptic gap, the signal runs up the next cell's dendrite to its body, and that cell fires in turn.
   *
   * The "forgetting liquid" fills the strip from the start side as far as the risk goes. The cells it reaches fade to
   * red: their spines pull back, the myelin breaks up, the terminals shrink, the gap widens and signals die on the way.
   * Cells it has not reached keep firing on their own, so one lost cell never silences the rest. Above 90 % the strip
   * trembles. A finished review (the risk going down) makes every connection flash and fire again.
   *
   * Built for phones on battery: every motion is timed by the clock (the same speed at 30, 60 or 120 frames a second),
   * the shapes are built once (Path2D), glows are plain gradients (no canvas shadow blur), the trembling is a CSS
   * transform, and nothing runs while the strip is hidden, off screen or under a review session.
   */
  type Props = { percent: number; cards: number; paused?: boolean; /** tapped: the brain map opens */ onopen?: () => void }
  let { percent, cards, paused = false, onopen }: Props = $props()

  const p = $derived(Math.max(0, Math.min(100, Math.round(percent))))
  let shown = $state(0) // the number follows the liquid as it moves
  let hue = $state(150)
  /** 0..1: how hard the strip trembles (from 90 %) */
  const quake = $derived(Math.max(0, (shown - 90) / 10))

  const STATUS: [number, string][] = [
    [0.2, 'حافظه محکم است؛ اتصال‌ها قوی و پرانرژی‌اند'],
    [0.45, 'کم‌کم کم‌رنگ می‌شود؛ یک مرور سبک کافی است'],
    [0.7, 'هشدار: اتصال‌ها دارند ضعیف می‌شوند'],
    [1.01, 'خطر بالا! همین حالا مرور کن'],
  ]
  const status = $derived(cards ? STATUS.find((s) => shown / 100 < s[0])![1] : 'امروز کارتی در خطر فراموشی نیست')

  const info = {
    title: 'خطر فراموشی',
    lines: [
      'اینکه امروز چقدر مهم است مرور کنی: خطر فراموشی کارت‌هایی که امروز هنوز منتظر مرورند، نسبت به همه‌ی کارت‌های امروز. با هر کارتی که مرور کنی پایین‌تر می‌آید و وقتی همه را مرور کنی به صفر می‌رسد.',
      'کارتی که دقیقاً سر وقتش است حدود ۳۳٪ حساب می‌شود و هر چه از وقتش بگذرد بالاتر می‌رود؛ ۱۰۰٪ یعنی احتمال فراموشی سه برابر حدی است که «درصد یادآوری» تنظیمات اجازه می‌دهد. کارت‌های در حال یادگیری هم با فاصله‌ی همان مرحله سنجیده می‌شوند. کارت‌های جدید حساب نمی‌شوند، چون هنوز چیزی برای فراموش کردن ندارند.',
      'در نوار، مایع فراموشی هر چه بالاتر برود نورون‌های بیشتری را می‌گیرد: خارهای دندریت جمع می‌شوند، غلاف میلین آکسون از هم می‌پاشد، شکاف سیناپسی باز می‌شود و پیام دیگر به نورون بعدی نمی‌رسد. بعد از هر مرور، اتصال‌ها دوباره روشن می‌شوند.',
    ],
  }

  // ---------- the tissue ----------
  type Pt = [number, number]
  /** a dendrite tip that receives a synapse; chain = the way from the cell body out to it */
  type Tip = { x: number; y: number; chain: Pt[]; fl: number }
  type Spine = { x: number; y: number; a: number; l: number }
  type Branch = { path: Path2D; w: number }
  type Neuron = {
    f: number; x: number; y: number; r: number; ph: number
    shape: number[]; dend: Branch[]; spines: Spine[]; tips: Tip[]
    g: number; fireAt: number; nextFire: number; lastFire: number; out: Link | null
  }
  type Term = { tip: Tip | null; cx: number; cy: number; bx: number; by: number; fl: number }
  type Link = {
    a: Neuron; b: Neuron | null; mf: number; k: number
    ax: number; ay: number; c1x: number; c1y: number; c2x: number; c2y: number; ex: number; ey: number
    /** stops of the action potential: the hillock, every node of Ranvier, the branch point */
    stops: number[]; nodeGlow: number[]; terms: Term[]; path: Path2D
  }
  /** an action potential: s counts the stops passed; then it runs out along the terminal branches */
  type Pulse = { l: Link; s: number; fail: number; term: number }
  type Nt = { l: Link; term: Term; u: number; ok: boolean; w: number }
  type Back = { n: Neuron; tip: Tip; u: number }
  type Spark = { x: number; y: number; vx: number; vy: number; life: number; h: number; dust?: boolean }

  let canvas: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D | null = null
  let W = 0
  let H = 0
  let nodes: Neuron[] = []
  let links: Link[] = []
  let pulses: Pulse[] = []
  let nts: Nt[] = []
  let backs: Back[] = []
  let sparks: Spark[] = []
  let risk = 0 // what is drawn, easing towards p / 100
  let flash = 0
  let t = 0
  let last = 0
  let raf = 0
  let onScreen = true
  let pageHidden = typeof document !== 'undefined' && document.hidden
  let lastP = -1
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const cl = (x: number) => Math.max(0, Math.min(1, x))
  const sm = (a: number, b: number, x: number) => {
    x = cl((x - a) / (b - a))
    return x * x * (3 - 2 * x)
  }
  /** the whole liquid: green → yellow → red as the risk grows */
  const liquidHue = (r: number) => 150 * Math.pow(1 - cl(r), 1.25)
  /** a cell: healthy teal → damaged red */
  const cellHue = (d: number) => 186 * (1 - d) + 6 * d
  const X = (f: number) => W * (1 - f) // f = 0 at the start side (right, in Persian)
  /** how far the liquid has damaged whatever sits at f (0 healthy .. 1 lost) */
  const dmg = (f: number) => sm(risk + 0.05, risk - 0.07, f)
  const linkDmg = (l: Link) => cl(dmg(l.mf) * (0.8 + 0.4 * l.k))
  const clampY = (y: number) => Math.max(4, Math.min(H - 4, y))

  function smooth(path: Path2D, pts: Pt[]) {
    path.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length - 1; i++)
      path.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
    const e = pts[pts.length - 1]
    path.lineTo(e[0], e[1])
  }

  /** a dendrite: three wavy pieces, then it forks (thinner and shorter each time) until its tips */
  function grow(n: Neuron, x: number, y: number, a: number, len: number, w: number, depth: number, chain: Pt[], tips: Tip[] | null) {
    const pts: Pt[] = [[x, y]]
    let px = x
    let py = y
    for (let j = 0; j < 3; j++) {
      const aa = a + rnd(-0.28, 0.28)
      px += (Math.cos(aa) * len) / 3
      py = clampY(py + (Math.sin(aa) * len) / 3)
      pts.push([px, py])
    }
    const path = new Path2D()
    smooth(path, pts)
    n.dend.push({ path, w })
    const here = chain.concat(pts.slice(1))
    // spines along the thinner branches
    if (depth <= 2)
      for (let j = 0; j < 3; j++) {
        const sg = Math.floor(rnd(0, 3))
        const u = rnd(0.15, 0.85)
        const A = pts[sg]
        const B = pts[sg + 1]
        n.spines.push({
          x: A[0] + (B[0] - A[0]) * u,
          y: A[1] + (B[1] - A[1]) * u,
          a: a + (Math.random() < 0.5 ? 1 : -1) * rnd(1.1, 1.9),
          l: rnd(1.6, 2.8) * (H / 72),
        })
      }
    if (depth > 1) {
      for (const s of [-1, 1]) grow(n, px, py, a + s * rnd(0.32, 0.6), len * rnd(0.6, 0.74), w * 0.62, depth - 1, here, tips)
    } else if (tips) tips.push({ x: px, y: py, chain: here, fl: 0 })
  }

  function build() {
    const rect = canvas.getBoundingClientRect()
    W = rect.width
    H = rect.height
    if (!W || !H) return
    const D = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(W * D)
    canvas.height = Math.round(H * D)
    ctx = canvas.getContext('2d')
    ctx?.setTransform(D, 0, 0, D, 0, 0)
    nodes = []
    links = []
    pulses = []
    nts = []
    backs = []
    sparks = []
    const n = Math.max(3, Math.round(W / 108))
    const cw = W / n
    const u = H / 72 // the shapes are drawn for a 72 px strip
    for (let i = 0; i < n; i++) {
      const f = (i + 0.62) / n
      const x = X(f)
      const y = H / 2 + (i % 2 ? 1 : -1) * H * rnd(0.04, 0.1)
      const r = rnd(5.2, 6.2) * u
      const nd: Neuron = {
        f, x, y, r, ph: rnd(0, 6.28), shape: [], dend: [], spines: [], tips: [],
        g: 0, fireAt: 0, nextFire: rnd(0.3, 2.6), lastFire: -9, out: null,
      }
      // a pyramidal cell: the body comes to a point where the apical dendrite leaves (towards the start side) and
      // bulges a little at the two basal corners
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * 6.283
        nd.shape.push(rnd(0.9, 1.06) + 0.62 * Math.pow(Math.max(0, Math.cos(a)), 4) + 0.12 * Math.pow(Math.max(0, -Math.cos(a)), 2))
      }
      // the apical dendrite, towards the cell before: its tips take the synapses
      grow(nd, x + r * 1.45, y, rnd(-0.12, 0.12), cw * 0.17, 2.3 * u, 3, [[x, y]], nd.tips)
      // basal dendrites around the body
      for (const a of [1.35, -1.35, 2.25, -2.25, 2.85]) {
        const sx = x + Math.cos(a) * r * 0.9
        const sy = y + Math.sin(a) * r * 0.9
        grow(nd, sx, sy, a + rnd(-0.15, 0.15), cw * rnd(0.07, 0.1), 1.5 * u, 2, [[x, y]], null)
      }
      nd.tips.sort((p1, q) => q.x - p1.x)
      nodes.push(nd)
    }
    // each axon reaches the next cell's apical tips (the last one runs off the strip, to cells out of sight)
    for (let i = 0; i < n; i++) {
      const a = nodes[i]
      const b = nodes[i + 1] ?? null
      const ax = a.x - a.r * 1.05 - 5 * u
      const ay = a.y
      let ex: number
      let ey: number
      let targets: (Tip | null)[]
      if (b) {
        targets = b.tips.slice(0, Math.min(3, b.tips.length))
        ex = Math.max(...targets.map((tp) => tp!.x)) + 9 * u
        ey = targets.reduce((s, tp) => s + tp!.y, 0) / targets.length
      } else {
        ex = -6
        ey = ay + rnd(-6, 6)
        targets = [null]
      }
      const len = Math.max(20, ax - ex)
      const l: Link = {
        a, b, mf: b ? (a.f + b.f) / 2 : a.f, k: Math.random(),
        ax, ay, c1x: ax - len * 0.38, c1y: ay + rnd(-8, 8) * u, c2x: ex + len * 0.32, c2y: ey + rnd(-8, 8) * u, ex, ey,
        stops: [], nodeGlow: [], terms: [], path: new Path2D(),
      }
      l.path.moveTo(ax, ay)
      l.path.bezierCurveTo(l.c1x, l.c1y, l.c2x, l.c2y, ex, ey)
      // the myelin sheath in internodes about 16 px long, the nodes of Ranvier between them
      const m = Math.max(2, Math.round(len / (16 * u)))
      for (let k = 0; k <= m; k++) l.stops.push(0.06 + (0.88 * k) / m)
      l.stops.unshift(0)
      l.stops.push(1)
      l.nodeGlow = l.stops.map(() => 0)
      for (const tp of targets) {
        const tx = tp ? tp.x : ex - 10
        const ty = tp ? tp.y : ey + rnd(-5, 5)
        l.terms.push({ tip: tp, cx: (ex + tx) / 2 + rnd(-2, 2), cy: (ey + ty) / 2 + rnd(-4, 4) * u, bx: tx, by: ty, fl: 0 })
      }
      a.out = l
      links.push(l)
    }
    if (!running()) draw(0)
  }

  /** a point on an axon (cubic Bézier) */
  const onAxon = (l: Link, u: number): Pt => {
    const v = 1 - u
    const a = v * v * v
    const b = 3 * v * v * u
    const c = 3 * v * u * u
    const d = u * u * u
    return [a * l.ax + b * l.c1x + c * l.c2x + d * l.ex, a * l.ay + b * l.c1y + c * l.c2y + d * l.ey]
  }
  /** where a terminal's bouton sits: short of its tip by the synaptic gap, which widens with the damage */
  function bouton(l: Link, tm: Term, d: number): Pt {
    const gap = (2.6 + d * 8) * (H / 72)
    const dx = tm.bx - tm.cx
    const dy = tm.by - tm.cy
    const m = Math.hypot(dx, dy) || 1
    return [tm.bx - (dx / m) * gap, tm.by - (dy / m) * gap]
  }
  const onTerm = (l: Link, tm: Term, u: number, d: number): Pt => {
    const [bx, by] = bouton(l, tm, d)
    const v = 1 - u
    return [v * v * l.ex + 2 * v * u * tm.cx + u * u * bx, v * v * l.ey + 2 * v * u * tm.cy + u * u * by]
  }
  /** a point along a polyline (u = 0 at its first point) */
  function onChain(pts: Pt[], u: number): Pt {
    const i = Math.min(pts.length - 2, Math.floor(u * (pts.length - 1)))
    const f = u * (pts.length - 1) - i
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]
  }
  /** a soft glow (instead of the canvas shadow blur, which is slow on phones) */
  function halo(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
    if (a <= 0.01 || r <= 0) return
    const g = c.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    c.globalAlpha = Math.min(1, a)
    c.fillStyle = g
    c.beginPath()
    c.arc(x, y, r, 0, 6.3)
    c.fill()
    c.globalAlpha = 1
  }
  function fire(n: Neuron) {
    if (t - n.lastFire < 0.6) return // refractory: a cell cannot fire again right away
    n.lastFire = t
    n.g = 1
    const l = n.out
    if (!l || pulses.length > 40) return
    const d = linkDmg(l)
    // a weak axon loses the signal at one of its nodes
    const fail = Math.random() < d * 1.15 ? 1 + Math.floor(rnd(0, l.stops.length - 2)) : 0
    pulses.push({ l, s: 0, fail, term: -1 })
  }
  function burst(x: number, y: number, h: number, n: number) {
    for (let i = 0; i < n && sparks.length < 160; i++) sparks.push({ x, y, vx: rnd(-1, 1), vy: rnd(-1.1, 0.5), life: 1, h })
  }

  /** one frame; `dt` in seconds (0 = a still picture) */
  function draw(dt: number) {
    const c = ctx
    if (!c || !W) return
    const k = dt * 60 // per-frame amounts were tuned at 60 frames a second
    const target = p / 100
    risk = dt ? risk + (target - risk) * Math.min(1, dt * 3.2) : target
    flash = Math.max(0, flash - dt * 0.9)
    const RH = liquidHue(risk)
    c.clearRect(0, 0, W, H)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    const fx = X(risk)

    // the forgetting liquid, one colour for the whole fill, its front rolling
    if (risk > 0.003) {
      const al = 0.3 + 0.32 * risk
      const g = c.createLinearGradient(W, 0, fx, 0)
      g.addColorStop(0, `hsla(${RH + 10},90%,46%,${al * 0.7})`)
      g.addColorStop(1, `hsla(${Math.max(0, RH - 8)},92%,50%,${al})`)
      const wob = 1 + quake * 1.5
      c.beginPath()
      c.moveTo(W + 2, 0)
      for (let y = 0; y <= H; y += 3) c.lineTo(fx + (Math.sin(y * 0.11 + t * 3) * 3 + Math.sin(y * 0.27 - t * 2.2) * 1.5) * wob, y)
      c.lineTo(W + 2, H)
      c.closePath()
      c.fillStyle = g
      c.fill()
      const gl = c.createLinearGradient(fx - 20, 0, fx + 20, 0)
      const hc = `hsla(${RH},95%,60%,`
      gl.addColorStop(0, hc + '0)')
      gl.addColorStop(0.5, hc + '.5)')
      gl.addColorStop(1, hc + '0)')
      c.fillStyle = gl
      c.fillRect(fx - 20, 0, 40, H)
      if (dt && Math.random() < 0.4 * k && sparks.length < 160)
        sparks.push({ x: fx + rnd(-3, 8), y: rnd(5, H - 5), vx: rnd(-0.4, 0.25), vy: rnd(-0.7, -0.15), life: 1, h: RH, dust: true })
    }

    // dendrites: a faint wide stroke under a fine one gives the soft look of living tissue
    for (const n of nodes) {
      const dd = dmg(n.f)
      const hu = cellHue(dd)
      const thin = 1 - 0.4 * dd
      c.strokeStyle = `hsla(${hu},70%,58%,${0.13 * (1 - dd) + 0.04})`
      for (const b of n.dend) {
        c.lineWidth = b.w * thin * 2.6 + 1
        c.stroke(b.path)
      }
      c.strokeStyle = `hsla(${hu},62%,${60 - 10 * dd}%,${0.85 - 0.45 * dd})`
      for (const b of n.dend) {
        c.lineWidth = b.w * thin + 0.25
        c.stroke(b.path)
      }
      // spines: little necks with heads, pulled back as the cell fades
      c.fillStyle = c.strokeStyle
      c.lineWidth = 0.7
      c.beginPath()
      for (const s of n.spines) {
        const L = s.l * (1 - dd * 0.95)
        if (L < 0.5) continue
        c.moveTo(s.x, s.y)
        c.lineTo(s.x + Math.cos(s.a) * L, s.y + Math.sin(s.a) * L)
      }
      c.stroke()
      c.beginPath()
      for (const s of n.spines) {
        const L = s.l * (1 - dd * 0.95)
        if (L < 0.5) continue
        const ex = s.x + Math.cos(s.a) * L
        const ey = s.y + Math.sin(s.a) * L
        c.moveTo(ex + 0.9, ey)
        c.arc(ex, ey, 0.9, 0, 6.3)
      }
      c.fill()
      // tips that just received a synapse light up
      for (const tp of n.tips) {
        tp.fl = Math.max(0, tp.fl - dt * 2.2)
        if (tp.fl > 0) halo(c, tp.x, tp.y, 7, 'rgba(255,236,150,1)', tp.fl * 0.8)
      }
    }

    // axons: myelin internodes between the nodes of Ranvier, then the terminal branches and their boutons
    for (const l of links) {
      const d = linkDmg(l)
      const s = 1 - d
      const hu = cellHue(d)
      // the bare axon
      if (d > 0.45) c.setLineDash([3, 2 + 7 * d])
      c.lineWidth = (1 * s + 0.5) * (1 + flash * 0.6)
      c.strokeStyle = `hsla(${hu},70%,${62 - 10 * d}%,${0.9 - 0.4 * d})`
      c.stroke(l.path)
      c.setLineDash([])
      // the myelin sheath, breaking up as the damage grows
      c.lineWidth = 3.4 * (H / 72) * (1 - 0.35 * d)
      c.strokeStyle = `hsla(${hu + 20},35%,${84 - 22 * d}%,${0.62 * (1 - d) + 0.06})`
      c.beginPath()
      for (let i = 1; i < l.stops.length - 2; i++) {
        const u0 = l.stops[i] + 0.035
        const u1 = l.stops[i + 1] - 0.035
        const keep = u0 + (u1 - u0) * (1 - 0.75 * d)
        for (let j = 0; j <= 4; j++) {
          const [x, y] = onAxon(l, u0 + ((keep - u0) * j) / 4)
          if (j) c.lineTo(x, y)
          else c.moveTo(x, y)
        }
      }
      c.stroke()
      // nodes of Ranvier light up as the signal jumps through them
      for (let i = 1; i < l.stops.length - 1; i++) {
        l.nodeGlow[i] = Math.max(0, l.nodeGlow[i] - dt * 3)
        if (l.nodeGlow[i] > 0) {
          const [x, y] = onAxon(l, l.stops[i])
          halo(c, x, y, 7, 'rgba(160,255,245,1)', l.nodeGlow[i] * 0.9)
        }
      }
      // the terminal branches with their boutons (full of vesicles while healthy)
      const br = (2.6 * (1 - 0.45 * d) + 0.5) * (H / 72)
      for (const tm of l.terms) {
        tm.fl = Math.max(0, tm.fl - dt * 2.5)
        const [bx, by] = bouton(l, tm, d)
        c.lineWidth = 0.9 * s + 0.4
        c.strokeStyle = `hsla(${hu},70%,${62 - 10 * d}%,${0.85 - 0.4 * d})`
        c.beginPath()
        c.moveTo(l.ex, l.ey)
        c.quadraticCurveTo(tm.cx, tm.cy, bx, by)
        c.stroke()
        halo(c, bx, by, br * 3.2, 'rgba(79,255,240,1)', 0.18 * s + tm.fl * 0.7)
        c.fillStyle = `hsla(${hu},75%,${62 - 10 * d}%,.95)`
        c.beginPath()
        c.arc(bx, by, br, 0, 6.3)
        c.fill()
        if (s > 0.35) {
          c.fillStyle = 'rgba(255,246,190,.8)'
          c.beginPath()
          for (let i = 0; i < 3; i++) {
            const vx = bx + Math.cos(i * 2.1 + t * 1.4) * br * 0.45
            const vy = by + Math.sin(i * 2.1 + t * 1.4) * br * 0.45
            c.moveTo(vx + 0.6, vy)
            c.arc(vx, vy, 0.6, 0, 6.3)
          }
          c.fill()
        }
      }
    }

    // cell bodies: the axon hillock, the pyramidal body, its nucleus and nucleolus
    for (const n of nodes) {
      const dd = dmg(n.f)
      const h = 1 - dd
      const hu = cellHue(dd)
      n.g = Math.max(0, n.g - dt * 1.8)
      if (n.fireAt && t >= n.fireAt) {
        n.fireAt = 0
        if (Math.random() > dd * 0.9) fire(n) // a damaged cell often stays silent
      }
      // every healthy cell also fires now and then by itself
      if (dt && !reduce && t >= n.nextFire) {
        n.nextFire = t + rnd(2.2, 4.6)
        if (dd < 0.5) fire(n)
      }
      const rr = n.r * (1 - 0.12 * dd) * (1 + (reduce ? 0 : 0.04 * Math.sin(t * 2 + n.ph) * h) + n.g * 0.1)
      if (h > 0.3) halo(c, n.x, n.y, rr * (2.6 + 1.6 * (n.g + flash * 0.7)), 'rgba(66,255,224,1)', 0.12 + 0.5 * (n.g + flash * 0.7) * h)
      const body = `hsla(${hu},70%,${46 - 12 * dd + 14 * n.g}%,${0.6 + 0.4 * h})`
      // hillock: the cone where the axon leaves the body
      c.fillStyle = body
      c.beginPath()
      c.moveTo(n.x - rr * 0.6, n.y - rr * 0.55)
      c.quadraticCurveTo(n.x - rr * 1.1, n.y - rr * 0.1, n.x - rr * 1.05 - 5 * (H / 72), n.y)
      c.quadraticCurveTo(n.x - rr * 1.1, n.y + rr * 0.1, n.x - rr * 0.6, n.y + rr * 0.55)
      c.fill()
      const gr = c.createRadialGradient(n.x - rr * 0.35, n.y - rr * 0.4, 0.5, n.x, n.y, rr * 1.4)
      const fl = dd > 0.3 ? 0.75 + 0.25 * Math.sin(t * 9 + n.ph * 5) : 1 // a dying cell flickers
      gr.addColorStop(0, `hsla(${hu},85%,${76 - 28 * dd + 16 * n.g}%,${fl})`)
      gr.addColorStop(1, body)
      c.fillStyle = gr
      const kk = n.shape.length
      const P = n.shape.map((m, i): Pt => {
        const a = (i / kk) * 6.283
        return [n.x + Math.cos(a) * rr * m, n.y + Math.sin(a) * rr * m * 0.86]
      })
      c.beginPath()
      c.moveTo((P[kk - 1][0] + P[0][0]) / 2, (P[kk - 1][1] + P[0][1]) / 2)
      for (let i = 0; i < kk; i++) {
        const a = P[i]
        const b = P[(i + 1) % kk]
        c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
      }
      c.closePath()
      c.fill()
      c.fillStyle = `rgba(4,22,32,${0.42 + 0.15 * dd})` // nucleus
      c.beginPath()
      c.ellipse(n.x - rr * 0.05, n.y + rr * 0.05, rr * 0.42, rr * 0.36, 0.3, 0, 6.3)
      c.fill()
      c.fillStyle = `hsla(${hu},80%,${70 - 20 * dd}%,${0.7 * h + 0.2})` // nucleolus
      c.beginPath()
      c.arc(n.x + rr * 0.06, n.y - rr * 0.02, rr * 0.13, 0, 6.3)
      c.fill()
      if (flash > 0.02) {
        c.strokeStyle = `rgba(120,255,225,${flash * 0.7})`
        c.lineWidth = 1.2
        c.beginPath()
        c.arc(n.x, n.y, rr + (1 - flash) * 26, 0, 6.3)
        c.stroke()
      }
    }

    // action potentials: in a myelinated axon the signal jumps from node to node (saltatory conduction)
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i]
      const l = pu.l
      const d = linkDmg(l)
      if (pu.term < 0) {
        pu.s += dt * (11 + 6 * flash) * (1 - 0.5 * d) // stops per second
        const at = Math.floor(pu.s)
        if (pu.fail && at >= pu.fail) {
          const [x, y] = onAxon(l, l.stops[pu.fail])
          burst(x, y, Math.min(RH, 25), 7) // the signal dies here
          pulses.splice(i, 1)
          continue
        }
        if (at >= l.stops.length - 1) {
          pu.term = 0 // at the branch point: out along the terminal branches
          continue
        }
        if (at > 0) l.nodeGlow[at] = Math.max(l.nodeGlow[at], 1)
        // fast inside the sheath, a short dwell at each node
        const fr = pu.s - at
        const e = fr < 0.5 ? 4 * fr * fr * fr : 1 - Math.pow(-2 * fr + 2, 3) / 2
        const [x, y] = onAxon(l, l.stops[at] + (l.stops[at + 1] - l.stops[at]) * e)
        halo(c, x, y, 8, 'rgba(127,255,240,1)', 0.75)
        c.fillStyle = 'rgba(220,255,250,.95)'
        c.beginPath()
        c.arc(x, y, 1.8, 0, 6.3)
        c.fill()
      } else {
        pu.term += dt * 5
        if (pu.term >= 1) {
          for (const tm of l.terms) {
            tm.fl = 1
            // transmitter across each gap; on a weak synapse some of it gets nowhere
            if (l.b) for (let j = 0; j < 3; j++) nts.push({ l, term: tm, u: -j * 0.18, ok: Math.random() > d, w: rnd(-2, 2) })
          }
          pulses.splice(i, 1)
          continue
        }
        for (const tm of l.terms) {
          const [x, y] = onTerm(l, tm, pu.term, d)
          halo(c, x, y, 6, 'rgba(127,255,240,1)', 0.6)
        }
      }
    }
    // neurotransmitter crossing the synaptic gap
    c.fillStyle = 'rgba(255,226,120,.95)'
    c.beginPath()
    for (let i = nts.length - 1; i >= 0; i--) {
      const q = nts[i]
      q.u += dt * 3.2
      if (q.u < 0) continue
      const tm = q.term
      if (q.u >= 1) {
        nts.splice(i, 1)
        if (q.ok && tm.tip && q.l.b && !backs.some((b) => b.tip === tm.tip)) {
          tm.tip.fl = 1
          backs.push({ n: q.l.b, tip: tm.tip, u: 0 })
        }
        continue
      }
      const [bx, by] = bouton(q.l, tm, linkDmg(q.l))
      const reach = q.ok ? 1 : 0.55
      const x = bx + (tm.bx - bx) * q.u * reach
      const y = by + (tm.by - by) * q.u * reach + Math.sin(q.u * 6.3) * q.w * 0.5
      c.moveTo(x + 1.1, y)
      c.arc(x, y, 1.1, 0, 6.3)
    }
    c.fill()
    // the signal running up the dendrite to the body, which then fires
    for (let i = backs.length - 1; i >= 0; i--) {
      const b = backs[i]
      b.u += dt * 3.4
      if (b.u >= 1) {
        backs.splice(i, 1)
        if (!b.n.fireAt) b.n.fireAt = t + 0.05
        continue
      }
      const [x, y] = onChain(b.tip.chain, 1 - b.u)
      halo(c, x, y, 6, 'rgba(255,236,150,1)', 0.65 * (1 - b.u * 0.4))
    }
    // sparks and memory dust
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      s.x += s.vx * k
      s.y += s.vy * k
      s.life -= (s.dust ? 0.014 : 0.04) * k
      if (s.life <= 0) {
        sparks.splice(i, 1)
        continue
      }
      c.fillStyle = `hsla(${s.h},95%,65%,${s.life * 0.8})`
      c.fillRect(s.x, s.y, 1.6, 1.6)
    }
    if (flash > 0.02) {
      c.fillStyle = `rgba(110,255,220,${flash * 0.1})`
      c.fillRect(0, 0, W, H)
    }

    const v = Math.round(risk * 100)
    if (v !== shown) shown = v
    const hh = Math.round(RH)
    if (hh !== hue) hue = hh
  }

  // ---------- running only while someone can see it ----------
  const running = () => !reduce && !paused && !pageHidden && onScreen && W > 0
  function loop(now: number) {
    raf = 0
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016
    last = now
    t += dt
    draw(dt)
    if (running()) raf = requestAnimationFrame(loop)
  }
  function wake() {
    if (running() && !raf) {
      last = 0
      raf = requestAnimationFrame(loop)
    } else if (!running() && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  // a lower risk than before = reviews were just done: every connection flashes and the cells fire one after another
  $effect(() => {
    const v = p
    if (lastP >= 0 && v < lastP) {
      flash = 1
      nodes.forEach((n, i) => {
        n.lastFire = -9
        n.fireAt = t + 0.05 + i * 0.14
      })
    }
    lastP = v
    if (!running()) draw(0)
  })
  $effect(() => {
    void paused
    wake()
  })

  let ro: ResizeObserver | undefined
  let io: IntersectionObserver | undefined
  const onVis = () => {
    pageHidden = document.hidden
    wake()
  }
  onMount(() => {
    risk = 0 // the liquid flows in when the tab opens
    ro = new ResizeObserver(() => {
      build()
      wake()
    })
    ro.observe(canvas)
    build() // at once too: the observer only reports with the next drawn frame
    io = new IntersectionObserver((e) => {
      onScreen = e[e.length - 1].isIntersecting
      wake()
    })
    io.observe(canvas)
    document.addEventListener('visibilitychange', onVis)
  })
  onDestroy(() => {
    cancelAnimationFrame(raf)
    ro?.disconnect()
    io?.disconnect()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
  })
</script>

<div class="risk" style:--h={hue}>
  <div class="head">
    <div class="titles">
      <span class="label">خطر فراموشی<InfoButton {...info} /></span>
      <small class="status" aria-live="polite">{status}</small>
    </div>
    <b class="pct">{fa(shown)}٪</b>
  </div>
  <button
    class="track"
    class:quake={quake > 0 && !reduce}
    style:--amp="{(0.6 + quake * 1.4).toFixed(2)}px"
    onclick={() => onopen?.()}
    data-value={p}
    aria-label="خطر فراموشی مرورهای امروز: {fa(p)} درصد — باز کردن نقشه‌ی مغز"
  >
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <span class="open" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
      مغز تو
    </span>
  </button>
</div>

<style>
  .risk {
    --c: hsl(var(--h) 85% 40%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  :global([data-theme='dark']) .risk {
    --c: hsl(var(--h) 88% 58%);
  }
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: calc(14px * var(--font-scale));
    font-weight: 800;
  }
  .status {
    font-size: calc(11.5px * var(--font-scale));
    color: var(--muted);
    line-height: 1.6;
  }
  .pct {
    flex: none;
    font-size: calc(26px * var(--font-scale));
    font-weight: 800;
    line-height: 1;
    color: var(--c);
    font-variant-numeric: tabular-nums;
  }
  /* a dark lab screen in both themes: the cells glow on black */
  .track {
    display: block;
    width: 100%;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    position: relative;
    height: 72px;
    border-radius: 18px;
    background: radial-gradient(ellipse 120% 90% at 50% 50%, #07101c, #03060c);
    border: 1px solid var(--line-2);
    box-shadow:
      0 0 22px -8px var(--c),
      inset 0 0 18px #000;
    overflow: hidden;
    /* its own layer: the strip repaints, the page around it does not */
    contain: strict;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* the way into the brain map */
  .open {
    position: absolute;
    bottom: 6px;
    inset-inline-end: 8px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10.5px;
    font-weight: 700;
    color: rgba(220, 235, 255, 0.85);
    background: rgba(5, 10, 20, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    padding: 2px 8px;
    pointer-events: none;
  }
  .track:active {
    filter: brightness(1.15);
  }
  /* above 90 %: the strip trembles (a transform only: no repaint, no layout) */
  .track.quake {
    animation: quake 0.32s linear infinite;
    will-change: transform;
  }
  @keyframes quake {
    0%,
    100% {
      transform: translate(0, 0);
    }
    15% {
      transform: translate(calc(var(--amp) * -1), calc(var(--amp) * 0.5));
    }
    30% {
      transform: translate(var(--amp), calc(var(--amp) * -0.4));
    }
    45% {
      transform: translate(calc(var(--amp) * -0.6), calc(var(--amp) * -0.6));
    }
    60% {
      transform: translate(calc(var(--amp) * 0.8), calc(var(--amp) * 0.3));
    }
    80% {
      transform: translate(calc(var(--amp) * -0.3), calc(var(--amp) * 0.6));
    }
  }
</style>
