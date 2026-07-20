// Campaign sync manager — owns the one open campaign document.
//
// Responsibilities:
//   - open/close the crdtbus Bus for a campaign code (topic = campaign code)
//   - persist the op-log document in IndexedDB (replaces Cloudflare D1)
//   - hand the local backend a consistent read view (memoized materialize)
//   - apply new ops (local writes) and broadcast them to peers
//   - surface remote updates so the UI can refresh
//
// The campaign code doubles as the crdtbus topic: everyone who knows the
// code syncs the same document. PINs still gate which *character* you can
// act as, but they are checked client-side — the document itself is readable
// by anyone holding the campaign code. That's the honest trust model of a
// serverless p2p app; campaign codes should be treated like invite links.

import { Bus } from './bus.js'
import {
  emptyDoc, mergeDocs, materialize, makeOp, maxLamport,
} from './doc.js'
import { openDB } from '../idb.js'

const SIGNALING_HOST =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PEERJS_HOST) ||
  '0.peerjs.com'

// Topic namespace is versioned (see doc.js DOC_VERSION) so a future breaking
// document-format change can move to tts2- without old clients corrupting it.
const TOPIC_PREFIX = 'tts1-'

const AGENT_KEY = 'tts_agent_id'

// ── Test / offline hooks ──────────────────────────────────────────────────────

const config = {
  // Tests run in Node where PeerJS (WebRTC) doesn't exist; they disable
  // networking and drive convergence by exchanging docs directly.
  network: typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined',
  // Tests also swap persistence for an in-memory map.
  persistence: typeof indexedDB !== 'undefined' ? 'idb' : 'memory',
}

export function configureSync(overrides) {
  Object.assign(config, overrides)
}

// ── Agent identity ────────────────────────────────────────────────────────────

function storage() {
  if (typeof localStorage !== 'undefined') return localStorage
  return memoryStorage
}

const memoryStorageMap = new Map()
const memoryStorage = {
  getItem: (k) => (memoryStorageMap.has(k) ? memoryStorageMap.get(k) : null),
  setItem: (k, v) => memoryStorageMap.set(k, String(v)),
  removeItem: (k) => memoryStorageMap.delete(k),
}

export function agentId() {
  let id = storage().getItem(AGENT_KEY)
  if (!id) {
    id = crypto.randomUUID()
    storage().setItem(AGENT_KEY, id)
  }
  return id
}

// ── Document persistence (IndexedDB) ──────────────────────────────────────────

const memoryDocs = new Map()

async function loadDoc(code) {
  if (config.persistence === 'memory') {
    return memoryDocs.get(code) ?? emptyDoc()
  }
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const tx  = db.transaction('campaign-docs', 'readonly')
      const req = tx.objectStore('campaign-docs').get(code)
      req.onsuccess = () => resolve(req.result?.doc ?? emptyDoc())
      req.onerror   = () => resolve(emptyDoc())
    })
  } catch {
    return emptyDoc()
  }
}

let saveTimer = null
function saveDoc(code, doc) {
  if (config.persistence === 'memory') {
    memoryDocs.set(code, doc)
    return
  }
  // Write-behind with a short debounce — snapshot backfill can apply dozens
  // of ops in a burst and each IDB write persists the whole doc anyway.
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      const db = await openDB()
      db.transaction('campaign-docs', 'readwrite')
        .objectStore('campaign-docs')
        .put({ code, doc, savedAt: new Date().toISOString() })
    } catch (e) {
      console.error('[sync] failed to persist campaign doc:', e)
    }
  }, 250)
}

export async function deleteLocalDoc(code) {
  memoryDocs.delete(code)
  if (config.persistence === 'memory') return
  try {
    const db = await openDB()
    db.transaction('campaign-docs', 'readwrite').objectStore('campaign-docs').delete(code)
  } catch { /* nothing to delete */ }
}

// ── Local-only bus (offline / test fallback) ──────────────────────────────────

function LocalBus({ load, save, merge }) {
  let state = load()
  const subs = new Set()
  return {
    state: {
      get: () => state,
      sub: (fn) => subs.add(fn),
      unsub: (fn) => subs.delete(fn),
    },
    networkStatus: { get: () => 'pending', sub: () => {}, unsub: () => {} },
    whosOnline:    { get: () => new Set(), sub: () => {}, unsub: () => {} },
    apply(patch) {
      state = merge(state, patch)
      save(state)
      subs.forEach((fn) => fn(state))
      this.subscriber()
    },
    // Test hook: simulates a patch arriving from a peer.
    receive(patch) {
      state = merge(state, patch)
      save(state)
      subs.forEach((fn) => fn(state))
      this.subscriber()
    },
    subscriber: () => {},
    close() {},
    destroy() {},
  }
}

// ── The open campaign ─────────────────────────────────────────────────────────

let current = null // { code, bus, stateCache: { doc, state } }

const remoteUpdateListeners = new Set()

// Register a callback fired whenever a *remote* peer's ops land in the open
// document (local writes don't fire it — the stores already update themselves
// optimistically after their own actions).
export function onRemoteUpdate(fn) {
  remoteUpdateListeners.add(fn)
  return () => remoteUpdateListeners.delete(fn)
}

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase()
}

function topicFor(code) {
  // PeerJS peer ids allow [A-Za-z0-9-_]; campaign codes are user input.
  return TOPIC_PREFIX + normalizeCode(code).replace(/[^A-Z0-9_-]/g, '-')
}

let applyingLocally = false

export async function openCampaign(code) {
  code = normalizeCode(code)
  if (!code) throw new Error('Campaign code is required')
  if (current?.code === code) return current

  closeCampaign()

  const initialDoc = await loadDoc(code)
  const busConfig = {
    topic: topicFor(code),
    agentId: agentId(),
    merge: mergeDocs,
    load: () => initialDoc,
    save: (doc) => saveDoc(code, doc),
    signalingServerHost: SIGNALING_HOST,
  }

  const bus = config.network ? Bus(busConfig) : LocalBus(busConfig)

  current = { code, bus, stateCache: null }

  bus.state.sub(() => {
    if (!applyingLocally) {
      remoteUpdateListeners.forEach((fn) => {
        try { fn() } catch (e) { console.error('[sync] remote-update listener failed:', e) }
      })
    }
  })

  return current
}

export function closeCampaign() {
  if (!current) return
  current.bus.close()
  current = null
}

export function openCode() {
  return current?.code ?? null
}

export function currentBus() {
  return current?.bus ?? null
}

// Memoized read view — materialize() re-runs only when the doc changed.
export function getState() {
  if (!current) return materialize(emptyDoc())
  const doc = current.bus.state.get()
  if (!current.stateCache || current.stateCache.doc !== doc) {
    current.stateCache = { doc, state: materialize(doc) }
  }
  return current.stateCache.state
}

// Apply a list of effects as one atomic op: merge locally, persist, and
// broadcast to connected peers (buffered by crdtbus until they connect).
export function applyEffects(effects) {
  if (!current) throw new Error('No open campaign')
  if (!effects.length) return
  const doc = current.bus.state.get()
  const { id, op } = makeOp({
    agentId: agentId(),
    lamport: maxLamport(doc) + 1,
    effects,
  })
  applyingLocally = true
  try {
    current.bus.apply({ v: doc.v ?? 1, ops: { [id]: op } })
  } finally {
    applyingLocally = false
  }
}

// Wait until the open document contains data (e.g. joining a campaign that
// only exists on other peers). Resolves true as soon as ops arrive, false on
// timeout. If the local doc already has ops, resolves immediately.
export function waitForCampaignData(timeoutMs = 8000) {
  if (!current) return Promise.resolve(false)
  const hasData = () => Object.keys(current.bus.state.get().ops ?? {}).length > 0
  if (hasData()) return Promise.resolve(true)
  // Without networking (tests, unsupported browsers) no peer will ever
  // deliver data — waiting out the timeout would just stall the caller.
  if (!config.network) return Promise.resolve(false)

  return new Promise((resolve) => {
    const bus = current.bus
    const timer = setTimeout(() => {
      bus.state.unsub(check)
      resolve(false)
    }, timeoutMs)
    function check() {
      if (hasData()) {
        clearTimeout(timer)
        bus.state.unsub(check)
        resolve(true)
      }
    }
    bus.state.sub(check)
  })
}
