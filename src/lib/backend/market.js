// Market data — events, snapshots, price history, traffic. Ported from the
// Worker's routes/market.js. Snapshot and traffic rows use deterministic
// composite-key ids with `init` effects, reproducing the old INSERT OR
// IGNORE + UNIQUE-constraint semantics: two peers generating the same
// (deterministically seeded) tick data converge on one copy.

import { route, ApiError, ok, created } from './router.js'
import { put, init, set } from '../crdt/doc.js'
import { uuid, nowISO, rows, sortBy } from './tables.js'
import { tickYear, tickMonth } from './rollup.js'

const snapshotKey = (r) => `${r.world_hex}|${r.sector}|${r.trade_good_die}|${r.tick}`
const trafficKey  = (r) => `${r.world_hex}|${r.sector}|${r.tick}`

function requireCampaign(ctx) {
  if (ctx.session.campaign_id !== ctx.params.id) throw new ApiError(403, 'Forbidden')
  return ctx.params.id
}

// ── GET /api/campaigns/:id/events ─────────────────────────────────────────────
// ?active=true   — only events where expires_tick IS NULL OR expires_tick > currentTick
// ?world_hex=X&sector=Y — world-specific + subsector events (for history panel)
route('GET', '/api/campaigns/:id/events', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { active, world_hex, sector, current_tick } = ctx.query

  let events = rows(ctx.state(), 'market_events').filter(e => e.campaign_id === id)

  if (active === 'true' && current_tick != null) {
    const t = Number(current_tick)
    events = events.filter(e => e.expires_tick == null || e.expires_tick > t)
  }

  if (world_hex && sector) {
    events = events.filter(e => e.sector === sector && (e.world_hex === world_hex || e.scope === 'subsector'))
  }

  return ok(sortBy(events, 'tick', -1).slice(0, 200))
})

// ── POST /api/campaigns/:id/events ────────────────────────────────────────────
route('POST', '/api/campaigns/:id/events', 'auth', (ctx) => {
  const id   = requireCampaign(ctx)
  const body = ctx.body

  // Duplicate check: used by maybeInsertEvent (tick, world_hex, campaign)
  if (body.check_duplicate) {
    const count = rows(ctx.state(), 'market_events').filter(
      e => e.campaign_id === id && e.tick === body.tick && (e.world_hex ?? '') === (body.world_hex ?? ''),
    ).length
    return ok({ count })
  }

  const eventId = uuid()
  const row = {
    id: eventId, campaign_id: id, tick: body.tick,
    scope: body.scope ?? 'local',
    world_hex: body.world_hex ?? null, sector: body.sector ?? null,
    trade_good_die: body.trade_good_die ?? null,
    buy_modifier_pct: body.buy_modifier_pct ?? null,
    sell_modifier_pct: body.sell_modifier_pct ?? null,
    description: body.description,
    expires_tick: body.expires_tick ?? null,
    severity: body.severity ?? 'minor',
    created_at: nowISO(),
  }
  ctx.apply([put('market_events', eventId, row)])
  return created(row)
})

// ── PATCH /api/campaigns/event/:eventId/expire (referee only) ─────────────────
route('PATCH', '/api/campaigns/event/:eventId/expire', 'referee', (ctx) => {
  ctx.apply([set('market_events', ctx.params.eventId, { expires_tick: ctx.body.current_tick })])
  return ok({ ok: true })
})

// ── GET /api/campaigns/:id/snapshots ──────────────────────────────────────────
// ?world_hex=X&sector=Y&tick=N&count=true
route('GET', '/api/campaigns/:id/snapshots', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, tick, count } = ctx.query

  const matches = rows(ctx.state(), 'market_snapshots').filter(
    r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector && r.tick === Number(tick),
  )

  if (count === 'true') return ok({ count: matches.length })

  return ok(sortBy(matches, 'trade_good_die'))
})

// ── GET /api/campaigns/:id/snapshots/last-tick ────────────────────────────────
route('GET', '/api/campaigns/:id/snapshots/last-tick', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector } = ctx.query

  const ticks = rows(ctx.state(), 'market_snapshots')
    .filter(r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector)
    .map(r => r.tick)

  return ok({ lastTick: ticks.length ? Math.max(...ticks) : null })
})

// ── POST /api/campaigns/:id/snapshots — batch insert ─────────────────────────
route('POST', '/api/campaigns/:id/snapshots', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { rows: newRows } = ctx.body
  if (!Array.isArray(newRows) || !newRows.length) throw new ApiError(400, 'rows array required')

  ctx.apply(newRows.map(r => {
    const key = snapshotKey(r)
    return init('market_snapshots', key, {
      id: r.id ?? uuid(), campaign_id: r.campaign_id,
      world_hex: r.world_hex, sector: r.sector,
      trade_good_die: r.trade_good_die, trade_good_name: r.trade_good_name,
      tick: r.tick, purchase_price: r.purchase_price, sale_price: r.sale_price,
      qty_available: r.qty_available, source_codes: r.source_codes ?? '',
      created_at: nowISO(),
    })
  }))

  return created({ count: newRows.length })
})

// ── GET /api/campaigns/:id/market/weekly ──────────────────────────────────────
route('GET', '/api/campaigns/:id/market/weekly', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, good_die, limit = '52' } = ctx.query

  const matches = rows(ctx.state(), 'market_snapshots').filter(
    r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector && r.trade_good_die === good_die,
  )

  return ok(
    sortBy(matches, 'tick', -1)
      .slice(0, Number(limit))
      .reverse()
      .map(r => ({ tick: r.tick, purchase_price: r.purchase_price, sale_price: r.sale_price, qty_available: r.qty_available })),
  )
})

// ── GET /api/campaigns/:id/market/monthly ─────────────────────────────────────
route('GET', '/api/campaigns/:id/market/monthly', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, good_die, limit = '24' } = ctx.query

  const matches = rows(ctx.state(), 'market_monthly').filter(
    r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector && r.trade_good_die === good_die,
  )

  return ok(
    matches
      .sort((a, b) => (b.year - a.year) || (b.month - a.month))
      .slice(0, Number(limit))
      .reverse()
      .map(r => ({
        year: r.year, month: r.month,
        open_price: r.open_price, high_price: r.high_price,
        low_price: r.low_price, close_price: r.close_price,
        volume_tons: r.volume_tons,
      })),
  )
})

// ── GET /api/campaigns/:id/market/realized ────────────────────────────────────
// Replaces the D1 realized_ohlcv view: OHLCV computed from actual trades.
route('GET', '/api/campaigns/:id/market/realized', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, good_die } = ctx.query

  const trades = rows(ctx.state(), 'trade_records')
    .filter(r =>
      r.campaign_id === id && r.market_world_hex === world_hex &&
      r.market_sector === sector && r.trade_good_die === good_die)
    .sort((a, b) => a.sell_tick - b.sell_tick)

  const buckets = new Map()
  for (const t of trades) {
    const year  = tickYear(t.sell_tick)
    const month = tickMonth(t.sell_tick)
    const key   = `${year}|${month}`
    if (!buckets.has(key)) {
      buckets.set(key, {
        year, month,
        open_price: t.sell_price_per_ton, high_price: t.sell_price_per_ton,
        low_price: t.sell_price_per_ton, close_price: t.sell_price_per_ton,
        volume_tons: 0, trade_count: 0,
      })
    }
    const b = buckets.get(key)
    b.high_price  = Math.max(b.high_price, t.sell_price_per_ton)
    b.low_price   = Math.min(b.low_price, t.sell_price_per_ton)
    b.close_price = t.sell_price_per_ton
    b.volume_tons += t.tons
    b.trade_count += 1
  }

  return ok([...buckets.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month)))
})

// ── GET /api/campaigns/:id/market/annual ──────────────────────────────────────
route('GET', '/api/campaigns/:id/market/annual', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, good_die } = ctx.query

  const matches = rows(ctx.state(), 'market_annual').filter(
    r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector && r.trade_good_die === good_die,
  )

  return ok(
    sortBy(matches, 'year').map(r => ({
      year: r.year,
      open_price: r.open_price, high_price: r.high_price,
      low_price: r.low_price, close_price: r.close_price,
      volume_tons: r.volume_tons,
    })),
  )
})

// ── GET /api/campaigns/:id/traffic — MgT2022 passenger/freight/mail scarcity ──
route('GET', '/api/campaigns/:id/traffic', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const { world_hex, sector, tick } = ctx.query

  const row = rows(ctx.state(), 'traffic_snapshots').find(
    r => r.campaign_id === id && r.world_hex === world_hex && r.sector === sector && r.tick === Number(tick),
  )

  return ok(row ?? {
    high_passages: 0, middle_passages: 0, basic_passages: 0, low_passages: 0,
    major_freight_lots: 0, minor_freight_lots: 0, incidental_freight_lots: 0,
    mail_containers: 0,
  })
})

// ── POST /api/campaigns/:id/traffic — insert one tick's traffic snapshot ─────
route('POST', '/api/campaigns/:id/traffic', 'auth', (ctx) => {
  const id = requireCampaign(ctx)
  const r  = ctx.body
  const key = trafficKey(r)

  ctx.apply([init('traffic_snapshots', key, {
    id: key, campaign_id: id,
    world_hex: r.world_hex, sector: r.sector, tick: r.tick,
    high_passages: r.high_passages, middle_passages: r.middle_passages,
    basic_passages: r.basic_passages, low_passages: r.low_passages,
    major_freight_lots: r.major_freight_lots, minor_freight_lots: r.minor_freight_lots,
    incidental_freight_lots: r.incidental_freight_lots, mail_containers: r.mail_containers,
    created_at: nowISO(),
  })])

  return created({ ok: true })
})
