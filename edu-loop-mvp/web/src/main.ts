import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import { router } from './router'
import { useSystemStore } from './stores/system'
import './styles.css'

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  const pinia = createPinia()

  // 先拿到运行模式，再安装 router 并挂载：生产模式下评测中心的路由与入口都需据此屏蔽。
  const system = useSystemStore(pinia)
  await system.load()

  // 必须在 app.use(router) 之前注册：router 安装时会立即触发首次导航。
  router.beforeEach(to => {
    if (to.name === 'eval' && !system.evalEnabled) return { path: '/course' }
    return true
  })

  app.use(pinia).use(router).use(ElementPlus, { locale: zhCn })
  app.mount('#app')
}

void bootstrap()
