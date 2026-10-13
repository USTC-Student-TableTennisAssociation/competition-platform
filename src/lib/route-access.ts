const PUBLIC_ROUTES = ['/auth', '/api/csrf-token', '/api/site-status', '/api/health', '/closed']

export function isRouteWithin(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function isPublicRoute(pathname: string) {
  if (PUBLIC_ROUTES.some((prefix) => isRouteWithin(pathname, prefix))) return true
  if (isRouteWithin(pathname, '/_next')) return true
  if (['/favicon.ico', '/robots.txt'].includes(pathname)) return true
  // Only actual asset namespaces bypass login; dots in a business URL do not.
  return /^\/(?:SVG|supermarket)\/[A-Za-z0-9_-]+\.(?:svg|png|jpe?g|webp|gif)$/i.test(pathname) ||
    /^\/uploads\/(?:avatars|supermarket)\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif)$/i.test(pathname)
}
