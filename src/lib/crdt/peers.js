// Vendored from crdtbus v2.0.1 (https://github.com/Taliesinsoftworks/crdtbus)
// MIT License © Taliesin Softworks.

import Peer from 'peerjs'

export function createPeer({ peerId, signalingServerHost }) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(peerId, {
      host: signalingServerHost,
      secure: true,
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
