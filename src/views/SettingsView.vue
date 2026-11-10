<template>
  <AppLayout>
    <h1 class="mb-16" style="font-size:26px; letter-spacing:-.02em">Settings</h1>

    <div class="grid grid-2">
      <div class="card">
        <h3 class="mb-16">Preferences</h3>
        <form @submit.prevent="save">
          <div class="field">
            <label>Theme</label>
            <select class="input" v-model="form.theme">
              <option value="bw">Black & White</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div class="field">
            <label>Currency</label>
            <select class="input" v-model="form.currency">
              <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div class="field">
            <label>Date format</label>
            <select class="input" v-model="form.date_format">
              <option v-for="d in DATE_FORMATS" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div class="field">
            <label>Week starts on</label>
            <select class="input" v-model="form.week_start">
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </select>
          </div>

          <div class="switch-row">
            <div><strong>Notifications</strong><div class="hint">Reminders & monthly summaries</div></div>
            <input type="checkbox" class="switch" v-model="form.notifications_enabled" />
          </div>
          <div class="switch-row">
            <div><strong>Offline mode</strong><div class="hint">Keep working without internet (PGlite)</div></div>
            <input type="checkbox" class="switch" v-model="form.offline_mode" />
          </div>

          <div v-if="ok" class="alert alert-ok mt-16">{{ ok }}</div>
          <div v-if="err" class="alert alert-error mt-16">{{ err }}</div>
          <button class="btn btn-block mt-16" :disabled="saving">{{ saving ? 'Saving…' : 'Save settings' }}</button>
        </form>
      </div>

      <div>
        <div class="card mb-16">
          <h3 class="mb-8">Offline & PWA</h3>
          <p class="small muted">Status: <strong>{{ online ? 'Online' : 'Offline' }}</strong> · Mode: <strong>{{ auth.mode === 'supabase' ? 'Supabase' : 'Demo (PGlite)' }}</strong></p>
          <p class="small muted">The app is installable and works offline. Data is stored in PGlite (IndexedDB) and synced to Supabase when you're back online.</p>
          <button class="btn btn-outline btn-block mt-16" @click="syncNow">⟳ Sync now</button>
          <p v-if="syncMsg" class="small mt-8">{{ syncMsg }}</p>
          <button v-if="deferredPrompt" class="btn btn-block mt-16" @click="installApp">⬇ Install app</button>
        </div>

        <div class="card mb-16">
          <h3 class="mb-8">About</h3>
          <p class="small muted">Finance Tracker v1.0.1<br />Vue 3 + Vite + Supabase + PGlite<br />Black & White · Mobile-first · PWA</p>
          <a class="small" href="https://github.com/harsh10101993/finance_tracker" target="_blank" rel="noopener">github.com/harsh10101993/finance_tracker ↗</a>
        </div>

        <div class="card">
          <h3 class="mb-8">Danger zone</h3>
          <p class="small muted">Export a backup before deleting anything.</p>
          <button class="btn btn-outline btn-block mt-16" @click="exportData">⬇ Export my data</button>
          <button class="btn btn-block mt-8" @click="wipe">🗑 Delete all my data</button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { reactive, ref, onMounted, watch } from 'vue'
import AppLayout from '../components/AppLayout.vue'
import { useAuthStore } from '../stores/auth.js'
import { useFinanceStore } from '../stores/finance.js'
import { CURRENCIES, DATE_FORMATS, downloadJSON } from '../lib/utils.js'
import * as api from '../lib/financeApi.js'
import { pgliteExec } from '../lib/pglite.js'

const auth = useAuthStore()
const finance = useFinanceStore()
const saving = ref(false)
const ok = ref('')
const err = ref('')
const online = ref(navigator.onLine)
const syncMsg = ref('')
const deferredPrompt = ref(null)

const form = reactive({
  theme: 'bw', currency: 'INR', date_format: 'DD/MM/YYYY', week_start: 'monday',
  notifications_enabled: true, offline_mode: true
})

onMounted(async () => {
  await finance.refreshAll()
  syncForm()
  window.addEventListener('online', () => (online.value = true))
  window.addEventListener('offline', () => (online.value = false))
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt.value = e })
})
watch(() => finance.settings, syncForm)

function syncForm() {
  if (!finance.settings) return
  Object.assign(form, {
    theme: finance.settings.theme || 'bw',
    currency: finance.settings.currency || 'INR',
    date_format: finance.settings.date_format || 'DD/MM/YYYY',
    week_start: finance.settings.week_start || 'monday',
    notifications_enabled: finance.settings.notifications_enabled !== false,
    offline_mode: finance.settings.offline_mode !== false
  })
}

async function save() {
  saving.value = true; ok.value = ''; err.value = ''
  try { await finance.saveSettings({ ...form }); ok.value = 'Settings saved ✓' }
  catch (e) { err.value = e.message }
  finally { saving.value = false }
}

async function syncNow() {
  syncMsg.value = 'Syncing…'
  try {
    const n = await api.flushSyncQueue(auth.user.id)
    syncMsg.value = n ? `Synced ${n} change(s) ✓` : 'Everything is already synced ✓'
    await finance.refreshAll()
  } catch (e) { syncMsg.value = e.message }
}

async function installApp() {
  if (!deferredPrompt.value) return
  deferredPrompt.value.prompt()
  await deferredPrompt.value.userChoice
  deferredPrompt.value = null
}

async function exportData() {
  const data = await api.exportUserData(auth.user.id)
  downloadJSON('finance-tracker-export.json', data)
}

async function wipe() {
  if (!confirm('Delete ALL your transactions, categories and settings? This cannot be undone.')) return
  try {
    await pgliteExec('delete from local_transactions where user_id=$1', [auth.user.id])
    await pgliteExec('delete from local_budgets where user_id=$1', [auth.user.id])
    await pgliteExec('delete from local_categories where user_id=$1', [auth.user.id])
    await pgliteExec('delete from sync_queue where user_id=$1', [auth.user.id])
    await finance.refreshAll()
    alert('Local data deleted. (With Supabase connected, also run delete_user_data() in SQL Editor to wipe server data.)')
  } catch (e) { alert(e.message) }
}
</script>
