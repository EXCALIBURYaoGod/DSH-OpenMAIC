/**
 * 运行环境状态：向 `/api/health` 读取后端运行模式（development / production）。
 *
 * 评测中心仅开发模式可用：生产模式下后端会屏蔽 `/api/eval`，前端据此隐藏入口
 * 并拦截对应路由，保证界面与接口两端一致。
 *
 * @module stores/system
 */

import { defineStore } from 'pinia'
import { apiGet } from '@/api/client'
import type { AppMode, HealthResponse } from '@/api/types'

export const useSystemStore = defineStore('system', {
  state: () => ({
    loading: false,
    /** 未知时按开发模式处理，避免误藏功能；接口侧仍会拦截。 */
    mode: 'development' as AppMode,
  }),
  getters: {
    /** 评测中心是否可用。 */
    evalEnabled(state): boolean {
      return state.mode === 'development'
    },
  },
  actions: {
    /** 启动时调用：拿到运行模式后再挂载应用与注册路由守卫。 */
    async load(): Promise<void> {
      this.loading = true
      try {
        const data = await apiGet<HealthResponse>('/api/health')
        this.mode = data.mode === 'production' ? 'production' : 'development'
      } catch {
        // 读取失败保持默认（开发模式）。
      } finally {
        this.loading = false
      }
    },
  },
})
