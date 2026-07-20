// Organizations (corporations / confederations / trade unions) — officers,
// members, equity, dues, disbursements, fleet report.
// Ported from the Worker's routes/organizations.js.

import { route, ApiError, ok, created } from './router.js'
import { put, set, del, add } from '../crdt/doc.js'
import { uuid, nowISO, rows, byId, sortBy } from './tables.js'

// True if the caller is this campaign's referee, or an officer of the org.
function isOfficerOrReferee(state, session, orgId) {
  if (session.role === 'referee') return true
  return rows(state, 'organization_officers').some(
    o => o.organization_id === orgId && o.player_id === session.player_id,
  )
}

function orgOr404(ctx, orgId) {
  const org = byId(ctx.state(), 'organizations', orgId)
  if (!org)                                        throw new ApiError(404, 'Organization not found')
  if (org.campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  return org
}

function requireOfficer(ctx, orgId) {
  if (!isOfficerOrReferee(ctx.state(), ctx.session, orgId)) {
    throw new ApiError(403, 'Officers only')
  }
}

function officerWithName(state, o) {
  return { ...o, character_name: byId(state, 'players', o.player_id)?.character_name ?? '' }
}

function memberWithShipName(state, m) {
  return { ...m, ship_name: byId(state, 'ships', m.ship_id)?.name ?? '' }
}

// ── GET /api/organizations/campaign-players — roster for officer picker ──────
route('GET', '/api/organizations/campaign-players', 'auth', (ctx) => {
  return ok(sortBy(
    rows(ctx.state(), 'players')
      .filter(p => p.campaign_id === ctx.session.campaign_id)
      .map(p => ({ id: p.id, character_name: p.character_name })),
    'character_name',
  ))
})

// ── GET /api/organizations — list this campaign's organizations ──────────────
route('GET', '/api/organizations', 'auth', (ctx) => {
  const state = ctx.state()
  return ok(sortBy(
    rows(state, 'organizations').filter(o => o.campaign_id === ctx.session.campaign_id),
    'name',
  ).map(o => ({
    ...o,
    is_officer: rows(state, 'organization_officers').some(
      off => off.organization_id === o.id && off.player_id === ctx.session.player_id,
    ),
  })))
})

// ── POST /api/organizations — found an organization ───────────────────────────
route('POST', '/api/organizations', 'auth', (ctx) => {
  const { name, treasury_credits, dues_rate, notes } = ctx.body
  const state = ctx.state()

  const taken = rows(state, 'organizations').find(
    o => o.campaign_id === ctx.session.campaign_id && o.name === name.trim(),
  )
  if (taken) throw new ApiError(409, 'An organization with this name already exists')

  const orgId = uuid()
  const org = {
    id: orgId, campaign_id: ctx.session.campaign_id, name: name.trim(),
    treasury_credits: treasury_credits ?? 0,
    dues_rate: dues_rate ?? null, dues_frequency_ticks: 4, last_dues_tick: null,
    notes: notes || null, created_at: nowISO(),
  }
  const officerId = uuid()

  ctx.apply([
    put('organizations', orgId, org),
    put('organization_officers', officerId, {
      id: officerId, organization_id: orgId, player_id: ctx.session.player_id,
      created_at: nowISO(),
    }),
  ])

  return created({ ...org, is_officer: true })
})

// ── PATCH /api/organizations/:id — edit an organization ───────────────────────
route('PATCH', '/api/organizations/:id', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  if (ctx.body.name) {
    const taken = rows(ctx.state(), 'organizations').find(
      o => o.campaign_id === ctx.session.campaign_id && o.name === ctx.body.name.trim() && o.id !== org.id,
    )
    if (taken) throw new ApiError(409, 'An organization with this name already exists')
  }

  const allowed = ['name', 'treasury_credits', 'dues_rate', 'dues_frequency_ticks', 'notes']
  const fields = {}
  for (const [k, v] of Object.entries(ctx.body)) {
    if (allowed.includes(k)) fields[k] = v
  }
  if (!Object.keys(fields).length) throw new ApiError(400, 'No valid fields')

  ctx.apply([set('organizations', org.id, fields)])
  return ok({ ...org, ...fields })
})

// ── DELETE /api/organizations/:id ──────────────────────────────────────────────
route('DELETE', '/api/organizations/:id', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  // CASCADE equivalent: remove dependent rows explicitly.
  const state = ctx.state()
  const effects = [del('organizations', org.id)]
  for (const table of ['organization_officers', 'organization_members', 'organization_ownership', 'dues_payments', 'disbursements']) {
    for (const row of rows(state, table)) {
      if (row.organization_id === org.id) effects.push(del(table, row.id))
    }
  }
  ctx.apply(effects)
  return ok({ ok: true })
})

// ── GET /api/organizations/:id/officers — list officers ───────────────────────
route('GET', '/api/organizations/:id/officers', 'auth', (ctx) => {
  const org   = orgOr404(ctx, ctx.params.id)
  const state = ctx.state()
  const officers = rows(state, 'organization_officers')
    .filter(o => o.organization_id === org.id)
    .map(o => officerWithName(state, o))
  return ok(sortBy(officers, 'character_name'))
})

// ── POST /api/organizations/:id/officers — add an officer ─────────────────────
route('POST', '/api/organizations/:id/officers', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { player_id } = ctx.body
  const state = ctx.state()
  const taken = rows(state, 'organization_officers').find(
    o => o.organization_id === org.id && o.player_id === player_id,
  )
  if (taken) throw new ApiError(409, 'This player is already an officer')

  const officerId = uuid()
  const officer = { id: officerId, organization_id: org.id, player_id, created_at: nowISO() }
  ctx.apply([put('organization_officers', officerId, officer)])
  return created(officerWithName(state, officer))
})

// ── DELETE /api/organizations/:id/officers/:playerId — remove an officer ─────
route('DELETE', '/api/organizations/:id/officers/:playerId', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const officers = rows(ctx.state(), 'organization_officers').filter(o => o.organization_id === org.id)
  if (officers.length <= 1) throw new ApiError(409, 'Cannot remove the last officer')

  const target = officers.find(o => o.player_id === ctx.params.playerId)
  if (target) ctx.apply([del('organization_officers', target.id)])
  return ok({ ok: true })
})

// ── GET /api/organizations/:id/members — ship members of an org ──────────────
route('GET', '/api/organizations/:id/members', 'auth', (ctx) => {
  const org   = orgOr404(ctx, ctx.params.id)
  const state = ctx.state()
  const members = rows(state, 'organization_members')
    .filter(m => m.organization_id === org.id)
    .map(m => memberWithShipName(state, m))
  return ok(sortBy(members, 'ship_name'))
})

// ── POST /api/organizations/:id/members — add a ship to the org ──────────────
route('POST', '/api/organizations/:id/members', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { ship_id, owns_ship } = ctx.body
  const state = ctx.state()

  const taken = rows(state, 'organization_members').find(
    m => m.organization_id === org.id && m.ship_id === ship_id,
  )
  if (taken) throw new ApiError(409, 'This ship is already a member of this organization')

  if (owns_ship) {
    const otherOwner = rows(state, 'organization_members').find(
      m => m.ship_id === ship_id && m.owns_ship === 1,
    )
    if (otherOwner) throw new ApiError(409, 'This ship is already owned outright by another organization')
  }

  const memberId = uuid()
  const member = {
    id: memberId, organization_id: org.id, ship_id,
    owns_ship: owns_ship ? 1 : 0, created_at: nowISO(),
  }
  ctx.apply([put('organization_members', memberId, member)])
  return created(memberWithShipName(state, member))
})

// ── DELETE /api/organizations/:id/members/:memberId — remove a ship ──────────
route('DELETE', '/api/organizations/:id/members/:memberId', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const member = byId(ctx.state(), 'organization_members', ctx.params.memberId)
  if (member && member.organization_id === org.id) {
    ctx.apply([del('organization_members', member.id)])
  }
  return ok({ ok: true })
})

// ── PATCH /api/organizations/:id/members/:memberId — toggle owns_ship ────────
route('PATCH', '/api/organizations/:id/members/:memberId', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { owns_ship } = ctx.body
  const state  = ctx.state()
  const member = byId(state, 'organization_members', ctx.params.memberId)
  if (!member || member.organization_id !== org.id) throw new ApiError(404, 'Membership not found')

  if (owns_ship) {
    const otherOwner = rows(state, 'organization_members').find(
      m => m.ship_id === member.ship_id && m.owns_ship === 1 && m.id !== member.id,
    )
    if (otherOwner) throw new ApiError(409, 'This ship is already owned outright by another organization')
  }

  ctx.apply([set('organization_members', member.id, { owns_ship: owns_ship ? 1 : 0 })])
  return ok(memberWithShipName(state, { ...member, owns_ship: owns_ship ? 1 : 0 }))
})

// ── GET /api/organizations/:id/ownership — list equity shares ────────────────
route('GET', '/api/organizations/:id/ownership', 'auth', (ctx) => {
  const org   = orgOr404(ctx, ctx.params.id)
  const state = ctx.state()
  return ok(
    rows(state, 'organization_ownership')
      .filter(o => o.organization_id === org.id)
      .sort((a, b) => b.percentage - a.percentage)
      .map(o => officerWithName(state, o)),
  )
})

// ── POST /api/organizations/:id/ownership — add an equity share ──────────────
route('POST', '/api/organizations/:id/ownership', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { player_id, percentage } = ctx.body
  const state = ctx.state()

  const existingTotal = rows(state, 'organization_ownership')
    .filter(o => o.organization_id === org.id)
    .reduce((s, r) => s + r.percentage, 0)
  if (existingTotal + percentage > 100) {
    throw new ApiError(409, `Equity shares can't exceed 100% (currently ${existingTotal}%)`)
  }

  const ownershipId = uuid()
  const share = {
    id: ownershipId, campaign_id: ctx.session.campaign_id,
    organization_id: org.id, player_id, percentage, created_at: nowISO(),
  }
  ctx.apply([put('organization_ownership', ownershipId, share)])
  return created(officerWithName(state, share))
})

// ── PATCH /api/organizations/:id/ownership/:ownershipId — edit a share ───────
route('PATCH', '/api/organizations/:id/ownership/:ownershipId', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { percentage } = ctx.body
  const state = ctx.state()
  const share = byId(state, 'organization_ownership', ctx.params.ownershipId)
  if (!share || share.organization_id !== org.id) throw new ApiError(404, 'Equity share not found')

  const existingTotal = rows(state, 'organization_ownership')
    .filter(o => o.organization_id === org.id && o.id !== share.id)
    .reduce((s, r) => s + r.percentage, 0)
  if (existingTotal + percentage > 100) {
    throw new ApiError(409, `Equity shares can't exceed 100% (other shares total ${existingTotal}%)`)
  }

  ctx.apply([set('organization_ownership', share.id, { percentage })])
  return ok(officerWithName(state, { ...share, percentage }))
})

// ── DELETE /api/organizations/:id/ownership/:ownershipId ─────────────────────
route('DELETE', '/api/organizations/:id/ownership/:ownershipId', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const share = byId(ctx.state(), 'organization_ownership', ctx.params.ownershipId)
  if (share && share.organization_id === org.id) {
    ctx.apply([del('organization_ownership', share.id)])
  }
  return ok({ ok: true })
})

// ── POST /api/organizations/:id/collect-dues — officer-triggered collection ──
route('POST', '/api/organizations/:id/collect-dues', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { tick } = ctx.body
  if (!org.dues_rate) throw new ApiError(400, 'No dues rate configured for this organization')

  if (org.last_dues_tick != null) {
    const nextDue = org.last_dues_tick + org.dues_frequency_ticks
    if (tick < nextDue) {
      throw new ApiError(409, `Dues aren't due yet — next collection available at tick ${nextDue}`)
    }
  }

  const state = ctx.state()
  const members = rows(state, 'organization_members')
    .filter(m => m.organization_id === org.id)
    .map(m => ({ ship_id: m.ship_id, credits: byId(state, 'ships', m.ship_id)?.credits ?? 0 }))

  const paid   = members.filter(m => m.credits >= org.dues_rate).map(m => m.ship_id)
  const failed = members.filter(m => m.credits <  org.dues_rate).map(m => m.ship_id)

  const collectedTotal = paid.length * org.dues_rate
  const effects = [
    ...paid.map(shipId => add('ships', shipId, 'credits', -org.dues_rate)),
    add('organizations', org.id, 'treasury_credits', collectedTotal),
    set('organizations', org.id, { last_dues_tick: tick }),
    ...paid.map(shipId => {
      const id = uuid()
      return put('dues_payments', id, {
        id, organization_id: org.id, ship_id: shipId,
        campaign_id: ctx.session.campaign_id, tick, amount: org.dues_rate,
        created_at: nowISO(),
      })
    }),
  ]
  ctx.apply(effects)

  return ok({
    organization: {
      ...org,
      treasury_credits: org.treasury_credits + collectedTotal,
      last_dues_tick: tick,
    },
    collected_total: collectedTotal,
    paid_ship_ids: paid,
    failed_ship_ids: failed,
  })
})

// ── POST /api/organizations/:id/disburse — ad hoc treasury -> ship transfer ──
route('POST', '/api/organizations/:id/disburse', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const { ship_id, amount, tick, notes } = ctx.body
  if (!(amount > 0))                 throw new ApiError(400, 'Amount must be positive')
  if (amount > org.treasury_credits) throw new ApiError(400, 'Insufficient organization treasury')

  const state  = ctx.state()
  const member = rows(state, 'organization_members').find(
    m => m.organization_id === org.id && m.ship_id === ship_id,
  )
  if (!member) throw new ApiError(404, 'Ship is not a member of this organization')

  const disbursementId = uuid()
  ctx.apply([
    add('organizations', org.id, 'treasury_credits', -amount),
    add('ships', ship_id, 'credits', amount),
    put('disbursements', disbursementId, {
      id: disbursementId, organization_id: org.id, ship_id,
      campaign_id: ctx.session.campaign_id, tick, amount,
      notes: notes || null, created_at: nowISO(),
    }),
  ])

  return ok({
    organization: { ...org, treasury_credits: org.treasury_credits - amount },
    ship_credits: (byId(state, 'ships', ship_id)?.credits ?? 0) + amount,
  })
})

// ── GET /api/organizations/:id/dues-payments — collection history ────────────
route('GET', '/api/organizations/:id/dues-payments', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const state = ctx.state()
  return ok(
    rows(state, 'dues_payments')
      .filter(d => d.organization_id === org.id)
      .sort((a, b) => b.tick - a.tick)
      .map(d => memberWithShipName(state, d)),
  )
})

// ── GET /api/organizations/:id/disbursements — disbursement history ──────────
route('GET', '/api/organizations/:id/disbursements', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const state = ctx.state()
  return ok(
    rows(state, 'disbursements')
      .filter(d => d.organization_id === org.id)
      .sort((a, b) => b.tick - a.tick)
      .map(d => memberWithShipName(state, d)),
  )
})

// ── GET /api/organizations/:id/fleet-report — consolidated fleet P&L ─────────
route('GET', '/api/organizations/:id/fleet-report', 'auth', (ctx) => {
  const org = orgOr404(ctx, ctx.params.id)
  requireOfficer(ctx, org.id)

  const state = ctx.state()
  const ships = sortBy(
    rows(state, 'organization_members')
      .filter(m => m.organization_id === org.id)
      .map(m => byId(state, 'ships', m.ship_id))
      .filter(Boolean),
    'name',
  )
  const shipIds = new Set(ships.map(s => s.id))

  const cargoByShip = {}
  for (const c of rows(state, 'cargo')) {
    if (shipIds.has(c.ship_id)) {
      cargoByShip[c.ship_id] = (cargoByShip[c.ship_id] ?? 0) + c.purchase_price * c.tons
    }
  }

  const debtByShip = {}
  for (const d of rows(state, 'ship_debts')) {
    if (shipIds.has(d.ship_id)) {
      debtByShip[d.ship_id] = (debtByShip[d.ship_id] ?? 0) + d.current_balance
    }
  }

  const byType = {}
  for (const t of rows(state, 'transactions')) {
    if (shipIds.has(t.ship_id) && t.campaign_id === ctx.session.campaign_id) {
      byType[t.type] = (byType[t.type] ?? 0) + t.total_cr
    }
  }

  const shipRows = ships.map(s => {
    const cargoValue = cargoByShip[s.id] ?? 0
    const debt       = debtByShip[s.id] ?? 0
    return {
      id: s.id, name: s.name, credits: s.credits, market_value: s.market_value,
      cargo_value: cargoValue, debt,
      net_contribution: s.credits + s.market_value + cargoValue - debt,
    }
  })

  return ok({
    organization_treasury: org.treasury_credits,
    ships: shipRows,
    fleet_net_worth: org.treasury_credits + shipRows.reduce((sum, r) => sum + r.net_contribution, 0),
    income_by_type: byType,
  })
})
