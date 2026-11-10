import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && anon && !url.includes('your-project-ref'))

// When not configured (e.g. GitHub Pages demo without keys), the app runs in
// fully-offline DEMO mode: PGlite + local auth. Same UI, same RPC-shaped API.
export const supabase = isSupabaseConfigured
  ? createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null

export function rpc(fn, args = {}) {
  if (!supabase) throw new Error('Supabase not configured')
  return supabase.rpc(fn, args)
}
