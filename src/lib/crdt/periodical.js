// Vendored from crdtbus v2.0.1 (https://github.com/Taliesinsoftworks/crdtbus)
// MIT License © Taliesin Softworks. TypeScript types stripped, inline
// @benchristel/taste tests removed — see the upstream repo for both.

export function createPeriodical(val) {
  const pubsub = createPubSub()
  return {
    get: () => val,
    pub: (newVal) => {
      val = newVal
      pubsub.pub(newVal)
    },
    sub: pubsub.sub,
    unsub: pubsub.unsub,
  }
}

export function next(periodical) {
  const [promise, resolve] = resolvablePromiseInternal()
  periodical.sub(resolve)
  promise.then(() => periodical.unsub(resolve))
  return promise
}

export function createPubSub() {
  const subs = new Set()
  return {
    pub: (val) => subs.forEach((sub) => sub(val)),
    sub: (subscriber) => subs.add(subscriber),
    unsub: (subscriber) => subs.delete(subscriber),
  }
}

function resolvablePromiseInternal() {
  let resolve = () => {}
  const promise = new Promise((_resolve) => (resolve = _resolve))
  return [promise, resolve]
}
