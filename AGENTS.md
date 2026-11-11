# AGENTS.md — Finance Tracker

Local-first finance-tracker PWA. Vue 3 (CDN) + Vite + PGlite, no login, no
backend. This file is the starting point for any agent working on the repo;
`src/README.md` has the full manual and `scratch/CURRENT_TASK.md` (when
present) has the in-progress task state.

## Layout

- `index.html` (workspace root) — Perchance preview entry, body-only.
- `src/index.html` — standalone entry (Vite / GitHub Pages).
- `src/app.js` — all UI (Vue). `src/db.js` — localStorage + PGlite store.
- `src/pdf_import.js` — bank-statement PDF parser (`parseBankPdf`,
  `guessCategory`, `isSelfTransfer`). `src/sms_import.js` — SMS import.
- `src/supabase_client.js`, `src/supabase_schema.sql` — future cloud use only.
- `src/VERSION`, `src/CHANGELOG.md`, `src/sw.js` (`fintrack-vX` cache key).

## Working rules

- Follow `src/skills/karpathy-guidelines/SKILL.md` for every code change:
  simplicity first, surgical diffs, match existing style, verify in the live
  preview (`page_refresh` + `page_eval`, zero console/perchance errors).
- Version every user-facing change: bump `src/VERSION`, add a
  `src/CHANGELOG.md` entry, keep the `sw.js` cache key in sync.
- Keep `src/README.md` and `scratch/CURRENT_TASK.md` current.
- Never commit secrets. The server-plugin rule applies if `server-plugin`
  is ever added: server code is public source — no passwords/tokens in it.
- Push via the GitHub REST git-database API on a user-supplied PAT
  (fine-grained, Contents + Workflows read/write); the PAT itself is never
  stored in the repo.

## Skills (vendored under `src/skills/`, see its README for sources)

- **Code changes** → `karpathy-guidelines` (default).
- **Security questions / reviews** → `security-audit/SKILL.md` in guidance
  mode. Run the full six-phase audit workflow only on explicit request
  ("audit the codebase", "full review", report artifacts).
- **Anything Supabase** (`supabase_schema.sql`, `supabase_client.js`,
  future sync) → `supabase/SKILL.md` first (changelog check, security
  checklist, verify-after-fix), plus `supabase-postgres-best-practices`
  for schema/query work.
