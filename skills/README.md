# Skills (vendored agent guidance)

Text-only copies of third-party agent skills used on this project. Sources:

| Skill | Source | License |
|---|---|---|
| `security-audit` | https://github.com/cloudflare/security-audit-skill | see `security-audit/LICENSE` |
| `supabase` | https://github.com/supabase/agent-skills | Apache-2.0 (upstream repo) |
| `supabase-postgres-best-practices` | https://github.com/supabase/agent-skills | Apache-2.0 (upstream repo) |
| `karpathy-guidelines` | https://github.com/multica-ai/andrej-karpathy-skills | MIT |

Notes:
- Only the skill content is vendored (`SKILL.md` + reference docs + the audit
  skill's `report-schema.json` / validators). CI configs, tests, lockfiles,
  images and marketing sites were left out.
- `agents.md` (https://github.com/agentsmd/agents.md) is the website for the
  AGENTS.md agent-file format — there was no skill to vendor from it. The
  convention itself is adopted as `src/AGENTS.md`.
- Re-sync a skill by downloading its repo zip and copying the same file set.
