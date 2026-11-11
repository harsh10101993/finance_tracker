-- ============================================================================
-- Finance Tracker — supabase_schema.sql  ·  v0.1.0
-- SINGLE SOURCE OF TRUTH for the backend. Keep updating this file on every
-- backend change (tables, policies, functions) and re-run it in the Supabase
-- SQL editor. The app (Settings → Cloud) is built against this schema.
-- How to apply: Supabase dashboard → SQL editor → paste this file → Run.
-- Requires: Supabase Auth enabled (email provider). No extensions needed
-- beyond pgcrypto (bundled). All writes from the app go through the
-- SECURITY DEFINER functions below so row checks live on the Supabase side.
-- ============================================================================

-- 0) Extensions ---------------------------------------------------------------
create extension if not exists "pgcrypto";

-- 1) Tables -------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text not null default 'User',
  currency text not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income', 'expense')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name, kind)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('income', 'expense')),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'INR',
  category_name text not null default 'Other',
  note text not null default '',
  occurred_on date not null default (now()::date),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category_name text not null default 'Other',
  month date not null,               -- first day of month
  limit_amount numeric(14,2) not null check (limit_amount > 0),
  created_at timestamptz not null default now(),
  unique (user_id, category_name, month)
);

create index if not exists idx_tx_user_date on public.transactions (user_id, occurred_on desc);
create index if not exists idx_tx_user_kind on public.transactions (user_id, kind);
create index if not exists idx_cat_user on public.categories (user_id);

-- 2) updated_at maintenance -----------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_tx_touch on public.transactions;
create trigger trg_tx_touch before update on public.transactions
for each row execute function public.touch_updated_at();

-- 3) Row Level Security (owner-only) -------------------------------------------
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets enable row level security;

drop policy if exists "owner all profiles" on public.profiles;
create policy "owner all profiles" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "owner all categories" on public.categories;
create policy "owner all categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner all transactions" on public.transactions;
create policy "owner all transactions" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner all budgets" on public.budgets;
create policy "owner all budgets" on public.budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 4) New-user bootstrap (profile + default categories) --------------------------
create or replace function public.seed_default_categories(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.categories (user_id, name, kind, is_default)
  values
    (p_user, 'Salary',    'income',  true),
    (p_user, 'Freelance', 'income',  true),
    (p_user, 'Food',      'expense', true),
    (p_user, 'Transport', 'expense', true),
    (p_user, 'Shopping',  'expense', true),
    (p_user, 'Bills',     'expense', true),
    (p_user, 'Health',    'expense', true),
    (p_user, 'Other',     'expense', true)
  on conflict (user_id, name, kind) do nothing;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), 'User'))
  on conflict (id) do nothing;
  perform public.seed_default_categories(new.id);
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5) Server-side operations (the app calls THESE, not raw writes) ----------------
-- 5a) Add a transaction with server-side validation. Returns the new row.
create or replace function public.add_transaction(
  p_kind text, p_amount numeric, p_currency text default 'INR',
  p_category text default 'Other', p_note text default '',
  p_occurred_on date default null
)
returns public.transactions language plpgsql security definer set search_path = public as $$
declare v_row public.transactions;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_kind not in ('income', 'expense') then raise exception 'kind must be income|expense'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  insert into public.transactions (user_id, kind, amount, currency, category_name, note, occurred_on)
  values (auth.uid(), p_kind, p_amount, coalesce(nullif(p_currency,''), 'INR'),
          coalesce(nullif(p_category,''), 'Other'), coalesce(p_note,''),
          coalesce(p_occurred_on, now()::date))
  returning * into v_row;
  return v_row;
end $$;

-- 5b) Rename own display name. Returns the updated profile.
create or replace function public.set_profile_name(p_name text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v_row public.profiles;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'name required'; end if;
  update public.profiles set display_name = trim(p_name) where id = auth.uid() returning * into v_row;
  return v_row;
end $$;

-- 5c) Dashboard aggregates computed on the Supabase side.
-- p_month: any date within the target month (YYYY-MM-DD).
create or replace function public.get_dashboard_stats(p_month date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', coalesce(p_month, now()::date))::date;
  v_inc numeric := 0; v_exp numeric := 0;
  v_minc numeric := 0; v_mexp numeric := 0;
  v_count int := 0; v_bycat jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select count(*), coalesce(sum(case when kind='income' then amount else 0 end),0),
         coalesce(sum(case when kind='expense' then amount else 0 end),0)
    into v_count, v_inc, v_exp
    from public.transactions where user_id = auth.uid();
  select coalesce(sum(case when kind='income' then amount else 0 end),0),
         coalesce(sum(case when kind='expense' then amount else 0 end),0)
    into v_minc, v_mexp
    from public.transactions
   where user_id = auth.uid()
     and occurred_on >= v_month and occurred_on < (v_month + interval '1 month');
  select coalesce(jsonb_object_agg(category_name, total), '{}'::jsonb) into v_bycat from (
    select category_name, sum(amount) as total from public.transactions
     where user_id = auth.uid() group by category_name
  ) s;
  return jsonb_build_object(
    'income', v_inc, 'expense', v_exp, 'balance', v_inc - v_exp,
    'month_income', v_minc, 'month_expense', v_mexp, 'month_balance', v_minc - v_mexp,
    'count', v_count, 'by_category', v_bycat, 'month', v_month);
end $$;

-- 5d) Monthly income/expense series for the chart, newest last.
create or replace function public.get_monthly_series(p_months int default 6)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select coalesce(jsonb_agg(row_to_json(s) order by s.m), '[]'::jsonb) into v from (
    select to_char(m, 'Mon') as label, to_char(m, 'YYYY-MM') as key,
      coalesce(sum(case when t.kind='income' then t.amount else 0 end),0) as inc,
      coalesce(sum(case when t.kind='expense' then t.amount else 0 end),0) as exp
    from (select date_trunc('month', now())::date - (generate_series(0, greatest(coalesce(p_months,6),1)-1) || ' months')::interval) as m) months
    left join public.transactions t
      on t.user_id = auth.uid()
     and date_trunc('month', t.occurred_on) = date_trunc('month', months.m)
    group by m
  ) s;
  return v;
end $$;

-- 6) Change log of this file ------------------------------------------------------
-- v0.1.0 — initial schema: profiles, categories, transactions, budgets,
--           RLS owner-only, handle_new_user + seed_default_categories,
--           add_transaction, set_profile_name, get_dashboard_stats,
--           get_monthly_series.
