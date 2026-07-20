// PBKDF2 password hashing via the Web Crypto API (no npm dependency).
// Format stored in the campaign doc: "pbkdf2:<iterations>:<saltHex>:<hashHex>"
// Moved verbatim from the retired Cloudflare Worker (worker/src/lib/hash.js)
// so existing PIN hashes remain verifiable after a campaign doc is imported.

const ITERATIONS = 10_000
const HASH_ALG   = 'SHA-256'

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)))
}

export async function hashPin(pin) {
  const salt   = crypto.getRandomValues(new Uint8Array(16))
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: HASH_ALG }, keyMat, 256)
  return `pbkdf2:${ITERATIONS}:${toHex(salt)}:${toHex(bits)}`
}

export async function verifyPin(pin, stored) {
  const parts = stored.split(':')
  if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false
  const [, iters, saltHex, hashHex] = parts
  const salt   = fromHex(saltHex)
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: parseInt(iters), hash: HASH_ALG }, keyMat, 256)
  return toHex(bits) === hashHex
}
