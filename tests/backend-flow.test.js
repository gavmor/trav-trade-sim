// @vitest-environment happy-dom
//
// End-to-end exercise of the local backend through the same api surface the
// Pinia stores use: campaign lifecycle → auth → ship → market → trade →
// tick/rollup → reports. This is the behavioral parity check for the
// D1 → CRDT migration.

import { beforeEach, describe, it, expect } from 'vitest'
import { api, setUnauthorizedHandler } from '../src/lib/api.js'
import { configureSync, closeCampaign } from '../src/lib/crdt/store.js'

configureSync({ network: false, persistence: 'memory' })

let n = 0
function uniqueCode() {
  return `FLOW-${Date.now()}-${n++}`
}

function saveSession(data) {
  localStorage.setItem('tts_session', JSON.stringify({
    campaign: data.campaign, player: data.player, token: data.token,
  }))
}

async function createCampaign(overrides = {}) {
  const { data, error } = await api.post('/api/campaigns', {
    label: 'Test Campaign', code: uniqueCode(), milieu: 'M1105',
    trade_rules: 'CT7', char_name: 'Referee Jane', pin: '1234',
    ...overrides,
  })
  expect(error).toBeNull()
  saveSession(data)
  return data
}

beforeEach(() => {
  localStorage.clear()
  closeCampaign()
  setUnauthorizedHandler(null)
})

describe('campaign lifecycle', () => {
  it('creates a campaign and reads back the calendar', async () => {
    const { campaign } = await createCampaign({ start_tick: 96 })
    const { data: cal } = await api.get(`/api/campaigns/${campaign.id}/calendar`)
    expect(cal).toEqual({ current_tick: 96, year: 1107, day: 1 })
  })

  it('rejects a duplicate campaign code', async () => {
    const { campaign } = await createCampaign()
    const { error } = await api.post('/api/campaigns', {
      label: 'Dupe', code: campaign.code, char_name: 'Other', pin: '9999',
    })
    expect(error).toBe('Campaign code already in use')
  })

  it('joins, logs in, and logs out a second character', async () => {
    const { campaign } = await createCampaign()

    const { data: joined, error: joinErr } = await api.post('/api/campaigns/join', {
      code: campaign.code, char_name: 'Player Two', pin: '5678',
    })
    expect(joinErr).toBeNull()
    expect(joined.player.role).toBe('player')

    const { data: login, error: loginErr } = await api.post('/api/auth/login', {
      code: campaign.code, char_name: 'Player Two', pin: '5678',
    })
    expect(loginErr).toBeNull()
    expect(login.player.character_name).toBe('Player Two')

    const wrong = await api.post('/api/auth/login', {
      code: campaign.code, char_name: 'Player Two', pin: '0000',
    })
    expect(wrong.error).toBe('Invalid PIN')
    expect(wrong.attempts_remaining).toBe(4)
  })

  it('resets a PIN with the recovery code', async () => {
    const created = await createCampaign()
    const { error } = await api.post('/api/campaigns/reset-pin', {
      code: created.campaign.code, char_name: 'Referee Jane',
      recovery: created.recovery_code, new_pin: '4321',
    })
    expect(error).toBeNull()

    const login = await api.post('/api/auth/login', {
      code: created.campaign.code, char_name: 'Referee Jane', pin: '4321',
    })
    expect(login.error).toBeNull()
  })
})

describe('ship + trade flow', () => {
  async function setupShip() {
    const created = await createCampaign()
    const { campaign, player } = created

    const { data: ship, error } = await api.post('/api/ships', {
      campaign_id: campaign.id, player_id: player.id,
      name: 'Beowulf', hull_type: 'Free Trader', hull_tons: 200, cargo_capacity: 82,
    })
    expect(error).toBeNull()

    // Referee grants starting credits
    await api.patch(`/api/ships/${ship.id}/credits`, { delta: 100_000 })
    return { ...created, ship }
  }

  it('buys and sells cargo, updating credits, ledger, and trade records', async () => {
    const { campaign, player, ship } = await setupShip()

    // Seed a market snapshot for tick 0 (what ensureWorldSnapshot would insert)
    const good = { trade_good_die: '11', trade_good_name: 'Textiles', purchase_price: 3000, sale_price: 3500 }
    await api.post(`/api/campaigns/${campaign.id}/snapshots`, {
      rows: [{
        campaign_id: campaign.id, world_hex: '1910', sector: 'Spinward Marches',
        ...good, tick: 0, qty_available: 20, source_codes: 'Ag',
      }],
    })

    const buy = await api.post(`/api/ships/${ship.id}/buy-cargo`, {
      campaign_id: campaign.id, player_id: player.id,
      good, tons: 10, world_hex: '1910', world_name: 'Regina', sector: 'Spinward Marches', tick: 0,
    })
    expect(buy.error).toBeNull()

    // Snapshot quantity decremented
    const { data: snaps } = await api.get(`/api/campaigns/${campaign.id}/snapshots`, {
      world_hex: '1910', sector: 'Spinward Marches', tick: 0,
    })
    expect(snaps[0].qty_available).toBe(10)

    // Overbuying what's left fails
    const over = await api.post(`/api/ships/${ship.id}/buy-cargo`, {
      campaign_id: campaign.id, player_id: player.id,
      good, tons: 11, world_hex: '1910', world_name: 'Regina', sector: 'Spinward Marches', tick: 0,
    })
    expect(over.error).toMatch(/available at this price/)

    const sell = await api.post(`/api/ships/${ship.id}/sell-cargo`, {
      campaign_id: campaign.id, cargo_item: buy.data, sell_price_per_ton: 4000,
      market_world_hex: '2005', market_sector: 'Spinward Marches', tick: 0, trade_rules: 'CT7',
    })
    expect(sell.error).toBeNull()
    expect(sell.data.net_profit).toBe(10_000)

    const { data: current } = await api.get('/api/ships/current', {
      player_id: player.id, campaign_id: campaign.id,
    })
    expect(current.ship.credits).toBe(100_000 - 30_000 + 40_000)
    expect(current.cargo).toHaveLength(0)

    const { data: ledger } = await api.get('/api/reports/ledger', { ship_id: ship.id })
    expect(ledger.map(t => t.type).sort()).toEqual(['buy', 'sell'])

    const { data: trades } = await api.get('/api/reports/trades', { ship_id: ship.id })
    expect(trades).toHaveLength(1)
    expect(trades[0].net_profit).toBe(10_000)

    const { data: income } = await api.get('/api/reports/income', { ship_id: ship.id })
    expect(income.buy).toBe(-30_000)
    expect(income.sell).toBe(40_000)
  })

  it('books, auto-delivers, and pays passengers and mail', async () => {
    const { campaign, player, ship } = await setupShip()

    const booking = await api.post(`/api/ships/${ship.id}/book-passengers`, {
      campaign_id: campaign.id, player_id: player.id,
      passage_type: 'high', count: 2,
      embark_world_hex: '1910', embark_sector: 'Spinward Marches', embark_world_name: 'Regina',
      dest_world_hex: '2005', dest_sector: 'Spinward Marches', dest_world_name: 'Jenghe',
      fare_per_head: 10_000, fare_total: 20_000, tick: 0,
    })
    expect(booking.error).toBeNull()
    expect(booking.data.count).toBe(2)
    expect(booking.data.fare_total).toBe(20_000)

    const mail = await api.post(`/api/ships/${ship.id}/accept-mail`, {
      campaign_id: campaign.id, player_id: player.id,
      origin_world_hex: '1910', origin_sector: 'Spinward Marches', origin_world_name: 'Regina',
      dest_world_hex: '2005', dest_sector: 'Spinward Marches', dest_world_name: 'Jenghe',
      parsecs: 2, payment: 25_000, tick: 0,
    })
    expect(mail.error).toBeNull()

    const deliver = await api.post(`/api/referee/ships/${ship.id}/auto-deliver`, {
      world_hex: '2005', sector: 'Spinward Marches', tick: 1,
      campaign_id: campaign.id, player_id: player.id,
    })
    expect(deliver.error).toBeNull()
    expect(deliver.data.passengers_delivered).toBe(1)
    expect(deliver.data.mail_delivered).toBe(1)

    const { data: current } = await api.get('/api/ships/current', {
      player_id: player.id, campaign_id: campaign.id,
    })
    // 100k start + 20k fares (at booking) + 25k mail (on delivery)
    expect(current.ship.credits).toBe(145_000)
    expect(current.passengers).toHaveLength(0)
    expect(current.mailContracts).toHaveLength(0)
  })
})

describe('tick advancement and rollups', () => {
  it('advances the tick and produces a monthly rollup at the boundary', async () => {
    const { campaign } = await createCampaign()

    // Snapshots for ticks 0..3 (one month of weekly prices)
    for (let t = 0; t < 4; t++) {
      await api.post(`/api/campaigns/${campaign.id}/snapshots`, {
        rows: [{
          campaign_id: campaign.id, world_hex: '1910', sector: 'Spinward Marches',
          trade_good_die: '11', trade_good_name: 'Textiles',
          tick: t, purchase_price: 3000 + t * 100, sale_price: 3500,
          qty_available: 20, source_codes: 'Ag',
        }],
      })
    }

    let last
    for (let t = 0; t < 4; t++) {
      last = await api.post(`/api/campaigns/${campaign.id}/advance-tick`, {})
      expect(last.error).toBeNull()
    }
    expect(last.data).toEqual({ tick: 4, year: 1105, day: 29, month: 2 })

    const { data: monthly } = await api.get(`/api/campaigns/${campaign.id}/market/monthly`, {
      world_hex: '1910', sector: 'Spinward Marches', good_die: '11',
    })
    expect(monthly).toHaveLength(1)
    expect(monthly[0]).toMatchObject({
      year: 1105, month: 1,
      open_price: 3000, close_price: 3300, high_price: 3300, low_price: 3000,
      volume_tons: 80,
    })

    const { data: weekly } = await api.get(`/api/campaigns/${campaign.id}/market/weekly`, {
      world_hex: '1910', sector: 'Spinward Marches', good_die: '11',
    })
    expect(weekly.map(w => w.tick)).toEqual([0, 1, 2, 3])
  })

  it('only lets the referee advance the tick', async () => {
    const { campaign } = await createCampaign()

    await api.post('/api/campaigns/join', {
      code: campaign.code, char_name: 'Deckhand', pin: '5678',
    })
    const { data: login } = await api.post('/api/auth/login', {
      code: campaign.code, char_name: 'Deckhand', pin: '5678',
    })
    saveSession({ campaign, player: login.player, token: login.token })

    const { error, errorKind } = await api.post(`/api/campaigns/${campaign.id}/advance-tick`, {})
    expect(errorKind).toBe('http')
    expect(error).toBe('Referee access required')
  })
})

describe('market events', () => {
  it('inserts, lists, and expires events', async () => {
    const { campaign } = await createCampaign()

    const ev = await api.post(`/api/campaigns/${campaign.id}/events`, {
      tick: 0, scope: 'local', world_hex: '1910', sector: 'Spinward Marches',
      trade_good_die: '11', buy_modifier_pct: 20, sell_modifier_pct: -10,
      description: 'Textile shortage', severity: 'major',
    })
    expect(ev.error).toBeNull()

    const { data: dup } = await api.post(`/api/campaigns/${campaign.id}/events`, {
      check_duplicate: true, tick: 0, world_hex: '1910',
    })
    expect(dup.count).toBe(1)

    const { data: active } = await api.get(`/api/campaigns/${campaign.id}/events`, {
      active: true, current_tick: 0,
    })
    expect(active).toHaveLength(1)

    await api.patch(`/api/campaigns/event/${ev.data.id}/expire`, { current_tick: 0 })
    const { data: afterExpire } = await api.get(`/api/campaigns/${campaign.id}/events`, {
      active: true, current_tick: 0,
    })
    expect(afterExpire).toHaveLength(0)
  })
})

describe('organizations', () => {
  it('founds an org, collects dues, and disburses from the treasury', async () => {
    const { campaign, player } = await createCampaign()

    const { data: ship } = await api.post('/api/ships', {
      campaign_id: campaign.id, player_id: player.id, name: 'Beowulf',
    })
    await api.patch(`/api/ships/${ship.id}/credits`, { delta: 10_000 })

    const { data: org, error } = await api.post('/api/organizations', {
      name: 'Far Traders Guild', treasury_credits: 0, dues_rate: 1000,
    })
    expect(error).toBeNull()
    expect(org.is_officer).toBe(true)

    await api.post(`/api/organizations/${org.id}/members`, { ship_id: ship.id, owns_ship: false })

    const dues = await api.post(`/api/organizations/${org.id}/collect-dues`, { tick: 0 })
    expect(dues.error).toBeNull()
    expect(dues.data.collected_total).toBe(1000)
    expect(dues.data.paid_ship_ids).toEqual([ship.id])

    const again = await api.post(`/api/organizations/${org.id}/collect-dues`, { tick: 1 })
    expect(again.error).toMatch(/aren't due yet/)

    const disburse = await api.post(`/api/organizations/${org.id}/disburse`, {
      ship_id: ship.id, amount: 500, tick: 1, notes: 'refit subsidy',
    })
    expect(disburse.error).toBeNull()
    expect(disburse.data.organization.treasury_credits).toBe(500)
    expect(disburse.data.ship_credits).toBe(9500)

    const { data: report } = await api.get(`/api/organizations/${org.id}/fleet-report`)
    expect(report.organization_treasury).toBe(500)
    expect(report.ships[0].credits).toBe(9500)
  })
})
