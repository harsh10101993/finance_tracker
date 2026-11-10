import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'
import { useAuthStore } from './stores/auth.js'
import { getPGlite } from './lib/pglite.js'
import './assets/style.css'

async function bootstrap() {
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)

  // Restore session (Supabase Auth or PGlite local account) before first route resolves.
  const auth = useAuthStore()
  try { await auth.init() } catch (err) { console.warn('[auth] init failed:', err) }

  // Warm up the offline database in the background.
  getPGlite().catch(err => console.warn('[PGlite] init failed:', err))

  // Flush the offline queue when connectivity returns.
  window.addEventListener('online', async () => {
    if (!auth.user) return
    try {
      const { flushSyncQueue } = await import('./lib/financeApi.js')
      await flushSyncQueue(auth.user.id)
    } catch { /* retry on next reconnect */ }
  })

  app.mount('#app')
}

bootstrap()
