// In-browser request router — the drop-in replacement for the Cloudflare
// Worker's Hono app. Same paths, same auth guards, same response bodies;
// the only difference is that handlers read from the materialized campaign
// document and write CRDT effects instead of running SQL against D1.

import { getState, applyEffects, openCampaign, openCode } from '../crdt/store.js'
import { getSession } from './session.js'

export class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body.error ?? `HTTP ${status}`)
    this.status = status
    this.body   = typeof body === 'string' ? { error: body } : body
  }
}

const routes = []

// guard: null (public) | 'auth' | 'referee'
export function route(method, pattern, guard, handler) {
  routes.push({ method, segments: pattern.split('/').filter(Boolean), guard, handler })
}

function match(segments, pathSegments) {
  if (segments.length !== pathSegments.length) return null
  const params = {}
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(':')) {
      params[segments[i].slice(1)] = decodeURIComponent(pathSegments[i])
    } else if (segments[i] !== pathSegments[i]) {
      return null
    }
  }
  return params
}

// Resolves the session and, like the Worker's requireAuth JOIN, reads the
// player's live role out of the campaign doc. Also (re)opens the campaign
// bus for the session's campaign — the p2p equivalent of "connecting to
// the database".
async function resolveSession(token, guard) {
  const record = getSession(token)
  if (!record) throw new ApiError(401, 'Unauthorized')

  if (openCode() !== record.code) {
    await openCampaign(record.code)
  }

  const player = getState().tables.players?.[record.player_id]
  if (!player) throw new ApiError(401, 'Unauthorized')
  if (guard === 'referee' && player.role !== 'referee') {
    throw new ApiError(403, 'Referee access required')
  }

  return {
    player_id:   record.player_id,
    campaign_id: record.campaign_id,
    code:        record.code,
    role:        player.role,
  }
}

export async function dispatch(method, path, { query = {}, body, token } = {}) {
  const pathSegments = path.split('?')[0].split('/').filter(Boolean)

  for (const r of routes) {
    if (r.method !== method) continue
    const params = match(r.segments, pathSegments)
    if (!params) continue

    try {
      const session = r.guard ? await resolveSession(token, r.guard) : null
      const ctx = {
        params,
        query,
        body: body ?? {},
        session,
        token,
        state: getState,
        apply: applyEffects,
      }
      const result = await r.handler(ctx)
      return { status: result?.status ?? 200, body: result?.body ?? { data: null } }
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: e.body }
      console.error(`[local-api] ${method} ${path} failed:`, e)
      return { status: 500, body: { error: e.message ?? 'Internal error' } }
    }
  }

  return { status: 404, body: { error: `No route for ${method} ${path}` } }
}

// Shorthands used by every handler module.
export const ok      = (data, status = 200) => ({ status, body: { data } })
export const created = (data)               => ({ status: 201, body: { data } })
