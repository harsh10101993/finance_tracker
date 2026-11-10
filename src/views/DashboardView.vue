<template>
  <AppLayout>
    <div class="row-between mb-16">
      <div>
        <h1 style="font-size:26px; letter-spacing:-.02em">Dashboard</h1>
        <p class="muted small">{{ monthLabel(finance.year, finance.month) }} · Hello, {{ auth.user?.full_name || 'there' }}</p>
      </div>
      <button class="btn" @click="openAdd">+ Add</button>
    </div>

    <div v-if="finance.error" class="alert alert-error">{{ finance.error }}</div>
    <div v-if="finance.loading && !finance.stats" class="empty"><span class="big">◌</span>Loading your finances…</div>

    <template v-else-if="finance.stats">
      <!-- Balance hero -->
      <div class="card card-dark mb-16">
        <div class="stat-label">Total balance</div>
        <div style="font-size:38px; font-weight:900; letter-spacing:-.03em">{{ formatMoney(finance.stats.total_balance, finance.currency) }}</div>
        <div class="grid grid-2 mt-16">
          <div>
            <div class="stat-label">Income (this month)</div>
            <div style="font-size:20px; font-weight:800">+{{ formatMoney(finance.stats.monthly_income, finance.currency) }}</div>
          </div>
          <div>
            <div class="stat-label">Expenses (this month)</div>
            <div style="font-size:20px; font-weight:800">−{{ formatMoney(finance.stats.monthly_expense, finance.currency) }}</div>
          </div>
        </div>
      </div>

      <!-- Stat cards -->
      <div class="grid grid-4 mb-16">
        <div class="card">
          <div class="stat-label">All-time income</div>
          <div class="stat-value">{{ formatMoney(finance.stats.total_income, finance.currency) }}</div>
        </div>
        <div class="card">
          <div class="stat-label">All-time expenses</div>
          <div class="stat-value">{{ formatMoney(finance.stats.total_expense, finance.currency) }}</div>
        </div>
        <div class="card">
          <div class="stat-label">Savings rate</div>
          <div class="stat-value">{{ finance.stats.savings_rate }}%</div>
          <div class="stat-sub">this month</div>
        </div>
        <div class="card">
          <div class="stat-label">Transactions</div>
          <div class="stat-value">{{ finance.stats.transaction_count }}</div>
          <div class="stat-sub">this month</div>
        </div>
      </div>

      <div class="grid grid-2">
        <!-- Monthly bars -->
        <div class="card">
          <h3 class="mb-8">Last 6 months</h3>
          <div class="month-bars" v-if="finance.monthly.length">
            <div class="month-col" v-for="m in finance.monthly" :key="m.month_start">
              <div class="stack">
                <div class="seg-income" :style="{ height: barH(m.total_income) }"></div>
                <div class="seg-expense" :style="{ height: barH(m.total_expense) }"></div>
              </div>
              <span class="mlabel">{{ shortMonth(m.month_start) }}</span>
            </div>
          </div>
          <p v-else class="muted small">No data yet — add your first transaction.</p>
          <div class="small mt-8"><span class="legend-dot" style="display:inline-block; vertical-align:middle"></span> Income &nbsp; <span class="legend-dot" style="display:inline-block; vertical-align:middle; background:#ccc"></span> Expenses</div>
        </div>

        <!-- Category breakdown -->
        <div class="card">
          <h3 class="mb-8">Spending by category</h3>
          <div v-if="finance.breakdown.length">
            <div class="legend-row" v-for="b in finance.breakdown" :key="b.category_id || b.category_name">
              <span class="legend-dot" :style="{ background: b.category_shade || '#000' }"></span>
              <span>{{ catMark(b.category_name) }} &nbsp;{{ b.category_name }}</span>
              <span class="spacer"></span>
              <strong>{{ formatMoney(b.total, finance.currency) }}</strong>
              <span class="muted small">({{ b.pct }}%)</span>
            </div>
            <div class="mt-16" v-for="b in finance.breakdown.slice(0, 5)" :key="'bar' + (b.category_id || b.category_name)">
              <div class="bar-track"><div class="bar-fill" :style="{ width: b.pct + '%' }"></div></div>
            </div>
          </div>
          <p v-else class="muted small">No expenses this month yet.</p>
        </div>
      </div>

      <!-- Recent -->
      <div class="card mt-16">
        <div class="row-between mb-8">
          <h3>Recent activity</h3>
          <router-link to="/transactions" class="small">View all →</router-link>
        </div>
        <div v-if="finance.transactions.length">
          <div class="tx-row" v-for="t in finance.transactions.slice(0, 5)" :key="t.id">
            <span class="tx-ico">{{ catMark(t.category_name || (t.type === 'income' ? 'Income' : 'Expense')) }}</span>
            <div class="tx-main">
              <div class="tx-desc">{{ t.description }}</div>
              <div class="tx-meta">{{ t.category_name || 'Uncategorised' }} · {{ formatDate(t.transaction_date, finance.settings?.date_format) }}</div>
            </div>
            <span class="tx-amt" :class="t.type">{{ formatMoney(t.amount, finance.currency) }}</span>
          </div>
        </div>
        <div v-else class="empty"><span class="big">○</span>No transactions yet.<br /><button class="btn mt-16" @click="openAdd">Add your first transaction</button></div>
      </div>
    </template>

    <TransactionModal ref="modal" :open="modalOpen" :editing="editingTx" @close="modalOpen = false" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import AppLayout from '../components/AppLayout.vue'
import TransactionModal from '../components/TransactionModal.vue'
import { useAuthStore } from '../stores/auth.js'
import { useFinanceStore } from '../stores/finance.js'
import { formatMoney, formatDate, monthLabel, catMark } from '../lib/utils.js'

const auth = useAuthStore()
const finance = useFinanceStore()
const modalOpen = ref(false)
const editingTx = ref(null)
const modal = ref(null)

onMounted(() => finance.refreshAll())

function openAdd() { editingTx.value = null; modalOpen.value = true; modal.value?.openWith(null) }
function shortMonth(iso) { return new Date(iso).toLocaleString('en-IN', { month: 'short' }) }
function barH(v) {
  const max = Math.max(...finance.monthly.map(m => Math.max(Number(m.total_income), Number(m.total_expense))), 1)
  return Math.max(3, (Number(v) / max) * 90) + 'px'
}
</script>
