# Changelog

All notable changes to **Finance Tracker** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Current version lives in [`VERSION`](./VERSION), app version in `package.json`.

## [Unreleased]

## [1.0.1] — 2026-11-10

### Changed
- Replaced emoji category icons with single-letter monochrome marks (`catMark()`) so the
  interface stays strictly black & white and renders identically on every platform.
- Default categories in `supabase_schema.sql` now seed monochrome marks (`F`, `T`, `S`, …).
- CI: bumped to `actions/checkout@v5` / `actions/setup-node@v5` (Node 20 runner deprecation) and
  `configure-pages` now enables the Pages site on first run.
- Dashboard/stats cards align to the top of their grid row; richer demo history covering
  three months so the 6-month chart is meaningful on first login.


## [1.0.0] — 2026-11-10

First public release: black & white, mobile-first finance tracker PWA.

### Added

**Auth & navigation**
- Login, Sign up and Forgot Password pages (Supabase Auth when configured; PGlite-backed
  local accounts when not — so the app is fully usable with zero backend setup).
- Protected routes: `/dashboard`, `/transactions`, `/profile`, `/settings`, guarded by a
  router `beforeEach` that redirects guests to `/login?redirect=…`.
- Demo account auto-seeded offline: `demo@finance.local` / `demo1234` with 11 categories
  and 8 sample transactions.
- Session persistence across reloads.

**Dashboard**
- Balance hero (all-time), current-month income, expenses and savings rate.
- 4 stat cards, a 6-month CSS bar chart (income vs expense) and spending-by-category
  breakdown with percentage bars.
- Recent activity list.

**Transactions**
- Full CRUD via a bottom-sheet (mobile) / modal (desktop) form.
- Search by description, filter by income/expense, edit and delete.
- Payment method, notes, category and date per transaction.

**Profile & Settings**
- Profile: name, currency, timezone, avatar URL, plus category management and JSON export.
- Settings: theme, currency, date format, week start, notifications toggle, offline-mode
  toggle, manual sync, PWA install prompt, data export.
- "Delete all my data" clears local PGlite tables.

**Offline / PWA**
- Service worker (Workbox `generateSW`) with precaching + SPA `navigateFallback`.
- Installable manifest, 192/512/maskable icons, black `theme-color`, safe-area support.
- **PGlite** (Postgres compiled to WASM) persisted to IndexedDB (`idb://finance-tracker-offline`)
  mirrors the Supabase schema: `local_profiles`, `local_categories`, `local_transactions`,
  `local_budgets`, `local_settings` + `sync_queue`.
- Every write made offline is queued and replayed on reconnect (`flushSyncQueue`), also
  triggerable from Settings → "Sync now".
- Online/offline banner and status pills.

**Backend (Supabase)**
- `supabase_schema.sql` v1.0.0 as the **single source of truth**: extensions, helpers,
  tables (`profiles`, `categories`, `transactions`, `budgets`, `settings`, `audit_logs`),
  RLS policies for every table, triggers (`handle_new_user`, `updated_at`, audit, default
  category seeding), views (`v_monthly_summary`, `v_category_totals`) and 20+ RPC
  functions.
- All business logic lives in Postgres functions called through `supabase.rpc(...)`:
  `get_dashboard_stats`, `get_monthly_summary`, `get_category_breakdown`,
  `create_transaction`, `update_transaction`, `delete_transaction`, `list_transactions`,
  `list_categories`, `create_category`, `delete_category`, `upsert_profile`, `get_profile`,
  `upsert_settings`, `get_settings`, `upsert_budget`, `get_budget_summary`,
  `export_user_data`, `delete_user_data`.
- Frontend never writes to tables directly — a single `src/lib/financeApi.js` facade
  switches between Supabase RPC and equivalent PGlite SQL.

**Design**
- Strict black & white palette (grayscale shades only), no colour accents.
- Mobile-first: bottom tab bar and top bar under 1024px; desktop gets a fixed sidebar and
  a 4-column stat grid from 768px.

**Tooling & deployment**
- Vue 3.5 + Vite 6 + Pinia + vue-router 4 + `@supabase/supabase-js` + `@electric-sql/pglite`.
- GitHub Pages workflow (`.github/workflows/deploy.yml`) building with base
  `/finance_tracker/` and deploying via `actions/deploy-pages`.
- `public/404.html` SPA deep-link fallback for GitHub Pages.
- `.env.example` for `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; app auto-detects demo
  mode when they are absent.
