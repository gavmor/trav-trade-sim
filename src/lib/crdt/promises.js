// Vendored from crdtbus v2.0.1 (https://github.com/Taliesinsoftworks/crdtbus)
// MIT License © Taliesin Softworks.

export function resolvablePromise() {
  let resolve = () => {}
  const promise = new Promise((_resolve) => (resolve = _resolve))
  return [promise, resolve]
}

export function waitForMilliseconds(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis))
}
