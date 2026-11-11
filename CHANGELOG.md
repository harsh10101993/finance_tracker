# Changelog

All notable changes to Finance Tracker are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
The backend source of truth is `supabase_schema.sql` (its own version history is at the bottom of that file).

## [0.2.6] - 2026-11-11
### Added
- SMS import (Transactions → Import SMS): SMS Backup & Restore `.xml` exports or
  plain-text files, one alert per line. Debits → expenses, credits → income,
  self-transfers excluded, same review/duplicate/month workflow as PDF import.
  Imported rows are tagged `sms` and included in one-tap "Clear imports".
- Month picker in the import preview: toggle which statement months to add.
### Changed
- Black & white replaced with a soft eye-friendly palette (warm paper + sage in
  light mode, muted slate in dark mode); Light/Dark theme toggle kept.

## [0.2.5] - 2026-11-11
### Added
- Self-transfers (e.g. to Harsh Sadashiv Patil) are auto-detected in PDF imports
  and marked as `transfer` — excluded from income, expenses, balance and charts,
  with a separate "self-transfers excluded" line. Set your full name in Profile
  for name-based detection. Manual transfers supported too (type selector +
  Transactions filter).
- Dashboard range selector: 3 months / 6 months / 12 months chart.
### Fixed
- Mobile dashboard hardening: fluid balance type, no-wrap amounts, ellipsis
  everywhere, tighter 12-month bars, wrapping section headers.

## [0.2.4] - 2026-11-11
### Added
- One-tap deletion of all PDF-imported transactions (Transactions → "Clear PDF (N)").
  Imports are tagged (`source: pdf` + file batch); manual entries are untouched.
  Imported rows show a "· PDF" marker, so the data stays uniform and re-imports
  start clean.

## [0.2.3] - 2026-11-11
### Fixed
- Amount parsing for real-world statements: 10+ digit reference/UTR/account numbers
  are never treated as money; amounts with paise win over bare integers (years, ref
  fragments); wider column geometry (nearest-column wins, balance excluded);
  "credit card payment" no longer misread as a credit. Import preview gains a
  "details" toggle showing per-row detected amounts, rule and debit/credit split.

## [0.2.2] - 2026-11-11
### Added
- Password-protected PDF support: if a statement needs a password, the import
  dialog asks for it (wrong passwords can be retried). The password is only used
  to unlock the file in memory and never leaves the device.

## [0.2.1] - 2026-11-11
### Fixed
- Bank PDF import on the deployed site: pdf.js/PGlite CDN imports are now full
  static URLs with `/* @vite-ignore */`, so the Vite production build preserves
  them as runtime imports instead of failing with "Unknown variable dynamic import".

## [0.2.0] - 2026-11-11
### Removed
- Login, sign up and forgot-password screens. The app opens straight into the
  dashboard — local-first, no account needed. Existing demo data is adopted
  automatically (no data loss).
### Added
- Bank statement PDF import (Transactions → Import PDF, or dashboard empty-state link).
  pdf.js text extraction + geometry-aware table parser: finds Debit/Credit header
  columns, handles single-amount Dr/Cr layouts, continuation-line narrations and
  DD/MM/YYYY, DD-MM-YY and DD Mon YYYY dates. Credits → income, debits → expenses,
  categories auto-guessed (Salary, Food, Transport, Shopping, Bills, Health…),
  per-row kind/category override, duplicate detection with skip-duplicates toggle.
- `DB.addMany()` batch insert; `pdf_import.js` module (pdf.js worker via Blob shim).
### Changed
- Profile tab: display name, stats, export/import/erase — no passwords or sessions.
- Settings: cloud/Supabase card removed (local-first); Supabase files kept in repo for future use.

## [0.1.0] - 2026-11-11
### Added
- Auth: login, sign up, forgot password (Supabase Auth in cloud mode, offline demo accounts in demo mode).
- Dashboard: total balance, income/expense cards, 6-month bar chart, top categories, recent transactions.
- Transactions: add / edit / delete, search, income-expense filter.
- Settings: currency (INR/USD/EUR/GBP/JPY/AUD/CAD), black-or-white theme, Supabase connect/disconnect, PWA install, JSON export/import.
- Profile: display name, password change, member-since, log out, delete account.
- PWA offline support: service worker (`sw.js`), manifest, localStorage + PGlite (Postgres-in-browser, IndexedDB) mirror.
- Backend (`supabase_schema.sql` v0.1.0): profiles, categories, transactions, budgets; owner-only RLS; `handle_new_user` bootstrap; server-side functions `add_transaction`, `set_profile_name`, `get_dashboard_stats`, `get_monthly_series`.
- Version control: `VERSION` file + version shown in app footer/Settings/About; this changelog.
- GitHub Pages ready: `vite.config.js` (`base: /finance_tracker/`), `package.json`, deploy workflow (`github-workflows-deploy.txt` → place at `.github/workflows/deploy.yml`).
- Mobile-first responsive layout with desktop sidebar; strict black-and-white colour scheme.
