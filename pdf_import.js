// Finance Tracker — bank statement PDF import.
// pdf.js (CDN, worker via Blob shim since cross-origin Workers are blocked) +
// geometry-aware table parser: finds Debit/Credit header columns by x-position,
// assigns amounts to columns, classifies credit→income / debit→expense.
// NOTE: full static URLs + @vite-ignore so the Vite production build preserves
// them as runtime CDN imports instead of trying (and failing) to bundle them.
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs";
let pdfjs = null;

async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  const mod = await import(/* @vite-ignore */ PDFJS_URL);
  const wtxt = await (await fetch(PDFJS_WORKER_URL)).text();
  mod.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wtxt], { type: "text/javascript" }));
  pdfjs = mod;
  return mod;
}

const DEBIT_WORDS = ["debit", "withdrawal", "withdrawl", "withdrawn", "paid out", "paid", "spent", "dr"];
const CREDIT_WORDS = ["credit", "deposit", "deposited", "received", "cr"];
const BAL_WORDS = ["balance", "closing", "running", "available"];
const DR_RE = /\bdr\b/i, CR_RE = /\bcr\b/i;
const AMT_RE = /\d[\d,]*\.\d{2}|\d[\d,]*/;
const DATE_RES = [
  /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,                 // 01/11/2026, 01-11-2026
  /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/,                // 01/11/26
  /(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{2,4})/,        // 01 Nov 2026, 01-Nov-26
];
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function toISODate(d, m, y) {
  d = Number(d); m = Number(m); y = Number(y);
  if (String(y).length === 2) y += 2000;
  if (!d || !m || !y || m > 12 || d > 31) return null;
  const d2 = new Date(Date.UTC(y, m - 1, d));
  if (d2.getUTCFullYear() !== y || d2.getUTCMonth() !== m - 1) return null;
  return d2.toISOString().slice(0, 10);
}
function findDate(text) {
  let m = text.match(DATE_RES[0]) || text.match(DATE_RES[1]);
  if (m) return toISODate(m[1], m[2], m[3]);
  m = text.match(DATE_RES[2]);
  if (m) {
    const mon = MON[m[2].slice(0, 3).toLowerCase()] || MON[m[2].toLowerCase()];
    if (mon) return toISODate(m[1], mon, m[3]);
  }
  return null;
}
const numVal = (s) => parseFloat(String(s).replace(/,/g, ""));
const hasWord = (text, list) => {
  const t = text.toLowerCase();
  // 1–2 letter codes (dr/cr) must match whole words — plain includes() would
  // fire on "micro", "screen", "address" and flip debits into credits.
  return list.some((w) => (w.length <= 2 ? new RegExp("\\b" + w + "\\b").test(t) : t.includes(w)));
};

// Group pdf.js text items into rows by y, left→right by x.
function itemsToRows(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // top of page first
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows.map((r) => ({ y: r.y, cells: r.cells, text: r.cells.map((c) => c.str).join(" ").replace(/\s+/g, " ").trim() }));
}

function headerX(cells, words) {
  for (const c of cells) {
    const t = c.str.toLowerCase();
    if (words.some((w) => t === w || t.startsWith(w))) return c.x;
  }
  return null;
}

function parsePages(pages, ownerName, extraKeys) {
  // 1) locate header row (first page preferred): debit, credit AND balance x
  let debitX = null, creditX = null, balX = null;
  outer:
  for (const page of pages.slice(0, 2)) {
    for (const row of page) {
      const dx = headerX(row.cells, DEBIT_WORDS), cx = headerX(row.cells, CREDIT_WORDS);
      if (dx != null && cx != null) { debitX = dx; creditX = cx; balX = headerX(row.cells, BAL_WORDS); break outer; }
    }
  }
  const txs = [];
  let pending = null;
  const pushPending = () => { if (pending && pending.amount > 0) txs.push(pending); pending = null; };

  for (const page of pages) {
    for (const row of page) {
      const line = row.text;
      if (!line || /page\s+\d+/i.test(line) && line.length < 20) continue;
      if (hasWord(line, DEBIT_WORDS) && hasWord(line, CREDIT_WORDS) && !findDate(line)) continue; // header row
      const date = findDate(line);
      if (!date) {
        // continuation of previous narration
        if (pending && line.length > 2 && !/opening|closing|carried|brought forward/i.test(line)) pending.note = (pending.note + " " + line).slice(0, 160);
        continue;
      }
      pushPending();
      // amounts with x positions (date digits stripped first so DD/MM/YYYY
      // never contributes bogus "amounts" like 05, 11, 2026)
      const stripDates = (s) => s.replace(DATE_RES[0], " ").replace(DATE_RES[1], " ").replace(DATE_RES[2], " ");
      const rawAmts = [];
      for (const c of row.cells) {
        const toks = stripDates(c.str).match(new RegExp(AMT_RE.source, "g")) || [];
        for (const t of toks) {
          const digits = t.replace(/[^0-9]/g, "");
          if (digits.length > 10) continue; // UTR / account / phone numbers, not money
          if (digits.length < 1) continue;
          rawAmts.push({ v: numVal(t), x: c.x, raw: t });
        }
      }
      if (!rawAmts.length) continue;
      // Prefer amounts with paise: bare integers are usually years/ref fragments.
      const hasDec = rawAmts.some((a) => a.raw.includes("."));
      const amts = hasDec ? rawAmts.filter((a) => a.raw.includes(".")) : rawAmts;
      const dbgBits = ["amounts:[" + amts.map((a) => a.raw + "@" + Math.round(a.x)).join(",") + "]"];
      let debit = 0, credit = 0, rule = "";
      // Direction markers (Dr/Cr) only count next to the TRANSACTION amount —
      // never in the trailing balance zone ("Balance 1,25,000 Cr" describes
      // the balance, and was flipping real debits into income).
      const xs = amts.map((a) => a.x).sort((p, q) => p - q);
      const cutX = balX != null ? balX - 40 : (xs.length >= 2 ? xs[xs.length - 1] - 5 : Infinity);
      const zoneCells = row.cells.filter((c) => c.x <= cutX);
      // UPI handles / emails (tokens with @) are never direction evidence:
      // "SARUK-CR@AX" is a payee handle, not a credit marker. SBI's genuine
      // "UPI/CR/…" / "UPI/DR/…" markers contain no @ and still work.
      const noHandles = (s) => String(s).split(/\s+/).filter((t) => !t.includes("@")).join(" ");
      const zoneText = zoneCells.map((c) => noHandles(c.str)).join(" ");
      const zoneAmts = amts.filter((a) => a.x <= cutX);
      const base = zoneAmts.length ? zoneAmts : amts;
      const nearDist = (re) => {
        let best = Infinity;
        for (const c of zoneCells) {
          const t = noHandles(c.str);
          if (!re.test(t)) continue;
          for (const a of base) best = Math.min(best, Math.abs(c.x - a.x));
        }
        return best;
      };
      const drD = nearDist(DR_RE), crD = nearDist(CR_RE);
      // Any marker surviving zone + @-handle filtering counts (narration
      // markers like SBI's "UPI/CR/…" can sit far from the amount; the balance
      // zone — the only dangerous source — is already excluded above).
      const dr = isFinite(drD), cr = isFinite(crD);
      dbgBits.push("mk:" + Math.round(drD) + "/" + Math.round(crD));
      // "credit card payment" is an expense, not a credit — ignore that phrase for keywords.
      // Keywords are tested on the transaction zone only (the trailing
      // balance "… Cr" must not count as a credit keyword either).
      const kwLine = zoneText.replace(/credit\s*card/gi, "");
      if (dr || cr) {
        // Nearest marker to a transaction amount wins (tie → debit, since
        // most UPI/card traffic is money out).
        const v = amts[0].v;
        if (cr && (!dr || crD < drD)) credit = v; else debit = v;
        rule = "dr-cr-marker";
      } else if (debitX != null && creditX != null && amts.length >= 1) {
        for (const a of amts) {
          const dd = Math.abs(a.x - debitX), dc = Math.abs(a.x - creditX);
          const db = balX != null ? Math.abs(a.x - balX) : Infinity;
          // nearest column wins (generous cap: real statements are wide);
          // balance-nearest amounts are ignored.
          if (dd <= dc && dd <= db && dd < 250) { debit = Math.max(debit, a.v); rule = "geom-debit"; }
          else if (dc < dd && dc <= db && dc < 250) { credit = Math.max(credit, a.v); rule = "geom-credit"; }
        }
        // geometry failed (scanned-header offset) -> fall back to order
        if (!debit && !credit && amts.length >= 2) {
          const sorted = amts.slice().sort((p, q) => p.x - q.x);
          const cands = sorted.slice(0, -1); // drop right-most (= likely balance)
          const first = cands[0];
          if (hasWord(kwLine, CREDIT_WORDS) || /salary|interest|refund|cashback/i.test(kwLine)) { credit = first.v; rule = "order-credit"; }
          else { debit = first.v; rule = "order-debit"; }
        }
      } else if (amts.length >= 2) {
        // no header: assume [..., txn, balance]; direction from keywords
        // ("NEFT … CR" in narration is already handled by the marker branch)
        const v = amts[amts.length - 2].v;
        if (hasWord(kwLine, CREDIT_WORDS) || /salary|interest|refund|cashback/i.test(kwLine)) { credit = v; rule = "keyw-credit"; }
        else { debit = v; rule = "keyw-debit"; }
      } else {
        debit = amts[0].v; rule = "single";
      }
      if (!debit && !credit) continue;
      // note = text between date and first amount token
      const firstAmtIdx = line.search(AMT_RE);
      let note = line.slice(0, firstAmtIdx > 0 ? firstAmtIdx : line.length);
      note = note.replace(DATE_RES[0], "").replace(DATE_RES[1], "").replace(DATE_RES[2], "").replace(/[|\-–—:;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Transaction";
      pending = {
        date,
        note,
        kind: isSelfTransfer(note, ownerName, extraKeys) ? "transfer" : (credit > 0 && !debit ? "income" : "expense"),
        amount: debit || credit,
        category: guessCategory(note, credit > 0 && !debit),
        dbg: dbgBits.concat([rule, "D:" + debit, "C:" + credit]).join(" "),
      };
      if (pending.kind === "transfer") pending.dbg += " self-transfer";
    }
  }
  pushPending();
  return { transactions: txs, headerFound: debitX != null && creditX != null };
}

const CAT_RULES = [
  [/salary|payroll|stipend|pension|bonus|dividend/i, "Salary"],
  [/grocer|bigbasket|blinkit|zepto|grofers|\bdmart\b|d-mart|reliance\s*(fresh|smart|retail)|spencer|\bmore\b.*(super|store|mart)|supermarket|kirana|ration|\bmart\b|vegetable|dairy|\bmilk\b|amul/i, "Groceries"],
  [/petrol|diesel|\bfuel\b|petrol\s*pump|\bhpcl\b|\bbpcl\b|\biocl\b|indian\s*oil|\bshell\b|essar|nayara|jio\s*bp/i, "Petrol"],
  [/electric|bijli|bescom|mescom|tsspdcl|tneb|power\s*bill|internet|broadband|wifi|wi-fi|fiber|fibre|jiofiber|mobile\s*recharge|\brecharge\b|\bdth\b|prepaid|postpaid|room\s*maintenance|\bmaintenance\b|society|apartment|water\s*bill|gas\s*bill|\blpg\b|piped\s*gas/i, "Utilities"],
  [/swiggy|zomato|restaurant|cafe|coffee|pizza|burger|bakery|\bfood\b|dining|\bhotel\b|dhaba|canteen|\beats\b|dominos|\bkfc\b|mcdonald/i, "Food"],
  [/train|rail|\birctc\b|metro|\bbus\b|ksrtc|msrtc|plane|flight|airline|indigo|spicejet|air\s*india|vistara|boat|ferry|ship|rickshaw|\bauto\b|\bola\b|\buber\b|\bcab\b|taxi|rapido|\bbike\b|two\s*wheeler|parking|\btoll\b|fastag|transport|travel|redbus|makemytrip|yatra/i, "Transport"],
];
const SALARY_RE = CAT_RULES[0][0];
export function guessCategory(note, isIncome) {
  const n = String(note || "");
  if (isIncome) return SALARY_RE.test(n) ? "Salary" : "Other";
  for (let i = 1; i < CAT_RULES.length; i++) if (CAT_RULES[i][0].test(n)) return CAT_RULES[i][1];
  return "Other";
}

const RAIL_RE = /neft|imps|rtgs|upi|\bach\b|\bnft\b|fund\s*transfer|money\s*transfer|internal\s*transfer/i;
const DIR_RE = /transfer|fund|neft|imps|upi|rtgs|credit|debit|pay|deposit/i;
function normKeys(input) {
  const arr = Array.isArray(input) ? input : String(input || "").split(/[,;\n]+/);
  return arr.map((k) => String(k || "").trim().toLowerCase()).filter((k) => k.length >= 3);
}
export function isSelfTransfer(note, owner, extraKeys) {  const n = String(note || "").toLowerCase();
  if (/\bself\b/.test(n) && /transfer|neft|imps|upi|rtgs|fund|pay/i.test(n)) return true;
  if (/own\s*(a\/c|account|bank)|self\s*(transfer|credit|debit|account)/i.test(n)) return true;
  const keys = normKeys(extraKeys);
  for (const k of keys) {
    if (!k || !n.includes(k)) continue;
    // a distinctive saved identifier (UPI id, last-4+bank, other-bank name
    // fragment): with a rail/direction word — or on its own when long.
    if (k.includes("@") || k.length >= 6 || RAIL_RE.test(n) || DIR_RE.test(n) || /\bself\b|\bown\b/i.test(n)) return true;
  }
  if (owner) {
    const parts = String(owner).toLowerCase().split(/[^a-z0-9@]+/).filter((w) => w.length >= 3);
    if (parts.length) {
      const hits = parts.filter((p) => p.length >= 4 ? n.includes(p) : n.includes(p));
      // all significant name parts present (e.g. full-name narration) → self
      if (parts.length >= 2 && parts.every((p) => n.includes(p))) return true;
      // any distinctive name token + a transfer rail / direction word
      // (catches "NEFT-HARSH PATIL" where the middle name is missing, and
      // UPI/NEFT legs from the user's other-bank accounts).
      if (hits.length >= 1 && (RAIL_RE.test(n) || /transfer|fund|self|own/i.test(n))) return true;
    }
  }
  return false;
}

export async function parseBankPdf(arrayBuffer, onProgress, password, ownerName, extraKeys) {
  const { getDocument } = await loadPdfJs();
  let doc;
  try {
    doc = await getDocument({
      data: arrayBuffer, isEvalSupported: false, useSystemFonts: true,
      ...(password ? { password } : {}),
    }).promise;
  } catch (e) {
    // pdf.js throws PasswordException (code 1 = needed, 2 = wrong) for encrypted PDFs.
    if (e && e.name === "PasswordException") {
      const err = new Error(e.code === 2 ? "PDFPasswordIncorrect" : "PDFPasswordRequired");
      err.pdfPassword = e.code === 2 ? "incorrect" : "required";
      throw err;
    }
    throw e;
  }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push(itemsToRows(tc.items));
    onProgress && onProgress(p / doc.numPages);
  }
  return { ...parsePages(pages, ownerName, extraKeys), pages: doc.numPages };
}
