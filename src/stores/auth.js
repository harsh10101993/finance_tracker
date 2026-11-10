import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase, isSupabaseConfigured } from '../lib/supabase.js'
import { pgliteQuery, pgliteExec, uid, hashPassword } from '../lib/pglite.js'
import { flushSyncQueue } from '../lib/financeApi.js'

const SESSION_KEY = 'ft_session'
const DEMO_EMAIL = 'demo@finance.local'
const DEMO_PASS = 'demo1234'

// Monochrome marks only — the UI must stay strictly black & white.
const DEFAULT_CATEGORIES = [
  ['Food & Dining', 'F', 'expense', '#000000'], ['Transport', 'T', 'expense', '#333333'],
  ['Shopping', 'S', 'expense', '#666666'], ['Bills & Utilities', 'B', 'expense', '#999999'],
  ['Health', 'H', 'expense', '#bbbbbb'], ['Entertainment', 'E', 'expense', '#dddddd'],
  ['Other Expense', '•', 'expense', '#000000'],
  ['Salary', 'S', 'income', '#000000'], ['Freelance', 'F', 'income', '#666666'],
  ['Investments', 'I', 'income', '#999999'], ['Other Income', '•', 'income', '#000000']
]

async function seedLocalUser(userId, email, fullName) {
  for (const [name, icon, type, shade] of DEFAULT_CATEGORIES) {
    await pgliteExec(
      'insert into local_categories (id, user_id, name, icon, type, shade, is_default) values ($1,$2,$3,$4,$5,$6,true)',
      [uid(), userId, name, icon, type, shade]
    ).catch(() => {})
  }
  await pgliteExec(
    'insert into local_settings (user_id) values ($1) on conflict (user_id) do nothing', [userId]
  ).catch(() => {})
}

async function seedDemoTransactions(userId) {
  const existing = await pgliteQuery('select count(*) as c from local_transactions where user_id=$1', [userId])
  if (Number(existing[0]?.c || 0) > 0) return
  const cats = await pgliteQuery('select * from local_categories where user_id=$1', [userId])
  const byName = Object.fromEntries(cats.map(c => [c.name, c.id]))
  const now = new Date()
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // monthOffset 0 = current month; -1 / -2 fill the 6-month chart with history.
  const seed = [
    [0, 'income', 85000, 'Salary', 'Salary', 1],
    [0, 'expense', 4200, 'Groceries — weekly market', 'Food & Dining', 3],
    [0, 'expense', 1800, 'Metro card recharge', 'Transport', 5],
    [0, 'expense', 2400, 'Electricity bill', 'Bills & Utilities', 7],
    [0, 'expense', 3200, 'Online shopping', 'Shopping', 10],
    [0, 'income', 12000, 'Freelance project', 'Freelance', 12],
    [0, 'expense', 950, 'Dinner with friends', 'Food & Dining', 15],
    [0, 'expense', 1500, 'Pharmacy', 'Health', 18],
    [-1, 'income', 85000, 'Salary', 'Salary', 1],
    [-1, 'expense', 16500, 'Rent', 'Bills & Utilities', 2],
    [-1, 'expense', 9800, 'Groceries', 'Food & Dining', 9],
    [-1, 'expense', 2600, 'Movie night', 'Entertainment', 14],
    [-1, 'expense', 4100, 'Clothes', 'Shopping', 21],
    [-1, 'income', 8000, 'Freelance invoice', 'Freelance', 24],
    [-2, 'income', 82000, 'Salary', 'Salary', 1],
    [-2, 'expense', 16500, 'Rent', 'Bills & Utilities', 2],
    [-2, 'expense', 11200, 'Groceries', 'Food & Dining', 11],
    [-2, 'expense', 1900, 'Cab rides', 'Transport', 16],
    [-2, 'expense', 5200, 'Festival gifts', 'Shopping', 22]
  ]
  for (const [offset, type, amount, desc, catName, day] of seed) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, day)
    await pgliteExec(
      'insert into local_transactions (id, user_id, category_id, type, amount, description, transaction_date) values ($1,$2,$3,$4,$5,$6,$7)',
      [uid(), userId, byName[catName] || null, type, amount, desc, iso(d)]
    )
  }
}

// Demo/offline mode: make sure the demo account exists as soon as the app boots,
// so Log in / Forgot password / Sign up all behave consistently on a fresh device.
// Single-flight: init(), signIn() and forgotPassword() may race to create it.
let demoPromise = null
async function ensureDemoAccount() {
  if (!demoPromise) {
    demoPromise = (async () => {
      const existing = await pgliteQuery('select * from local_profiles where email=$1', [DEMO_EMAIL])
      if (existing.length) return existing[0]
      await pgliteExec(
        `insert into local_profiles (id, email, full_name, password_hash) values ($1,$2,$3,$4)
         on conflict (email) do nothing`,
        [uid(), DEMO_EMAIL, 'Demo User', await hashPassword(DEMO_PASS)]
      )
      const rows = await pgliteQuery('select * from local_profiles where email=$1', [DEMO_EMAIL])
      const account = rows[0]
      if (!account) throw new Error('Could not create the demo account')
      await seedLocalUser(account.id, DEMO_EMAIL, account.full_name || 'Demo User')
      await seedDemoTransactions(account.id)
      return account
    })().catch(err => { demoPromise = null; throw err })
  }
  return demoPromise
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)          // { id, email, full_name }
  const loading = ref(true)
  const mode = computed(() => (isSupabaseConfigured ? 'supabase' : 'demo'))
  const isAuthenticated = computed(() => !!user.value)

  function setSession(u) {
    user.value = u
    if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u))
    else localStorage.removeItem(SESSION_KEY)
  }

  async function init() {
    loading.value = true
    try {
      if (isSupabaseConfigured && supabase) {
        const { data } = await supabase.auth.getSession()
        const s = data.session
        if (s?.user) {
          setSession({ id: s.user.id, email: s.user.email, full_name: s.user.user_metadata?.full_name || '' })
          flushSyncQueue(s.user.id).catch(() => {})
        } else setSession(null)
        supabase.auth.onAuthStateChange((_event, session) => {
          if (session?.user) setSession({ id: session.user.id, email: session.user.email, full_name: session.user.user_metadata?.full_name || '' })
          else setSession(null)
        })
      } else {
        const raw = localStorage.getItem(SESSION_KEY)
        setSession(raw ? JSON.parse(raw) : null)
        // Warm the demo account (idempotent) so offline flows are ready immediately.
        ensureDemoAccount().catch(err => console.warn('[demo seed]', err))
      }
    } finally { loading.value = false }
  }

  async function signUp({ email, password, fullName }) {
    email = email.trim().toLowerCase()
    if (isSupabaseConfigured && supabase) {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: { full_name: fullName } }
      })
      if (error) throw new Error(error.message)
      if (data.user) setSession({ id: data.user.id, email, full_name: fullName })
      return data.user
    }
    // Demo / offline signup → PGlite local account
    const existing = await pgliteQuery('select id from local_profiles where email=$1', [email])
    if (existing.length) throw new Error('An account with this email already exists. Please log in.')
    const id = uid()
    const hash = await hashPassword(password)
    await pgliteExec(
      'insert into local_profiles (id, email, full_name, password_hash) values ($1,$2,$3,$4)',
      [id, email, fullName, hash]
    )
    await seedLocalUser(id, email, fullName)
    const u = { id, email, full_name: fullName }
    setSession(u)
    return u
  }

  async function signIn({ email, password }) {
    email = email.trim().toLowerCase()
    if (isSupabaseConfigured && supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw new Error(error.message)
      setSession({ id: data.user.id, email, full_name: data.user.user_metadata?.full_name || '' })
      flushSyncQueue(data.user.id).catch(() => {})
      return data.user
    }
    // Demo shortcut: demo@finance.local / demo1234 (auto-created on first login)
    if (email === DEMO_EMAIL && password === DEMO_PASS) {
      const account = await ensureDemoAccount()
      const u = { id: account.id, email, full_name: account.full_name || 'Demo User' }
      setSession(u)
      return u
    }
    const rows = await pgliteQuery('select * from local_profiles where email=$1', [email])
    if (!rows.length) throw new Error('No account found for this email. Please sign up first.')
    const hash = await hashPassword(password)
    if (rows[0].password_hash !== hash) throw new Error('Incorrect password. Please try again.')
    const u = { id: rows[0].id, email, full_name: rows[0].full_name }
    setSession(u)
    return u
  }

  async function signOut() {
    if (isSupabaseConfigured && supabase) await supabase.auth.signOut().catch(() => {})
    setSession(null)
  }

  async function forgotPassword(email) {
    email = email.trim().toLowerCase()
    if (isSupabaseConfigured && supabase) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + import.meta.env.BASE_URL
      })
      if (error) throw new Error(error.message)
      return 'Password reset link sent. Check your inbox.'
    }
    // Offline demo: there is no mail server, so explain what production would do.
    await ensureDemoAccount().catch(() => {})
    const rows = await pgliteQuery('select id from local_profiles where email=$1', [email])
    if (!rows.length) throw new Error('No account found for this email. Check the address or sign up first.')
    return 'Demo mode: no email is sent. Real reset emails require Supabase (set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY). Demo login: demo@finance.local / demo1234'
  }

  return { user, loading, mode, isAuthenticated, init, signUp, signIn, signOut, forgotPassword }
})
