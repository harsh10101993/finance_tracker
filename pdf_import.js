// Finance Tracker — bank statement PDF import.
// pdf.js (CDN, worker via Blob shim since cross-origin Workers are blocked) +
// geometry-aware table parser with balance-delta ground truth. Direction is
// decided in this priority order:
//   1. balance math: balance_now - balance_prev == +/-txn amount (decisive —
//      two printed numbers agreeing beats any wording guess; also validates
//      which amount is the balance and which is the transaction).
//   2. explicit Dr/Cr indicator column ("Dr/Cr", "D/C", "Type" header).
//   3. same-cell signals on the amount itself: leading -/+, (parentheses),
//      or a Dr/Cr suffix ("10,000.00 Cr").
//   4. in-row Dr/Cr markers (UPI handles containing @ are never evidence).
//   5. debit/credit header column geometry, compared by column CENTERS —
//      statements right-align numbers, so left edges wander while centers hold.
//   6. narration keywords. Anything still unsure defaults to expense and is
//      counted as uncertain so the UI can ask the user to check kinds.
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

const DEBIT_WORDS = ["debit", "withdrawal", "withdrawals", "withdrawn", "paid", "paid out", "payments", "payment", "debited", "spent", "money out", "dr"];
const CREDIT_WORDS = ["credit", "deposit", "deposits", "deposited", "received", "receipts", "receipt", "credited", "money in", "cr"];
const BAL_WORDS = ["balance", "bal", "closing", "running", "available"];
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

// Group pdf.js text items into rows by y, left→right by x. Column geometry is
// compared by cell CENTER (cx): statements right-align money columns, so the
// left edge of "5.00" and "1,25,000.00" differ wildly while centers line up.
function itemsToRows(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const w = it.width || it.str.length * 5;
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x, w, right: x + w, cx: x + w / 2, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // top of page first
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows.map((r) => ({ y: r.y, cells: r.cells, text: r.cells.map((c) => c.str).join(" ").replace(/\s+/g, " ").trim() }));
}

// Header cells come in many shapes ("Withdrawal Amt (Rs.)", "DEPOSITS",
// "Money Paid", "Dr/Cr") — strip units/punctuation, then match whole tokens.
function cleanHdr(s) {
  return String(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[₹]/g, " ")
    .replace(/\b(amounts?|amts?|rs\.?|inr)\b/g, " ").replace(/\s*\/\s*/g, "/")
    .replace(/[^a-z\/ ]/g, " ").replace(/\s+/g, " ").trim();
}
const TYPE_HDRS = new Set(["dr/cr", "drcr", "dr cr", "d/c", "dc", "type", "txn type", "transaction type", "debit/credit", "dr./cr.", "transaction dr/cr"]);
function headerKind(str) {
  const t = cleanHdr(str);
  if (!t) return null;
  if (TYPE_HDRS.has(t)) return "type";
  const toks = t.split(" ");
  const hit = (words) => words.some((w) => {
    if (w.includes(" ")) return t.includes(w); // multi-word phrase
    if (w.length <= 2) return toks.includes(w); // dr / cr: exact only
    return toks.includes(w) || toks.some((tok) => tok.startsWith(w));
  });
  const d = hit(DEBIT_WORDS), c = hit(CREDIT_WORDS);
  if (d && c) return "type"; // e.g. a lone "Debit Credit"/"Dr Cr" indicator header
  if (d) return "debit";
  if (c) return "credit";
  if (hit(BAL_WORDS)) return "bal";
  return null;
}

// Amounts are pulled in two tiers. STRICT: the cell is essentially just a
// number (currency, sign, brackets, Dr/Cr suffix allowed) — narration cells
// like "UPI/CR/1234567890/HARSH" fail this and their stray digits are ignored.
// LOOSE (only when strict finds nothing in the row): scan for numbers anywhere.
const STRICT_AMT_RE = /^\s*\(?\s*([-+])?\s*(?:Rs\.?|₹|INR)?\s*(\d[\d,]*\.?\d*)\s*(dr|cr)?\s*\.?\)?\s*$/i;
const LOOSE_AMT_RE = /\(?\s*([-+])?\s*(?:Rs\.?|₹|INR)?\s*(\d[\d,]*\.?\d*)\s*(dr|cr)?\s*\)?/gi;
function validNum(num, raw) {
  const digits = num.replace(/[^0-9]/g, "");
  if (digits.length > 10) return false; // UTR / account / phone numbers, not money
  if (digits.length < 1) return false;
  const dot = raw.includes(".");
  const v = numVal(num);
  if (!dot && v >= 1900 && v <= 2100) return false; // stray year fragment
  if (!dot && digits.length >= 10) return false; // phone-size integers, not money
  return true;
}
function amtFromMatch(cell, pre, num, suf, raw) {
  const t = raw.trim();
  const wrapped = /^\(.*\)\.?$/.test(t);
  const neg = wrapped || /^\s*\(?\s*-/.test(t) || /-\s*\)?\.?\s*$/.test(t);
  const plus = /^\s*\(?\s*\+/.test(t);
  return {
    v: numVal(num), x: cell.x, cx: cell.cx, right: cell.right, raw,
    neg, plus,
    suf: suf ? suf.toUpperCase() : null, cell,
  };
}
function extractAmts(cells) {
  const stripDates = (s) => s.replace(DATE_RES[0], " ").replace(DATE_RES[1], " ").replace(DATE_RES[2], " ");
  const strict = [];
  for (const c of cells) {
    const s = stripDates(c.str);
    const m = s.match(STRICT_AMT_RE);
    if (m && validNum(m[2], m[0])) strict.push(amtFromMatch(c, m[1], m[2], m[3], m[0].trim()));
  }
  if (strict.length) return strict;
  const loose = [];
  for (const c of cells) {
    const s = stripDates(c.str);
    LOOSE_AMT_RE.lastIndex = 0;
    let m;
    while ((m = LOOSE_AMT_RE.exec(s))) {
      if (validNum(m[2], m[0])) loose.push(amtFromMatch(c, m[1], m[2], m[3], m[0].trim()));
      if (m[0].length === 0) LOOSE_AMT_RE.lastIndex++;
    }
  }
  return loose;
}

const SEED_RE = /opening|brought forward|carried forward|previous balance|balance b\/f|open\.?\s*bal/i;

export function parsePages(pages, ownerName, extraKeys) {
  // 1) locate header columns (first two pages): debit, credit, balance AND a
  // Dr/Cr indicator column ("Dr/Cr", "D/C", "Type"). Same-row debit+credit is
  // the strong signal; otherwise fall back to independent first matches, so
  // multi-line headers still work.
  let debitX = null, creditX = null, balX = null, typeX = null;
  let debitHdr = "", creditHdr = "", balHdr = "", typeHdr = "";
  outer:
  for (const page of pages.slice(0, 2)) {
    for (const row of page) {
      if (findDate(row.text) || /\d/.test(row.text)) continue; // headers carry no digits
      let dh = null, ch = null, bh = null, th = null;
      for (const c of row.cells) {
        const k = headerKind(c.str);
        if (k === "debit" && !dh) dh = c;
        else if (k === "credit" && !ch) ch = c;
        else if (k === "bal" && !bh) bh = c;
        else if (k === "type" && !th) th = c;
      }
      if (dh && ch) {
        debitX = dh.cx; creditX = ch.cx;
        debitHdr = dh.str; creditHdr = ch.str;
        if (bh) { balX = bh.cx; balHdr = bh.str; }
        if (th) { typeX = th.cx; typeHdr = th.str; }
        break outer;
      }
    }
  }
  if (debitX == null || creditX == null) {
    for (const page of pages.slice(0, 2)) {
      for (const row of page) {
        if (findDate(row.text) || /\d/.test(row.text)) continue; // headers carry no digits
        for (const c of row.cells) {
          const k = headerKind(c.str);
          if (k === "debit" && debitX == null) { debitX = c.cx; debitHdr = c.str; }
          else if (k === "credit" && creditX == null) { creditX = c.cx; creditHdr = c.str; }
          else if (k === "bal" && balX == null) { balX = c.cx; balHdr = c.str; }
          else if (k === "type" && typeX == null) { typeX = c.cx; typeHdr = c.str; }
        }
      }
    }
  }
  const headerFound = (debitX != null && creditX != null) || typeX != null;
  const headerText = [debitHdr, creditHdr, typeHdr, balHdr].filter(Boolean).join(" | ").replace(/\s+/g, " ").trim().slice(0, 80);

  const txs = [];
  let pending = null;
  let prevBal = null; // signed previous closing balance (balance-delta chain)
  let uncertain = 0;
  const pushPending = () => { if (pending && pending.amount > 0) txs.push(pending); pending = null; };

  for (const page of pages) {
    for (const row of page) {
      const line = row.text;
      if (!line || (/page\s+\d+/i.test(line) && line.length < 20)) continue;
      const amtsAll = extractAmts(row.cells);
      // Prefer amounts with paise: bare integers are usually ref fragments.
      const hasDec = amtsAll.some((a) => a.raw.includes("."));
      const amts = hasDec ? amtsAll.filter((a) => a.raw.includes(".")) : amtsAll;
      const date = findDate(line);
      if (!date) {
        // Opening / carried-forward rows seed the balance chain even though
        // they are not transactions themselves.
        if (SEED_RE.test(line) && amts.length) {
          const b = amts[amts.length - 1];
          prevBal = (b.neg || b.suf === "DR") ? -b.v : b.v;
        } else if (pending && line.length > 2 && !SEED_RE.test(line)) {
          pending.note = (pending.note + " " + line).slice(0, 160);
        }
        continue;
      }
      pushPending();
      if (!amts.length) continue;
      const dbgBits = ["amounts:[" + amts.map((a) => a.raw + "@" + Math.round(a.cx)).join(",") + "]"];

      // Identify the balance: nearest amount to the balance column, else the
      // right-most amount when there are 2+ (…txn, balance). Balances can
      // carry Dr (overdraft = negative) or Cr suffixes.
      let bal = null;
      if (balX != null) {
        let bd = Infinity;
        for (const a of amts) { const d = Math.abs(a.cx - balX); if (d < bd) { bd = d; bal = a; } }
        if (!bal || bd >= 250) bal = null;
      }
      if (!bal && amts.length >= 2) bal = amts.reduce((p, q) => (q.right > p.right ? q : p));
      const balVal = bal ? ((bal.neg || bal.suf === "DR") ? -bal.v : bal.v) : null;
      const cands = bal ? amts.filter((a) => a !== bal) : amts.slice();
      if (!cands.length) { if (balVal != null) prevBal = balVal; continue; } // balance-only row
      const balCell = bal ? bal.cell : null;
      const zoneCells = balCell ? row.cells.filter((c) => c !== balCell) : row.cells.slice();
      // UPI handles / emails (tokens with @) are never direction evidence:
      // "SARUK-CR@AX" is a payee handle, not a credit marker. SBI's genuine
      // "UPI/CR/…" / "UPI/DR/…" markers contain no @ and still work.
      const noHandles = (s) => String(s).split(/\s+/).filter((t) => !t.includes("@")).join(" ");
      const zoneText = zoneCells.map((c) => noHandles(c.str)).join(" ");
      dbgBits.push("bal:" + (bal ? bal.raw + "=" + balVal : "-") + " prev:" + (prevBal == null ? "-" : prevBal));

      // Evidence 1 — balance math. When the printed balances move by exactly
      // one of the row's amounts, the direction is arithmetic fact.
      let deltaDir = 0, deltaMatch = -1;
      if (prevBal != null && balVal != null) {
        const delta = balVal - prevBal;
        const ad = Math.abs(delta);
        if (ad > 0.005) {
          const tol = Math.max(0.05, ad * 0.002);
          cands.forEach((a, i) => { if (deltaMatch < 0 && Math.abs(a.v - ad) <= tol) deltaMatch = i; });
          if (deltaMatch >= 0) { deltaDir = delta > 0 ? 1 : -1; dbgBits.push("delta:" + delta.toFixed(2)); }
        }
      }
      // Evidence 2 — explicit indicator column ("Dr"/"Cr" cell near typeX).
      let typeDir = 0, typeCx = null;
      const typeCellNear = (cxRef) => {
        let best = null, bd = Infinity;
        for (const c of zoneCells) {
          const d = Math.abs((c.cx ?? c.x) - cxRef);
          if (d < bd) { bd = d; best = c; }
        }
        return bd <= 120 ? best : null;
      };
      if (typeX != null) {
        const tc = typeCellNear(typeX);
        if (tc) {
          const t = noHandles(tc.str);
          if (DR_RE.test(t) && !CR_RE.test(t)) { typeDir = -1; typeCx = tc.cx ?? tc.x; }
          else if (CR_RE.test(t) && !DR_RE.test(t)) { typeDir = 1; typeCx = tc.cx ?? tc.x; }
        }
      }
      // Evidence 3 — same-cell signals on the amount itself.
      const cellDir = cands.map((a) => (a.suf === "CR" ? 1 : a.suf === "DR" ? -1 : a.neg ? -1 : a.plus ? 1 : 0));
      // Evidence 4 — standalone in-row Dr/Cr markers (nearest wins, tie → debit).
      const nearDist = (re) => {
        let best = Infinity, bx = null;
        for (const c of zoneCells) {
          const t = noHandles(c.str);
          if (!re.test(t)) continue;
          for (const a of cands) {
            const d = Math.abs((c.cx ?? c.x) - a.cx);
            if (d < best) { best = d; bx = c.cx ?? c.x; }
          }
        }
        return { d: best, x: bx };
      };
      const drM = nearDist(DR_RE), crM = nearDist(CR_RE);
      const dr = isFinite(drM.d), cr = isFinite(crM.d);
      dbgBits.push("mk:" + Math.round(drM.d) + "/" + Math.round(crM.d));
      let markDir = 0, markX = null;
      if (dr || cr) {
        if (cr && (!dr || crM.d < drM.d)) { markDir = 1; markX = crM.x; }
        else { markDir = -1; markX = drM.x; }
      }
      // Evidence 5 — header column geometry (centers).
      const gdir = cands.map((a) => {
        if (debitX == null || creditX == null) return 0;
        const dd = Math.abs(a.cx - debitX), dc = Math.abs(a.cx - creditX);
        const db = balX != null ? Math.abs(a.cx - balX) : Infinity;
        if (dd <= dc && dd <= db && dd < 250) return -1;
        if (dc < dd && dc <= db && dc < 250) return 1;
        return 0;
      });
      // Evidence 6 — narration keywords ("credit card payment" excluded).
      const kwLine = zoneText.replace(/credit\s*card/gi, "");
      let kwDir = 0;
      if (hasWord(kwLine, CREDIT_WORDS) || /salary|interest|refund|cashback/i.test(kwLine)) kwDir = 1;
      else if (hasWord(kwLine, DEBIT_WORDS)) kwDir = -1;

      // Decide. Balance math first (it validates itself); then indicator
      // column, same-cell signals, markers, geometry, keywords, default.
      const nearestCand = (x) => {
        let bi = 0, bd = Infinity;
        cands.forEach((a, i) => { const d = Math.abs(a.cx - x); if (d < bd) { bd = d; bi = i; } });
        return bi;
      };
      let idx = 0, dir = 0, rule = "", conf = "L";
      if (deltaMatch >= 0) { idx = deltaMatch; dir = deltaDir; rule = "balance-delta"; conf = "H"; }
      else if (typeDir !== 0) { idx = nearestCand(typeCx); dir = typeDir; rule = "type-column"; conf = "H"; }
      else {
        const ci = cellDir.findIndex((d) => d !== 0);
        if (ci >= 0) { idx = ci; dir = cellDir[ci]; rule = cands[ci].suf ? "suffix-dr-cr" : "signed-amount"; conf = "H"; }
        else if (markDir !== 0) { idx = nearestCand(markX); dir = markDir; rule = "dr-cr-marker"; conf = "M"; }
        else {
          const votes = gdir.map((g, i) => (g !== 0 ? i : -1)).filter((i) => i >= 0);
          if (votes.length === 1) { idx = votes[0]; dir = gdir[votes[0]]; rule = dir > 0 ? "geom-credit" : "geom-debit"; conf = "M"; }
          else if (kwDir !== 0) { idx = 0; dir = kwDir; rule = dir > 0 ? "keyw-credit" : "keyw-debit"; conf = "L"; }
          else if (cands.length === 1) { idx = 0; dir = -1; rule = "single"; conf = "L"; }
          else { idx = 0; dir = -1; rule = "default-expense"; conf = "L"; }
        }
      }
      const debit = dir < 0 ? cands[idx].v : 0;
      const credit = dir > 0 ? cands[idx].v : 0;
      if (conf === "L") uncertain++;
      if (balVal != null) prevBal = balVal;
      if (!debit && !credit) continue;
      // note = text between date and first amount token
      const firstAmtIdx = line.search(AMT_RE);
      let note = line.slice(0, firstAmtIdx > 0 ? firstAmtIdx : line.length);
      note = note.replace(DATE_RES[0], "").replace(DATE_RES[1], "").replace(DATE_RES[2], "").replace(/[|\-–—:;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Transaction";
      // dated opening/cARRY rows seed the chain instead of becoming txns
      if (SEED_RE.test(zoneText) && /opening/i.test(zoneText)) continue;
      pending = {
        date,
        note,
        kind: isSelfTransfer(note, ownerName, extraKeys) ? "transfer" : (credit > 0 && !debit ? "income" : "expense"),
        amount: debit || credit,
        category: guessCategory(note, credit > 0 && !debit),
        dbg: dbgBits.concat([rule, "conf:" + conf, "D:" + debit, "C:" + credit]).join(" "),
      };
      if (pending.kind === "transfer") pending.dbg += " self-transfer";
    }
  }
  pushPending();
  return { transactions: txs, headerFound, headerText, uncertain };
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
