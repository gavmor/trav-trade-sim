// @vitest-environment happy-dom
//
// Two-context convergence: proves that two browser contexts sharing a
// campaign through crdtbus end up with identical state. Context A runs the
// full app stack (api → backend → bus). Context B is a simulated remote
// peer holding its own copy of the document; patches flow both ways through
// exactly the merge path crdtbus uses over WebRTC (its network layer just
// ships state patches to other peers' merge functions — see
// src/lib/crdt/bus.js — so exchanging docs through mergeDocs *is* the wire
// protocol, minus the sockets).

import { beforeEach, describe, it, expect } from 'vitest'
import { api } from '../src/lib/api.js'
import { configureSync, closeCampaign, currentBus, onRemoteUpdate } from '../src/lib/crdt/store.js'
import {
  emptyDoc, mergeDocs, materialize, makeOp, maxLamport,
  add, put, byId, rows,
} from '../src/lib/crdt/doc.js'

configureSync({ network: false, persistence: 'memory' })

let n = 0
const uniqueCode = () => `SYNC-${Date.now()}-${n++}`

function saveSession(data) {
  localStorage.setItem('tts_session', JSON.stringify({
    campaign: data.campaign, player: data.player, token: data.token,
  }))
}

beforeEach(() => {
  localStorage.clear()
  closeCampaign()
})

describe('two contexts sharing a campaign', () => {
  it('a late-joining peer receives the full campaign, and concurrent trades on both peers converge', async () => {
    // ── Context A: referee creates a campaign and a funded ship ─────────────
    const created = await api.post('/api/campaigns', {
      label: 'Sync Test', code: uniqueCode(), char_name: 'Referee', pin: '1234',
    })
    saveSession(created.data)
    const { campaign, player } = created.data

    const { data: ship } = await api.post('/api/ships', {
      campaign_id: campaign.id, player_id: player.id, name: 'Beowulf',
    })
    await api.patch(`/api/ships/${ship.id}/credits`, { delta: 10_000 })

    const busA = currentBus()

    // ── Context B: a fresh peer connects with an empty local doc.
    // On connect, crdtbus's host sends its full current state as one patch;
    // B merges it (this is the "latecomers immediately sync up" behavior).
    let docB = mergeDocs(emptyDoc(), busA.state.get())
    const stateB = materialize(docB)
    expect(byId(stateB, 'campaigns', campaign.id).label).toBe('Sync Test')
    expect(byId(stateB, 'ships', ship.id).credits).toBe(10_000)

    // ── Concurrent activity: A spends via the app; B spends via its own op
    // (same lamport range — genuinely concurrent, neither knows of the other).
    const spendB = makeOp({
      agentId: 'peer-b',
      lamport: maxLamport(docB) + 1,
      effects: [add('ships', ship.id, 'credits', -3_000)],
    })
    docB = mergeDocs(docB, { v: 1, ops: { [spendB.id]: spendB.op } })

    await api.patch(`/api/ships/${ship.id}/credits`, { delta: -2_000 })

    // ── Sync: B's patch arrives at A (remote update fires); A's doc reaches B.
    let remoteUpdates = 0
    const unsub = onRemoteUpdate(() => remoteUpdates++)
    busA.receive({ v: 1, ops: { [spendB.id]: spendB.op } })
    unsub()
    expect(remoteUpdates).toBe(1)

    docB = mergeDocs(docB, busA.state.get())

    // ── Both contexts see both debits: 10000 - 2000 - 3000.
    const finalA = materialize(busA.state.get())
    const finalB = materialize(docB)
    expect(byId(finalA, 'ships', ship.id).credits).toBe(5_000)
    expect(finalA).toEqual(finalB)

    // And the app on context A reads the converged balance through the api.
    const { data: current } = await api.get('/api/ships/current', {
      player_id: player.id, campaign_id: campaign.id,
    })
    expect(current.ship.credits).toBe(5_000)
  })

  it('concurrent snapshot generation for the same world/tick converges to one row (INSERT OR IGNORE parity)', async () => {
    const created = await api.post('/api/campaigns', {
      label: 'Snap Race', code: uniqueCode(), char_name: 'Referee', pin: '1234',
    })
    saveSession(created.data)
    const { campaign } = created.data

    // Context A generates this world's tick-0 snapshot through the app.
    await api.post(`/api/campaigns/${campaign.id}/snapshots`, {
      rows: [{
        campaign_id: campaign.id, world_hex: '1910', sector: 'Spinward Marches',
        trade_good_die: '11', trade_good_name: 'Textiles',
        tick: 0, purchase_price: 3000, sale_price: 3500, qty_available: 20,
      }],
    })

    // Context B raced to generate the same snapshot (deterministic seeding
    // means identical prices; id key is the composite world|sector|die|tick).
    const busA = currentBus()
    const raceOp = makeOp({
      agentId: 'peer-b',
      lamport: 1, // concurrent with A's insert
      effects: [put('market_snapshots', '1910|Spinward Marches|11|0', {
        id: 'peer-b-copy', campaign_id: campaign.id,
        world_hex: '1910', sector: 'Spinward Marches',
        trade_good_die: '11', trade_good_name: 'Textiles',
        tick: 0, purchase_price: 3000, sale_price: 3500, qty_available: 20,
      })],
    })
    // B used init in real code; simulate with the same key to show one row wins.
    raceOp.op.e[0].t = 'init'
    busA.receive({ v: 1, ops: { [raceOp.id]: raceOp.op } })

    const state = materialize(busA.state.get())
    const snaps = rows(state, 'market_snapshots').filter(s => s.tick === 0)
    expect(snaps).toHaveLength(1)
  })
})
