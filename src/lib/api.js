// Local API client. Same interface and response envelope as the old HTTP
// client for the Cloudflare Worker, but requests are dispatched to the
// in-browser backend (src/lib/backend/), which reads and writes the p2p
// campaign document instead of a remote database. All stores and components
// import this exactly as before.

import { dispatch } from './backend/index.js'

function getToken() {
  try {
    const raw = localStorage.getItem('tts_session')
    return raw ? (JSON.parse(raw).token ?? null) : null
  } catch { return null }
}

// Set by auth.js at startup so a 401 on an authenticated request can log the
// session out and redirect once, centrally, instead of every caller having
// to notice "Unauthorized" in its own error string.
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

function cleanParams(params) {
  if (!params) return {}
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
  )
}

async function request(method, path, body, params) {
  const token = getToken()
  let result
  try {
    result = await dispatch(method, path, {
      query: cleanParams(params),
      body,
      token,
    })
  } catch (e) {
    return { data: null, error: e.message ?? 'Local backend error', errorKind: 'network' }
  }

  if (result.status < 200 || result.status >= 300) {
    if (result.status === 401 && token && onUnauthorized) onUnauthorized()
    // Spread the full error body so callers can inspect locked_until, attempts_remaining, etc.
    return { data: null, ...result.body, error: result.body.error ?? `HTTP ${result.status}`, errorKind: 'http' }
  }
  return { data: result.body.data ?? null, error: null }
}

export const api = {
  get:    (path, params) => request('GET',    path, undefined, params),
  post:   (path, body)   => request('POST',   path, body),
  patch:  (path, body)   => request('PATCH',  path, body),
  delete: (path, body)   => request('DELETE', path, body),
}
