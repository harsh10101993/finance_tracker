import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { guest: true } },
  { path: '/signup', name: 'signup', component: () => import('../views/SignupView.vue'), meta: { guest: true } },
  { path: '/forgot-password', name: 'forgot', component: () => import('../views/ForgotPasswordView.vue'), meta: { guest: true } },
  { path: '/dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { auth: true } },
  { path: '/transactions', name: 'transactions', component: () => import('../views/TransactionsView.vue'), meta: { auth: true } },
  { path: '/profile', name: 'profile', component: () => import('../views/ProfileView.vue'), meta: { auth: true } },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { auth: true } },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (auth.loading) await auth.init().catch(() => {})
  if (to.meta.auth && !auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.meta.guest && auth.isAuthenticated) return { name: 'dashboard' }
  return true
})

export default router
