// Finance Tracker — offline-first storage layer (localStorage + optional PGlite mirror).
// PGlite (Postgres in the browser, persisted to IndexedDB) is loaded lazily so it
// never blocks first paint. If it fails, localStorage remains the source of truth.
const LS_TX = "ft_txs_v1";
const LS_USERS = "ft_users_v1";
const LS_SESSION = "ft_session_v1";
const LS_SETTINGS = "ft_settings_v1";

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.floor(Math.random() * 1e9));

function read(key, fb) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fb;
  } catch { return fb; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

export const DEFAULT_CATS = [
  { name: "Salary", kind: "income" }, { name: "Freelance", kind: "income" },
  { name: "Food", kind: "expense" }, { name: "Transport", kind: "expense" },
  { name: "Shopping", kind: "expense" }, { name: "Bills", kind: "expense" },
  { name: "Health", kind: "expense" }, { name: "Other", kind: "expense" },
];

export const DB = {
  pglite: null,      // PGlite instance when available
  pgliteReady: false,
  pgliteError: null,

  settings() { return read(LS_SETTINGS, {}); },
  saveSettings(s) { write(LS_SETTINGS, s); },

  // ---- local demo auth ----
  users() { return read(LS_USERS, []); },
  _saveUsers(u) { write(LS_USERS, u); },
  signup(email, password, name) {
    email = String(email || "").trim().toLowerCase();
    if (!email || !password) throw new Error("Email and password are required.");
    const users = this.users();
    if (users.find((u) => u.email === email)) throw new Error("Account already exists. Please log in.");
    const u = { id: uid(), email, password, name: name || email.split("@")[0], createdAt: new Date().toISOString() };
    users.push(u); this._saveUsers(users);
    write(LS_SESSION, { id: u.id });
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
  },
  login(email, password) {
    email = String(email || "").trim().toLowerCase();
    const u = this.users().find((x) => x.email === email && x.password === password);
    if (!u) throw new Error("Invalid email or password.");
    write(LS_SESSION, { id: u.id });
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
  },
  logout() { try { localStorage.removeItem(LS_SESSION); } catch {} },
  sessionUser() {
    const s = read(LS_SESSION, null);
    if (!s) return null;
    const u = this.users().find((x) => x.id === s.id);
    return u ? { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt } : null;
  },
  resetPassword(email) {
    // Demo/offline mode: no email backend — set a temporary password and return it.
    email = String(email || "").trim().toLowerCase();
    const users = this.users();
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error("No account found for that email.");
    const tmp = "tmp-" + Math.random().toString(36).slice(2, 8);
    u.password = tmp; this._saveUsers(users);
    return tmp;
  },
  setPassword(userId, next) {
    const users = this.users();
    const u = users.find((x) => x.id === userId);
    if (!u) throw new Error("User not found.");
    u.password = next; this._saveUsers(users);
  },
  updateProfile(userId, name) {
    const users = this.users();
    const u = users.find((x) => x.id === userId);
    if (!u) throw new Error("User not found.");
    u.name = name; this._saveUsers(users);
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
  },
  deleteAccount(userId) {
    this._saveUsers(this.users().filter((x) => x.id !== userId));
    write(LS_TX, read(LS_TX, []).filter((t) => t.userId !== userId));
    this.logout();
  },

  // ---- transactions (local source of truth) ----
  txs(userId) { return read(LS_TX, []).filter((t) => !userId || t.userId === userId); },
  addTx(t) {
    const all = read(LS_TX, []);
    const row = { id: uid(), createdAt: new Date().toISOString(), ...t };
    all.push(row); write(LS_TX, all);
    this._mirrorToPGlite().catch(() => {});
    return row;
  },
  addMany(list) {
    const all = read(LS_TX, []);
    const rows = (list || []).map((t) => ({ id: uid(), createdAt: new Date().toISOString(), ...t }));
    write(LS_TX, all.concat(rows));
    this._mirrorToPGlite().catch(() => {});
    return rows;
  },
  updateTx(id, patch) {
    const all = read(LS_TX, []);
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) throw new Error("Transaction not found.");
    all[i] = { ...all[i], ...patch };
    write(LS_TX, all);
    this._mirrorToPGlite().catch(() => {});
    return all[i];
  },
  deleteTx(id) {
    write(LS_TX, read(LS_TX, []).filter((t) => t.id !== id));
    this._mirrorToPGlite().catch(() => {});
  },
  deleteImported(userId) {
    const all = read(LS_TX, []);
    const gone = all.filter((t) => t.userId === userId && t.source === "pdf").length;
    write(LS_TX, all.filter((t) => !(t.userId === userId && t.source === "pdf")));
    this._mirrorToPGlite().catch(() => {});
    return gone;
  },
  exportAll() {
    return JSON.stringify({ app: "finance-tracker", version: "0.1.0", exportedAt: new Date().toISOString(), txs: read(LS_TX, []), users: this.users() }, null, 2);
  },
  importAll(text) {
    const d = JSON.parse(text);
    if (!Array.isArray(d.txs)) throw new Error("Invalid backup file.");
    write(LS_TX, d.txs);
    if (Array.isArray(d.users)) this._saveUsers(d.users);
    this._mirrorToPGlite().catch(() => {});
  },
  clearUser(userId) {
    write(LS_TX, read(LS_TX, []).filter((t) => t.userId !== userId));
    this._mirrorToPGlite().catch(() => {});
  },

  // ---- PGlite: Postgres-in-browser mirror (IndexedDB), best-effort ----
  async initPGlite(onStatus) {
    try {
      // jsdelivr +esm keeps PGlite's relative wasm/data assets resolvable (esm.sh 404s on postgres.data).
      // @vite-ignore: keep as a runtime CDN import, never bundle.
      const { PGlite } = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.7/+esm");
      this.pglite = new PGlite("idb://finance-tracker");
      await this.pglite.query(`
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY, user_id TEXT, kind TEXT,
          amount NUMERIC, currency TEXT, category TEXT,
          note TEXT, occurred_on DATE, created_at TEXT
        );`);
      this.pgliteReady = true;
      await this._mirrorToPGlite();
      onStatus && onStatus(true);
    } catch (e) {
      this.pgliteError = String(e && e.message || e);
      onStatus && onStatus(false);
    }
  },
  async _mirrorToPGlite() {
    if (!this.pglite) return;
    const rows = read(LS_TX, []);
    await this.pglite.query("DELETE FROM transactions;");
    for (const t of rows) {
      await this.pglite.query(
        "INSERT INTO transactions (id,user_id,kind,amount,currency,category,note,occurred_on,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [t.id, t.userId, t.kind, t.amount, t.currency || "", t.category || "", t.note || "", t.date || null, t.createdAt || ""]
      );
    }
  },
  async sql(q, params) {
    if (!this.pglite) throw new Error("PGlite not ready (using localStorage).");
    return this.pglite.query(q, params);
  },
};
