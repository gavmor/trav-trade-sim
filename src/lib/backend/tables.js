// Shared read helpers over the materialized campaign document — the moral
// equivalent of the Worker's SELECT statements and column aliases.

export const uuid   = () => crypto.randomUUID()
export const nowISO = () => new Date().toISOString()

export function rows(state, table) {
  return Object.values(state.tables[table] ?? {})
}

export function byId(state, table, id) {
  return state.tables[table]?.[id] ?? null
}

export function sortBy(list, key, dir = 1) {
  return [...list].sort((a, b) => {
    const x = a[key], y = b[key]
    if (x === y) return 0
    if (x == null) return -dir
    if (y == null) return dir
    return (x < y ? -1 : 1) * dir
  })
}

// ── Obligation views ─────────────────────────────────────────────────────────
// obligations rows aliased back to the passenger_manifests / mail_contracts /
// freight shapes the frontend expects — mirrors PASSENGER_SELECT, MAIL_SELECT
// and FREIGHT_SELECT in the retired Worker routes.

export function passengerView(o) {
  return {
    id: o.id, campaign_id: o.campaign_id, ship_id: o.ship_id, player_id: o.player_id,
    passage_type: o.passage_type,
    count: o.passenger_count,
    embark_world_hex: o.origin_world_hex, embark_sector: o.origin_sector,
    embark_world_name: o.origin_world_name, embark_tick: o.accept_tick,
    dest_world_hex: o.dest_world_hex, dest_sector: o.dest_sector, dest_world_name: o.dest_world_name,
    fare_per_head: o.fare_per_head, fare_total: o.amount,
    status: o.status, resolve_tick: o.resolve_tick ?? null, created_at: o.created_at,
  }
}

export function mailView(o) {
  return {
    id: o.id, campaign_id: o.campaign_id, ship_id: o.ship_id, player_id: o.player_id,
    origin_world_hex: o.origin_world_hex, origin_sector: o.origin_sector,
    origin_world_name: o.origin_world_name, accept_tick: o.accept_tick,
    dest_world_hex: o.dest_world_hex, dest_sector: o.dest_sector, dest_world_name: o.dest_world_name,
    parsecs: o.parsecs, payment: o.amount,
    status: o.status, resolve_tick: o.resolve_tick ?? null, created_at: o.created_at,
  }
}

export function freightView(o) {
  return {
    id: o.id, campaign_id: o.campaign_id, ship_id: o.ship_id, player_id: o.player_id,
    origin_world_hex: o.origin_world_hex, origin_sector: o.origin_sector,
    origin_world_name: o.origin_world_name, accept_tick: o.accept_tick,
    dest_world_hex: o.dest_world_hex, dest_sector: o.dest_sector, dest_world_name: o.dest_world_name,
    parsecs: o.parsecs, freight_tons: o.freight_tons, freight_lot_size: o.freight_lot_size,
    rate_per_ton: o.rate_per_ton, due_tick: o.due_tick ?? null,
    charge: o.amount,
    status: o.status, resolve_tick: o.resolve_tick ?? null, created_at: o.created_at,
  }
}

export function obligationsFor(state, { kind, shipId, campaignId, status }) {
  return sortBy(
    rows(state, 'obligations').filter(o =>
      o.kind === kind &&
      (shipId === undefined || o.ship_id === shipId) &&
      (campaignId === undefined || o.campaign_id === campaignId) &&
      (status === undefined || o.status === status)
    ),
    'created_at',
  )
}
