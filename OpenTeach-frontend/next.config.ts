import type { NextConfig } from 'next';

const isVercelBuild = Boolean(process.env.VERCEL);

/**
 * OpenTeach-frontend 对接 OpenTeach（DSH 插件）后端。
 *
 * 本包直接移植自 OpenMAIC 前端，客户端仍以相对路径 `/api/*` 发起请求。
 * 设置 `OPENTEACH_API_BASE`（如 `http://127.0.0.1:8787`）后，`beforeFiles`
 * 重写会把 `/api/*` 在进入本应用自身的路由处理器之前转发到 OpenTeach 后端，
 * 从而绕过 Next.js 自带的 API 路由；未设置时保持原状（回落到自带路由，自给自足）。
 */
const openTeachApiBase = process.env.OPENTEACH_API_BASE?.trim().replace(/\/+$/, '');

const nextConfig: NextConfig = {
  env: {
    // Pin even the unset/default value in both client and server bundles.
    // A runtime-only override must not disable the route the built client uses.
    NEXT_PUBLIC_PI_CHAT_ENABLED: process.env.NEXT_PUBLIC_PI_CHAT_ENABLED ?? '',
  },
  output: process.env.VERCEL ? undefined : 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      'lib/server/agent-runtime/import-pptx-worker.mjs',
      'skills/openmaic/**',
      'skills/agent-runtime/**',
      // Loaded through a runtime-only `import('undici')` (see the LLM
      // dispatcher in lib/ai/providers.ts and the Google proxy transport), so
      // the output tracer never sees it and standalone builds ship without it.
      'node_modules/undici/**',
      // sharp's native libvips libraries are loaded via dlopen and are not
      // statically analyzable, so Next.js standalone tracing omits them. Two
      // sharp versions resolve in the tree (0.34.5 transitive -> libvips
      // 1.2.4, 0.35.4 direct -> libvips 1.3.3); tracing picked the wrong one
      // and the runtime dlopen of sharp 0.35.4 failed with
      // "libvips-cpp.so.8.18.6: No such file or directory" on self-hosted
      // Docker (Alpine/musl) deployments. Force-include every sharp-libvips
      // native lib dir for standalone builds. Vercel packages its runtime
      // dependencies itself; including every native variant there bloats each
      // traced function and can push Hobby deployments past 12 bundles.
      ...(!isVercelBuild
        ? ['node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/sharp-libvips-*/lib/**']
        : []),
    ],
  },
  typescript: {
    tsconfigPath: process.env.NODE_ENV === 'production' ? 'tsconfig.build.json' : 'tsconfig.json',
  },
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@openmaic/generation',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    proxyClientMaxBodySize: '200mb',
    // Next 的 rewrite 代理默认把上游请求限在 30s
    // （next/dist/server/lib/router-utils/proxy-request.js:
    //  `proxyTimeout: proxyTimeout === null ? undefined : proxyTimeout || 30000`），
    // 于是 `/api/generate/scene-content` 这类非流式重 LLM 阶段会被砍成
    // `socket hang up`（SSE 阶段有心跳保活，不受影响）。这里放宽到 10 分钟。
    proxyTimeout: 600_000,
  },
  async rewrites() {
    if (!openTeachApiBase) return [];
    return {
      beforeFiles: [{ source: '/api/:path*', destination: `${openTeachApiBase}/api/:path*` }],
    };
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
