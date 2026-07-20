// Vendored from crdtbus v2.0.1 (https://github.com/Taliesinsoftworks/crdtbus)
// MIT License © Taliesin Softworks.
//
// Vendored (rather than installed from npm) because the package is published
// only to the GitHub Package Registry, which requires an authenticated
// .npmrc — an unacceptable setup burden for contributors and CI on a public
// GitHub Pages app. TypeScript types and inline @benchristel/taste tests are
// stripped; the runtime logic is otherwise unchanged.
//
// Sync a CRDT across browser tabs or devices — no server, no backend.
// Peers connect directly via WebRTC using PeerJS. The first peer to claim a
// topic on the signaling server becomes the host; the host merges and fans
// out state updates to all clients, and clients send heartbeats so dead
// connections get cleaned up even on browsers that never emit "close".

import { createPeriodical, createPubSub } from './periodical.js'
import { createPeer, connect } from './peers.js'
import { resolvablePromise, waitForMilliseconds } from './promises.js'

export function Bus(config) {
  const initialState = config.load()
  const agentId = config.agentId
  const state = createPeriodical(initialState)
  const updates = createPubSub()
  const networkStatus = createPeriodical('pending')
  const whosOnline = createPeriodical(new Set())

  let network = nullNetwork
  ;(async () =>
    (network = await PeerNetwork(
      agentId,
      config.topic,
      config.signalingServerHost,
      state.get,
      networkStatus.pub,
      whosOnline.pub,
      updates.pub,
    )))()

  updates.sub((patch) => {
    const newState = config.merge(state.get(), patch)
    config.save(newState)
    state.pub(newState)
    self.subscriber()
  })

  const self = {
    id: config.topic,
    state,
    networkStatus,
    whosOnline,
    apply,
    close,
    subscriber: () => {},
    destroy: close,
  }
  return self

  function apply(patch) {
    const newState = config.merge(state.get(), patch)
    config.save(newState)
    state.pub(newState)
    network.send(patch)
    self.subscriber()
  }

  function close() {
    network.disconnect()
  }
}

// ==== PRIVATE STUFF BELOW ==============================

const nullNetwork = {
  send() {},
  disconnect() {},
}

async function PeerNetwork(
  agentId,
  topic,
  signalingServerHost,
  data,
  networkStatus,
  whosOnline,
  update,
) {
  let agent = deadAgent
  let shouldReconnect = true

  const agentConfig = {
    id: agentId,
    topic,
    signalingServerHost,
    onUpdate: update,
    onOnlineAgentsChanged: whosOnline,
    getCurrentState: data,
  }

  ;(async () => {
    while (true) {
      if (!shouldReconnect) break
      agent = await createHost(agentConfig)
      networkStatus('connected')
      await agent.death
      if (!shouldReconnect) break
      networkStatus('reconnecting')
      agent = await createClient(agentConfig)
      networkStatus('connected')
      await agent.death
      if (!shouldReconnect) break
      networkStatus('reconnecting')
      await waitForMilliseconds(2000)
    }
  })()

  return {
    send(d) {
      agent.send(d)
    },
    disconnect() {
      shouldReconnect = false
      agent.disconnect()
    },
  }
}

async function createHost(config) {
  const timeToLiveSeconds = 10
  const connections = new Map()
  const [death, die] = resolvablePromise()

  let peer
  try {
    peer = await createPeer({
      peerId: config.topic,
      signalingServerHost: config.signalingServerHost,
    })
  } catch (e) {
    return deadAgent
  }

  // On Firefox, PeerJS connections don't emit the "close" event. To ensure
  // dead connections get cleaned up anyway, each peer sends heartbeats while
  // it is alive; connections that go quiet for timeToLiveSeconds are closed.
  const cleanupInterval = setInterval(() => {
    let deletedAny = false
    eachConnection((c) => {
      const metadata = connections.get(c)
      if (metadata && --metadata.timeToLive <= 0) {
        c.close()
        connections.delete(c)
        deletedAny = true
      }
    })
    if (deletedAny) tellEveryoneWhosOnline()
  }, 1000)

  // If we get disconnected from the signaling server, the hostId is no longer
  // reserved for us and the next peer to join would claim it, leading to a
  // split-brained state. Destroy the peer to ensure there's only one host.
  peer.on('disconnected', disconnect)
  peer.on('error', disconnect)

  peer.on('connection', (conn) => {
    conn.on('close', () => closeConnection(conn))
    conn.on('error', () => closeConnection(conn))
    conn.on('data', (msg) => {
      switch (msg.type) {
        case 'heartbeat': {
          const metadata = connections.get(conn)
          if (metadata) {
            metadata.timeToLive = timeToLiveSeconds
          }
          break
        }
        case 'hello':
          connections.set(conn, {
            agentId: msg.agentId,
            timeToLive: timeToLiveSeconds,
          })
          conn.send({ type: 'data', data: config.getCurrentState() })
          tellEveryoneWhosOnline()
          break
        case 'data':
          config.onUpdate(msg.data)
          eachConnection((c) => c !== conn && c.send(msg))
          break
      }
    })
  })

  function send(data) {
    eachConnection((c) => c.send({ type: 'data', data }))
  }

  function disconnect() {
    clearInterval(cleanupInterval)
    peer.destroy()
    die()
  }

  function closeConnection(conn) {
    conn.close()
    connections.delete(conn)
    tellEveryoneWhosOnline()
  }

  function tellEveryoneWhosOnline() {
    const agentIds = [
      config.id,
      ...[...connections.values()].map((c) => c.agentId),
    ]
    config.onOnlineAgentsChanged(new Set(agentIds))
    eachConnection((c) =>
      c.send({
        type: 'whosOnline',
        agentIds,
      }),
    )
  }

  function eachConnection(callback) {
    for (const conn of connections.keys()) {
      callback(conn)
    }
  }

  return {
    send,
    disconnect,
    death,
  }
}

async function createClient(config) {
  let heartbeatInterval
  const hostPeerId = config.topic
  let peer
  try {
    peer = await createPeer({ signalingServerHost: config.signalingServerHost })
  } catch (e) {
    console.error('error calling createPeer in createClient:', e)
    return deadAgent
  }

  const [death, die] = resolvablePromise()
  peer.on('error', disconnect)

  let hostConn
  try {
    hostConn = await connect(peer, hostPeerId)
  } catch (e) {
    console.error('error connecting to host in createClient:', e)
    disconnect()
    return {
      send() {},
      disconnect() {},
      death,
    }
  }
  hostConn.on('close', disconnect)
  hostConn.on('error', disconnect)
  hostConn.on('data', (msg) => {
    switch (msg.type) {
      case 'whosOnline':
        config.onOnlineAgentsChanged(new Set(msg.agentIds))
        break
      case 'data':
        config.onUpdate(msg.data)
        break
    }
  })

  hostConn.send({
    type: 'hello',
    agentId: config.id,
  })

  hostConn.send({
    type: 'data',
    data: config.getCurrentState(),
  })

  heartbeatInterval = setInterval(() => {
    hostConn.send({ type: 'heartbeat' })
  }, 5000)

  function send(data) {
    hostConn.send({
      type: 'data',
      data,
    })
  }

  function disconnect() {
    clearInterval(heartbeatInterval)
    peer.destroy()
    die()
  }

  return {
    send,
    disconnect,
    death,
  }
}

const deadAgent = {
  send() {},
  disconnect() {},
  death: Promise.resolve(),
}
