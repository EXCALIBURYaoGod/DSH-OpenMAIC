/**
 * LLM provider 状态：把后端「配置驱动的 provider + 适配器注册表」暴露给 UI。
 *
 * 用户在这里可以切换 provider / model，并直观看到某个 provider 是否处于
 * 「无凭据 → 本地 mock 降级」状态。
 *
 * @module stores/llm
 */

import { defineStore } from 'pinia'
import { apiGet } from '@/api/client'
import type { ProviderInfo, ProvidersResponse } from '@/api/types'

export const useLlmStore = defineStore('llm', {
  state: () => ({
    loading: false,
    error: '',
    defaultProvider: '',
    defaultModel: '',
    providers: [] as ProviderInfo[],
    provider: '',
    model: '',
  }),
  getters: {
    currentProvider(state): ProviderInfo | undefined {
      return state.providers.find(item => item.id === state.provider)
    },
    currentModels(state) {
      return state.providers.find(item => item.id === state.provider)?.models ?? []
    },
    isDegraded(state): boolean {
      return state.providers.find(item => item.id === state.provider)?.degraded === true
    },
    /** 请求体里统一携带的路由信息。 */
    route(state): { provider: string; model: string } {
      return { provider: state.provider, model: state.model }
    },
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const data = await apiGet<ProvidersResponse>('/api/llm/providers')
        this.defaultProvider = data.defaultProvider
        this.defaultModel = data.defaultModel
        this.providers = data.providers
        if (this.provider.length === 0) this.provider = data.defaultProvider
        const models = this.currentModels
        if (this.model.length === 0 || !models.some(item => item.id === this.model)) {
          this.model = models.find(item => item.id === data.defaultModel)?.id ?? models[0]?.id ?? data.defaultModel
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },
    setProvider(provider: string): void {
      this.provider = provider
      const models = this.providers.find(item => item.id === provider)?.models ?? []
      this.model = models[0]?.id ?? ''
    },
  },
})