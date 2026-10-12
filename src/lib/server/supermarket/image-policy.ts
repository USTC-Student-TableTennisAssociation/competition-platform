/** Sources compatible with the site's image CSP. Uploads never accept SVG. */
export function isPrizeImageUrl(value: string): boolean {
  if (value.length > 2048 || value !== value.trim()) return false
  if (/^\/(?:supermarket|uploads\/supermarket)\/[A-Za-z0-9_/-]+\.(?:png|jpe?g|webp|gif|svg)$/.test(value)) {
    return true
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' &&
      !url.port && !url.username && !url.password &&
      url.pathname.includes('/image/upload/')
  } catch {
    return false
  }
}

export const MAX_PRIZE_IMAGE_BYTES = 2 * 1024 * 1024

export function prizeImageExtension(type: string, bytes: Uint8Array): string | null {
  const signature = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end))
  if (type === 'image/jpeg' && bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (type === 'image/png' && bytes.length >= 8 &&
    [137,80,78,71,13,10,26,10].every((byte,i) => bytes[i] === byte)) return 'png'
  if (type === 'image/webp' && bytes.length >= 12 &&
    signature(0,4) === 'RIFF' && signature(8,12) === 'WEBP') return 'webp'
  return null
}

export function isLocalSupermarketDatabase(databaseUrl = process.env.DATABASE_URL): boolean {
  if (!databaseUrl) return false
  try {
    const url = new URL(databaseUrl)
    return ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['localhost','127.0.0.1','[::1]'].includes(url.hostname) &&
      url.pathname === '/ustctta_v2'
  } catch {
    return false
  }
}
