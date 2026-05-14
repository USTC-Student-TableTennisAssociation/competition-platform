type RateLimitWindow = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitWindow>()

function now() {
  return Date.now()
}

function gc() {
  const ts = now()
  for (const [key, value] of store.entries()) {
    if (value.resetAt <= ts) {
      store.delete(key)
    }
  }
}

export function hitRateLimit(key: string, options: { maxHits: number; windowMs: number }) {
  const ts = now()
  const current = store.get(key)

  if (!current || current.resetAt <= ts) {
    store.set(key, {
      count: 1,
      resetAt: ts + options.windowMs,
    })
    return false
  }

  if (current.count >= options.maxHits) {
    return true
  }

  current.count += 1
  store.set(key, current)

  if (store.size > 2000) {
    gc()
  }

  return false
}
