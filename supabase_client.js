// Finance Tracker — Supabase client + server-side operations.
// All heavy work runs in Postgres via the functions defined in supabase_schema.sql
// (single source of truth). Lazy-loaded so offline/demo mode needs no network.
let client = null;
let cfg = { url: "", anonKey: "" };

export const SB = {
  get client() { return client; },
  isConfigured() { return !!(cfg.url && cfg.anonKey && client); },

  async configure(url, anonKey) {
    cfg = { url: (url || "").trim(), anonKey: (anonKey || "").trim() };
    if (!cfg.url || !cfg.anonKey) { client = null; return null; }
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.44.4");
    client = createClient(cfg.url, cfg.anonKey);
    return client;
  },

  async signUp(email, password, name) {
    const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: name } } });
    if (error) throw error;
    return data.user;
  },
  async signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signOut() {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  },
  async resetEmail(email) {
    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },
  async sessionUser() {
    const { data } = await client.auth.getUser();
    const u = data && data.user;
    if (!u) return null;
    const prof = await this.profile(u.id).catch(() => null);
    return { id: u.id, email: u.email, name: (prof && prof.display_name) || u.email, createdAt: u.created_at };
  },

  // Server-side ops (Postgres functions from supabase_schema.sql)
  async profile(userId) {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).single();
    if (error) throw error;
    return data;
  },
  async setProfileName(name) {
    const { data, error } = await client.rpc("set_profile_name", { p_name: name });
    if (error) throw error;
    return data;
  },
  async addTransaction(t) {
    const { data, error } = await client.rpc("add_transaction", {
      p_kind: t.kind, p_amount: t.amount, p_currency: t.currency || "INR",
      p_category: t.category || "Other", p_note: t.note || "",
      p_occurred_on: t.date,
    });
    if (error) throw error;
    return data;
  },
  async listTransactions(limit) {
    const { data, error } = await client.from("transactions").select("*").order("occurred_on", { ascending: false }).limit(limit || 500);
    if (error) throw error;
    return (data || []).map((r) => ({ id: r.id, kind: r.kind, amount: Number(r.amount), currency: r.currency, category: r.category_name, note: r.note, date: r.occurred_on }));
  },
  async deleteTransaction(id) {
    const { error } = await client.from("transactions").delete().eq("id", id);
    if (error) throw error;
  },
  async dashboardStats(monthStart) {
    const { data, error } = await client.rpc("get_dashboard_stats", { p_month: monthStart });
    if (error) throw error;
    return data;
  },
  async monthlySeries(months) {
    const { data, error } = await client.rpc("get_monthly_series", { p_months: months || 6 });
    if (error) throw error;
    return data;
  },
};
