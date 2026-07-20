// Vendored from crdtbus v2.0.1 (https://github.com/Taliesinsoftworks/crdtbus)
// MIT License © Taliesin Softworks.
//
// Local extension beyond the published package (pattern from druthers, the
// crdtbus reference app): fetch TURN/STUN credentials before opening the
// peer connection, so WebRTC can relay when both peers sit behind symmetric
// NAT / CGNAT and a direct connection is impossible. The endpoint returns
// short-lived credentials as { iceServers: [...] }. On any failure we fall
// back to PeerJS's built-in defaults (Google STUN, no TURN) — sync then
// works on most home networks but not across carrier-grade NAT.

import Peer from 'peerjs'

const TURN_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TURN_URL !== undefined
    ? import.meta.env.VITE_TURN_URL // set it to "" to disable the fetch
    : 'https://turn-worker.gavmor.workers.dev/api/turn')

async function getIceServers() {
  if (!TURN_URL) return []
  try {
    const res = await fetch(TURN_URL, { method: 'POST' })
    if (res.ok) return (await res.json()).iceServers ?? []
  } catch { /* offline, or this origin isn't allowlisted by the worker */ }
  return []
}

export async function createPeer({ peerId, signalingServerHost }) {
  // Only override PeerJS's ICE config when the worker actually returned
  // servers — passing an empty list would strip its default STUN entries.
  const iceServers = await getIceServers()
  return new Promise((resolve, reject) => {
    const peer = new Peer(peerId, {
      host: signalingServerHost,
      secure: true,
      ...(iceServers.length ? { config: { iceServers } } : {}),
    })
    peer.on('open', () => resolve(peer))
    peer.on('error', reject)
  })
}

export function connect(me, otherPeerId) {
  return new Promise((resolve, reject) => {
    me.on('error', reject)
    const conn = me.connect(otherPeerId, { serialization: 'json' })
    conn.on('error', reject)
    conn.on('close', reject)
    conn.on('open', () => resolve(conn))
  })
}
