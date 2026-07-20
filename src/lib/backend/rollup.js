// Monthly/annual OHLC rollups — ported from the Worker's lib/rollup.js.
// Instead of SQL upserts, these return CRDT effects. Rollup rows use a
// deterministic composite-key id, so a `put` is a natural upsert: any two
// peers that roll up the same boundary write the same row id and converge.

import { put, del } from '../crdt/doc.js'
import { rows } from './tables.js'

export function tickYear(tick)  { return 1105 + Math.floor(tick / 48) }
export function tickMonth(tick) { return Math.floor(tick / 4) % 12 + 1 }
export function tickDay(tick)   { return (tick % 48) * 7 + 1 }

const monthlyId = (g, year, month) => `${g.world_hex}|${g.sector}|${g.trade_good_die}|${year}|${month}`
const annualId  = (g, year)        => `${g.world_hex}|${g.sector}|${g.trade_good_die}|${year}`

function groupByGood(list) {
  const groups = new Map()
  for (const row of list) {
    const key = `${row.world_hex}|${row.sector}|${row.trade_good_die}`
    if (!groups.has(key)) {
      groups.set(key, { world_hex: row.world_hex, sector: row.sector, trade_good_die: row.trade_good_die, rows: [] })
    }
    groups.get(key).rows.push(row)
  }
  return groups
}

export function rollupMonthEffects(state, campaignId, year, month) {
  const tickMin = (year - 1105) * 48 + (month - 1) * 4
  const tickMax = tickMin + 3

  const snapshots = rows(state, 'market_snapshots').filter(
    r => r.campaign_id === campaignId && r.tick >= tickMin && r.tick <= tickMax,
  )
  if (!snapshots.length) return []

  const effects = []
  for (const g of groupByGood(snapshots).values()) {
    const sorted = g.rows.sort((a, b) => a.tick - b.tick)
    const id = monthlyId(g, year, month)
    effects.push(put('market_monthly', id, {
      id, campaign_id: campaignId,
      world_hex: g.world_hex, sector: g.sector, trade_good_die: g.trade_good_die,
      year, month,
      open_price:  sorted[0].purchase_price,
      close_price: sorted[sorted.length - 1].purchase_price,
      high_price:  Math.max(...sorted.map(r => r.purchase_price)),
      low_price:   Math.min(...sorted.map(r => r.purchase_price)),
      volume_tons: sorted.reduce((s, r) => s + r.qty_available, 0),
    }))
  }
  return effects
}

export function rollupYearEffects(state, campaignId, year) {
  const monthly = rows(state, 'market_monthly').filter(
    r => r.campaign_id === campaignId && r.year === year,
  )

  const effects = []
  for (const g of groupByGood(monthly).values()) {
    const sorted = g.rows.sort((a, b) => a.month - b.month)
    const id = annualId(g, year)
    effects.push(put('market_annual', id, {
      id, campaign_id: campaignId,
      world_hex: g.world_hex, sector: g.sector, trade_good_die: g.trade_good_die,
      year,
      open_price:  sorted[0].open_price,
      close_price: sorted[sorted.length - 1].close_price,
      high_price:  Math.max(...sorted.map(r => r.high_price)),
      low_price:   Math.min(...sorted.map(r => r.low_price)),
      volume_tons: sorted.reduce((s, r) => s + r.volume_tons, 0),
    }))
  }

  // Event compaction: delete expired events older than (year - 1).
  const cutoff = (year - 1 - 1105) * 48
  for (const ev of rows(state, 'market_events')) {
    if (ev.campaign_id === campaignId && ev.expires_tick != null && ev.expires_tick < cutoff) {
      effects.push(del('market_events', ev.id))
    }
  }

  return effects
}

// Re-runs monthly/annual rollup for a boundary tick that was possibly rolled
// up against incomplete data (e.g. a world's weekly snapshots were backfilled
// after the boundary already passed). Safe to repeat — composite-key puts
// are upserts.
export function repairRollupEffects(state, campaignId, tick) {
  const effects = []
  if (tick > 0 && tick % 4 === 0) {
    effects.push(...rollupMonthEffects(state, campaignId, tickYear(tick - 4), tickMonth(tick - 4)))
  }
  if (tick > 0 && tick % 48 === 0) {
    effects.push(...rollupYearEffects(state, campaignId, tickYear(tick - 48)))
  }
  return effects
}
