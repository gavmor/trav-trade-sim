// Campaign document CRDT — an operation log with a deterministic total order.
//
// The one organizing idea: every mutation to campaign state is an *op* — a
// small record carrying a list of precomputed *effects* (row puts, field
// sets, additive deltas, deletes). The document itself is just the set of
// all ops ever applied, keyed by op id:
//
//   doc = { v: 1, ops: { [opId]: { l, a, e } } }     l=lamport, a=agentId, e=effects
//
// merge(a, b) is set union — trivially commutative, associative, and
// idempotent, which is exactly the contract crdtbus requires. Every peer
// *materializes* the same table state by folding effects in the total order
// (lamport, agentId, opId), so any two peers holding the same op set render
// identical state regardless of delivery order.
//
// Effects were chosen over storing rows directly (row-level LWW) because
// this is a game economy: two players spending from the same ship's credit
// balance concurrently must BOTH debit it. Additive 'add' effects make that
// arithmetic conflict-free; 'put'/'set' conflicts resolve last-writer-wins
// under the total order, matching what two racing HTTP POSTs used to do
// against D1.
//
// Determinism rules for handler code producing effects:
//   - Roll dice / read clocks / generate UUIDs at *submit* time and bake the
//     results into the effect payload. Materialization must stay pure.
//   - `init` (insert-if-absent) with a deterministic composite-key id gives
//     the same semantics as SQL INSERT OR IGNORE on a UNIQUE constraint.

export const DOC_VERSION = 1

export function emptyDoc() {
  return { v: DOC_VERSION, ops: {} }
}

// Set union of op logs. Op ids are UUIDs, so identical keys are identical ops.
export function mergeDocs(a, b) {
  if (!a?.ops) return b?.ops ? b : emptyDoc()
  if (!b?.ops) return a
  return { v: DOC_VERSION, ops: { ...a.ops, ...b.ops } }
}

export function maxLamport(doc) {
  let max = 0
  for (const op of Object.values(doc.ops)) {
    if (op.l > max) max = op.l
  }
  return max
}

// Build an op envelope. `effects` is an array of effect objects (see below).
export function makeOp({ agentId, lamport, effects }) {
  return { id: crypto.randomUUID(), op: { l: lamport, a: agentId, e: effects } }
}

// ── Effect constructors ───────────────────────────────────────────────────────

export const put   = (table, id, row)      => ({ t: 'put',  tb: table, id, row })
export const init  = (table, id, row)      => ({ t: 'init', tb: table, id, row })
export const set   = (table, id, fields)   => ({ t: 'set',  tb: table, id, fields })
export const add   = (table, id, field, n) => ({ t: 'add',  tb: table, id, field, n })
export const del   = (table, id)           => ({ t: 'del',  tb: table, id })
export const clear = ()                    => ({ t: 'clear' })

// ── Materialization ───────────────────────────────────────────────────────────

// Total order: lamport clock, then agent id, then op id — all three compared
// so every peer folds the ops identically.
export function opOrder([idA, a], [idB, b]) {
  if (a.l !== b.l) return a.l - b.l
  if (a.a !== b.a) return a.a < b.a ? -1 : 1
  return idA < idB ? -1 : idA > idB ? 1 : 0
}

// Folds the op log into `{ tables: { [table]: { [id]: row } } }`.
// Pure — same doc always yields the same state.
export function materialize(doc) {
  const tables = {}
  const sorted = Object.entries(doc.ops).sort(opOrder)
  for (const [, op] of sorted) {
    for (const fx of op.e) {
      applyEffect(tables, fx)
    }
  }
  return { tables }
}

function tableOf(tables, name) {
  return (tables[name] ??= {})
}

function applyEffect(tables, fx) {
  switch (fx.t) {
    case 'put': {
      tableOf(tables, fx.tb)[fx.id] = { ...fx.row }
      break
    }
    case 'init': {
      const tb = tableOf(tables, fx.tb)
      if (!(fx.id in tb)) tb[fx.id] = { ...fx.row }
      break
    }
    case 'set': {
      const tb = tableOf(tables, fx.tb)
      const row = tb[fx.id]
      if (row) tb[fx.id] = { ...row, ...fx.fields }
      break
    }
    case 'add': {
      const tb = tableOf(tables, fx.tb)
      const row = tb[fx.id]
      if (row) tb[fx.id] = { ...row, [fx.field]: (row[fx.field] ?? 0) + fx.n }
      break
    }
    case 'del': {
      delete tableOf(tables, fx.tb)[fx.id]
      break
    }
    case 'clear': {
      for (const name of Object.keys(tables)) delete tables[name]
      break
    }
    default:
      // Unknown effect from a newer client — skip it rather than crash.
      // (DOC_VERSION exists so a future breaking change can be detected.)
      break
  }
}

// ── Read helpers ──────────────────────────────────────────────────────────────

export function rows(state, table) {
  return Object.values(state.tables[table] ?? {})
}

export function byId(state, table, id) {
  return state.tables[table]?.[id] ?? null
}
