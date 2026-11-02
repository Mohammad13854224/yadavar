/** How long the brain model takes to build for big collections (npx tsx tools/brain-bench.ts). */
import { buildBrain } from '../src/lib/brain/model'
import type { Card, ReviewLogEntry, TreeNode } from '../src/lib/types'

function run(label: string, folders: number, depth: number, cards: number, reviews: number) {
  const nodes: TreeNode[] = []
  for (let i = 0; i < folders; i++) {
    const parent = i < 8 || depth === 1 ? null : nodes[Math.floor(Math.random() * Math.min(i, 8 * depth))].id
    nodes.push({ id: 'n' + i, parentId: parent, name: 'پوشه ' + i, createdAt: i })
  }
  const list: Card[] = []
  const now = Date.now()
  for (let i = 0; i < cards; i++) {
    const studied = i % 3 !== 0
    list.push({
      id: String(1000 + i),
      folderId: nodes.length ? nodes[i % nodes.length].id : null,
      name: 'کارت ' + i,
      front: { html: '', widgets: [] },
      back: { html: '', widgets: [] },
      state: studied ? 'review' : 'new',
      ready: false,
      due: now,
      interval: studied ? Math.random() * 100 : 0,
      reps: studied ? 3 : 0,
      lapses: 0,
      createdAt: i,
      recall: studied ? 0.4 + Math.random() * 0.6 : undefined,
    })
  }
  const revlog: ReviewLogEntry[] = []
  let t = now - 200 * 86_400_000
  for (let i = 0; i < reviews; i++) {
    t += Math.random() < 0.02 ? 86_400_000 : 20_000
    revlog.push({ cardId: list[Math.floor(Math.random() * list.length)].id, at: t, rating: 3 })
  }
  const kids = new Map<string | null, TreeNode[]>()
  for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n])
  const of = new Map<string | null, Card[]>()
  for (const c of list) of.set(c.folderId, [...(of.get(c.folderId) ?? []), c])
  const t0 = performance.now()
  const m = buildBrain({ nodes, cards: list, revlog, retention: 0.9, children: (id) => kids.get(id) ?? [], cardsOf: (id) => of.get(id) ?? [] })
  const ms = performance.now() - t0
  const t1 = performance.now()
  revlog.push({ cardId: list[0].id, at: t + 1000, rating: 3 })
  buildBrain({ nodes, cards: list, revlog, retention: 0.9, children: (id) => kids.get(id) ?? [], cardsOf: (id) => of.get(id) ?? [] })
  const again = performance.now() - t1
  console.log(`${label}: ${ms.toFixed(0)} ms (one more review: ${again.toFixed(0)} ms) — ${m.count} neurons, ${m.regions.length} regions, ${m.linkA.length} links, radius ${m.radius.toFixed(1)}`)
}

run('small', 5, 1, 300, 1000)
run('imported', 40, 3, 20000, 0)
run('heavy', 300, 4, 20000, 60000)
run('flat 2000 folders', 2000, 1, 30000, 30000)
