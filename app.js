// Finance Tracker v0.2.0 — no login. Local-first (localStorage + PGlite mirror).
// Bank statement PDF import: credits → income, debits → expenses.
import { createApp, ref, reactive, computed, onMounted } from "https://cdn.jsdelivr.net/npm/vue@3.4.31/dist/vue.esm-browser.js";
import { DB, DEFAULT_CATS } from "./db.js";
import { parseBankPdf } from "./pdf_import.js";
import { parseSmsFile } from "./sms_import.js";

const APP_VERSION = "0.2.8";
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "JPY", "AUD", "CAD"];
const LOCAL_FALLBACK_UID = "local";

async function fetchFirst(paths, fallback) {
  for (const p of paths) {
    try {
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) return await r.text();
    } catch {}
  }
  return fallback;
}
const todayISO = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const monthStartISO = (d) => { const x = new Date(d); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-01"; };

const app = createApp({
  setup() {
    const boot = ref(true);
    const uid = ref(LOCAL_FALLBACK_UID);
    const profileName = ref("My Account");
    const selfKeys = ref(""); // own-account fragments for self-transfer detection
    const memberSince = ref(new Date().toISOString().slice(0, 10));
    const tab = ref("dashboard");
    const txs = ref([]);
    const q = ref(""), kindFilter = ref("all");
    const showModal = ref(false), editing = ref(null);
    const form = reactive({ kind: "expense", amount: "", category: "Food", note: "", date: todayISO() });
    const settings = reactive({ currency: "INR", theme: "light" });
    const online = ref(navigator.onLine);
    const pglite = ref("starting");
    const toastMsg = ref("");
    const version = ref(APP_VERSION);
    const changelog = ref("");
    const canInstall = ref(false);
    let deferredPrompt = null;
    // pdf import
    const importOpen = ref(false), importBusy = ref(false), importMsg = ref(""), parseErr = ref("");
    const importKind = ref("pdf"); // 'pdf' | 'sms'
    const fileAccept = computed(() => (importKind.value === "pdf" ? "application/pdf,.pdf" : ".xml,.txt,.csv"));
    const needPw = ref(false), pdfPassword = ref(""), pwErr = ref("");
    const importFileName = ref("statement.pdf");
    const parsed = ref([]);
    const skipDupes = ref(true);
    const showDbg = ref(false);
    let pdfBytesStore = null;
    const parseFn = () => (window.__ftParsePdf || parseBankPdf); // test hook: stub in page_eval if needed

    let toastT = null;
    function toast(m) {
      toastMsg.value = m;
      clearTimeout(toastT);
      toastT = setTimeout(() => (toastMsg.value = ""), 2600);
    }
    function money(n) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "INR", maximumFractionDigits: 2 }).format(n);
      } catch { return (settings.currency || "") + " " + Number(n).toFixed(2); }
    }
    function cmoney(n) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "INR", notation: "compact", maximumFractionDigits: 1 }).format(n);
      } catch { return (settings.currency || "") + " " + Number(n).toFixed(0); }
    }
    const cats = computed(() => {
      const kinds = {};
      for (const c of DEFAULT_CATS) kinds[c.name] = c.kind;
      for (const t of txs.value) if (t.category && !kinds[t.category]) kinds[t.category] = t.kind;
      for (const r of parsed.value) if (r.category && !kinds[r.category]) kinds[r.category] = r.kind;
      const arr = Object.entries(kinds).map(([n, k]) => ({ name: n, kind: k }));
      // "Other" must exist for BOTH kinds (imported income often lands on Other)
      if (!arr.some((c) => c.name === "Other" && c.kind === "income")) arr.push({ name: "Other", kind: "income" });
      if (!arr.some((c) => c.name === "Other" && c.kind === "expense")) arr.push({ name: "Other", kind: "expense" });
      return arr;
    });
    const catsForKind = computed(() => (form.kind === "transfer" ? cats.value : cats.value.filter((c) => c.kind === form.kind)));
    function catsForKindOf(k) { return k === "transfer" ? cats.value : cats.value.filter((c) => c.kind === k); }

    function localStats(list) {
      const act = list.filter((t) => t.kind !== "transfer"); // self-transfers never count
      const m = monthStartISO(new Date());
      let income = 0, expense = 0, trTotal = 0, trCount = 0;
      const byCat = {};
      for (const t of list) {
        const a = Number(t.amount) || 0;
        if (t.kind === "transfer") { trTotal += a; trCount++; continue; }
        if (t.kind === "income") income += a; else expense += a;
        const k = t.category || "Other";
        byCat[k] = (byCat[k] || 0) + a;
      }
      const cur = act.filter((t) => (t.date || "").slice(0, 7) === m.slice(0, 7));
      let mIn = 0, mOut = 0;
      for (const t of cur) { const a = Number(t.amount) || 0; if (t.kind === "income") mIn += a; else mOut += a; }
      return { income, expense, balance: income - expense, monthIncome: mIn, monthExpense: mOut, monthBalance: mIn - mOut, byCat, count: act.length, transfers: trTotal, transferCount: trCount };
    }
    const stats = computed(() => localStats(txs.value));
    const period = ref(6); // dashboard chart range in months: 3 | 6 | 12
    const periodLabel = computed(() => (period.value === 12 ? "12 months" : period.value + " months"));
    const monthly = computed(() => {
      const N = period.value;
      const out = [];
      const now = new Date();
      for (let i = N - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        let inc = 0, exp = 0;
        for (const t of txs.value) {
          if (t.kind === "transfer") continue;
          if ((t.date || "").slice(0, 7) === key) {
            const a = Number(t.amount) || 0;
            if (t.kind === "income") inc += a; else exp += a;
          }
        }
        out.push({ key, label: d.toLocaleString(undefined, { month: "short" }), inc, exp, sav: inc - exp });
      }
      return out;
    });
    const maxBar = computed(() => Math.max(1, ...monthly.value.flatMap((m) => [m.inc, m.exp])));
    const topCats = computed(() => {
      const e = Object.entries(stats.value.byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const tot = e.reduce((s, x) => s + x[1], 0) || 1;
      return e.map(([n, v]) => ({ n, v, pct: Math.round((v / tot) * 100) }));
    });
    const filtered = computed(() => {
      const s = q.value.trim().toLowerCase();
      return txs.value
        .filter((t) => kindFilter.value === "all" || t.kind === kindFilter.value)
        .filter((t) => !s || (t.note || "").toLowerCase().includes(s) || (t.category || "").toLowerCase().includes(s))
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    });
    const recent = computed(() => txs.value.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6));
    const selectedMonths = ref([]); // YYYY-MM strings to include from an import
    const monthsInParsed = computed(() => {
      const map = {};
      for (const r of parsed.value) {
        const m = (r.date || "").slice(0, 7);
        if (m) map[m] = (map[m] || 0) + 1;
      }
      return Object.keys(map).sort().map((m) => ({ m, n: map[m], label: new Date(m + "-01T00:00").toLocaleString(undefined, { month: "short", year: "numeric" }) }));
    });
    function toggleMonth(m) {
      const i = selectedMonths.value.indexOf(m);
      if (i < 0) selectedMonths.value.push(m);
      else selectedMonths.value.splice(i, 1);
    }
    const parsedVisible = computed(() => parsed.value.filter((r) => selectedMonths.value.includes((r.date || "").slice(0, 7))));
    const hasParsed = computed(() => parsed.value.length > 0);
    const selectedCount = computed(() => parsedVisible.value.filter((r) => r.checked).length);
    const dupeCount = computed(() => parsedVisible.value.filter((r) => r.dupe).length);
    const importedCount = computed(() => txs.value.filter((t) => t.source === "pdf" || t.source === "sms").length);
    async function clearPdfImports() {
      if (!importedCount.value) return;
      if (!confirm("Delete all " + importedCount.value + " imported transactions (PDF + SMS)? Manual entries stay untouched.")) return;
      const n = DB.deleteImported(uid.value);
      await loadTxs();
      toast("Deleted " + n + " imported transactions");
    }

    function persistProfile() { DB.saveSettings({ currency: settings.currency, theme: settings.theme, profileName: profileName.value, selfKeys: selfKeys.value, uid: uid.value, memberSince: memberSince.value }); }
    function applyTheme() {
      document.documentElement.setAttribute("data-theme", settings.theme === "dark" ? "dark" : "light");
    }
    async function loadTxs() {
      const all = DB.txs(null);
      if (!all.some((t) => t.userId === uid.value) && all.length) {
        // adopt data from previous (demo/login-era) install instead of showing empty
        const freq = {};
        for (const t of all) freq[t.userId || "local"] = (freq[t.userId || "local"] || 0) + 1;
        uid.value = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
        persistProfile();
      }
      txs.value = DB.txs(uid.value);
    }

    // ---------- transactions ----------
    function setKind(k) {
      form.kind = k;
      const ok = catsForKind.value.some((c) => c.name === form.category);
      if (!ok) form.category = (catsForKind.value[0] || {}).name || (k === "income" ? "Salary" : "Food");
    }
    function openAdd() {
      editing.value = null;
      Object.assign(form, { kind: "expense", amount: "", category: "Food", note: "", date: todayISO() });
      showModal.value = true;
    }
    function openEdit(t) {
      editing.value = t;
      Object.assign(form, { kind: t.kind, amount: t.amount, category: t.category, note: t.note || "", date: t.date });
      showModal.value = true;
    }
    async function saveTx() {
      const amt = Number(form.amount);
      if (!amt || amt <= 0) { toast("Enter a valid amount"); return; }
      if (!form.category) setKind(form.kind);
      busy.value = true;
      try {
        const payload = { kind: form.kind, amount: amt, currency: settings.currency, category: form.category, note: form.note, date: form.date, userId: uid.value };
        if (editing.value) DB.updateTx(editing.value.id, payload);
        else DB.addTx(payload);
        await loadTxs();
        showModal.value = false;
        toast(editing.value ? "Transaction updated" : "Transaction added");
      } catch (e) { toast("Save failed: " + (e.message || e)); }
      busy.value = false;
    }
    async function delTx(t) {
      if (!confirm("Delete this transaction?")) return;
      DB.deleteTx(t.id);
      await loadTxs();
      toast("Deleted");
    }
    function loadSample() {
      const u = uid.value, c = settings.currency;
      DB.addMany([
        { kind: "income", amount: 85000, category: "Salary", note: "Monthly salary", date: todayISO(), userId: u, currency: c },
        { kind: "expense", amount: 1200, category: "Groceries", note: "Groceries", date: todayISO(), userId: u, currency: c },
        { kind: "expense", amount: 800, category: "Transport", note: "Metro + cab", date: todayISO(), userId: u, currency: c },
      ]);
      loadTxs();
      toast("Sample data added");
    }

    // ---------- statement import (PDF + SMS) ----------
    function openImport(kind) {
      importKind.value = kind || "pdf";
      importOpen.value = true; parseErr.value = ""; parsed.value = [];
      needPw.value = false; selectedMonths.value = [];
    }
    function stampRows(list, foundMsg) {
      const existing = new Set(DB.txs(uid.value).map((t) => (t.date || "") + "|" + Number(t.amount) + "|" + String(t.note || "").toLowerCase().slice(0, 40)));
      parsed.value = list.slice(0, 500).map((r) => {
        const key = (r.date || "") + "|" + Number(r.amount) + "|" + String(r.note || "").toLowerCase().slice(0, 40);
        const dupe = existing.has(key);
        return { ...r, checked: !dupe || !skipDupes.value, dupe };
      });
      selectedMonths.value = monthsInParsed.value.map((m) => m.m);
      needPw.value = false;
      importMsg.value = "";
      toast(list.length + " found" + (foundMsg || ""));
    }
    async function tryParsePdf(pw) {
      importBusy.value = true; parseErr.value = ""; pwErr.value = "";
      try {
        importMsg.value = "Reading PDF…";
        // slice(0): pdf.js detaches (transfers) the buffer it is given, so every
        // attempt — including password retries — needs a fresh copy.
        const res = await parseFn()(pdfBytesStore.slice(0), (p) => { importMsg.value = "Parsing pages… " + Math.round(p * 100) + "%"; }, pw || undefined, profileName.value, selfKeys.value);
        if (!res.transactions.length) throw new Error("No transactions found. The PDF may be a scanned image (no text layer) or an unsupported layout.");
        stampRows(res.transactions, res.headerFound ? "" : " (no debit/credit header — check kinds)");
      } catch (e) {
        if (e && e.pdfPassword) {
          needPw.value = true;
          pwErr.value = e.pdfPassword === "incorrect" ? "Wrong password — try again." : "";
          importMsg.value = "";
        } else { parseErr.value = "Import failed: " + (e.message || e); }
      }
      importBusy.value = false;
    }
    async function tryParseSms(file) {
      importBusy.value = true; parseErr.value = "";
      try {
        importMsg.value = "Reading SMS file…";
        const res = await parseSmsFile(file, profileName.value, selfKeys.value);
        if (!res.transactions.length) throw new Error("No bank transactions found in that file. Use an SMS Backup & Restore XML export, or a text file with one alert per line.");
        stampRows(res.transactions, " from " + res.count + " messages");
      } catch (e) { parseErr.value = "Import failed: " + (e.message || e); }
      importBusy.value = false;
    }
    async function onImportFile(ev) {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      parsed.value = []; needPw.value = false; pdfPassword.value = ""; selectedMonths.value = [];
      if (importKind.value === "sms") {
        importFileName.value = f.name || "sms.xml";
        await tryParseSms(f);
      } else {
        pdfBytesStore = await f.arrayBuffer();
        importFileName.value = f.name || "statement.pdf";
        await tryParsePdf("");
      }
    }
    function unlockPdf() { if (pdfBytesStore && pdfPassword.value) tryParsePdf(pdfPassword.value); }
    function applyDupeFlags() {
      if (skipDupes.value) for (const r of parsed.value) if (r.dupe) r.checked = false;
    }
    function onImpKind(r) {
      if (!catsForKindOf(r.kind).some((c) => c.name === r.category)) r.category = (catsForKindOf(r.kind)[0] || {}).name || "Other";
    }
    async function doImportSelected() {
      const rows = parsedVisible.value.filter((r) => r.checked);
      if (!rows.length) { toast("Nothing selected"); return; }
      DB.addMany(rows.map((r) => ({ kind: r.kind, amount: r.amount, currency: settings.currency, category: r.category || "Other", note: (r.note || "").slice(0, 120), date: r.date, userId: uid.value, source: importKind.value, batch: importFileName.value })));
      await loadTxs();
      importOpen.value = false; parsed.value = [];
      tab.value = "dashboard";
      toast("Imported " + rows.length + " transactions");
    }

    // ---------- settings / profile ----------
    function saveSettings() { persistProfile(); applyTheme(); toast("Settings saved"); }
    function saveProfile() {
      if (!profileName.value.trim()) { toast("Enter a display name"); return; }
      profileName.value = profileName.value.trim();
      persistProfile();
      toast("Profile updated");
    }
    function exportData() {
      const blob = new Blob([DB.exportAll()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "finance-tracker-backup.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    function importData(ev) {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        try { DB.importAll(String(r.result)); await loadTxs(); toast("Backup imported"); }
        catch (e) { toast("Import failed: " + (e.message || e)); }
      };
      r.readAsText(f);
      ev.target.value = "";
    }
    async function eraseAll() {
      if (!confirm("Erase ALL transactions and reset the profile? This cannot be undone.")) return;
      DB.clearUser(uid.value);
      await loadTxs();
      toast("All data erased");
    }
    function installApp() {
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; canInstall.value = false; }
      else toast("Use browser menu → Install / Add to Home Screen");
    }

    onMounted(async () => {
      const s = DB.settings();
      settings.currency = s.currency || "INR";
      settings.theme = s.theme || "light";
      profileName.value = s.profileName || "My Account";
      selfKeys.value = s.selfKeys || "";
      uid.value = s.uid || LOCAL_FALLBACK_UID;
      memberSince.value = s.memberSince || new Date().toISOString().slice(0, 10);
      persistProfile();
      applyTheme();
      await loadTxs();
      version.value = (await fetchFirst(["src/VERSION", "VERSION"], APP_VERSION)).trim() || APP_VERSION;
      changelog.value = await fetchFirst(["src/CHANGELOG.md", "CHANGELOG.md"], "");
      window.addEventListener("online", () => (online.value = true));
      window.addEventListener("offline", () => (online.value = false));
      window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; canInstall.value = true; });
      try {
        if ("serviceWorker" in navigator) {
          for (const u of ["sw.js", "src/sw.js", "./sw.js", "./src/sw.js"]) {
            try { await navigator.serviceWorker.register(u); break; } catch {}
          }
        }
      } catch {}
      DB.initPGlite((ok) => { pglite.value = ok ? "ready" : "fallback"; });
      setTimeout(() => { if (pglite.value === "starting") pglite.value = "fallback"; }, 8000);
      boot.value = false;
    });

    const busy = ref(false);
    return {
      boot, busy, profileName, selfKeys, memberSince, tab, txs, q, kindFilter, showModal, editing, form,
      settings, online, pglite, toastMsg, version, changelog, canInstall,
      importOpen, importBusy, importMsg, parseErr, skipDupes, parsedVisible,
      needPw, pdfPassword, pwErr, unlockPdf, showDbg, period, periodLabel,
      importKind, fileAccept, monthsInParsed, selectedMonths, toggleMonth, hasParsed,
      CURRENCIES, cats, catsForKind, stats, monthly, maxBar, topCats, filtered, recent,
      selectedCount, dupeCount,
      money, cmoney, openAdd, openEdit, setKind, saveTx, delTx, loadSample,      openImport, onImportFile, applyDupeFlags, onImpKind, doImportSelected, catsForKindOf,
      importedCount, clearPdfImports,
      saveSettings, saveProfile, exportData, importData, eraseAll, installApp,
    };
  },
  template: `
  <div v-if="boot" class="auth-wrap"><div class="auth-card"><div class="brand"><div class="brand-mark">F</div><div><h1>Finance Tracker</h1><small>loading…</small></div></div></div></div>

  <div v-else>
    <div class="topbar"><div class="topbar-in">
      <div class="brand-mark" style="width:34px;height:34px;font-size:17px;border-radius:9px;">F</div>
      <b>Finance Tracker</b>
      <span class="mode-pill">local</span>
      <span class="sp"></span>
      <span :class="['netdot', online?'':'off']" :title="online?'online':'offline'"></span>
      <small class="sub">{{online?'online':'offline'}}</small>
    </div></div>

    <div class="layout"><div>
      <nav class="tabbar">
        <button :class="{on:tab==='dashboard'}" @click="tab='dashboard'"><span class="ic">▦</span>Dashboard</button>
        <button :class="{on:tab==='transactions'}" @click="tab='transactions'"><span class="ic">≣</span>Txns</button>
        <button :class="{on:tab==='settings'}" @click="tab='settings'"><span class="ic">⚙</span>Settings</button>
        <button :class="{on:tab==='profile'}" @click="tab='profile'"><span class="ic">○</span>Profile</button>
      </nav>
    </div><div>

      <section v-if="tab==='dashboard'">
        <div class="grid">
          <div class="card solid"><div class="kicker">Total balance</div><div class="big">{{money(stats.balance)}}</div><div class="sub">{{stats.count}} transactions · {{money(stats.monthIncome)}} in / {{money(stats.monthExpense)}} out this month</div><div v-if="stats.transferCount" class="sub">⇄ {{stats.transferCount}} self-transfers excluded ({{money(stats.transfers)}} moved)</div></div>
          <div class="grid c2">
            <div class="card"><div class="kicker">Income (all time)</div><div class="big" style="font-size:22px;">{{money(stats.income)}}</div></div>
            <div class="card"><div class="kicker">Expense (all time)</div><div class="big" style="font-size:22px;">{{money(stats.expense)}}</div></div>
          </div>
          <div class="card"><div class="sec-row"><div class="kicker">Last {{periodLabel}}</div><div class="seg" style="max-width:220px;"><button :class="{on:period===3}" @click="period=3">3M</button><button :class="{on:period===6}" @click="period=6">6M</button><button :class="{on:period===12}" @click="period=12">1Y</button></div></div>
            <div class="ybar">
              <div class="yaxis"><div class="ysav"></div><div class="ytracks"><span class="t">{{cmoney(maxBar)}}</span><span class="z">0</span><span class="b">{{cmoney(maxBar)}}</span></div><div class="ylab"></div></div>
              <div class="bars2"><div class="bar2" v-for="m in monthly" :key="m.key">
                <div class="sav" :class="m.sav>=0?'in':'out'" :title="'saved '+money(m.sav)">{{cmoney(m.sav)}}</div>
                <div class="up"><div class="col inc" :style="{height:(m.inc>0?Math.max(2,(m.inc/maxBar)*70):0)+'px'}" :title="'in '+money(m.inc)"></div></div>
                <div class="zero"></div>
                <div class="down"><div class="col exp" :style="{height:(m.exp>0?Math.max(2,(m.exp/maxBar)*70):0)+'px'}" :title="'out '+money(m.exp)"></div></div>
                <small>{{m.label}}</small>
              </div></div>
            </div>
            <div class="sub"><span class="sw inc"></span> income (up) · <span class="sw exp"></span> expense (down) · top number = saved</div>
          </div>
          <div class="card"><div class="kicker">Top categories</div>
            <div v-if="!topCats.length" class="sub">No data yet.</div>
            <div class="legend"><div v-for="c in topCats" :key="c.n"><b>{{c.n}}</b><span>{{money(c.v)}} · {{c.pct}}%</span></div></div>
          </div>
          <div class="card"><div class="sec-row"><div class="kicker">Recent</div><button class="iconbtn desk-add" @click="openAdd">+ Add</button></div>
            <div v-if="!recent.length" class="sub">Nothing here yet. <button class="link" @click="openAdd">Add your first transaction</button>, <button class="link" @click="openImport('pdf')">import a bank PDF</button> or <button class="link" @click="loadSample">load sample data</button>.</div>
            <div v-for="t in recent" :key="t.id" class="txn"><div class="dot">{{(t.category||'?').slice(0,1)}}</div><div class="meta"><b>{{t.note||t.category}}</b><span>{{t.date}} · {{t.category}}</span></div><div :class="['amt', t.kind==='income'?'in':(t.kind==='transfer'?'tr':'out')]">{{money(t.amount)}}</div></div>
          </div>
        </div>
      </section>

      <section v-if="tab==='transactions'">
        <div class="sec-row"><h2 class="sec">Transactions</h2><button class="iconbtn desk-add" @click="openAdd">+ Add</button></div>
        <div class="toolbar"><input class="input" v-model="q" placeholder="Search note or category…"><select class="input" v-model="kindFilter" style="max-width:130px;"><option value="all">All</option><option value="income">Income</option><option value="expense">Expense</option><option value="transfer">Transfer</option></select><button class="btn sm" @click="openImport('pdf')">Import PDF</button><button class="btn ghost sm" @click="openImport('sms')">Import SMS</button><button v-if="importedCount" class="btn ghost sm" @click="clearPdfImports">Clear imports ({{importedCount}})</button></div>
        <div class="card">
          <div v-if="!filtered.length" class="sub">No transactions match.</div>
          <div v-for="t in filtered" :key="t.id" class="txn"><div class="dot">{{(t.category||'?').slice(0,1)}}</div><div class="meta"><b>{{t.note||t.category}}</b><span>{{t.date}} · {{t.category}} · {{t.kind}}<span v-if="t.source"> · {{t.source === "sms" ? "SMS" : "PDF"}}</span></span></div><div :class="['amt', t.kind==='income'?'in':(t.kind==='transfer'?'tr':'out')]">{{money(t.amount)}}</div><button class="iconbtn" @click="openEdit(t)">Edit</button><button class="iconbtn" @click="delTx(t)">Del</button></div>
        </div>
      </section>

      <section v-if="tab==='settings'">
        <h2 class="sec">Settings</h2>
        <div class="grid">
          <div class="card"><div class="kicker">Preferences</div>
            <div class="field"><label>Currency</label><select class="input" v-model="settings.currency" @change="saveSettings"><option v-for="c in CURRENCIES" :key="c" :value="c">{{c}}</option></select></div>
            <div class="field"><label>Theme</label><div class="seg"><button :class="{on:settings.theme==='light'}" @click="settings.theme='light';saveSettings()">Light</button><button :class="{on:settings.theme==='dark'}" @click="settings.theme='dark';saveSettings()">Dark</button></div></div>
          </div>
          <div class="card"><div class="kicker">Offline &amp; PWA</div>
            <div class="kv"><span>Local engine</span><b>PGlite: {{pglite}}</b></div>
            <div class="kv"><span>Network</span><b>{{online?'online':'offline'}}</b></div>
            <div class="kv"><span>Storage</span><b>{{stats.count}} transactions on this device</b></div>
            <div class="row2" style="margin-top:10px;"><button class="btn ghost sm" @click="installApp">Install app</button></div>
          </div>
          <div class="card"><div class="kicker">About · v{{version}}</div>
            <pre class="code" v-if="changelog" style="white-space:pre-wrap;">{{changelog.slice(0,1200)}}</pre>
            <div class="foot">Finance Tracker v{{version}} · MIT · black &amp; white · 100% offline, no account needed</div>
          </div>
        </div>
      </section>

      <section v-if="tab==='profile'">
        <h2 class="sec">Profile</h2>
        <div class="grid">
          <div class="card"><div style="display:flex;gap:14px;align-items:center;"><div class="avatar">{{(profileName||'?').slice(0,1).toUpperCase()}}</div><div><b>{{profileName}}</b><div class="sub">Tracking since {{memberSince}} · {{stats.count}} transactions</div></div></div>
            <div class="field" style="margin-top:14px;"><label>Display name</label><input class="input" v-model="profileName"></div>
            <div class="field"><label>Own accounts (self-transfer detection)</label><input class="input" v-model="selfKeys" placeholder="e.g. 4821, myname@okhdfc, HDFC 5678"><p class="hint">Comma separated fragments of your OTHER bank accounts: last 4 digits, UPI IDs, account nicknames. Any NEFT/UPI narration containing one of these is marked as a self-transfer and excluded from totals.</p></div>
            <button class="btn sm" @click="saveProfile" :disabled="busy">Save profile</button>
          </div>
          <div class="card"><div class="kicker">Data</div>
            <div class="row2"><button class="btn ghost sm" @click="exportData">Export JSON</button><label class="btn ghost sm" style="text-align:center;">Import<input type="file" accept=".json" hidden @change="importData"></label></div>
            <div class="row2" style="margin-top:10px;"><button class="btn ghost sm" @click="eraseAll">Erase all data</button></div>
            <p class="hint">Everything stays on this device (localStorage + PGlite). Export a backup before clearing browser data.</p>
          </div>
        </div>
      </section>

      <div class="foot">Finance Tracker v{{version}} · local-first · PGlite {{pglite}}</div>
    </div></div>
    <button v-if="tab==='dashboard'||tab==='transactions'" class="fab" @click="openAdd" title="Add transaction">+</button>

    <div v-if="showModal" class="modal-bg" @click.self="showModal=false"><div class="modal">
      <b>{{editing?'Edit':'Add'}} transaction</b>
      <div class="field"><label>Type</label><div class="seg"><button :class="{on:form.kind==='expense'}" @click="setKind('expense')">Expense</button><button :class="{on:form.kind==='income'}" @click="setKind('income')">Income</button><button :class="{on:form.kind==='transfer'}" @click="setKind('transfer')">Transfer</button></div><p class="hint" v-if="form.kind==='transfer'">Transfers to self are excluded from income, expenses and balance.</p></div>
      <div class="field"><label>Amount ({{settings.currency}})</label><input class="input" v-model="form.amount" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div class="row2"><div class="field"><label>Category</label><select class="input" v-model="form.category"><option v-for="c in catsForKind" :key="c.name" :value="c.name">{{c.name}}</option></select></div>
      <div class="field"><label>Date</label><input class="input" v-model="form.date" type="date"></div></div>
      <div class="field"><label>Note</label><input class="input" v-model="form.note" placeholder="Optional"></div>
      <div class="row2"><button class="btn ghost" @click="showModal=false">Cancel</button><button class="btn" @click="saveTx" :disabled="busy">Save</button></div>
    </div></div>

    <div v-if="importOpen" class="modal-bg" @click.self="importOpen=false"><div class="modal" style="max-width:600px;">
      <b>{{importKind === "sms" ? "Import bank SMS" : "Import bank statement (PDF)"}}</b>
      <p v-if="importKind==='sms'" class="sub">Upload an SMS Backup &amp; Restore <b>.xml</b> export (or a text file, one alert per line). Debits become <b>expenses</b>, credits become <b>income</b>. Review everything before importing.</p>
      <p v-else class="sub">Upload a bank statement PDF. Credits become <b>income</b>, debits become <b>expenses</b>, self-transfers are excluded. Review everything before importing.</p>
      <p v-if="importKind==='pdf'" class="hint">Tip: set your full name in Profile — transfers mentioning you (e.g. "NEFT-HARSH SADASHIV PATIL-SELF") are auto-marked as transfers. NEFT/UPI legs from your other-bank accounts are caught too: add their identifiers (last 4 digits, UPI ID, other-bank name fragment, comma separated) in Profile → Own accounts.</p>
      <div v-if="!hasParsed && !importBusy" class="field"><label>{{importKind === "sms" ? "SMS file (.xml / .txt / .csv)" : "PDF file"}}</label><input class="input" type="file" :accept="fileAccept" @change="onImportFile"></div>
      <div v-if="importBusy" class="okmsg"><span class="spin"></span> {{importMsg}}</div>
      <div v-if="parseErr" class="err">{{parseErr}}</div>
      <div v-if="needPw && !hasParsed && !importBusy" class="field"><label>PDF password</label><div class="row2"><input class="input" v-model="pdfPassword" type="password" placeholder="Enter PDF password" @keyup.enter="unlockPdf"><button class="btn sm" @click="unlockPdf">Unlock</button></div><p class="hint">This statement is password protected (banks often use account number, DOB or PAN). The password never leaves this device.</p></div>
      <div v-if="pwErr" class="err">{{pwErr}}</div>
      <div v-if="hasParsed">
        <div class="toolbar"><label class="sub"><input type="checkbox" v-model="skipDupes" @change="applyDupeFlags"> skip duplicates ({{dupeCount}})</label><label class="sub"><input type="checkbox" v-model="showDbg"> details</label><span class="sp"></span><b class="sub">{{selectedCount}} selected</b></div>
        <div v-if="monthsInParsed.length > 1" class="toolbar" style="margin-top:-4px;"><span class="sub">Months:</span><button v-for="mo in monthsInParsed" :key="mo.m" class="iconbtn" :style="{fontWeight: selectedMonths.includes(mo.m) ? '800' : '400', opacity: selectedMonths.includes(mo.m) ? 1 : 0.55}" @click="toggleMonth(mo.m)">{{mo.label}} ({{mo.n}})</button></div>
        <div style="max-height:320px;overflow:auto;border:1px solid var(--field);border-radius:10px;padding:4px 8px;background:var(--bg);">
          <div v-for="(r,i) in parsedVisible" :key="i" class="txn" :style="{opacity:r.checked?1:0.5}">
            <input type="checkbox" v-model="r.checked">
            <div class="meta"><b>{{r.note}}</b><span>{{r.date}} · {{money(r.amount)}}</span><span v-if="showDbg" style="display:block;font-size:10px;">{{r.dbg}}</span></div>
            <select v-model="r.kind" @change="onImpKind(r)" style="max-width:96px;font-size:12px;padding:6px;" class="input"><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select>
            <select v-model="r.category" style="max-width:104px;font-size:12px;padding:6px;" class="input"><option v-for="c in catsForKindOf(r.kind)" :key="c.name" :value="c.name">{{c.name}}</option></select>
          </div>
        </div>
      </div>
      <div class="row2" style="margin-top:12px;"><button class="btn ghost" @click="importOpen=false">Cancel</button><button class="btn" @click="doImportSelected" :disabled="!selectedCount||importBusy">Import {{selectedCount}}</button></div>
    </div></div>

    <div v-if="toastMsg" class="toast">{{toastMsg}}</div>
  </div>
  `,
});

app.mount("#app");
