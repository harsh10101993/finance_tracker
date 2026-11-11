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

const DEBIT_WORDS = ["debit", "withdrawal", "withdrawl", "withdrawn", "paid out", "spent"];
const CREDIT_WORDS = ["credit", "deposit", "deposited", "received"];
const BAL_WORDS = ["balance", "closing"];
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

function parsePages(pages) {
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
      const amts = [];
      for (const c of row.cells) {
        const toks = stripDates(c.str).match(new RegExp(AMT_RE.source, "g")) || [];
        for (const t of toks) {
          if (t.replace(/,/g, "").length < 1) continue;
          amts.push({ v: numVal(t), x: c.x, raw: t });
        }
      }
      if (!amts.length) continue;
      let debit = 0, credit = 0;
      const dr = DR_RE.test(line), cr = CR_RE.test(line);
      if (dr || cr) {
        // Explicit Dr/Cr marker beats column geometry (different layouts mix per row).
        const v = amts[0].v;
        if (cr && !dr) credit = v; else debit = v;
      } else if (debitX != null && creditX != null && amts.length >= 1) {
        for (const a of amts) {
          const dd = Math.abs(a.x - debitX), dc = Math.abs(a.x - creditX);
          const db = balX != null ? Math.abs(a.x - balX) : Infinity;
          if (dd < db && dd <= dc && dd < 90) debit = Math.max(debit, a.v);
          else if (dc < db && dc < dd && dc < 90) credit = Math.max(credit, a.v);
          // else: nearer to balance column (or neither) → ignore
        }
        // geometry failed (scanned-header offset) -> fall back to order
        if (!debit && !credit && amts.length >= 2) {
          const sorted = amts.slice().sort((p, q) => p.x - q.x);
          const [first, second] = sorted.slice(-3, -1);
          if (debitX < creditX) { debit = first.v; credit = second.v; }
          else { credit = first.v; debit = second.v; }
        }
      } else if (amts.length >= 2) {
        // no header: assume [txn, balance]; direction from keywords
        const v = amts[amts.length - 2].v;
        if (hasWord(line, CREDIT_WORDS) || /salary|neft.*cr|interest/i.test(line)) credit = v; else debit = v;
      } else {
        debit = amts[0].v;
      }
      if (!debit && !credit) continue;
      // note = text between date and first amount token
      const firstAmtIdx = line.search(AMT_RE);
      let note = line.slice(0, firstAmtIdx > 0 ? firstAmtIdx : line.length);
      note = note.replace(DATE_RES[0], "").replace(DATE_RES[1], "").replace(DATE_RES[2], "").replace(/[|\-–—:;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Transaction";
      pending = {
        date,
        note,
        kind: credit > 0 && !debit ? "income" : "expense",
        amount: credit > 0 && !debit ? credit : debit,
        category: guessCategory(note, credit > 0 && !debit),
      };
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

export async function parseBankPdf(arrayBuffer, onProgress, password) {
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
  return { ...parsePages(pages), pages: doc.numPages };
}
