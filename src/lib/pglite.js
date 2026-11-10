/**
 * PGlite — offline Postgres in the browser (WASM).
 * Persists to IndexedDB so data survives reloads / offline.
 * Mirrors the Supabase schema (see supabase_schema.sql §2) so the same
 * SQL-shaped operations work online (Supabase) and offline (PGlite).
 */
import { PGlite } from '@electric-sql/pglite'

let dbPromise = null
let ready = false

const SCHEMA = `
create table if not exists local_profiles (
  id text primary key,
  email text not null unique,
  full_name text not null default '',
  password_hash text,
  currency text not null default 'INR',
  timezone text not null default 'Asia/Kolkata',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists local_categories (
  id text primary key,
  user_id text not null,
  name text not null,
  icon text not null default '•',
  type text not null check (type in ('income','expense')),
  shade text not null default '#000000',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists local_transactions (
  id text primary key,
  user_id text not null,
  category_id text,
  type text not null check (type in ('income','expense')),
  amount numeric(14,2) not null check (amount > 0),
  description text not null,
  notes text,
  payment_method text not null default 'cash',
  transaction_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists local_budgets (
  id text primary key,
  user_id text not null,
  category_id text not null,
  amount numeric(14,2) not null default 0,
  budget_month int not null,
  budget_year int not null
);
create table if not exists local_settings (
  user_id text primary key,
  theme text not null default 'bw',
  currency text not null default 'INR',
  date_format text not null default 'DD/MM/YYYY',
  week_start text not null default 'monday',
  notifications_enabled boolean not null default true,
  offline_mode boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists sync_queue (
  id serial primary key,
  user_id text not null,
  op text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  synced_at timestamptz
);
create index if not exists idx_local_tx_user on local_transactions(user_id, transaction_date desc);
create index if not exists idx_local_cat_user on local_categories(user_id, type);
create index if not exists idx_sync_pending on sync_queue(synced_at) where synced_at is null;
`

export function getPGlite() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await PGlite.create('idb://finance-tracker-offline')
      await db.exec(SCHEMA)
      ready = true
      return db
    })()
  }
  return dbPromise
}

export function isPGliteReady() { return ready }

// Tiny SQL helpers (PGlite returns { rows, affectedRows })
export async function pgliteQuery(sql, params = []) {
  const db = await getPGlite()
  const res = await db.query(sql, params)
  return res.rows
}

export async function pgliteExec(sql, params = []) {
  const db = await getPGlite()
  const res = await db.query(sql, params)
  return res
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2))
}

// Demo-grade hash (NOT for production secrets — real auth is Supabase Auth).
// Keeps offline demo accounts from storing plaintext passwords.
export async function hashPassword(plain) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ft::' + plain))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
