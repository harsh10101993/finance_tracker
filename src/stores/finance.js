import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../lib/financeApi.js'
import { useAuthStore } from './auth.js'

export const useFinanceStore = defineStore('finance', () => {
  const auth = useAuthStore()
  const stats = ref(null)
  const monthly = ref([])
  const breakdown = ref([])
  const transactions = ref([])
  const categories = ref([])
  const profile = ref(null)
  const settings = ref(null)
  const loading = ref(false)
  const error = ref('')
  const month = ref(new Date().getMonth() + 1)
  const year = ref(new Date().getFullYear())

  const currency = computed(() => settings.value?.currency || profile.value?.currency || 'INR')

  async function refreshAll() {
    if (!auth.user) return
    loading.value = true; error.value = ''
    try {
      const uid = auth.user.id
      const [s, m, b, t, c, p, st] = await Promise.all([
        api.getDashboardStats(uid, month.value, year.value),
        api.getMonthlySummary(uid, 6),
        api.getCategoryBreakdown(uid, month.value, year.value, 'expense'),
        api.listTransactions(uid, { limit: 100 }),
        api.listCategories(uid),
        api.getProfile(uid),
        api.getSettings(uid)
      ])
      stats.value = s; monthly.value = m; breakdown.value = b
      transactions.value = t; categories.value = c; profile.value = p; settings.value = st
      if (p?.full_name) auth.user.full_name = p.full_name
    } catch (e) { error.value = e.message }
    finally { loading.value = false }
  }

  async function addTransaction(payload) {
    await api.createTransaction(auth.user.id, payload)
    await refreshAll()
  }
  async function editTransaction(id, payload) {
    await api.updateTransaction(auth.user.id, id, payload)
    await refreshAll()
  }
  async function removeTransaction(id) {
    await api.deleteTransaction(auth.user.id, id)
    await refreshAll()
  }
  async function addCategory(payload) {
    await api.createCategory(auth.user.id, payload)
    await refreshAll()
  }
  async function saveProfile(payload) {
    profile.value = await api.upsertProfile(auth.user.id, payload)
    if (payload.full_name) auth.user.full_name = payload.full_name
  }
  async function saveSettings(payload) {
    settings.value = await api.upsertSettings(auth.user.id, payload)
  }
  function setMonth(y, m) { year.value = y; month.value = m; refreshAll() }

  return {
    stats, monthly, breakdown, transactions, categories, profile, settings,
    loading, error, month, year, currency,
    refreshAll, addTransaction, editTransaction, removeTransaction,
    addCategory, saveProfile, saveSettings, setMonth
  }
})
