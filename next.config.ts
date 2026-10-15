import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pdfkit", "exceljs", "baileys", "pino", "pino-pretty", "bullmq", "ioredis", "@prisma/client"],
  // Arquivos lidos em tempo de execução que o rastreamento do build standalone não detecta:
  // - fontes padrão do pdfkit (standard-fonts/*.cjs e métricas .afm);
  // - entradas "module-sync" (require.mjs) de generator-function/async-function, usadas pelo
  //   exceljs no Node 22+.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/data/**/*",
      "./node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/standard-fonts/**/*",
      "./node_modules/.pnpm/generator-function@*/node_modules/generator-function/**/*",
      "./node_modules/.pnpm/async-function@*/node_modules/async-function/**/*",
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
