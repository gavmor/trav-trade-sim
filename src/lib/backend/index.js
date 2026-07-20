// The local backend: importing this module registers every route handler
// with the router — the equivalent of the old Worker's index.js wiring the
// Hono sub-apps together.

import './campaigns.js'
import './calendar.js'
import './market.js'
import './ships.js'
import './referee.js'
import './reports.js'
import './organizations.js'

export { dispatch } from './router.js'
