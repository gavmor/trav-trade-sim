# Traveller Trade Simulator

A Morningstar-style speculative trade dashboard for Classic Traveller, built on live data from the [Traveller Map API](https://travellermap.com).

## Features

- **Sector & world browser** — browse all sectors across multiple milieus (1105 Classic Era through Year 1900)
- **Speculative trade engine** — Classic Traveller Book 7 and T5 rules; buy/sell cargo with deterministic pricing driven by world trade codes
- **Passengers** — book High, Middle, and Low passage with automatic fare collection; manifests auto-deliver on arrival; referee can issue refunds
- **Fuel purchasing** — refined/unrefined fuel priced by starport class with tank capacity tracking; fill-level bar and "Fill for jump" shortcut
- **Mail contracts** — accept Imperial mail contracts for on-delivery payment (CT7 flat; T5 per-parsec)
- **Price history charts** — candlestick charts with Weekly, Monthly, Annual, and Realized (actual trade prices) time frames
- **Campaign management** — multi-player campaigns with a short campaign code + mandatory PIN (no email, no PII stored)
- **Market events** — M.U.L.E.-style local and subsector events with independent buy/sell modifiers; 20-entry referee catalogue
- **Imperial Calendar** — DDD-YYYY format; 1 tick = 1 jump-week; auto-delivery of passengers and mail on ship arrival

## License & Copyright Notice

The **application code** in this repository is licensed under the [Apache License 2.0](LICENSE.md).

The **Traveller game rules and trade mechanics** implemented here are based on Classic Traveller Books 2 and 7, copyright © Game Designers' Workshop / Far Future Enterprises. Used with permission from Marc Miller for non-commercial purposes only.

**This application must remain non-commercial.** Do not use it as part of any paid product or service.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vue 3 (Composition API + SFC), Pinia, Vue Router |
| Build | Vite |
| Multiplayer sync | [crdtbus](https://github.com/Taliesinsoftworks/crdtbus) — p2p CRDT sync over WebRTC (PeerJS) |
| Persistence | IndexedDB (per-campaign op-log document in each player's browser) |
| Charts | lightweight-charts (TradingView OSS) |
| Hosting | GitHub Pages (static frontend — no backend) |

## How multiplayer works

There is no server and no database. Each campaign is a CRDT document — an
append-only log of operations (trades, bookings, tick advances, …) — stored in
every participant's browser (IndexedDB) and synced peer-to-peer over WebRTC by
a vendored copy of [crdtbus](https://github.com/Taliesinsoftworks/crdtbus)
(`src/lib/crdt/`). The campaign code is the sync topic: everyone who enters
the same code merges into the same document. Peers discover each other through
a PeerJS signaling server (defaults to the public PeerJS cloud; override with
`VITE_PEERJS_HOST`); actual game data flows browser-to-browser.

Consequences worth knowing:

- **Someone must be online to sync from.** Joining or logging into a campaign
  from a new browser requires at least one other campaign member to have the
  app open — their browser is where the campaign lives.
- **Treat the campaign code like an invite link.** PINs still gate which
  character you play, but they're enforced client-side; anyone with the code
  can read campaign data.
- **Offline works.** With no peers online you can keep playing; your ops are
  buffered and everything reconciles when peers reconnect (conflicting edits
  resolve deterministically — credit changes are additive, field edits are
  last-writer-wins).

## Setup

### Prerequisites

- Node.js 20+

### Local development

```bash
npm install
npm run dev
```

### Deploy

```bash
# Push to master — GitHub Actions deploys to GitHub Pages
npm run build
```

### Verifying two-browser sync manually

1. `npm run dev`, open the app in a normal window, create a campaign.
2. Open the same URL in a private/incognito window (a separate browser
   context), pick **Join Campaign**, and enter the same campaign code.
3. Trade or advance the tick in one window — the other window's calendar,
   credits, and market panels update within a few seconds.

## Project Structure

```
src/
  lib/
    api.js               # Local API client — same interface as the old HTTP client
    backend/             # Route handlers (ported from the Cloudflare Worker)
      router.js          # Path matching + auth guards
      campaigns.js       # Campaign lifecycle, login, PIN recovery
      ships.js           # Trade, passengers, fuel, mail, freight, debts
      ...                # calendar, market, referee, reports, organizations
      session.js         # Local (browser-only) session tokens
      hash.js            # PBKDF2 PIN hashing (Web Crypto API)
    crdt/
      bus.js             # Vendored crdtbus (p2p sync over PeerJS/WebRTC)
      doc.js             # Campaign op-log CRDT: merge, total order, materialize
      store.js           # Open campaign, IndexedDB persistence, remote updates
    traveller-data.js    # CT lookup tables, Book 2 goods, Book 7 price tables
    traveller-helpers.js # UWP decode, sector parsing, route parsing
    trade-engine-ct7.js  # CT Book 7 trade rules (pure functions)
  stores/
    map.js               # Pinia store — sector/world browser state
  assets/
    style.css            # Dark space theme
  App.vue
  main.js
```
