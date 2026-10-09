/**
 * tsdown preset for @openteach/bundle：把组装层与 11 个后端模块插件打成 **一个**
 * 自包含的 ESM node 半部（lib/index.js + 声明文件），供 dsh 的 Loader 按包名装载。
 *
 * 外部化策略：`@deepseek-ai/*`（cordis / schemastery / dsh-* 宿主包）保持 external，
 * 由 harness 装载时的模块表解析；本仓库内部的 `@openteach/*` 模块插件与
 * `@openmaic/dsl` 则内联进 bundle，使安装单位只有一个包。
 */
import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // 关闭自动 dts：本包把 11 个 `@openteach/*` 模块插件的**裸 .ts 源码**内联进产物，
    // rolldown-plugin-dts 为它们生成声明时会命中 TS2742（推断类型引用了 schemastery →
    // cosmokit 的非公开路径，无法命名）。声明改由手写的窄接口 `types/index.d.ts` 提供，
    // 与 openmaic-core 的做法一致；运行时消费方（dsh Loader）只读 lib/index.js。
    dts: false,
    clean: true,
    deps: {
      neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
      // 内部模块插件必须内联：它们不是独立发布物，dsh profile 里解析不到。
      alwaysBundle: [/^@openteach\//, /^@openmaic\//],
    },
  },
] satisfies UserConfig[]