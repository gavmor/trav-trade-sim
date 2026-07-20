// Session tokens, now purely local to this browser.
//
// The old Worker stored sessions in D1 so it could authenticate HTTP
// requests. There is no server anymore — a "session" is just this browser
// remembering which character it logged in as, so tokens live in
// localStorage. The PIN check still happens at login; the token exists so
// the rest of the app (api.js's Bearer-token plumbing, 401 handling) keeps
// working unchanged.

import { normalizeCode } from '../crdt/store.js'

const SESSIONS_KEY = 'tts_local_sessions'
const TTL_DAYS = 30

function storage() {
  if (typeof localStorage !== 'undefined') return localStorage
  return memoryStorage
}

const memoryMap = new Map()
const memoryStorage = {
  getItem: (k) => (memoryMap.has(k) ? memoryMap.get(k) : null),
  setItem: (k, v) => memoryMap.set(k, String(v)),
  removeItem: (k) => memoryMap.delete(k),
}

function loadAll() {
  try {
    const raw = storage().getItem(SESSIONS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveAll(sessions) {
  try {
    storage().setItem(SESSIONS_KEY, JSON.stringify(sessions))
  } catch { /* storage-restricted browser — sessions stay in-memory only */ }
}

export function createSession(playerId, campaignId, campaignCode) {
  const token = crypto.randomUUID()
  const sessions = loadAll()
  sessions[token] = {
    player_id:   playerId,
    campaign_id: campaignId,
    code:        normalizeCode(campaignCode),
    expires_at:  new Date(Date.now() + TTL_DAYS * 86_400_000).toISOString(),
  }
  saveAll(sessions)
  return token
}

// Returns { player_id, campaign_id, code } or null if invalid/expired.
// The caller looks up the player's current role from the campaign doc —
// same as the Worker's JOIN against players.
export function getSession(token) {
  if (!token) return null
  const record = loadAll()[token]
  if (!record) return null
  if (new Date(record.expires_at) <= new Date()) {
    deleteSession(token)
    return null
  }
  return record
}

export function deleteSession(token) {
  const sessions = loadAll()
  if (token in sessions) {
    delete sessions[token]
    saveAll(sessions)
  }
}

export function deletePlayerSessions(playerId) {
  const sessions = loadAll()
  let changed = false
  for (const [token, record] of Object.entries(sessions)) {
    if (record.player_id === playerId) {
      delete sessions[token]
      changed = true
    }
  }
  if (changed) saveAll(sessions)
}
