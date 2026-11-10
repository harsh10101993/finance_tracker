<template>
  <AppLayout>
    <h1 class="mb-16" style="font-size:26px; letter-spacing:-.02em">Profile</h1>

    <div v-if="finance.error" class="alert alert-error">{{ finance.error }}</div>

    <div class="grid grid-2">
      <div class="card">
        <div class="row-between mb-16">
          <div class="avatar">{{ initials(form.full_name) }}</div>
          <span class="pill">{{ auth.mode === 'supabase' ? 'Supabase' : 'Demo / Offline' }}</span>
        </div>
        <form @submit.prevent="save">
          <div class="field">
            <label>Full name</label>
            <input class="input" required v-model="form.full_name" />
          </div>
          <div class="field">
            <label>Email</label>
            <input class="input" disabled :value="auth.user?.email" />
            <p class="hint">Email can't be changed here. Contact support to update it.</p>
          </div>
          <div class="field">
            <label>Currency</label>
            <select class="input" v-model="form.currency">
              <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div class="field">
            <label>Timezone</label>
            <input class="input" v-model="form.timezone" placeholder="Asia/Kolkata" />
          </div>
          <div class="field">
            <label>Avatar URL (optional)</label>
            <input class="input" v-model="form.avatar_url" placeholder="https://…" />
          </div>
          <div v-if="ok" class="alert alert-ok">{{ ok }}</div>
          <div v-if="err" class="alert alert-error">{{ err }}</div>
          <button class="btn btn-block" :disabled="saving">{{ saving ? 'Saving…' : 'Save profile' }}</button>
        </form>
      </div>

      <div>
        <div class="card mb-16">
          <h3 class="mb-8">Account</h3>
          <p class="small muted">Member since {{ formatDate(finance.profile?.created_at) }}</p>
          <p class="small muted">User ID: <code>{{ auth.user?.id?.slice(0, 8) }}…</code></p>
          <button class="btn btn-outline btn-block mt-16" @click="exportData">⬇ Export my data (JSON)</button>
          <button class="btn btn-outline btn-block mt-8" @click="logout">Log out</button>
        </div>

        <div class="card">
          <h3 class="mb-8">Categories</h3>
          <p class="hint mb-16">Used when adding transactions.</p>
          <div v-for="c in finance.categories" :key="c.id" class="legend-row">
            <span class="legend-dot" :style="{ background: c.shade || '#000' }"></span>
            <span>{{ catMark(c.name) }} &nbsp;{{ c.name }}</span>
            <span class="spacer"></span>
            <span class="pill off">{{ c.type }}</span>
          </div>
          <form class="mt-16" @submit.prevent="addCat">
            <div class="grid grid-2">
              <input class="input" required v-model="newCat.name" placeholder="New category" maxlength="60" />
              <select class="input" v-model="newCat.type">
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            <button class="btn btn-outline btn-block mt-8">+ Add category</button>
          </form>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { reactive, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppLayout from '../components/AppLayout.vue'
import { useAuthStore } from '../stores/auth.js'
import { useFinanceStore } from '../stores/finance.js'
import { CURRENCIES, initials, formatDate, downloadJSON, catMark } from '../lib/utils.js'
import * as api from '../lib/financeApi.js'

const auth = useAuthStore()
const finance = useFinanceStore()
const router = useRouter()
const saving = ref(false)
const ok = ref('')
const err = ref('')
const form = reactive({ full_name: '', currency: 'INR', timezone: 'Asia/Kolkata', avatar_url: '' })
const newCat = reactive({ name: '', type: 'expense' })

onMounted(async () => {
  await finance.refreshAll()
  syncForm()
})
watch(() => finance.profile, syncForm)

function syncForm() {
  if (!finance.profile) return
  form.full_name = finance.profile.full_name || ''
  form.currency = finance.profile.currency || 'INR'
  form.timezone = finance.profile.timezone || 'Asia/Kolkata'
  form.avatar_url = finance.profile.avatar_url || ''
}

async function save() {
  saving.value = true; ok.value = ''; err.value = ''
  try { await finance.saveProfile({ ...form }); ok.value = 'Profile saved ✓' }
  catch (e) { err.value = e.message }
  finally { saving.value = false }
}

async function addCat() {
  try { await finance.addCategory({ name: newCat.name.trim(), type: newCat.type }); newCat.name = '' }
  catch (e) { alert(e.message) }
}

async function exportData() {
  try {
    const data = await api.exportUserData(auth.user.id)
    downloadJSON('finance-tracker-export.json', data)
  } catch (e) { alert(e.message) }
}

async function logout() { await auth.signOut(); router.push('/login') }
</script>
