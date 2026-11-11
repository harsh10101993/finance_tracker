# Finance Tracker — v0.2.0

Black & white, mobile-first, offline-first finance tracker PWA. No login —
opens straight into the app. Vue 3 + Vite + PGlite (offline Postgres in the browser).

Dashboard (balance, income/expense, 6-month chart, categories, recent) →
transactions (add/edit/delete, search, filter, **bank statement PDF import** with
one-tap deletion of all PDF imports) →
settings (currency, black/white theme, PWA install, export/import) →
profile (display name, stats, erase).

Bank PDF import: upload a statement PDF — credits become **income** (salary etc.),
debits become **expenses**, with category guesses, per-row kind/category overrides
and duplicate detection. Review everything before importing.

## Repo layout (this folder IS the repo root when pushing to GitHub)

| File | Purpose |
|---|---|
| `index.html` | Standalone entry (Vite / GitHub Pages). |
| `app.js`, `styles.css`, `db.js`, `pdf_import.js` | App code + bank-PDF parser. |
| `supabase_client.js`, `supabase_schema.sql` | Kept for optional future cloud use (not required by the app). |
| `VERSION`, `CHANGELOG.md` | Version control + changelog (also shown in-app). |
| `package.json`, `vite.config.js` | Vite dev/build, `base: /finance_tracker/` for Pages. |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | PWA offline support. |
| `gitignore.txt` | Save as `.gitignore` at repo root. |
| `github-workflows-deploy.txt` | Save as `.github/workflows/deploy.yml` at repo root. |

## 1) Data (local-first, no account)

Everything is stored on-device (localStorage + PGlite mirror) — no backend needed.
Optional future cloud: `supabase_schema.sql` + `supabase_client.js` are kept in
the repo if multi-device sync is ever wanted.

## 2) Local dev / build

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
npm run preview
```

## 3) GitHub Pages + push

```bash
# inside this folder (repo root):
cp gitignore.txt .gitignore
mkdir -p .github/workflows && cp github-workflows-deploy.txt .github/workflows/deploy.yml
git init -b main
git add .
git commit -m "Finance Tracker v0.2.0"
git remote add origin https://github.com/harsh10101993/finance_tracker.git
git push -u origin main
```

Then: repo Settings → Pages → Source: **GitHub Actions**.
Live URL: `https://harsh10101993.github.io/finance_tracker/`

## 4) Versioning

- Bump `VERSION`, add a `CHANGELOG.md` entry.
- PWA cache key in `sw.js` (`fintrack-vX`) must match the release.
