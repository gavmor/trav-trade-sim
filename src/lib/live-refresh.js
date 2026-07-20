// Live multiplayer refresh — the payoff of the crdtbus migration.
//
// When another campaign member's ops arrive over WebRTC, the relevant Pinia
// stores re-read the (now updated) local campaign document, so the calendar,
// market, and ship panels follow the rest of the table in near-real-time —
// something the old poll-free HTTP architecture never did.

import { onRemoteUpdate, openCampaign } from './crdt/store.js'
import { useAuthStore } from '../stores/auth.js'
import { useTickStore } from '../stores/tick.js'
import { useShipStore } from '../stores/ship.js'

export function initLiveRefresh() {
  const auth = useAuthStore()

  // Reconnect to the campaign swarm on page load — without this, a lone
  // referee tab would only join the swarm after their first action, leaving
  // a window where joining players can't find anyone to sync from.
  if (auth.campaign?.code) {
    openCampaign(auth.campaign.code).catch(e =>
      console.error('[sync] failed to open campaign on startup:', e),
    )
  }

  let timer = null
  onRemoteUpdate(() => {
    // Coalesce bursts (a peer backfilling snapshots applies many ops).
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (!auth.isAuthenticated) return
      const tick = useTickStore()
      const ship = useShipStore()
      await Promise.all([
        tick.loadCalendar(),
        tick.loadActiveEvents(),
        ship.loadShip(auth.player?.id, auth.campaign?.id),
      ])
    }, 300)
  })
}
