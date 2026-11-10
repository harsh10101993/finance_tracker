<template>
  <AppLayout>
    <div class="row-between mb-16">
      <h1 style="font-size:26px; letter-spacing:-.02em">Transactions</h1>
      <button class="btn" @click="openAdd">+ Add</button>
    </div>

    <div class="card mb-16">
      <div class="grid grid-2">
        <div class="field" style="margin:0">
          <input class="input" v-model="search" placeholder="🔍 Search description…" @input="debouncedRefresh" />
        </div>
        <div class="field" style="margin:0">
          <select class="input" v-model="typeFilter" @change="finance.refreshAll()">
            <option :value="null">All types</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
      </div>
    </div>

    <div v-if="finance.error" class="alert alert-error">{{ finance.error }}</div>

    <div class="card">
      <div v-if="filtered.length">
        <div class="tx-row" v-for="t in filtered" :key="t.id">
          <span class="tx-ico">{{ catMark(t.category_name || (t.type === 'income' ? 'Income' : 'Expense')) }}</span>
          <div class="tx-main">
            <div class="tx-desc">{{ t.description }}</div>
            <div class="tx-meta">{{ t.category_name || 'Uncategorised' }} · {{ formatDate(t.transaction_date, finance.settings?.date_format) }} · {{ t.payment_method }}</div>
          </div>
          <span class="tx-amt" :class="t.type">{{ formatMoney(t.amount, finance.currency) }}</span>
          <button class="icon-btn" @click="openEdit(t)" aria-label="Edit">✎</button>
          <button class="icon-btn" @click="remove(t)" aria-label="Delete">🗑</button>
        </div>
      </div>
      <div v-else class="empty"><span class="big">○</span>No transactions match.<br /><button class="btn mt-16" @click="openAdd">Add transaction</button></div>
    </div>

    <TransactionModal ref="modal" :open="modalOpen" :editing="editingTx" @close="modalOpen = false" />
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import AppLayout from '../components/AppLayout.vue'
import TransactionModal from '../components/TransactionModal.vue'
import { useFinanceStore } from '../stores/finance.js'
import { formatMoney, formatDate, catMark } from '../lib/utils.js'
import * as api from '../lib/financeApi.js'
import { useAuthStore } from '../stores/auth.js'

const finance = useFinanceStore()
const auth = useAuthStore()
const modalOpen = ref(false)
const editingTx = ref(null)
const modal = ref(null)
const search = ref('')
const typeFilter = ref(null)
let timer = null

const filtered = computed(() => {
  let list = finance.transactions
  if (typeFilter.value) list = list.filter(t => t.type === typeFilter.value)
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase()
    list = list.filter(t => t.description.toLowerCase().includes(q))
  }
  return list
})

onMounted(() => finance.refreshAll())

function debouncedRefresh() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    if (!auth.user) return
    try {
      finance.transactions = await api.listTransactions(auth.user.id, { limit: 200, search: search.value.trim() || null })
    } catch { /* keep cached list */ }
  }, 350)
}

function openAdd() { editingTx.value = null; modalOpen.value = true; modal.value?.openWith(null) }
function openEdit(t) { editingTx.value = t; modalOpen.value = true; modal.value?.openWith(t) }
async function remove(t) {
  if (!confirm(`Delete "${t.description}"?`)) return
  try { await finance.removeTransaction(t.id) } catch (e) { alert(e.message) }
}
</script>
