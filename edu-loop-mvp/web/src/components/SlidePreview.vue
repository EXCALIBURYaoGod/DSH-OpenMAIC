<script setup lang="ts">
/**
 * SlidePreview.vue：Vue↔React 桥接，用 @openmaic/renderer 的 SlideCanvas 渲染
 * PPTist 风格 SlideDeck。采用 defineAsyncComponent 懒加载 React 段，失败时显示
 * 占位而不阻断讲解主流程。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElButton, ElSkeleton, ElEmpty } from 'element-plus'
import type { SlideDeck } from '@/api/types'

const props = defineProps<{ deck: SlideDeck | null }>()

const container = ref<HTMLDivElement | null>(null)
const slideIndex = ref(0)
const loading = ref(false)
const renderFailed = ref(false)

const slides = computed(() => props.deck?.slides ?? [])
const current = computed(() => slides.value[slideIndex.value] ?? null)

watch(
  () => props.deck,
  async () => {
    slideIndex.value = 0
    // deck 到位时容器可能尚未渲染（watcher 默认在 DOM 更新前触发），
    // 必须等下一帧再画，否则首屏是一块空白。
    await nextTick()
    paint()
  },
)

let root: { unmount: () => void } | null = null
let rootEl: HTMLElement | null = null
let _rootRender: ((slide: SlideDeck['slides'][number]) => void) | null = null

/**
 * 在当前容器上渲染某页。React root 惰性创建，并在容器元素变化时重新绑定——
 * 容器被 v-if 分支重建后，旧 root 已脱离 DOM，继续 render 不会显示任何内容。
 */
function paint(): void {
  const el = container.value
  const slide = current.value
  if (el === null || slide === null) return
  const api = reactApi
  if (api === null) return
  if (root === null || rootEl !== el) {
    root?.unmount()
    const r = api.createRoot(el)
    root = { unmount: () => r.unmount() }
    rootEl = el
    _rootRender = (s) => r.render(api.createElement(api.SlideCanvas, { slide: s, chrome: false }))
  }
  if (_rootRender === null) return
  _rootRender(slide)
}

/** React 模块句柄（一次性加载）。 */
let reactApi: {
  createElement: (comp: unknown, props: unknown) => unknown
  createRoot: (el: HTMLElement) => { render: (node: unknown) => void; unmount: () => void }
  SlideCanvas: unknown
} | null = null

/** 运行时加载 React + renderer 模块（只加载模块，不碰容器）。返回 null 表示降级。 */
async function loadReactModules(): Promise<boolean> {
  try {
    const reactMod = (await import('react')) as {
      createElement: (comp: unknown, props: unknown) => unknown
    }
    const reactDomMod = (await import('react-dom/client')) as {
      createRoot: (el: HTMLElement) => { render: (node: unknown) => void; unmount: () => void }
    }
    const rendererMod = (await import('@openmaic/renderer')) as { SlideCanvas: unknown }
    if (
      rendererMod.SlideCanvas === undefined ||
      typeof reactMod.createElement !== 'function' ||
      typeof reactDomMod.createRoot !== 'function'
    ) {
      return false
    }
    reactApi = { ...reactMod, createRoot: reactDomMod.createRoot, SlideCanvas: rendererMod.SlideCanvas }
    return true
  } catch (error) {
    console.error('[SlidePreview] renderer 模块加载失败:', error)
    return false
  }
}

onMounted(async () => {
  loading.value = true
  renderFailed.value = false
  const ok = await loadReactModules()
  loading.value = false
  if (!ok) {
    renderFailed.value = true
    return
  }
  // 等容器挂载（deck 有内容时 v-else 分支渲染 container）后再绘制。
  await nextTick()
  paint()
})

onBeforeUnmount(() => {
  root?.unmount()
  root = null
  rootEl = null
})

watch(slideIndex, () => paint())

function prev(): void {
  if (slideIndex.value > 0) slideIndex.value -= 1
}

function next(): void {
  if (slideIndex.value < slides.value.length - 1) slideIndex.value += 1
}
</script>

<template>
  <div class="slide-preview">
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="renderFailed" description="幻灯片渲染组件未就绪，暂无法预览" :image-size="80">
      <p class="fallback-hint">讲解正文不受影响，可正常查看。</p>
    </el-empty>
    <template v-else-if="slides.length > 0">
      <div ref="container" class="canvas" />
      <div class="toolbar">
        <el-button size="small" :disabled="slideIndex <= 0" @click="prev">上一页</el-button>
        <span class="page-indicator">{{ slideIndex + 1 }} / {{ slides.length }}</span>
        <el-button size="small" :disabled="slideIndex >= slides.length - 1" @click="next">下一页</el-button>
      </div>
    </template>
    <el-empty v-else description="暂无幻灯片，点击「生成幻灯片」创建预览" :image-size="80" />
  </div>
</template>

<style scoped>
.slide-preview {
  width: 100%;
}

.canvas {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #f5f7fa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}

.canvas :deep(> div) {
  width: 100%;
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 10px;
}

.page-indicator {
  font-size: 13px;
  color: var(--muted);
}

.fallback-hint {
  font-size: 12px;
  color: var(--muted);
}
</style>