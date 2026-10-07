import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'

// @openmaic/renderer 源码位于 OpenMAIC（web 工程外），它 import 的第三方包会从
// 该物理位置向上查找 node_modules 而失败。这里将 renderer 用到的裸模块统一
// alias 回 web 自己的 node_modules，避免安装 OpenMAIC 整棵依赖树。
const ndm = (name: string): string =>
  fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url))

export default defineConfig({
  plugins: [vue(), react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 直接编译 @openmaic/renderer/@openmaic/dsl 源码，避免安装 OpenMAIC 整棵依赖树。
      '@openmaic/renderer': fileURLToPath(
        new URL('../../OpenMAIC/packages/@openmaic/renderer/src/index.ts', import.meta.url),
      ),
      '@openmaic/dsl': fileURLToPath(
        new URL('../../OpenMAIC/packages/@openmaic/dsl/dist/index.js', import.meta.url),
      ),
      // renderer 的外部运行时依赖 → 回指 web/node_modules。
      // 注意：只 alias 顶层包入口，子路径（react/jsx-runtime、react-dom/client、
      // echarts/core、motion/react 等）由各包自身的 exports map 解析，避免预构建失败。
      'react': ndm('react'),
      'react-dom': ndm('react-dom'),
      'clsx': ndm('clsx'),
      'tailwind-merge': ndm('tailwind-merge'),
      'tinycolor2': ndm('tinycolor2'),
      'motion': ndm('motion'),
      'lucide-react': ndm('lucide-react'),
      'echarts': ndm('echarts'),
      'html2canvas-pro': ndm('html2canvas-pro'),
      'html-to-image': ndm('html-to-image'),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})