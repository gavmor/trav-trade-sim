import { describe, it, expect } from 'vitest'
import {
  emptyDoc, mergeDocs, makeOp, materialize, maxLamport, opOrder,
  put, init, set, add, del, clear, rows, byId,
} from '../src/lib/crdt/doc.js'

function docWith(...opEntries) {
  const doc = emptyDoc()
  for (const { id, op } of opEntries) doc.ops[id] = op
  return doc
}

function op(agentId, lamport, effects) {
  return makeOp({ agentId, lamport, effects })
}

describe('mergeDocs', () => {
  it('is a set union of ops', () => {
    const a = docWith(op('a', 1, [put('ships', 's1', { id: 's1' })]))
    const b = docWith(op('b', 1, [put('ships', 's2', { id: 's2' })]))
    const merged = mergeDocs(a, b)
    expect(Object.keys(merged.ops)).toHaveLength(2)
  })

  it('is commutative: merge(a,b) materializes the same as merge(b,a)', () => {
    const a = docWith(
      op('agent-a', 1, [put('ships', 's1', { id: 's1', credits: 100 })]),
      op('agent-a', 2, [add('ships', 's1', 'credits', -30)]),
    )
    const b = docWith(op('agent-b', 2, [add('ships', 's1', 'credits', -50)]))

    const ab = materialize(mergeDocs(a, b))
    const ba = materialize(mergeDocs(b, a))
    expect(ab).toEqual(ba)
    expect(byId(ab, 'ships', 's1').credits).toBe(20)
  })

  it('is idempotent: merging the same doc twice changes nothing', () => {
    const a = docWith(op('a', 1, [put('t', 'x', { id: 'x', v: 1 })]))
    expect(materialize(mergeDocs(a, a))).toEqual(materialize(a))
  })

  it('is associative across three peers', () => {
    const a = docWith(op('a', 1, [put('t', 'x', { id: 'x', n: 0 })]))
    const b = docWith(op('b', 2, [add('t', 'x', 'n', 5)]))
    const c = docWith(op('c', 2, [add('t', 'x', 'n', 7)]))

    const left  = materialize(mergeDocs(mergeDocs(a, b), c))
    const right = materialize(mergeDocs(a, mergeDocs(b, c)))
    expect(left).toEqual(right)
    expect(byId(left, 't', 'x').n).toBe(12)
  })
})

describe('materialize total order', () => {
  it('orders by lamport, then agent id, then op id', () => {
    const first  = { id: 'op-1', op: { l: 1, a: 'z', e: [put('t', 'x', { id: 'x', who: 'first' })] } }
    const second = { id: 'op-2', op: { l: 2, a: 'a', e: [set('t', 'x', { who: 'second' })] } }
    expect(opOrder(['op-1', first.op], ['op-2', second.op])).toBeLessThan(0)

    const doc = emptyDoc()
    doc.ops[second.id] = second.op
    doc.ops[first.id]  = first.op
    expect(byId(materialize(doc), 't', 'x').who).toBe('second')
  })

  it('resolves concurrent set conflicts deterministically (same on every peer)', () => {
    const a = docWith(
      op('agent-a', 1, [put('ships', 's1', { id: 's1', name: 'Beowulf' })]),
    )
    const renameA = op('agent-a', 2, [set('ships', 's1', { name: 'Ares' })])
    const renameB = op('agent-b', 2, [set('ships', 's1', { name: 'Boreas' })])

    const peer1 = materialize(mergeDocs(docWith(renameA), mergeDocs(a, docWith(renameB))))
    const peer2 = materialize(mergeDocs(mergeDocs(a, docWith(renameA)), docWith(renameB)))
    expect(peer1).toEqual(peer2)
    // agent-b sorts after agent-a at equal lamport → last writer wins
    expect(byId(peer1, 'ships', 's1').name).toBe('Boreas')
  })
})

describe('effects', () => {
  it('init is insert-if-absent (INSERT OR IGNORE semantics)', () => {
    const doc = docWith(
      op('a', 1, [init('snap', 'k', { price: 100 })]),
      op('b', 2, [init('snap', 'k', { price: 999 })]),
    )
    expect(byId(materialize(doc), 'snap', 'k').price).toBe(100)
  })

  it('set and add on a deleted row are no-ops', () => {
    const doc = docWith(
      op('a', 1, [put('t', 'x', { id: 'x', n: 1 })]),
      op('a', 2, [del('t', 'x')]),
      op('a', 3, [set('t', 'x', { n: 5 }), add('t', 'x', 'n', 5)]),
    )
    expect(byId(materialize(doc), 't', 'x')).toBeNull()
  })

  it('clear wipes everything before it but not ops after it', () => {
    const doc = docWith(
      op('a', 1, [put('t', 'x', { id: 'x' })]),
      op('a', 2, [clear()]),
      op('a', 3, [put('t', 'y', { id: 'y' })]),
    )
    const state = materialize(doc)
    expect(rows(state, 't').map(r => r.id)).toEqual(['y'])
  })

  it('unknown effect types are skipped, not fatal', () => {
    const doc = docWith(op('a', 1, [{ t: 'from-the-future' }, put('t', 'x', { id: 'x' })]))
    expect(byId(materialize(doc), 't', 'x')).toEqual({ id: 'x' })
  })
})

describe('maxLamport', () => {
  it('returns 0 for an empty doc and the max otherwise', () => {
    expect(maxLamport(emptyDoc())).toBe(0)
    const doc = docWith(op('a', 3, []), op('b', 7, []))
    expect(maxLamport(doc)).toBe(7)
  })
})
