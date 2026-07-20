// Imperial Calendar — ported from the Worker's routes/calendar.js.
//
// Only current_tick is stored; year/day/month are derived at read time so a
// concurrent tick advance on two peers (both +1 via an additive effect)
// still converges to a calendar consistent with the merged tick count.

import { route, ApiError, ok } from './router.js'
import { add, set } from '../crdt/doc.js'
import { byId } from './tables.js'
import { tickYear, tickMonth, tickDay, rollupMonthEffects, rollupYearEffects, repairRollupEffects } from './rollup.js'

// ── GET /api/campaigns/:id/calendar ──────────────────────────────────────────
route('GET', '/api/campaigns/:id/calendar', 'auth', (ctx) => {
  if (ctx.session.campaign_id !== ctx.params.id) throw new ApiError(403, 'Forbidden')

  const row = byId(ctx.state(), 'campaign_calendar', ctx.params.id)
  if (!row) throw new ApiError(404, 'Calendar not found')

  return ok({
    current_tick: row.current_tick,
    year: tickYear(row.current_tick),
    day:  tickDay(row.current_tick),
  })
})

// ── POST /api/campaigns/:id/advance-tick (referee only) ───────────────────────
route('POST', '/api/campaigns/:id/advance-tick', 'referee', (ctx) => {
  const { id } = ctx.params
  if (ctx.session.campaign_id !== id) throw new ApiError(403, 'Forbidden')

  const state = ctx.state()
  const row   = byId(state, 'campaign_calendar', id)
  if (!row) throw new ApiError(400, 'Campaign calendar not found')

  const newTick = row.current_tick + 1
  const effects = [
    add('campaign_calendar', id, 'current_tick', 1),
    set('campaign_calendar', id, { updated_at: new Date().toISOString() }),
  ]

  // Monthly rollup fires after every 4th tick (completed month);
  // annual after every 48th (completed year).
  if (newTick % 4 === 0) {
    effects.push(...rollupMonthEffects(state, id, tickYear(newTick - 4), tickMonth(newTick - 4)))
  }
  if (newTick % 48 === 0) {
    effects.push(...rollupYearEffects(state, id, tickYear(newTick - 48)))
  }

  ctx.apply(effects)

  return ok({
    tick:  newTick,
    year:  tickYear(newTick),
    day:   tickDay(newTick),
    month: tickMonth(newTick),
  })
})

// ── POST /api/campaigns/:id/rollup-repair ─────────────────────────────────────
// Re-runs monthly/annual rollup for a boundary tick discovered mid-backfill
// (any authenticated campaign member — this is a side effect of a lazy world
// visit, not a privileged action).
route('POST', '/api/campaigns/:id/rollup-repair', 'auth', (ctx) => {
  const { id } = ctx.params
  if (ctx.session.campaign_id !== id) throw new ApiError(403, 'Forbidden')

  const effects = repairRollupEffects(ctx.state(), id, ctx.body.tick)
  if (effects.length) ctx.apply(effects)
  return ok({ ok: true })
})
