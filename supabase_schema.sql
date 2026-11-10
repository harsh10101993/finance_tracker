-- ============================================================================
-- Finance Tracker — Supabase Schema (SINGLE SOURCE OF TRUTH)
-- ============================================================================
-- Version: 1.0.1  |  Updated: 2026-11-10  |  Changelog: see CHANGELOG.md
-- Repo: https://github.com/harsh10101993/finance_tracker
--
-- HOW TO USE:
--   1. Supabase Dashboard → SQL Editor → New query → paste this ENTIRE file → Run
--   2. Or CLI:  supabase db push  /  psql "$DATABASE_URL" -f supabase_schema.sql
--   3. Keep this file updated with EVERY schema change. Never edit the dashboard
--      without mirroring the change here in the same commit.
--
-- DESIGN:
--   • Frontend NEVER writes to tables directly for business logic.
--     It calls Postgres FUNCTIONS (RPC) — all validation, aggregation and
--     side-effects happen on the Supabase side (see §5).
--   • RLS is ON for every table. Users can only see their own rows.
--   • Functions are SECURITY DEFINER with auth.uid() checks + search_path locked.
--   • PGlite (offline) mirrors tables: profiles, categories, transactions,
--     budgets, settings + a client-side sync_queue (see src/lib/pglite.js).
-- ============================================================================

-- ── §0 Extensions ────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- fuzzy search on descriptions

-- ── §1 Helper: updated_at trigger ────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── §2 Tables ────────────────────────────────────────────────────────────────

-- 2.1 Profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text not null default '',
  avatar_url    text,
  currency      text not null default 'INR' check (currency in ('INR','USD','EUR','GBP','AED','SGD')),
  timezone      text not null default 'Asia/Kolkata',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.profiles is 'Public profile per user. Created by handle_new_user() trigger.';

-- 2.2 Categories (per-user, income/expense)
create table if not exists public.categories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  icon          text not null default '•',
  type          text not null check (type in ('income','expense')),
  shade         text not null default '#000000'
                  check (shade ~ '^#([0-9a-fA-F]{6})$'),  -- grayscale hex only (B&W theme)
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, lower(name), type)
);
comment on table public.categories is 'User categories. shade is grayscale to enforce B&W theme.';

-- 2.3 Transactions
create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  category_id       uuid references public.categories(id) on delete set null,
  type              text not null check (type in ('income','expense')),
  amount            numeric(14,2) not null check (amount > 0),
  description       text not null check (char_length(description) between 1 and 200),
  notes             text,
  payment_method    text not null default 'cash'
                      check (payment_method in ('cash','card','upi','bank','wallet','other')),
  transaction_date  date not null default current_date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.transactions is 'Core ledger. amount is always positive; sign comes from type.';

-- 2.4 Budgets (one per user/category/month)
create table if not exists public.budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  category_id   uuid not null references public.categories(id) on delete cascade,
  amount        numeric(14,2) not null check (amount >= 0),
  budget_month  int not null check (budget_month between 1 and 12),
  budget_year   int not null check (budget_year between 2000 and 2100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, category_id, budget_month, budget_year)
);

-- 2.5 Settings (1:1 per user)
create table if not exists public.settings (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  theme                 text not null default 'bw' check (theme in ('bw','dark','light')),
  currency              text not null default 'INR',
  date_format           text not null default 'DD/MM/YYYY' check (date_format in ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD')),
  week_start            text not null default 'monday' check (week_start in ('monday','sunday')),
  notifications_enabled boolean not null default true,
  offline_mode          boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- 2.6 Audit log (append-only; written by RPC functions, never by client)
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,          -- e.g. transaction.create
  entity      text not null,          -- e.g. transactions
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ── §3 Indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_tx_user_date   on public.transactions(user_id, transaction_date desc);
create index if not exists idx_tx_user_type   on public.transactions(user_id, type);
create index if not exists idx_tx_category    on public.transactions(category_id);
create index if not exists idx_tx_desc_trgm   on public.transactions using gin (description gin_trgm_ops);
create index if not exists idx_cat_user_type  on public.categories(user_id, type);
create index if not exists idx_budget_user    on public.budgets(user_id, budget_year, budget_month);
create index if not exists idx_audit_user     on public.audit_logs(user_id, created_at desc);

-- ── §4 Triggers ──────────────────────────────────────────────────────────────
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_categories_updated on public.categories;
create trigger trg_categories_updated before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists trg_transactions_updated on public.transactions;
create trigger trg_transactions_updated before update on public.transactions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budgets_updated on public.budgets;
create trigger trg_budgets_updated before update on public.budgets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_settings_updated on public.settings;
create trigger trg_settings_updated before update on public.settings
  for each row execute function public.set_updated_at();

-- 4.1 Auto-create profile + settings + default categories on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_email text := new.email;
  v_name  text := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, v_email, v_name)
  on conflict (id) do nothing;

  insert into public.settings (user_id) values (new.id)
  on conflict (user_id) do nothing;

  -- Default categories: single-letter monochrome marks + grayscale shades only
  -- (no emoji, so the UI stays strictly black & white on every platform)
  insert into public.categories (user_id, name, icon, type, shade, is_default) values
    (new.id, 'Food & Dining',  'F', 'expense', '#000000', true),
    (new.id, 'Transport',      'T', 'expense', '#333333', true),
    (new.id, 'Shopping',       'S', 'expense', '#666666', true),
    (new.id, 'Bills & Utilities','B', 'expense', '#999999', true),
    (new.id, 'Health',         'H', 'expense', '#bbbbbb', true),
    (new.id, 'Entertainment',  'E', 'expense', '#dddddd', true),
    (new.id, 'Other Expense',  '•', 'expense', '#000000', true),
    (new.id, 'Salary',         'S', 'income',  '#000000', true),
    (new.id, 'Freelance',      'F', 'income',  '#666666', true),
    (new.id, 'Investments',    'I', 'income',  '#999999', true),
    (new.id, 'Other Income',   '•', 'income',  '#000000', true)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── §5 Row Level Security ────────────────────────────────────────────────────
alter table public.profiles    enable row level security;
alter table public.categories  enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets     enable row level security;
alter table public.settings    enable row level security;
alter table public.audit_logs  enable row level security;

-- Profiles: users see/update only their own
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- Categories / Transactions / Budgets / Settings: own rows only (all ops)
drop policy if exists "categories_all_own" on public.categories;
create policy "categories_all_own" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "transactions_all_own" on public.transactions;
create policy "transactions_all_own" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "budgets_all_own" on public.budgets;
create policy "budgets_all_own" on public.budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "settings_all_own" on public.settings;
create policy "settings_all_own" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Audit logs: select own only; inserts happen via SECURITY DEFINER functions
drop policy if exists "audit_select_own" on public.audit_logs;
create policy "audit_select_own" on public.audit_logs
  for select using (auth.uid() = user_id);

-- ── §6 Views (read models for dashboard) ─────────────────────────────────────
create or replace view public.v_monthly_summary as
select
  user_id,
  date_trunc('month', transaction_date)::date as month_start,
  sum(amount) filter (where type = 'income')  as total_income,
  sum(amount) filter (where type = 'expense') as total_expense,
  count(*) as tx_count
from public.transactions
group by user_id, date_trunc('month', transaction_date);

create or replace view public.v_category_totals as
select
  t.user_id,
  t.category_id,
  c.name as category_name,
  c.icon as category_icon,
  c.shade as category_shade,
  t.type,
  date_trunc('month', t.transaction_date)::date as month_start,
  sum(t.amount) as total
from public.transactions t
left join public.categories c on c.id = t.category_id
group by t.user_id, t.category_id, c.name, c.icon, c.shade, t.type,
         date_trunc('month', t.transaction_date);

-- ── §7 RPC Functions — ALL business logic lives here ─────────────────────────
-- Frontend calls: supabase.rpc('fn_name', { ... })  — never raw inserts.

-- 7.1 Internal: write audit log
create or replace function public._audit(p_action text, p_entity text, p_entity_id uuid, p_meta jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (user_id, action, entity, entity_id, metadata)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_meta);
end;
$$;

-- 7.2 Dashboard stats (single round-trip for the whole dashboard)
create or replace function public.get_dashboard_stats(
  p_month int default extract(month from current_date)::int,
  p_year  int default extract(year from current_date)::int
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_income numeric; v_expense numeric; v_balance numeric;
  v_m_income numeric; v_m_expense numeric; v_count int;
  v_prev_income numeric; v_prev_expense numeric;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select coalesce(sum(amount) filter (where type='income'),0),
         coalesce(sum(amount) filter (where type='expense'),0)
    into v_income, v_expense
    from public.transactions where user_id = v_uid;

  select coalesce(sum(amount) filter (where type='income'),0),
         coalesce(sum(amount) filter (where type='expense'),0),
         count(*)
    into v_m_income, v_m_expense, v_count
    from public.transactions
   where user_id = v_uid
     and extract(month from transaction_date) = p_month
     and extract(year from transaction_date)  = p_year;

  -- previous month for delta arrows
  select coalesce(sum(amount) filter (where type='income'),0),
         coalesce(sum(amount) filter (where type='expense'),0)
    into v_prev_income, v_prev_expense
    from public.transactions
   where user_id = v_uid
     and transaction_date >= (make_date(p_year, p_month, 1) - interval '1 month')
     and transaction_date <  make_date(p_year, p_month, 1);

  v_balance := v_income - v_expense;

  return jsonb_build_object(
    'total_balance', v_balance,
    'total_income', v_income,
    'total_expense', v_expense,
    'monthly_income', v_m_income,
    'monthly_expense', v_m_expense,
    'monthly_balance', v_m_income - v_m_expense,
    'transaction_count', v_count,
    'prev_month_income', v_prev_income,
    'prev_month_expense', v_prev_expense,
    'savings_rate', case when v_m_income > 0
      then round(((v_m_income - v_m_expense) / v_m_income) * 100, 1) else 0 end
  );
end;
$$;

-- 7.3 Monthly summary rows (for charts / history)
create or replace function public.get_monthly_summary(p_months int default 6)
returns table (month_start date, total_income numeric, total_expense numeric, net numeric, tx_count bigint)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return query
  select m.month_start,
         coalesce(m.total_income,0), coalesce(m.total_expense,0),
         coalesce(m.total_income,0) - coalesce(m.total_expense,0),
         coalesce(m.tx_count,0)
  from (
    select date_trunc('month', gs)::date as month_start
    from generate_series(
      date_trunc('month', current_date) - ((p_months - 1) || ' months')::interval,
      date_trunc('month', current_date),
      interval '1 month'
    ) gs
  ) months m
  left join public.v_monthly_summary v
    on v.user_id = auth.uid() and v.month_start = m.month_start
  order by m.month_start;
end;
$$;

-- 7.4 Category breakdown (for donut/bar charts)
create or replace function public.get_category_breakdown(
  p_month int default extract(month from current_date)::int,
  p_year  int default extract(year from current_date)::int,
  p_type  text default 'expense'
)
returns table (category_id uuid, category_name text, category_icon text, category_shade text, total numeric, pct numeric)
language plpgsql security definer set search_path = public as $$
declare v_grand numeric;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select coalesce(sum(total),0) into v_grand from public.v_category_totals
   where user_id = auth.uid() and type = p_type
     and extract(month from month_start) = p_month
     and extract(year from month_start)  = p_year;

  return query
  select v.category_id, v.category_name, v.category_icon, v.category_shade, v.total,
         case when v_grand > 0 then round((v.total / v_grand) * 100, 1) else 0 end
  from public.v_category_totals v
  where v.user_id = auth.uid() and v.type = p_type
    and extract(month from v.month_start) = p_month
    and extract(year from v.month_start)  = p_year
  order by v.total desc;
end;
$$;

-- 7.5 Create transaction (validates category ownership + type match)
create or replace function public.create_transaction(
  p_type text, p_amount numeric, p_description text,
  p_category_id uuid default null,
  p_transaction_date date default current_date,
  p_notes text default null,
  p_payment_method text default 'cash'
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_tx public.transactions%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_type not in ('income','expense') then raise exception 'invalid type'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_description is null or char_length(trim(p_description)) = 0 then raise exception 'description required'; end if;

  if p_category_id is not null then
    if not exists (select 1 from public.categories
                    where id = p_category_id and user_id = v_uid and type = p_type) then
      raise exception 'category not found or type mismatch';
    end if;
  end if;

  insert into public.transactions
    (user_id, category_id, type, amount, description, notes, payment_method, transaction_date)
  values (v_uid, p_category_id, p_type, p_amount, trim(p_description), p_notes, p_payment_method, p_transaction_date)
  returning * into v_tx;

  perform public._audit('transaction.create', 'transactions', v_tx.id,
    jsonb_build_object('type', p_type, 'amount', p_amount));

  return to_jsonb(v_tx);
end;
$$;

-- 7.6 Update transaction
create or replace function public.update_transaction(
  p_transaction_id uuid, p_type text default null, p_amount numeric default null,
  p_description text default null, p_category_id uuid default null,
  p_transaction_date date default null, p_notes text default null,
  p_payment_method text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_tx public.transactions%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_tx from public.transactions where id = p_transaction_id and user_id = v_uid;
  if not found then raise exception 'transaction not found'; end if;

  update public.transactions set
    type             = coalesce(p_type, type),
    amount           = coalesce(p_amount, amount),
    description      = coalesce(nullif(trim(p_description),''), description),
    category_id      = coalesce(p_category_id, category_id),
    transaction_date = coalesce(p_transaction_date, transaction_date),
    notes            = coalesce(p_notes, notes),
    payment_method   = coalesce(p_payment_method, payment_method)
  where id = p_transaction_id and user_id = v_uid
  returning * into v_tx;

  perform public._audit('transaction.update', 'transactions', v_tx.id, '{}');
  return to_jsonb(v_tx);
end;
$$;

-- 7.7 Delete transaction
create or replace function public.delete_transaction(p_transaction_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_found boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  delete from public.transactions where id = p_transaction_id and user_id = v_uid;
  get diagnostics v_found = row_count;
  if v_found then perform public._audit('transaction.delete','transactions',p_transaction_id,'{}'); end if;
  return v_found;
end;
$$;

-- 7.8 List transactions (filter + search + pagination, all server-side)
create or replace function public.list_transactions(
  p_limit int default 50, p_offset int default 0,
  p_type text default null, p_category_id uuid default null,
  p_search text default null,
  p_date_from date default null, p_date_to date default null
)
returns table (
  id uuid, category_id uuid, category_name text, category_icon text, category_shade text,
  type text, amount numeric, description text, notes text, payment_method text,
  transaction_date date, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return query
  select t.id, t.category_id, c.name, c.icon, c.shade,
         t.type, t.amount, t.description, t.notes, t.payment_method,
         t.transaction_date, t.created_at,
         count(*) over () as total_count
  from public.transactions t
  left join public.categories c on c.id = t.category_id
  where t.user_id = auth.uid()
    and (p_type is null or t.type = p_type)
    and (p_category_id is null or t.category_id = p_category_id)
    and (p_search is null or t.description % p_search or t.description ilike '%' || p_search || '%')
    and (p_date_from is null or t.transaction_date >= p_date_from)
    and (p_date_to   is null or t.transaction_date <= p_date_to)
  order by t.transaction_date desc, t.created_at desc
  limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- 7.9 Categories CRUD (server-side)
create or replace function public.list_categories(p_type text default null)
returns table (id uuid, name text, icon text, type text, shade text, is_default boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return query select c.id, c.name, c.icon, c.type, c.shade, c.is_default
  from public.categories c
  where c.user_id = auth.uid() and (p_type is null or c.type = p_type)
  order by c.is_default desc, c.name;
end;
$$;

create or replace function public.create_category(p_name text, p_type text, p_icon text default '•', p_shade text default '#000000')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cat public.categories%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_type not in ('income','expense') then raise exception 'invalid type'; end if;
  insert into public.categories (user_id, name, icon, type, shade)
  values (v_uid, trim(p_name), p_icon, p_type, p_shade)
  returning * into v_cat;
  perform public._audit('category.create','categories',v_cat.id,'{}');
  return to_jsonb(v_cat);
end;
$$;

create or replace function public.delete_category(p_category_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_found boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  -- refuse to delete a category that still has transactions (protects ledger)
  if exists (select 1 from public.transactions where category_id = p_category_id and user_id = v_uid) then
    raise exception 'category has transactions — reassign or delete them first';
  end if;
  delete from public.categories where id = p_category_id and user_id = v_uid;
  get diagnostics v_found = row_count;
  return v_found;
end;
$$;

-- 7.10 Profile (upsert + get — used by Profile page)
create or replace function public.upsert_profile(
  p_full_name text default null, p_avatar_url text default null,
  p_currency text default null, p_timezone text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_p public.profiles%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  update public.profiles set
    full_name  = coalesce(nullif(trim(p_full_name),''), full_name),
    avatar_url = coalesce(p_avatar_url, avatar_url),
    currency   = coalesce(p_currency, currency),
    timezone   = coalesce(p_timezone, timezone)
  where id = v_uid returning * into v_p;
  if not found then raise exception 'profile not found'; end if;
  perform public._audit('profile.update','profiles',v_uid,'{}');
  return to_jsonb(v_p);
end;
$$;

create or replace function public.get_profile()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_p public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_p from public.profiles where id = auth.uid();
  if not found then raise exception 'profile not found'; end if;
  return to_jsonb(v_p);
end;
$$;

-- 7.11 Settings (upsert + get — used by Settings page)
create or replace function public.upsert_settings(
  p_theme text default null, p_currency text default null,
  p_date_format text default null, p_week_start text default null,
  p_notifications_enabled boolean default null, p_offline_mode boolean default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_s public.settings%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.settings set
    theme                 = coalesce(p_theme, theme),
    currency              = coalesce(p_currency, currency),
    date_format           = coalesce(p_date_format, date_format),
    week_start            = coalesce(p_week_start, week_start),
    notifications_enabled = coalesce(p_notifications_enabled, notifications_enabled),
    offline_mode          = coalesce(p_offline_mode, offline_mode)
  where user_id = v_uid returning * into v_s;
  perform public._audit('settings.update','settings',v_uid,'{}');
  return to_jsonb(v_s);
end;
$$;

create or replace function public.get_settings()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_s public.settings%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_s from public.settings where user_id = auth.uid();
  if not found then return '{}'::jsonb; end if;
  return to_jsonb(v_s);
end;
$$;

-- 7.12 Budgets (upsert + summary)
create or replace function public.upsert_budget(
  p_category_id uuid, p_amount numeric, p_month int, p_year int
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_b public.budgets%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.categories where id = p_category_id and user_id = v_uid) then
    raise exception 'category not found';
  end if;
  insert into public.budgets (user_id, category_id, amount, budget_month, budget_year)
  values (v_uid, p_category_id, p_amount, p_month, p_year)
  on conflict (user_id, category_id, budget_month, budget_year)
  do update set amount = excluded.amount
  returning * into v_b;
  perform public._audit('budget.upsert','budgets',v_b.id,'{}');
  return to_jsonb(v_b);
end;
$$;

create or replace function public.get_budget_summary(
  p_month int default extract(month from current_date)::int,
  p_year  int default extract(year from current_date)::int
)
returns table (category_id uuid, category_name text, budget numeric, spent numeric, remaining numeric, pct_used numeric)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return query
  select b.category_id, c.name, b.amount,
         coalesce(sum(t.amount),0) as spent,
         b.amount - coalesce(sum(t.amount),0) as remaining,
         case when b.amount > 0 then round((coalesce(sum(t.amount),0) / b.amount) * 100, 1) else 0 end
  from public.budgets b
  join public.categories c on c.id = b.category_id
  left join public.transactions t
    on t.category_id = b.category_id and t.user_id = auth.uid() and t.type = 'expense'
   and extract(month from t.transaction_date) = p_month
   and extract(year from t.transaction_date)  = p_year
  where b.user_id = auth.uid() and b.budget_month = p_month and b.budget_year = p_year
  group by b.category_id, c.name, b.amount
  order by c.name;
end;
$$;

-- 7.13 Export + wipe (Profile → Data controls)
create or replace function public.export_user_data()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'settings', (select to_jsonb(s) from public.settings s where s.user_id = v_uid),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.categories c where c.user_id = v_uid),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.transaction_date desc),'[]') from public.transactions t where t.user_id = v_uid),
    'budgets', (select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.budgets b where b.user_id = v_uid)
  );
end;
$$;

create or replace function public.delete_user_data()
returns boolean language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  -- order matters (FKs). auth.users row itself is deleted via Supabase Auth admin API.
  delete from public.transactions where user_id = v_uid;
  delete from public.budgets where user_id = v_uid;
  delete from public.categories where user_id = v_uid;
  delete from public.settings where user_id = v_uid;
  delete from public.profiles where id = v_uid;
  return true;
end;
$$;

-- ── §8 Grants ────────────────────────────────────────────────────────────────
-- Authenticated users may EXECUTE all RPC functions (RLS + auth.uid() inside
-- each function still enforces ownership). anon gets nothing.
grant execute on all functions in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on schema public to authenticated;
-- Views
grant select on public.v_monthly_summary, public.v_category_totals to authenticated;

-- ── §9 Seed (dev only — safe to re-run; does nothing in prod without a user) ──
-- Real seed data is created per-user by handle_new_user(). The statements below
-- are intentionally commented out. Uncomment + replace <USER_ID> for manual QA:
--   insert into public.transactions (user_id, type, amount, description, transaction_date)
--   values ('<USER_ID>', 'income', 50000, 'Salary — Nov', current_date),
--          ('<USER_ID>', 'expense', 1200, 'Groceries', current_date);

-- ============================================================================
-- END OF SCHEMA  •  Keep this file as the single source of truth.
-- Bump the version header + CHANGELOG.md on every change.
-- ============================================================================
