// Reports — ledger, debts, ownership, trade history, income, self-service
// skills. Ported from the Worker's routes/reports.js.

import { route, ApiError, ok } from './router.js'
import { put, del } from '../crdt/doc.js'
import { rows, byId, sortBy, nowISO } from './tables.js'

const skillId = (playerId, skill) => `${playerId}|${skill}`

// ── GET /api/reports/ledger — paginated transaction ledger ────────────────────
// ?ship_id=X&limit=N&from_tick=A&to_tick=B
route('GET', '/api/reports/ledger', 'auth', (ctx) => {
  const { ship_id, limit = '101', from_tick, to_tick } = ctx.query

  let txns = rows(ctx.state(), 'transactions').filter(
    t => t.ship_id === ship_id && t.campaign_id === ctx.session.campaign_id,
  )
  if (from_tick != null) txns = txns.filter(t => t.tick >= Number(from_tick))
  if (to_tick   != null) txns = txns.filter(t => t.tick <  Number(to_tick))

  return ok(sortBy(txns, 'tick', -1).slice(0, Number(limit)))
})

// ── GET /api/reports/debts — a ship's debts (player-facing) ───────────────────
route('GET', '/api/reports/debts', 'auth', (ctx) => {
  return ok(sortBy(
    rows(ctx.state(), 'ship_debts').filter(
      d => d.ship_id === ctx.query.ship_id && d.campaign_id === ctx.session.campaign_id,
    ),
    'created_at',
  ))
})

// ── GET /api/reports/ownership — a ship's ownership shares (player-facing) ───
// If the ship is owned outright by an organization (organization_members.
// owns_ship = 1), personal Net Worth attribution flows through that org's
// equity (organization_ownership) instead of the ship's own ship_ownership
// rows — same {id, player_id, character_name, percentage} shape either way.
route('GET', '/api/reports/ownership', 'auth', (ctx) => {
  const { ship_id } = ctx.query
  const state = ctx.state()

  const withName = (o) => ({
    ...o, character_name: byId(state, 'players', o.player_id)?.character_name ?? '',
  })

  const owningOrg = rows(state, 'organization_members').find(
    m => m.ship_id === ship_id && m.owns_ship === 1,
  )

  if (owningOrg) {
    return ok(
      rows(state, 'organization_ownership')
        .filter(o => o.organization_id === owningOrg.organization_id && o.campaign_id === ctx.session.campaign_id)
        .sort((a, b) => b.percentage - a.percentage)
        .map(withName),
    )
  }

  return ok(
    rows(state, 'ship_ownership')
      .filter(o => o.ship_id === ship_id && o.campaign_id === ctx.session.campaign_id)
      .sort((a, b) => b.percentage - a.percentage)
      .map(withName),
  )
})

// ── GET /api/reports/trades — paginated trade record history ──────────────────
route('GET', '/api/reports/trades', 'auth', (ctx) => {
  const { ship_id, limit = '101', from_tick, to_tick } = ctx.query

  let trades = rows(ctx.state(), 'trade_records').filter(
    t => t.ship_id === ship_id && t.campaign_id === ctx.session.campaign_id,
  )
  if (from_tick != null) trades = trades.filter(t => t.sell_tick >= Number(from_tick))
  if (to_tick   != null) trades = trades.filter(t => t.sell_tick <  Number(to_tick))

  return ok(sortBy(trades, 'sell_tick', -1).slice(0, Number(limit)))
})

// ── GET /api/reports/income — income breakdown by transaction type ─────────────
route('GET', '/api/reports/income', 'auth', (ctx) => {
  const { ship_id, from_tick, to_tick } = ctx.query

  let txns = rows(ctx.state(), 'transactions').filter(
    t => t.ship_id === ship_id && t.campaign_id === ctx.session.campaign_id,
  )
  if (from_tick != null) txns = txns.filter(t => t.tick >= Number(from_tick))
  if (to_tick   != null) txns = txns.filter(t => t.tick <  Number(to_tick))

  const byType = {}
  for (const t of txns) {
    byType[t.type] = (byType[t.type] ?? 0) + t.total_cr
  }
  return ok(byType)
})

// ── POST /api/reports/skills — player self-service skill upsert ───────────────
// Used by CharacterDialog (players editing their own skills)
route('POST', '/api/reports/skills', 'auth', (ctx) => {
  const { campaign_id, player_id, skill, level } = ctx.body
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (player_id   !== ctx.session.player_id)   throw new ApiError(403, 'Forbidden')

  const id = skillId(player_id, skill.trim())
  ctx.apply([put('player_skills', id, {
    id, campaign_id, player_id, skill: skill.trim(), level, created_at: nowISO(),
  })])

  return ok({ id, skill: skill.trim(), level })
})

// ── GET /api/reports/skills — player self-service skill list ─────────────────
route('GET', '/api/reports/skills', 'auth', (ctx) => {
  const { campaign_id, player_id } = ctx.query
  if (campaign_id !== ctx.session.campaign_id) throw new ApiError(403, 'Forbidden')
  if (player_id   !== ctx.session.player_id)   throw new ApiError(403, 'Forbidden')

  return ok(sortBy(
    rows(ctx.state(), 'player_skills')
      .filter(s => s.campaign_id === campaign_id && s.player_id === player_id)
      .map(s => ({ id: s.id, skill: s.skill, level: s.level })),
    'skill',
  ))
})

// ── DELETE /api/reports/skills/:id — player deletes own skill ────────────────
route('DELETE', '/api/reports/skills/:id', 'auth', (ctx) => {
  const row = byId(ctx.state(), 'player_skills', ctx.params.id)
  if (!row)                                      throw new ApiError(404, 'Skill not found')
  if (row.player_id !== ctx.session.player_id)   throw new ApiError(403, 'Forbidden')

  ctx.apply([del('player_skills', row.id)])
  return ok({ ok: true })
})
