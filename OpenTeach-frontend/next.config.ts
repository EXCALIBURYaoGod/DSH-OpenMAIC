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
  // Pin the project root so Next does not walk up to /workspace (a multi-repo
  // directory far larger than this app). Without this, tracing and file watching
  // escape the project directory.
  outputFileTracingRoot: process.cwd(),
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
  // Sandbox constraints: the OS inotify watch limit is low and read-only here,
  // so Turbopack's native watcher aborts with "OS file watch limit reached".
  // Running `next dev --webpack` with watchOptions.poll avoids inotify entirely.
  // The client-side `fs: false` fallback keeps `await import('fs')` (guarded by
  // `typeof window === 'undefined'` in comfyui-workflows.ts / the ComfyUI
  // adapter) resolvable instead of failing with "Can't resolve 'fs'".
  webpack: (config, { dev, isServer, nextRuntime, webpack }) => {
    // Source maps are the single largest avoidable string allocation during a
    // dev compile; dropping them keeps peak memory under the 4 GiB cap.
    if (dev) config.devtool = false;
    // Sandbox memory budget (4 GiB cgroup) vs. this app's many-module client
    // graph: the first compile of `/` alone needs ~3.7 GiB. Two avoidable
    // consumers tip it over and are dropped here in dev only:
    //   1. webpack's in-memory cache keeps a serialized copy of every module,
    //      which is hundreds of MB for a graph this size (HMR rebuilds get
    //      slower, but the first compile must fit);
    //   2. the export/usage analyses allocate per-module `ExportsInfo` maps
    //      that scale with the graph. They are pure optimizations, so skipping
    //      them changes nothing functionally in a dev build.
    if (dev) {
      config.cache = false;
      config.optimization = {
        ...config.optimization,
        providedExports: false,
        usedExports: false,
        innerGraph: false,
        concatenateModules: false,
        sideEffects: false,
        mangleExports: false,
        emitOnErrors: true,
      };
    }
    // `nextRuntime === 'edge'` is the key case: the Edge bundle has no window
    // (so the `typeof window === 'undefined'` guard does not eliminate the
    // branch) yet also has no `fs`/`path`, so those dynamic imports must
    // resolve to an empty module there.
    if (!isServer || nextRuntime === 'edge') {
      config.resolve = config.resolve ?? {};
      // Node builtins reachable from server-only modules (the agent runtime
      // that `instrumentation.ts` pulls in, media/pdf adapters, …). They must
      // resolve to an empty module in the Edge/browser bundles, where the
      // `NEXT_RUNTIME === 'nodejs'`-gated code paths that use them never run.
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        path: false,
        crypto: false,
        os: false,
        stream: false,
        util: false,
        events: false,
        assert: false,
        url: false,
        buffer: false,
        string_decoder: false,
        timers: false,
        punycode: false,
        child_process: false,
        worker_threads: false,
        net: false,
        tls: false,
        dns: false,
        http: false,
        https: false,
        http2: false,
        zlib: false,
        readline: false,
        tty: false,
        v8: false,
        vm: false,
        module: false,
        repl: false,
        cluster: false,
        dgram: false,
        inspector: false,
        async_hooks: false,
        perf_hooks: false,
        querystring: false,
        domain: false,
        constants: false,
        trace_events: false,
        console: false,
        sqlite: false,
        test: false,
        sea: false,
        sys: false,
        wasi: false,
        diagnostics_channel: false,
        'fs/promises': false,
        'stream/promises': false,
        'stream/web': false,
        'stream/consumers': false,
        'dns/promises': false,
        'readline/promises': false,
        'timers/promises': false,
        'util/types': false,
        'assert/strict': false,
        'inspector/promises': false,
        'path/posix': false,
        'path/win32': false,
        'test/reporters': false,
      };
      // `import('node:child_process')` etc. use the `node:` URI scheme, which
      // webpack's resolver does not route through `resolve.fallback` (it raises
      // UnhandledSchemeError instead). Strip the prefix so the fallbacks above
      // handle them. `resolve.fallback: false` yields an empty module (named
      // imports become `undefined`) without the hard "not exported" error a
      // `data:` stub would raise — and the callers are gated on the Node
      // runtime, so they never execute in the Edge/browser bundles.
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '');
        }),
      );
    }
    // The Edge build of `instrumentation.ts` is what actually OOMs: unlike the
    // Node build, `serverExternalPackages` does not apply there, so webpack
    // would bundle the entire agent runtime (pi-ai, ali-oss, undici, pdf and
    // media SDKs, …) into the Edge bundle just to prove it resolves. Those
    // imports sit behind the `NEXT_RUNTIME === 'nodejs'` early-return and are
    // never loaded in Edge, so externalise them and skip the traversal — this
    // is the difference between ~4 GB and a few hundred MB of peak heap.
    if (nextRuntime === 'edge') {
      const EDGE_EXTERNAL_PREFIXES = [
        '@earendil-works',
        '@openmaic',
        '@alicloud',
        '@aws-sdk',
        '@aws-crypto',
        '@modelcontextprotocol',
        '@langchain',
        '@copilotkit',
        '@napi-rs',
        '@electric-sql',
        '@mozilla',
        'copilotkit',
        'undici',
        'pg',
        'sharp',
        'pptxgenjs',
        'pptxtojson',
        'unpdf',
        'pdf-lib',
        'docx',
        'exceljs',
        'shiki',
        'echarts',
        'katex',
        'sanitize-html',
        'jszip',
        'linkedom',
        'ai',
        '@ai-sdk',
        'openai',
      ];
      const existingExternals = config.externals
        ? Array.isArray(config.externals)
          ? config.externals
          : [config.externals]
        : [];
      config.externals = [
        ...existingExternals,
        ({ request }, callback) => {
          if (!request) return callback();
          const isHeavy = EDGE_EXTERNAL_PREFIXES.some(
            (prefix) => request === prefix || request.startsWith(`${prefix}/`),
          );
          return isHeavy ? callback(null, `commonjs ${request}`) : callback();
        },
      ];
    }
    config.watchOptions = {
      ...(config.watchOptions ?? {}),
      ignored: ['**/node_modules/**', '**/.git/**', '**/.next/**'],
      poll: 2000,
      aggregateTimeout: 500,
    };
    return config;
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
    // `pg` (and its optional native binding, which is absent here) is only ever
    // used server-side; loading it natively keeps it out of the bundled server
    // graph and silences the "Can't resolve 'pg-native'" warning.
    'pg',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    // The sandbox caps the container at 4 GiB and the many-module client graph
    // otherwise peaks above it (OOM-killed mid-compile). This trades build CPU
    // for a smaller webpack peak heap, which is what we need here.
    webpackMemoryOptimizations: true,
    // The dev server otherwise preloads every page's modules at boot, which
    // for this app is a large fixed footprint before a single request arrives.
    // Load routes on demand instead — the first request pays the cost.
    preloadEntriesOnStart: false,
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
