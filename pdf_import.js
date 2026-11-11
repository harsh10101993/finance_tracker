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
const hasWord = (text, list) => { const t = text.toLowerCase(); return list.some((w) => t.includes(w)); };

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

function parsePages(pages, ownerName) {
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
      const dr = DR_RE.test(line), cr = CR_RE.test(line);
      // "credit card payment" is an expense, not a credit — ignore that phrase for keywords.
      const kwLine = line.replace(/credit\s*card/gi, "");
      if (dr || cr) {
        // Explicit Dr/Cr marker beats column geometry (different layouts mix per row).
        const v = amts[0].v;
        if (cr && !dr) credit = v; else debit = v;
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
        const v = amts[amts.length - 2].v;
        if (hasWord(kwLine, CREDIT_WORDS) || /salary|neft.*cr|interest/i.test(kwLine)) { credit = v; rule = "keyw-credit"; }
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
        kind: isSelfTransfer(note, ownerName) ? "transfer" : (credit > 0 && !debit ? "income" : "expense"),
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
  [/salary|payroll|stipend/i, "Salary"],
  [/freelance|consult/i, "Freelance"],
  [/swiggy|zomato|restaurant|food|cafe|pizza|burger|bakery/i, "Food"],
  [/uber|ola|metro|rail|petrol|diesel|fuel|cab|parking|toll/i, "Transport"],
  [/amazon|flipkart|myntra|shopping|mall|store|retail/i, "Shopping"],
  [/electric|water|gas|bill|recharge|mobile|broadband|emi|loan|insurance|rent/i, "Bills"],
  [/hospital|pharma|clinic|doctor/i, "Health"],
];
function guessCategory(note, isIncome) {
  for (const [re, c] of CAT_RULES) if (re.test(note)) return c;
  return isIncome ? "Other" : "Other";
}

function isSelfTransfer(note, owner) {
  const n = String(note || "").toLowerCase();
  if (/\bself\b/.test(n) && /transfer|neft|imps|upi|rtgs|fund|pay/i.test(n)) return true;
  if (/own\s*(a\/c|account)|self\s*(transfer|credit|debit)/i.test(n)) return true;
  if (owner) {
    const parts = String(owner).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (parts.length >= 2 && parts.every((p) => n.includes(p))) return true;
  }
  return false;
}

export async function parseBankPdf(arrayBuffer, onProgress, password, ownerName) {
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
  return { ...parsePages(pages, ownerName), pages: doc.numPages };
}
