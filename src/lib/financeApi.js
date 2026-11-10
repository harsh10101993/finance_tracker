/**
 * Finance API — single interface for the whole app.
 *
 * Online + Supabase configured  → calls Postgres RPC functions (supabase_schema.sql §7).
 * Offline / demo mode           → runs equivalent logic against PGlite (local Postgres)
 *                                 and enqueues the op in sync_queue for later sync.
 *
 * Views/stores NEVER talk to Supabase or PGlite directly — only through here.
 */
import { supabase, isSupabaseConfigured } from './supabase.js'
import { pgliteQuery, pgliteExec, uid } from './pglite.js'
import { toISODate } from './utils.js'

export function isOnline() { return typeof navigator === 'undefined' ? true : navigator.onLine }
export function useSupabase() { return isSupabaseConfigured && isOnline() && !!supabase }

async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

async function enqueue(userId, op, payload) {
  try {
    await pgliteExec(
      'insert into sync_queue (user_id, op, payload) values ($1, $2, $3::jsonb)',
      [userId, op, JSON.stringify(payload)]
    )
  } catch { /* queue is best-effort offline */ }
}

/** Flush sync_queue to Supabase (called on reconnect / app start). */
export async function flushSyncQueue(userId) {
  if (!useSupabase() || !userId) return 0
  const pending = await pgliteQuery(
    'select * from sync_queue where user_id = $1 and synced_at is null order by id', [userId]
  ).catch(() => [])
  let done = 0
  for (const item of pending) {
    try {
      const p = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
      if (item.op === 'transaction.create') await rpc('create_transaction', p)
      else if (item.op === 'transaction.update') await rpc('update_transaction', { p_transaction_id: p.id, ...p })
      else if (item.op === 'transaction.delete') await rpc('delete_transaction', { p_transaction_id: p.id })
      else if (item.op === 'profile.update') await rpc('upsert_profile', p)
      else if (item.op === 'settings.update') await rpc('upsert_settings', p)
      await pgliteExec('update sync_queue set synced_at = now() where id = $1', [item.id])
      done++
    } catch { /* leave queued; retry next flush */ }
  }
  return done
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export async function getDashboardStats(userId, month, year) {
  if (useSupabase()) return rpc('get_dashboard_stats', { p_month: month, p_year: year })
  const rows = await pgliteQuery(
    `select
       coalesce(sum(amount) filter (where type='income'),0) as total_income,
       coalesce(sum(amount) filter (where type='expense'),0) as total_expense,
       coalesce(sum(amount) filter (where type='income' and extract(month from transaction_date)=$2 and extract(year from transaction_date)=$3),0) as monthly_income,
       coalesce(sum(amount) filter (where type='expense' and extract(month from transaction_date)=$2 and extract(year from transaction_date)=$3),0) as monthly_expense,
       count(*) filter (where extract(month from transaction_date)=$2 and extract(year from transaction_date)=$3) as transaction_count
     from local_transactions where user_id = $1`,
    [userId, month, year]
  )
  const r = rows[0] || {}
  const total_income = Number(r.total_income || 0)
  const total_expense = Number(r.total_expense || 0)
  const monthly_income = Number(r.monthly_income || 0)
  const monthly_expense = Number(r.monthly_expense || 0)
  return {
    total_balance: total_income - total_expense,
    total_income, total_expense,
    monthly_income, monthly_expense,
    monthly_balance: monthly_income - monthly_expense,
    transaction_count: Number(r.transaction_count || 0),
    prev_month_income: 0, prev_month_expense: 0,
    savings_rate: monthly_income > 0 ? Math.round(((monthly_income - monthly_expense) / monthly_income) * 1000) / 10 : 0
  }
}

export async function getMonthlySummary(userId, months = 6) {
  if (useSupabase()) return rpc('get_monthly_summary', { p_months: months })
  const rows = await pgliteQuery(
    `select date_trunc('month', transaction_date)::date as month_start,
            coalesce(sum(amount) filter (where type='income'),0) as total_income,
            coalesce(sum(amount) filter (where type='expense'),0) as total_expense,
            count(*) as tx_count
     from local_transactions where user_id = $1
     group by 1 order by 1 desc limit $2`,
    [userId, months]
  )
  return rows.reverse().map(r => ({
    month_start: toISODate(r.month_start),
    total_income: Number(r.total_income), total_expense: Number(r.total_expense),
    net: Number(r.total_income) - Number(r.total_expense), tx_count: Number(r.tx_count)
  }))
}

export async function getCategoryBreakdown(userId, month, year, type = 'expense') {
  if (useSupabase()) return rpc('get_category_breakdown', { p_month: month, p_year: year, p_type: type })
  const rows = await pgliteQuery(
    `select c.id as category_id, c.name as category_name, c.icon as category_icon, c.shade as category_shade,
            coalesce(sum(t.amount),0) as total
     from local_categories c
     left join local_transactions t on t.category_id = c.id
       and extract(month from t.transaction_date) = $2 and extract(year from t.transaction_date) = $3
     where c.user_id = $1 and c.type = $4
     group by c.id, c.name, c.icon, c.shade
     having coalesce(sum(t.amount),0) > 0
     order by total desc`,
    [userId, month, year, type]
  )
  const grand = rows.reduce((s, r) => s + Number(r.total), 0)
  return rows.map(r => ({
    ...r, total: Number(r.total),
    pct: grand > 0 ? Math.round((Number(r.total) / grand) * 1000) / 10 : 0
  }))
}

// ── Transactions ─────────────────────────────────────────────────────────────
export async function listTransactions(userId, { limit = 50, offset = 0, type = null, search = null } = {}) {
  if (useSupabase()) {
    const rows = await rpc('list_transactions', {
      p_limit: limit, p_offset: offset, p_type: type, p_search: search
    })
    return rows.map(r => ({ ...r, amount: Number(r.amount) }))
  }
  const rows = await pgliteQuery(
    `select t.*, c.name as category_name, c.icon as category_icon, c.shade as category_shade
     from local_transactions t
     left join local_categories c on c.id = t.category_id
     where t.user_id = $1
       and ($3::text is null or t.type = $3)
       and ($4::text is null or t.description ilike '%' || $4 || '%')
     order by t.transaction_date desc, t.created_at desc
     limit $2 offset $5`,
    [userId, limit, type, search, offset]
  )
  return rows.map(r => ({
    ...r, amount: Number(r.amount), transaction_date: toISODate(r.transaction_date)
  }))
}

export async function createTransaction(userId, payload) {
  if (useSupabase()) return rpc('create_transaction', {
    p_type: payload.type, p_amount: payload.amount, p_description: payload.description,
    p_category_id: payload.category_id || null, p_transaction_date: payload.transaction_date,
    p_notes: payload.notes || null, p_payment_method: payload.payment_method || 'cash'
  })
  const id = uid()
  await pgliteExec(
    `insert into local_transactions (id, user_id, category_id, type, amount, description, notes, payment_method, transaction_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, userId, payload.category_id || null, payload.type, payload.amount, payload.description,
     payload.notes || null, payload.payment_method || 'cash', payload.transaction_date]
  )
  await enqueue(userId, 'transaction.create', {
    p_type: payload.type, p_amount: payload.amount, p_description: payload.description,
    p_category_id: payload.category_id || null, p_transaction_date: payload.transaction_date,
    p_notes: payload.notes || null, p_payment_method: payload.payment_method || 'cash'
  })
  return { id, ...payload }
}

export async function updateTransaction(userId, id, payload) {
  if (useSupabase()) return rpc('update_transaction', { p_transaction_id: id, ...payload })
  await pgliteExec(
    `update local_transactions set type=$3, amount=$4, description=$5, category_id=$6,
       transaction_date=$7, notes=$8, payment_method=$9, updated_at=now()
     where id=$1 and user_id=$2`,
    [id, userId, payload.type, payload.amount, payload.description, payload.category_id || null,
     payload.transaction_date, payload.notes || null, payload.payment_method || 'cash']
  )
  await enqueue(userId, 'transaction.update', { id, ...payload })
  return { id, ...payload }
}

export async function deleteTransaction(userId, id) {
  if (useSupabase()) return rpc('delete_transaction', { p_transaction_id: id })
  await pgliteExec('delete from local_transactions where id=$1 and user_id=$2', [id, userId])
  await enqueue(userId, 'transaction.delete', { id })
  return true
}

// ── Categories ───────────────────────────────────────────────────────────────
export async function listCategories(userId, type = null) {
  if (useSupabase()) return rpc('list_categories', { p_type: type })
  return pgliteQuery(
    'select * from local_categories where user_id=$1 and ($2::text is null or type=$2) order by is_default desc, name',
    [userId, type]
  )
}

export async function createCategory(userId, { name, type, icon = '•', shade = '#000000' }) {
  if (useSupabase()) return rpc('create_category', { p_name: name, p_type: type, p_icon: icon, p_shade: shade })
  const id = uid()
  await pgliteExec(
    'insert into local_categories (id, user_id, name, icon, type, shade) values ($1,$2,$3,$4,$5,$6)',
    [id, userId, name, icon, type, shade]
  )
  return { id, name, type, icon, shade }
}

// ── Profile & Settings ───────────────────────────────────────────────────────
export async function getProfile(userId) {
  if (useSupabase()) return rpc('get_profile', {})
  const rows = await pgliteQuery('select id, email, full_name, currency, timezone, avatar_url, created_at from local_profiles where id=$1', [userId])
  return rows[0] || null
}

export async function upsertProfile(userId, payload) {
  if (useSupabase()) return rpc('upsert_profile', {
    p_full_name: payload.full_name, p_avatar_url: payload.avatar_url,
    p_currency: payload.currency, p_timezone: payload.timezone
  })
  await pgliteExec(
    'update local_profiles set full_name=$2, avatar_url=$3, currency=$4, timezone=$5, updated_at=now() where id=$1',
    [userId, payload.full_name, payload.avatar_url || null, payload.currency, payload.timezone]
  )
  await enqueue(userId, 'profile.update', {
    p_full_name: payload.full_name, p_avatar_url: payload.avatar_url,
    p_currency: payload.currency, p_timezone: payload.timezone
  })
  return getProfile(userId)
}

export async function getSettings(userId) {
  if (useSupabase()) return rpc('get_settings', {})
  const rows = await pgliteQuery('select * from local_settings where user_id=$1', [userId])
  return rows[0] || { theme: 'bw', currency: 'INR', date_format: 'DD/MM/YYYY', week_start: 'monday', notifications_enabled: true, offline_mode: true }
}

export async function upsertSettings(userId, payload) {
  if (useSupabase()) return rpc('upsert_settings', {
    p_theme: payload.theme, p_currency: payload.currency, p_date_format: payload.date_format,
    p_week_start: payload.week_start, p_notifications_enabled: payload.notifications_enabled,
    p_offline_mode: payload.offline_mode
  })
  await pgliteExec(
    `insert into local_settings (user_id, theme, currency, date_format, week_start, notifications_enabled, offline_mode)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (user_id) do update set theme=$2, currency=$3, date_format=$4, week_start=$5,
       notifications_enabled=$6, offline_mode=$7, updated_at=now()`,
    [userId, payload.theme, payload.currency, payload.date_format, payload.week_start,
     payload.notifications_enabled, payload.offline_mode]
  )
  await enqueue(userId, 'settings.update', {
    p_theme: payload.theme, p_currency: payload.currency, p_date_format: payload.date_format,
    p_week_start: payload.week_start, p_notifications_enabled: payload.notifications_enabled,
    p_offline_mode: payload.offline_mode
  })
  return getSettings(userId)
}

// ── Export ───────────────────────────────────────────────────────────────────
export async function exportUserData(userId) {
  if (useSupabase()) return rpc('export_user_data', {})
  const [profile, settings, categories, transactions, budgets] = await Promise.all([
    getProfile(userId), getSettings(userId),
    listCategories(userId), listTransactions(userId, { limit: 10000 }), pgliteQuery('select * from local_budgets where user_id=$1', [userId])
  ])
  return { exported_at: new Date().toISOString(), profile, settings, categories, transactions, budgets }
}
