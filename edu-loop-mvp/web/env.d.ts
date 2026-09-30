/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// @openmaic/renderer 源码（TSX）由 Vite 的 resolve.alias 编译，不在 web/src 内做类型检查。
// 此处声明其运行时导出，避免 vue-tsc 追踪 OpenMAIC 源码。
declare module '@openmaic/renderer' {
  export const SlideCanvas: unknown
}