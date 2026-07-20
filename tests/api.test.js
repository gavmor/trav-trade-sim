// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { api, setUnauthorizedHandler } from '../src/lib/api.js'
import { configureSync, closeCampaign } from '../src/lib/crdt/store.js'

// The api client no longer speaks HTTP — it dispatches to the in-browser
// backend. These tests cover the envelope contract the stores rely on:
// { data, error, errorKind } plus the centralized 401 handling.

configureSync({ network: false, persistence: 'memory' })

beforeEach(() => {
  localStorage.clear()
  closeCampaign()
  setUnauthorizedHandler(null)
})

describe('api envelope', () => {
  it('tags an unknown route as errorKind "http"', async () => {
    const { data, error, errorKind } = await api.get('/api/ping')
    expect(data).toBeNull()
    expect(error).toMatch(/No route/)
    expect(errorKind).toBe('http')
  })

  it('tags a handler rejection as errorKind "http" with the handler message', async () => {
    const { data, error, errorKind } = await api.post('/api/campaigns', { label: 'X' })
    expect(data).toBeNull()
    expect(error).toBe('Missing required fields')
    expect(errorKind).toBe('http')
  })

  it('returns data with no errorKind on success', async () => {
    const { data, error, errorKind } = await api.post('/api/campaigns', {
      label: 'Envelope Test', code: 'ENV-01', char_name: 'Ref', pin: '1234',
    })
    expect(error).toBeNull()
    expect(errorKind).toBeUndefined()
    expect(data.campaign.code).toBe('ENV-01')
    expect(data.player.role).toBe('referee')
    expect(data.token).toBeTruthy()
    expect(data.recovery_code).toBeTruthy()
  })
})

describe('api 401 interceptor', () => {
  it('does not fire onUnauthorized when no session token is present', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    const { errorKind } = await api.get('/api/ships/current', { player_id: 1, campaign_id: 1 })
    expect(errorKind).toBe('http')
    expect(handler).not.toHaveBeenCalled()
  })

  it('fires onUnauthorized on a 401 for an authenticated request', async () => {
    localStorage.setItem('tts_session', JSON.stringify({ token: 'stale-token' }))
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await api.get('/api/ships/current', { player_id: 1, campaign_id: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
