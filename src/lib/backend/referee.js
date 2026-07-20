// Referee tooling — fleet management, templates, debts, ownership, crew,
// players, skills, refunds, auto-delivery. Ported from routes/referee.js.

import { route, ApiError, ok, created } from './router.js'
import { put, set, del, add } from '../crdt/doc.js'
import { uuid, nowISO, rows, byId, sortBy, passengerView, mailView } from './tables.js'

// Skills use a deterministic composite id so an upsert is a plain `put` —
// same trick as market snapshot keys (mirrors the old ON CONFLICT clause).
const skillId = (playerId, skill) => `${playerId}|${skill}`

function crewWithPlayer(state, c) {
  const p = byId(state, 'players', c.player_id)
  return {
    id: c.id, ship_id: c.ship_id, role: c.role,
    can_trade: c.can_trade === 1, has_stateroom: c.has_stateroom === 1,
    joined_tick: c.joined_tick,
    players: p ? { id: p.id, character_name: p.character_name, role: p.role } : null,
  }
}

// ── GET /api/referee/ships — ships with embedded active crew ──────────────────
route('GET', '/api/referee/ships', 'referee', (ctx) => {
  const state      = ctx.state()
  const campaignId = ctx.session.campaign_id

  const activeCrew = rows(state, 'crew').filter(c => c.campaign_id === campaignId && c.left_tick == null)
  const ships = sortBy(rows(state, 'ships').filter(s => s.campaign_id === campaignId), 'name')
    .map(s => ({
      ...s,
      crew: activeCrew.filter(c => c.ship_id === s.id).map(c => crewWithPlayer(state, c)),
    }))

  return ok(ships)
})

// ── POST /api/referee/ships — create ship (no crew assignment) ────────────────
route('POST', '/api/referee/ships', 'referee', (ctx) => {
  const b = ctx.body
  const shipId = uuid()
  const ship = {
    id: shipId, campaign_id: ctx.session.campaign_id,
    name: b.name.trim(), hull_type: b.hull_type || null,
    hull_tons: b.hull_tons ?? 200, cargo_capacity: b.cargo_capacity ?? 80,
    current_world: null, current_sector: null,
    credits: b.credits ?? 0,
    jump_rating: b.jump_rating || null, maneuver_drive_rating: b.maneuver_drive_rating || null,
    stateroom_capacity: b.stateroom_capacity ?? 0, low_berth_capacity: b.low_berth_capacity ?? 0,
    fuel_capacity: b.fuel_capacity ?? 0, fuel_current: b.fuel_current ?? 0,
    market_value: b.market_value ?? 0,
    created_at: nowISO(),
  }
  ctx.apply([put('ships', shipId, ship)])
  return created({ ...ship, crew: [] })
})

// ── PATCH /api/referee/ships/:id — update ship ────────────────────────────────
route('PATCH', '/api/referee/ships/:id', 'referee', (ctx) => {
  const ship = byId(ctx.state(), 'ships', ctx.params.id)
  if (!ship)                                            throw new ApiError(404, 'Ship not found')
  if (ship.campaign_id !== ctx.session.campaign_id)     throw new ApiError(403, 'Forbidden')

  const allowed = ['name', 'hull_type', 'hull_tons', 'cargo_capacity', 'credits',
                   'current_world', 'current_sector', 'jump_rating', 'maneuver_drive_rating',
                   'stateroom_capacity', 'low_berth_capacity', 'fuel_capacity', 'fuel_current',
                   'market_value']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields')

  ctx.apply([set('ships', ship.id, fields)])
  return ok({ ...ship, ...fields })
})

// ── GET /api/referee/ship-templates — templates for this campaign's ruleset ───
// Lazily seeds one starter template (Type A Free Trader) the first time a
// CT7 or MgT2022 campaign has none — same "generate on first access" pattern
// used for market snapshots/events.
route('GET', '/api/referee/ship-templates', 'referee', (ctx) => {
  const state      = ctx.state()
  const campaignId = ctx.session.campaign_id
  const campaign   = byId(state, 'campaigns', campaignId)
  if (!campaign) throw new ApiError(404, 'Campaign not found')

  const list = () => sortBy(
    rows(ctx.state(), 'ship_templates').filter(
      t => t.campaign_id === campaignId && t.trade_rules === campaign.trade_rules,
    ),
    'name',
  )

  const existing = list()
  if (existing.length === 0 && (campaign.trade_rules === 'CT7' || campaign.trade_rules === 'MgT2022')) {
    const notes = campaign.trade_rules === 'CT7'
      ? 'Standard CT Book 2 reference design — verify against your own copy before relying on these numbers.'
      : 'Standard MgT2022 Core Rulebook reference design — verify against your own copy before relying on these numbers.'
    const id = uuid()
    ctx.apply([put('ship_templates', id, {
      id, campaign_id: campaignId, trade_rules: campaign.trade_rules,
      name: 'Type A Free Trader', hull_type: 'Free Trader',
      hull_tons: 200, cargo_capacity: 82, jump_rating: 1, maneuver_drive_rating: 1,
      stateroom_capacity: 6, low_berth_capacity: 20, fuel_capacity: 30,
      market_value: 37680000, notes, created_at: nowISO(),
    })])
    return ok(list())
  }

  return ok(existing)
})

// ── POST /api/referee/ship-templates — create a custom template ──────────────
route('POST', '/api/referee/ship-templates', 'referee', (ctx) => {
  const state      = ctx.state()
  const campaignId = ctx.session.campaign_id
  const campaign   = byId(state, 'campaigns', campaignId)
  if (!campaign) throw new ApiError(404, 'Campaign not found')

  const b = ctx.body
  const taken = rows(state, 'ship_templates').find(
    t => t.campaign_id === campaignId && t.name === b.name.trim(),
  )
  if (taken) throw new ApiError(409, 'A template with this name already exists')

  const id = uuid()
  const template = {
    id, campaign_id: campaignId, trade_rules: campaign.trade_rules,
    name: b.name.trim(), hull_type: b.hull_type || null,
    hull_tons: b.hull_tons ?? 200, cargo_capacity: b.cargo_capacity ?? 80,
    jump_rating: b.jump_rating || null, maneuver_drive_rating: b.maneuver_drive_rating || null,
    stateroom_capacity: b.stateroom_capacity ?? 0, low_berth_capacity: b.low_berth_capacity ?? 0,
    fuel_capacity: b.fuel_capacity ?? 0, market_value: b.market_value ?? 0,
    notes: b.notes || null, created_at: nowISO(),
  }
  ctx.apply([put('ship_templates', id, template)])
  return created(template)
})

// ── PATCH /api/referee/ship-templates/:id — edit a template ───────────────────
route('PATCH', '/api/referee/ship-templates/:id', 'referee', (ctx) => {
  const state    = ctx.state()
  const template = byId(state, 'ship_templates', ctx.params.id)
  if (!template)                                        throw new ApiError(404, 'Template not found')
  if (template.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  if (ctx.body.name) {
    const taken = rows(state, 'ship_templates').find(
      t => t.campaign_id === ctx.session.campaign_id && t.name === ctx.body.name.trim() && t.id !== template.id,
    )
    if (taken) throw new ApiError(409, 'A template with this name already exists')
  }

  const allowed = ['name', 'hull_type', 'hull_tons', 'cargo_capacity', 'jump_rating',
                   'maneuver_drive_rating', 'stateroom_capacity', 'low_berth_capacity',
                   'fuel_capacity', 'market_value', 'notes']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields')

  ctx.apply([set('ship_templates', template.id, fields)])
  return ok({ ...template, ...fields })
})

// ── DELETE /api/referee/ship-templates/:id ────────────────────────────────────
route('DELETE', '/api/referee/ship-templates/:id', 'referee', (ctx) => {
  const template = byId(ctx.state(), 'ship_templates', ctx.params.id)
  if (!template)                                        throw new ApiError(404, 'Template not found')
  if (template.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  ctx.apply([del('ship_templates', template.id)])
  return ok({ ok: true })
})

// ── GET /api/referee/ship-debts — list a ship's debts ─────────────────────────
route('GET', '/api/referee/ship-debts', 'referee', (ctx) => {
  return ok(sortBy(
    rows(ctx.state(), 'ship_debts').filter(
      d => d.campaign_id === ctx.session.campaign_id && d.ship_id === ctx.query.ship_id,
    ),
    'created_at',
  ))
})

// ── POST /api/referee/ship-debts — create a debt ──────────────────────────────
route('POST', '/api/referee/ship-debts', 'referee', (ctx) => {
  const b = ctx.body
  const id = uuid()
  const debt = {
    id, campaign_id: ctx.session.campaign_id, ship_id: b.ship_id,
    type: b.type, creditor_name: b.creditor_name || null,
    principal: b.principal, current_balance: b.current_balance ?? b.principal,
    due_tick: b.due_tick ?? null, notes: b.notes || null,
    created_at: nowISO(),
  }
  ctx.apply([put('ship_debts', id, debt)])
  return created(debt)
})

// ── PATCH /api/referee/ship-debts/:id — edit a debt ───────────────────────────
route('PATCH', '/api/referee/ship-debts/:id', 'referee', (ctx) => {
  const debt = byId(ctx.state(), 'ship_debts', ctx.params.id)
  if (!debt)                                        throw new ApiError(404, 'Debt not found')
  if (debt.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const allowed = ['type', 'creditor_name', 'principal', 'current_balance', 'due_tick', 'notes']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields')

  ctx.apply([set('ship_debts', debt.id, fields)])
  return ok({ ...debt, ...fields })
})

// ── DELETE /api/referee/ship-debts/:id ─────────────────────────────────────────
route('DELETE', '/api/referee/ship-debts/:id', 'referee', (ctx) => {
  const debt = byId(ctx.state(), 'ship_debts', ctx.params.id)
  if (!debt)                                        throw new ApiError(404, 'Debt not found')
  if (debt.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  ctx.apply([del('ship_debts', debt.id)])
  return ok({ ok: true })
})

// ── GET /api/referee/ship-ownership — list a ship's ownership shares ──────────
route('GET', '/api/referee/ship-ownership', 'referee', (ctx) => {
  const state = ctx.state()
  return ok(
    rows(state, 'ship_ownership')
      .filter(o => o.ship_id === ctx.query.ship_id)
      .sort((a, b) => b.percentage - a.percentage)
      .map(o => ({ ...o, character_name: byId(state, 'players', o.player_id)?.character_name ?? '' })),
  )
})

// ── POST /api/referee/ship-ownership — add an owner ────────────────────────────
route('POST', '/api/referee/ship-ownership', 'referee', (ctx) => {
  const state = ctx.state()
  const { ship_id, player_id, percentage } = ctx.body

  const ship = byId(state, 'ships', ship_id)
  if (!ship)                                        throw new ApiError(404, 'Ship not found')
  if (ship.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const existingTotal = rows(state, 'ship_ownership')
    .filter(o => o.ship_id === ship_id)
    .reduce((s, r) => s + r.percentage, 0)
  if (existingTotal + percentage > 100) {
    throw new ApiError(409, `Ownership shares can't exceed 100% (currently ${existingTotal}%)`)
  }

  const id = uuid()
  const share = {
    id, campaign_id: ctx.session.campaign_id, ship_id, player_id, percentage,
    created_at: nowISO(),
  }
  ctx.apply([put('ship_ownership', id, share)])
  return created({ ...share, character_name: byId(state, 'players', player_id)?.character_name ?? '' })
})

// ── PATCH /api/referee/ship-ownership/:id — edit a share ───────────────────────
route('PATCH', '/api/referee/ship-ownership/:id', 'referee', (ctx) => {
  const state = ctx.state()
  const share = byId(state, 'ship_ownership', ctx.params.id)
  if (!share)                                        throw new ApiError(404, 'Ownership share not found')
  if (share.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const { percentage } = ctx.body
  const existingTotal = rows(state, 'ship_ownership')
    .filter(o => o.ship_id === share.ship_id && o.id !== share.id)
    .reduce((s, r) => s + r.percentage, 0)
  if (existingTotal + percentage > 100) {
    throw new ApiError(409, `Ownership shares can't exceed 100% (other shares total ${existingTotal}%)`)
  }

  ctx.apply([set('ship_ownership', share.id, { percentage })])
  return ok({
    ...share, percentage,
    character_name: byId(state, 'players', share.player_id)?.character_name ?? '',
  })
})

// ── DELETE /api/referee/ship-ownership/:id ─────────────────────────────────────
route('DELETE', '/api/referee/ship-ownership/:id', 'referee', (ctx) => {
  const share = byId(ctx.state(), 'ship_ownership', ctx.params.id)
  if (!share)                                        throw new ApiError(404, 'Ownership share not found')
  if (share.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  ctx.apply([del('ship_ownership', share.id)])
  return ok({ ok: true })
})

// ── POST /api/referee/crew — assign crew member ───────────────────────────────
route('POST', '/api/referee/crew', 'referee', (ctx) => {
  const { ship_id, player_id, role, current_tick } = ctx.body

  const crewId = uuid()
  const crewRow = {
    id: crewId, campaign_id: ctx.session.campaign_id, ship_id, player_id,
    role, can_trade: role === 'captain' ? 1 : 0, has_stateroom: 1,
    joined_tick: current_tick ?? 0, left_tick: null,
  }
  ctx.apply([put('crew', crewId, crewRow)])
  return created(crewWithPlayer(ctx.state(), crewRow))
})

// ── PATCH /api/referee/crew/:id — update crew row (role, can_trade, left_tick) ─
route('PATCH', '/api/referee/crew/:id', 'referee', (ctx) => {
  const allowed = ['role', 'can_trade', 'has_stateroom', 'left_tick']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields')

  ctx.apply([set('crew', ctx.params.id, fields)])
  return ok({ ok: true })
})

// ── GET /api/referee/players — players with skills + ship name ────────────────
route('GET', '/api/referee/players', 'referee', (ctx) => {
  const state      = ctx.state()
  const campaignId = ctx.session.campaign_id

  const activeCrew = rows(state, 'crew').filter(c => c.campaign_id === campaignId && c.left_tick == null)
  const crewMap = Object.fromEntries(
    activeCrew.map(c => [c.player_id, byId(state, 'ships', c.ship_id)?.name ?? '']),
  )

  const skillMap = {}
  for (const s of rows(state, 'player_skills').filter(s => s.campaign_id === campaignId)) {
    ;(skillMap[s.player_id] ??= []).push({ id: s.id, player_id: s.player_id, skill: s.skill, level: s.level })
  }

  const players = sortBy(
    rows(state, 'players').filter(p => p.campaign_id === campaignId),
    'character_name',
  ).map(p => ({
    id: p.id, character_name: p.character_name, role: p.role, credits: p.credits ?? 0,
    current_ship: crewMap[p.id] ?? '',
    skills: skillMap[p.id] ?? [],
  }))

  return ok(players)
})

// ── POST /api/referee/skills — upsert a skill ─────────────────────────────────
route('POST', '/api/referee/skills', 'referee', (ctx) => {
  const { player_id, skill, level } = ctx.body
  const id = skillId(player_id, skill.trim())

  ctx.apply([put('player_skills', id, {
    id, campaign_id: ctx.session.campaign_id, player_id,
    skill: skill.trim(), level, created_at: nowISO(),
  })])

  return ok({ id, skill: skill.trim(), level })
})

// ── DELETE /api/referee/skills/:id ────────────────────────────────────────────
route('DELETE', '/api/referee/skills/:id', 'referee', (ctx) => {
  ctx.apply([del('player_skills', ctx.params.id)])
  return ok({ ok: true })
})

// ── POST /api/referee/ships/:id/refund-passenger — referee-side refund ────────
route('POST', '/api/referee/ships/:id/refund-passenger', 'referee', (ctx) => {
  const { id } = ctx.params
  const { manifest_id, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const o = byId(ctx.state(), 'obligations', manifest_id)
  if (!o || o.kind !== 'passenger') throw new ApiError(404, 'Manifest not found')
  const manifest = passengerView(o)

  ctx.apply([
    set('obligations', manifest_id, { status: 'cancelled', resolve_tick: tick }),
    put('transactions', uuid(), {
      id: uuid(), campaign_id, player_id, ship_id: id, tick, type: 'passenger_refund',
      total_cr: -manifest.fare_total,
      world_hex: manifest.embark_world_hex, sector: manifest.embark_sector,
      notes: `Refund: ${manifest.count}× ${manifest.passage_type}`,
      created_at: nowISO(),
    }),
    add('ships', id, 'credits', -manifest.fare_total),
  ])

  return ok({ ok: true })
})

// ── POST /api/referee/ships/:id/auto-deliver — deliver passengers + mail on world change ──
route('POST', '/api/referee/ships/:id/auto-deliver', 'referee', (ctx) => {
  const { id } = ctx.params
  const { world_hex, sector, tick, campaign_id, player_id } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')

  const state = ctx.state()
  const pendingHere = (kind) => rows(state, 'obligations').filter(
    o => o.kind === kind && o.ship_id === id && o.campaign_id === campaign_id &&
         o.status === 'pending' && o.dest_world_hex === world_hex && o.dest_sector === sector,
  )

  const passengers = pendingHere('passenger').map(passengerView)
  const mail       = pendingHere('mail').map(mailView)

  if (!passengers.length && !mail.length) return ok({ ok: true })

  const effects = [
    ...passengers.map(p => set('obligations', p.id, { status: 'fulfilled', resolve_tick: tick })),
    ...passengers.map(p => put('transactions', uuid(), {
      id: uuid(), campaign_id, player_id: p.player_id, ship_id: id, tick,
      type: 'passenger_fare', total_cr: 0, world_hex, sector,
      notes: `Delivered: ${p.count}× ${p.passage_type} from ${p.embark_world_name || p.embark_world_hex}`,
      created_at: nowISO(),
    })),
    ...mail.map(m => set('obligations', m.id, { status: 'fulfilled', resolve_tick: tick })),
    ...mail.map(m => put('transactions', uuid(), {
      id: uuid(), campaign_id, player_id, ship_id: id, tick,
      type: 'mail', total_cr: m.payment, world_hex, sector,
      notes: `Mail delivered from ${m.origin_world_name || m.origin_world_hex}`,
      created_at: nowISO(),
    })),
  ]

  const totalMailPayment = mail.reduce((s, m) => s + m.payment, 0)
  if (totalMailPayment > 0) {
    effects.push(add('ships', id, 'credits', totalMailPayment))
  }

  ctx.apply(effects)
  return ok({ ok: true, passengers_delivered: passengers.length, mail_delivered: mail.length })
})
