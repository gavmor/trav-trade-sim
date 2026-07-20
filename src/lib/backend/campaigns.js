// Campaign lifecycle + authentication — ported from the Worker's
// routes/campaigns.js and routes/auth.js.

import { route, ApiError, ok, created } from './router.js'
import { put, set, clear } from '../crdt/doc.js'
import { hashPin, verifyPin } from './hash.js'
import { createSession, deleteSession, deletePlayerSessions } from './session.js'
import { uuid, nowISO, rows } from './tables.js'
import {
  openCampaign, closeCampaign, waitForCampaignData, deleteLocalDoc,
  getState, applyEffects, normalizeCode,
} from '../crdt/store.js'

function campaignByCode(state, code) {
  return rows(state, 'campaigns').find(c => c.code === code) ?? null
}

function playerByName(state, campaignId, name) {
  return rows(state, 'players').find(
    p => p.campaign_id === campaignId && p.character_name === name,
  ) ?? null
}

const publicCampaign = (c) => ({
  id: c.id, code: c.code, label: c.label, milieu: c.milieu, trade_rules: c.trade_rules,
})
const publicPlayer = (p) => ({
  id: p.id, character_name: p.character_name, role: p.role, credits: p.credits ?? 0,
})

// ── POST /api/campaigns — create campaign + referee character ─────────────────
route('POST', '/api/campaigns', null, async (ctx) => {
  const { label, code, milieu, trade_rules, char_name, pin, start_tick = 0 } = ctx.body

  if (!label || !code || !char_name || !pin) throw new ApiError(400, 'Missing required fields')
  if (pin.trim().length < 4)                 throw new ApiError(400, 'PIN must be at least 4 characters')

  const normalized = normalizeCode(code)
  await openCampaign(normalized)
  // Give any online peers a moment to send their document — the p2p
  // equivalent of the old "SELECT id FROM campaigns WHERE code = ?" check.
  await waitForCampaignData(2500)
  if (campaignByCode(getState(), normalized)) {
    throw new ApiError(409, 'Campaign code already in use')
  }

  const campaignId   = uuid()
  const playerId     = uuid()
  const pinHash      = await hashPin(pin)
  const recoveryCode = uuid().toUpperCase().replace(/-/g, '')
  const recoveryHash = await hashPin(recoveryCode)

  const tick = Math.max(0, start_tick)
  const campaign = {
    id: campaignId, code: normalized, label: label.trim(),
    milieu: milieu ?? 'M1105', trade_rules: trade_rules ?? 'CT7',
    recovery_code_hash: recoveryHash, created_at: nowISO(),
  }
  const player = {
    id: playerId, campaign_id: campaignId, character_name: char_name.trim(),
    pin_hash: pinHash, role: 'referee', credits: 0,
    failed_attempts: 0, locked_until: null, created_at: nowISO(),
  }

  applyEffects([
    put('campaigns', campaignId, campaign),
    put('campaign_calendar', campaignId, {
      campaign_id: campaignId, current_tick: tick, updated_at: nowISO(),
    }),
    put('players', playerId, player),
  ])

  const token = createSession(playerId, campaignId, normalized)

  return created({
    campaign:      publicCampaign(campaign),
    player:        publicPlayer(player),
    recovery_code: recoveryCode,
    token,
  })
})

// ── POST /api/campaigns/join — register a new player character ────────────────
route('POST', '/api/campaigns/join', null, async (ctx) => {
  const { code, char_name, pin } = ctx.body

  if (!code || !char_name || !pin) throw new ApiError(400, 'Missing required fields')
  if (pin.trim().length < 4)       throw new ApiError(400, 'PIN must be at least 4 characters')

  const normalized = normalizeCode(code)
  await openCampaign(normalized)
  await waitForCampaignData(8000)

  const state    = getState()
  const campaign = campaignByCode(state, normalized)
  if (!campaign) {
    throw new ApiError(404, 'Campaign not found — make sure another campaign member has the app open so it can sync to you')
  }

  if (playerByName(state, campaign.id, char_name.trim())) {
    throw new ApiError(409, 'Character name already taken in this campaign')
  }

  const playerId = uuid()
  const player = {
    id: playerId, campaign_id: campaign.id, character_name: char_name.trim(),
    pin_hash: await hashPin(pin), role: 'player', credits: 0,
    failed_attempts: 0, locked_until: null, created_at: nowISO(),
  }
  applyEffects([put('players', playerId, player)])

  return created({
    player: { ...publicPlayer(player), campaign_id: campaign.id },
  })
})

// ── PATCH /api/campaigns/:id — update campaign label ──────────────────────────
route('PATCH', '/api/campaigns/:id', 'referee', (ctx) => {
  if (ctx.session.campaign_id !== ctx.params.id) throw new ApiError(403, 'Forbidden')

  const { label } = ctx.body
  if (!label?.trim()) throw new ApiError(400, 'Label is required')

  ctx.apply([set('campaigns', ctx.params.id, { label: label.trim() })])
  return ok({ ok: true, label: label.trim() })
})

// ── DELETE /api/campaigns/:id — referee deletes their campaign ────────────────
route('DELETE', '/api/campaigns/:id', 'referee', async (ctx) => {
  const { id } = ctx.params
  if (ctx.session.campaign_id !== id) throw new ApiError(403, 'Forbidden')

  const player = ctx.state().tables.players?.[ctx.session.player_id]
  if (!player) throw new ApiError(404, 'Player not found')

  const okPin = await verifyPin(ctx.body.pin, player.pin_hash)
  if (!okPin) throw new ApiError(403, 'Incorrect PIN')

  // Broadcast a full wipe (the CASCADE equivalent), then drop our local copy.
  ctx.apply([clear()])
  for (const p of rows(ctx.state(), 'players')) deletePlayerSessions(p.id)
  deletePlayerSessions(ctx.session.player_id)
  closeCampaign()
  await deleteLocalDoc(ctx.session.code)

  return ok({ ok: true })
})

// ── POST /api/campaigns/recovery-code — regenerate recovery code ──────────────
route('POST', '/api/campaigns/recovery-code', 'referee', async (ctx) => {
  const recoveryCode = uuid().toUpperCase().replace(/-/g, '')
  const recoveryHash = await hashPin(recoveryCode)

  ctx.apply([set('campaigns', ctx.session.campaign_id, { recovery_code_hash: recoveryHash })])
  return ok({ recovery_code: recoveryCode })
})

// ── POST /api/campaigns/reset-pin — reset PIN using recovery code ─────────────
route('POST', '/api/campaigns/reset-pin', null, async (ctx) => {
  const { code, char_name, recovery, new_pin } = ctx.body

  if (!code || !char_name || !recovery || !new_pin) throw new ApiError(400, 'Missing required fields')
  if (new_pin.trim().length < 4)                    throw new ApiError(400, 'PIN must be at least 4 characters')

  const normalized = normalizeCode(code)
  await openCampaign(normalized)
  await waitForCampaignData(8000)

  const state    = getState()
  const campaign = campaignByCode(state, normalized)
  if (!campaign)                    throw new ApiError(404, 'Campaign not found')
  if (!campaign.recovery_code_hash) throw new ApiError(400, 'No recovery code set for this campaign')

  const validRecovery = await verifyPin(recovery.trim().toUpperCase(), campaign.recovery_code_hash)
  if (!validRecovery) throw new ApiError(403, 'Invalid recovery code')

  const player = playerByName(state, campaign.id, char_name.trim())
  if (!player) throw new ApiError(404, 'Character not found')

  const newHash = await hashPin(new_pin)
  applyEffects([
    set('players', player.id, { pin_hash: newHash, failed_attempts: 0, locked_until: null }),
  ])
  deletePlayerSessions(player.id)

  return ok({ ok: true })
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
route('POST', '/api/auth/login', null, async (ctx) => {
  const { code, char_name, pin } = ctx.body
  if (!code || !char_name || !pin) throw new ApiError(400, 'Missing required fields')

  const normalized = normalizeCode(code)
  await openCampaign(normalized)
  await waitForCampaignData(8000)

  const state    = getState()
  const campaign = campaignByCode(state, normalized)
  if (!campaign) {
    throw new ApiError(404, 'Campaign not found — make sure another campaign member has the app open so it can sync to you')
  }

  const player = playerByName(state, campaign.id, char_name.trim())
  if (!player) throw new ApiError(404, 'Character not found')

  if (player.locked_until && new Date(player.locked_until) > new Date()) {
    throw new ApiError(403, {
      error: 'Too many failed attempts — account locked',
      locked_until: player.locked_until,
    })
  }

  const valid = await verifyPin(pin, player.pin_hash)
  if (valid) {
    applyEffects([
      set('players', player.id, { failed_attempts: 0, locked_until: null, last_seen: nowISO() }),
    ])
    const token = createSession(player.id, campaign.id, normalized)
    return ok({
      campaign: publicCampaign(campaign),
      player:   publicPlayer(player),
      token,
    })
  }

  const newAttempts = (player.failed_attempts ?? 0) + 1
  const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null
  applyEffects([
    set('players', player.id, { failed_attempts: newAttempts, locked_until: lockedUntil }),
  ])

  throw new ApiError(401, {
    error: 'Invalid PIN',
    attempts_remaining: Math.max(0, 4 - (player.failed_attempts ?? 0)),
  })
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
route('POST', '/api/auth/logout', 'auth', (ctx) => {
  deleteSession(ctx.token)
  closeCampaign()
  return ok({ ok: true })
})
