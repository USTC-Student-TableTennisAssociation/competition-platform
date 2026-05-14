function toHash(input: string) {
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

export function toClubId(userId: string) {
  const normalized = userId.replace(/[^a-zA-Z0-9]/g, '')
  const sixDigits = (toHash(normalized) % 1000000).toString().padStart(6, '0')
  return `CLUB-${sixDigits}`
}
