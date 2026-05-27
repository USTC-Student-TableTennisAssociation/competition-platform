import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/matchs/[id]/certificate": [
      "./assets/fonts/**",
      "./node_modules/pdfkit/js/data/**",
    ],
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://res.cloudinary.com",
      "font-src 'self' data:",
      isProd
        ? "connect-src 'self'"
        : "connect-src 'self' ws: wss: http: https:",
      "frame-src 'none'",
      ...(isProd ? ["upgrade-insecure-requests"] : []),
    ].join('; ')

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["kedappclub.xyz", "www.kedappclub.xyz"],
    },
  },
};

export default nextConfig;
