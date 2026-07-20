// Ship operations — trade, passengers, fuel, mail, freight, debts.
// Ported from the Worker's routes/ships.js. Credit movements use additive
// effects so two crew members transacting concurrently both settle.

import { route, ApiError, ok, created } from './router.js'
import { put, set, add, del } from '../crdt/doc.js'
import { uuid, nowISO, rows, byId, sortBy, passengerView, mailView, freightView, obligationsFor } from './tables.js'

// ── MgT2022 late-delivery penalty ─────────────────────────────────────────────
// Same seeded-RNG scheme and (1D+4)×10% formula as
// src/lib/trade-engine-mgt2022.js's freightLatePenaltyPct. Deterministic per
// (campaign, obligation), so it needs no storage and every peer that replays
// a late delivery computes the identical penalty.

function fnv1a(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

function makeRng(seedStr) {
  let s = fnv1a(seedStr)
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

function d6(rng) { return Math.floor(rng() * 6) + 1 }

function freightLatePenaltyPct(campaignId, obligationId) {
  const rng = makeRng(`${campaignId}:${obligationId}:late`)
  return (d6(rng) + 4) * 10
}

function freightNetAfterPenalty(charge, penaltyPct) {
  return Math.max(0, Math.round(charge * (1 - penaltyPct / 100)))
}

const snapshotKey = (world_hex, sector, die, tick) => `${world_hex}|${sector}|${die}|${tick}`

function txnEffect(fields) {
  const id = uuid()
  return put('transactions', id, { id, created_at: nowISO(), ...fields })
}

function shipOr404(ctx, shipId) {
  const ship = byId(ctx.state(), 'ships', shipId)
  if (!ship) throw new ApiError(404, 'Ship not found')
  return ship
}

// ── GET /api/ships/current — player's active ship ─────────────────────────────
route('GET', '/api/ships/current', 'auth', (ctx) => {
  const { player_id, campaign_id } = ctx.query
  if (player_id !== ctx.session.player_id)     throw new ApiError(403, 'Forbidden')
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const state = ctx.state()
  const crewRow = rows(state, 'crew').find(
    c => c.player_id === player_id && c.campaign_id === campaign_id && c.left_tick == null,
  )
  if (!crewRow) return ok(null)

  const s = byId(state, 'ships', crewRow.ship_id)
  if (!s) return ok(null)

  const ship = {
    id: s.id, name: s.name, hull_type: s.hull_type,
    hull_tons: s.hull_tons, cargo_capacity: s.cargo_capacity,
    current_world: s.current_world, current_sector: s.current_sector,
    credits: s.credits, jump_rating: s.jump_rating,
    maneuver_drive_rating: s.maneuver_drive_rating,
    stateroom_capacity: s.stateroom_capacity,
    low_berth_capacity: s.low_berth_capacity,
    fuel_capacity: s.fuel_capacity, fuel_current: s.fuel_current,
    market_value: s.market_value,
    crew_role: crewRow.role, can_trade: crewRow.can_trade === 1,
    crew_staterooms: rows(state, 'crew').filter(
      c => c.ship_id === s.id && c.campaign_id === campaign_id && c.left_tick == null && c.has_stateroom === 1,
    ).length,
  }

  const cargo = sortBy(
    rows(state, 'cargo').filter(c => c.ship_id === s.id && c.campaign_id === campaign_id),
    'created_at',
  )

  return ok({
    ship,
    cargo,
    passengers:    obligationsFor(state, { kind: 'passenger', shipId: s.id, campaignId: campaign_id, status: 'pending' }).map(passengerView),
    mailContracts: obligationsFor(state, { kind: 'mail',      shipId: s.id, campaignId: campaign_id, status: 'pending' }).map(mailView),
    freight:       obligationsFor(state, { kind: 'freight',   shipId: s.id, campaignId: campaign_id, status: 'pending' }).map(freightView),
  })
})

// ── POST /api/ships — create ship + crew assignment ───────────────────────────
route('POST', '/api/ships', 'auth', (ctx) => {
  const { campaign_id, player_id, name, hull_type, hull_tons, cargo_capacity, current_tick = 0 } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const shipId = uuid()
  const ship = {
    id: shipId, campaign_id, name,
    hull_type: hull_type ?? null,
    hull_tons: hull_tons ?? 200,
    cargo_capacity: cargo_capacity ?? 80,
    current_world: null, current_sector: null, credits: 0,
    jump_rating: null, maneuver_drive_rating: null,
    stateroom_capacity: 0, low_berth_capacity: 0,
    fuel_capacity: 0, fuel_current: 0, market_value: 0,
    created_at: nowISO(),
  }
  const crewId = uuid()

  ctx.apply([
    put('ships', shipId, ship),
    put('crew', crewId, {
      id: crewId, campaign_id, ship_id: shipId, player_id,
      role: 'captain', can_trade: 1, has_stateroom: 1,
      joined_tick: current_tick, left_tick: null,
    }),
  ])

  return created({ ...ship, crew_role: 'captain', can_trade: true })
})

// ── PATCH /api/ships/:id — update ship fields ─────────────────────────────────
route('PATCH', '/api/ships/:id', 'auth', (ctx) => {
  const ship = shipOr404(ctx, ctx.params.id)
  if (ship.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const allowed = ['current_world', 'current_sector', 'credits', 'fuel_current',
                   'hull_type', 'hull_tons', 'cargo_capacity', 'jump_rating',
                   'maneuver_drive_rating', 'stateroom_capacity', 'low_berth_capacity',
                   'fuel_capacity', 'name']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields to update')

  ctx.apply([set('ships', ship.id, fields)])
  return ok({ ...ship, ...fields })
})

// ── PATCH /api/ships/:id/credits — adjust credits by delta ───────────────────
route('PATCH', '/api/ships/:id/credits', 'auth', (ctx) => {
  const ship = shipOr404(ctx, ctx.params.id)
  if (ship.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  ctx.apply([add('ships', ship.id, 'credits', ctx.body.delta)])
  return ok({ credits: ship.credits + ctx.body.delta })
})

// ── POST /api/ships/:id/buy-cargo — atomic: cargo + transaction + credits + qty ─
route('POST', '/api/ships/:id/buy-cargo', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, player_id, good, tons, world_hex, world_name, sector, tick } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const ship = shipOr404(ctx, id)

  const totalCost = good.purchase_price * tons
  if ((ship.credits ?? 0) < totalCost) throw new ApiError(400, 'Insufficient credits')

  const snapKey   = snapshotKey(world_hex, sector, good.trade_good_die, tick)
  const snapshot  = byId(ctx.state(), 'market_snapshots', snapKey)
  if (!snapshot) throw new ApiError(400, 'Market snapshot not found for this tick')
  if (tons > snapshot.qty_available) {
    throw new ApiError(400, `Only ${snapshot.qty_available}t available at this price`)
  }

  const cargoId  = uuid()
  const cargoRow = {
    id: cargoId, campaign_id, player_id, ship_id: id,
    trade_good_die: good.trade_good_die, trade_good_name: good.trade_good_name,
    tons, purchase_price: good.purchase_price, purchased_tick: tick,
    purchase_world: world_hex, purchase_world_name: world_name ?? '', purchase_sector: sector,
    created_at: nowISO(),
  }

  ctx.apply([
    put('cargo', cargoId, cargoRow),
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'buy',
      trade_good_die: good.trade_good_die, trade_good_name: good.trade_good_name,
      tons, price_per_ton: good.purchase_price, total_cr: -totalCost,
      world_hex, sector,
    }),
    add('ships', id, 'credits', -totalCost),
    add('market_snapshots', snapKey, 'qty_available', -tons),
  ])

  return created(cargoRow)
})

// ── POST /api/ships/:id/sell-cargo — atomic: delete cargo + transaction + trade_record + credits ──
route('POST', '/api/ships/:id/sell-cargo', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, cargo_item, sell_price_per_ton, market_world_hex, market_sector, tick, trade_rules } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const totalRevenue = sell_price_per_ton * cargo_item.tons
  const totalCost    = cargo_item.purchase_price * cargo_item.tons
  const netProfit    = totalRevenue - totalCost

  ctx.apply([
    del('cargo', cargo_item.id),
    txnEffect({
      campaign_id, player_id: cargo_item.player_id, ship_id: id, tick, type: 'sell',
      trade_good_die: cargo_item.trade_good_die, trade_good_name: cargo_item.trade_good_name,
      tons: cargo_item.tons, price_per_ton: sell_price_per_ton, total_cr: totalRevenue,
      world_hex: market_world_hex, sector: market_sector,
    }),
    put('trade_records', uuid(), {
      id: uuid(), campaign_id, player_id: cargo_item.player_id, ship_id: id, trade_rules,
      trade_good_die: cargo_item.trade_good_die, trade_good_name: cargo_item.trade_good_name,
      tons: cargo_item.tons,
      source_world_hex: cargo_item.purchase_world, source_sector: cargo_item.purchase_sector,
      purchase_tick: cargo_item.purchased_tick, buy_price_per_ton: cargo_item.purchase_price,
      total_cost: totalCost,
      market_world_hex, market_sector, sell_tick: tick,
      trade_price_per_ton: sell_price_per_ton, sell_price_per_ton,
      total_revenue: totalRevenue, net_profit: netProfit,
      created_at: nowISO(),
    }),
    add('ships', id, 'credits', totalRevenue),
  ])

  return ok({ ok: true, net_profit: netProfit })
})

// ── POST /api/ships/:id/book-passengers — atomic: manifest + transaction + credits ──
route('POST', '/api/ships/:id/book-passengers', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, player_id, passage_type, count, embark_world_hex, embark_sector, embark_world_name,
          dest_world_hex, dest_sector, dest_world_name, fare_per_head, fare_total, tick } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const manifestId = uuid()
  const manifest = {
    id: manifestId, campaign_id, ship_id: id, player_id,
    kind: 'passenger', status: 'pending', amount: fare_total,
    passage_type, passenger_count: count,
    origin_world_hex: embark_world_hex, origin_sector: embark_sector,
    origin_world_name: embark_world_name ?? '', accept_tick: tick,
    dest_world_hex, dest_sector, dest_world_name: dest_world_name ?? '',
    fare_per_head, resolve_tick: null, created_at: nowISO(),
  }

  ctx.apply([
    put('obligations', manifestId, manifest),
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'passenger_fare',
      total_cr: fare_total, world_hex: embark_world_hex, sector: embark_sector,
      notes: `${count}× ${passage_type} → ${dest_world_name || dest_world_hex}`,
    }),
    add('ships', id, 'credits', fare_total),
  ])

  return created(passengerView(manifest))
})

// ── POST /api/ships/:id/deliver-passengers — batch update status ──────────────
route('POST', '/api/ships/:id/deliver-passengers', 'auth', (ctx) => {
  const { ids, tick, campaign_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (!ids?.length) return ok({ ok: true })

  ctx.apply(ids.map(pid => set('obligations', pid, { status: 'fulfilled', resolve_tick: tick })))
  return ok({ ok: true })
})

// ── POST /api/ships/:id/refund-passenger — atomic: manifest + transaction + credits ──
route('POST', '/api/ships/:id/refund-passenger', 'auth', (ctx) => {
  const { id } = ctx.params
  const { manifest_id, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const o = byId(ctx.state(), 'obligations', manifest_id)
  if (!o || o.campaign_id !== campaign_id || o.kind !== 'passenger') throw new ApiError(404, 'Manifest not found')
  const manifest = passengerView(o)

  ctx.apply([
    set('obligations', manifest_id, { status: 'cancelled', resolve_tick: tick }),
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'passenger_refund',
      total_cr: -manifest.fare_total,
      world_hex: manifest.embark_world_hex, sector: manifest.embark_sector,
      notes: `Refund: ${manifest.count}× ${manifest.passage_type}`,
    }),
    add('ships', id, 'credits', -manifest.fare_total),
  ])

  return ok({ ok: true })
})

// ── POST /api/ships/:id/purchase-fuel — atomic: transaction + credits + fuel_current ──
route('POST', '/api/ships/:id/purchase-fuel', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, player_id, fuel_type, tons, price_per_ton, world_hex, sector, tick } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const ship = shipOr404(ctx, id)
  const totalCost = Math.round(tons * price_per_ton)

  ctx.apply([
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'fuel',
      tons, price_per_ton, total_cr: -totalCost,
      world_hex, sector, notes: `${fuel_type} fuel`,
    }),
    add('ships', id, 'credits', -totalCost),
    add('ships', id, 'fuel_current', tons),
  ])

  return ok({
    ok: true, total_cost: totalCost,
    credits: ship.credits - totalCost,
    fuel_current: ship.fuel_current + tons,
  })
})

// ── POST /api/ships/:id/accept-mail — insert mail contract ───────────────────
route('POST', '/api/ships/:id/accept-mail', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, player_id, origin_world_hex, origin_sector, origin_world_name,
          dest_world_hex, dest_sector, dest_world_name, parsecs, payment, tick } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const contractId = uuid()
  const contract = {
    id: contractId, campaign_id, ship_id: id, player_id,
    kind: 'mail', status: 'pending', amount: payment,
    origin_world_hex, origin_sector, origin_world_name: origin_world_name ?? '',
    accept_tick: tick, dest_world_hex, dest_sector, dest_world_name: dest_world_name ?? '',
    parsecs, resolve_tick: null, created_at: nowISO(),
  }

  ctx.apply([put('obligations', contractId, contract)])
  return created(mailView(contract))
})

// ── POST /api/ships/:id/deliver-mail — atomic: mail contracts + transactions + credits ──
route('POST', '/api/ships/:id/deliver-mail', 'auth', (ctx) => {
  const { id } = ctx.params
  const { contracts, world_hex, sector, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (!contracts?.length) return ok({ ok: true })

  const totalPayment = contracts.reduce((s, m) => s + m.payment, 0)
  ctx.apply([
    ...contracts.map(m => set('obligations', m.id, { status: 'fulfilled', resolve_tick: tick })),
    ...contracts.map(m => txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'mail',
      total_cr: m.payment, world_hex, sector,
      notes: `Mail delivered from ${m.origin_world_name || m.origin_world_hex}`,
    })),
    add('ships', id, 'credits', totalPayment),
  ])

  return ok({ ok: true })
})

// ── POST /api/ships/:id/book-freight — atomic: obligation + transaction + credits ──
// MgT2022 only. Charged upfront, like passenger fares.
route('POST', '/api/ships/:id/book-freight', 'auth', (ctx) => {
  const { id } = ctx.params
  const { campaign_id, player_id, origin_world_hex, origin_sector, origin_world_name,
          dest_world_hex, dest_sector, dest_world_name, parsecs,
          freight_tons, freight_lot_size, rate_per_ton, charge, due_tick, tick } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const obligationId = uuid()
  const obligation = {
    id: obligationId, campaign_id, ship_id: id, player_id,
    kind: 'freight', status: 'pending', amount: charge,
    origin_world_hex, origin_sector, origin_world_name: origin_world_name ?? '',
    accept_tick: tick, dest_world_hex, dest_sector, dest_world_name: dest_world_name ?? '',
    parsecs, freight_tons, freight_lot_size, rate_per_ton, due_tick,
    resolve_tick: null, created_at: nowISO(),
  }

  ctx.apply([
    put('obligations', obligationId, obligation),
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'freight_charge',
      total_cr: charge, world_hex: origin_world_hex, sector: origin_sector,
      notes: `${freight_tons}t ${freight_lot_size} freight → ${dest_world_name || dest_world_hex}`,
    }),
    add('ships', id, 'credits', charge),
  ])

  return created(freightView(obligation))
})

// ── POST /api/ships/:id/deliver-freight — atomic: obligations + late penalty + transactions + credits ──
route('POST', '/api/ships/:id/deliver-freight', 'auth', (ctx) => {
  const { id } = ctx.params
  const { lots, world_hex, sector, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (!lots?.length) return ok({ ok: true, lots: [] })

  const effects = []
  const deliveredLots = []
  let netTotal = 0

  for (const lot of lots) {
    const isLate = lot.due_tick != null && tick > lot.due_tick
    const penaltyPct = isLate ? freightLatePenaltyPct(campaign_id, lot.id) : 0
    const net = isLate ? freightNetAfterPenalty(lot.charge, penaltyPct) : lot.charge
    netTotal += net
    deliveredLots.push({ ...lot, penaltyPct, net })

    effects.push(set('obligations', lot.id, { status: 'fulfilled', resolve_tick: tick }))
    // The charge itself was already paid at booking time (book-freight
    // credits the ship immediately) — nothing to record here on time.
    if (isLate) {
      effects.push(txnEffect({
        campaign_id, player_id, ship_id: id, tick, type: 'freight_penalty',
        total_cr: net - lot.charge, world_hex, sector,
        notes: `Late delivery penalty: ${penaltyPct}%`,
      }))
    }
  }

  // Freight was already paid at booking time; a late penalty claws back the
  // difference here instead of paying again.
  const clawback = lots.reduce((s, l) => s + l.charge, 0) - netTotal
  if (clawback > 0) {
    effects.push(add('ships', id, 'credits', -clawback))
  }

  ctx.apply(effects)
  return ok({ ok: true, lots: deliveredLots, clawback })
})

// ── POST /api/ships/:id/refund-freight — atomic: obligation + transaction + credits ──
route('POST', '/api/ships/:id/refund-freight', 'auth', (ctx) => {
  const { id } = ctx.params
  const { obligation_id, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const o = byId(ctx.state(), 'obligations', obligation_id)
  if (!o || o.campaign_id !== campaign_id || o.kind !== 'freight') throw new ApiError(404, 'Freight contract not found')
  const obligation = freightView(o)

  ctx.apply([
    set('obligations', obligation_id, { status: 'cancelled', resolve_tick: tick }),
    txnEffect({
      campaign_id, player_id, ship_id: id, tick, type: 'freight_refund',
      total_cr: -obligation.charge,
      world_hex: obligation.origin_world_hex, sector: obligation.origin_sector,
      notes: `Refund: ${obligation.freight_tons}t ${obligation.freight_lot_size} freight`,
    }),
    add('ships', id, 'credits', -obligation.charge),
  ])

  return ok({ ok: true })
})

// ── GET /api/ships/:id/passengers — in-transit passengers (referee use) ───────
route('GET', '/api/ships/:id/passengers', 'auth', (ctx) => {
  const { campaign_id } = ctx.query
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  return ok(
    obligationsFor(ctx.state(), {
      kind: 'passenger', shipId: ctx.params.id, campaignId: campaign_id, status: 'pending',
    }).map(passengerView),
  )
})

// ── POST /api/ships/:id/pay-debt — atomic: credits + debt balance + payment row ─
route('POST', '/api/ships/:id/pay-debt', 'auth', (ctx) => {
  const { id } = ctx.params
  const { debt_id, amount, tick, campaign_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (!(amount > 0)) throw new ApiError(400, 'Payment amount must be positive')

  const state = ctx.state()
  const ship  = byId(state, 'ships', id)
  if (!ship || ship.campaign_id !== campaign_id) throw new ApiError(404, 'Ship not found')

  const debt = byId(state, 'ship_debts', debt_id)
  if (!debt || debt.ship_id !== id) throw new ApiError(404, 'Debt not found')

  if (amount > ship.credits)         throw new ApiError(400, 'Insufficient credits')
  if (amount > debt.current_balance) throw new ApiError(400, 'Payment exceeds remaining balance')

  const paymentId = uuid()
  ctx.apply([
    add('ships', id, 'credits', -amount),
    add('ship_debts', debt_id, 'current_balance', -amount),
    put('debt_payments', paymentId, {
      id: paymentId, debt_id, campaign_id, ship_id: id, tick, amount,
      notes: null, created_at: nowISO(),
    }),
  ])

  return ok({
    ok: true,
    debt: { ...debt, current_balance: debt.current_balance - amount },
    credits: ship.credits - amount,
  })
})
