// Finance Tracker — SMS transaction import.
// Reads SMS Backup & Restore XML (.xml) or plain-text files (.txt/.csv, one SMS
// per line). Bank/UPI alerts like "Rs 450.00 debited ... UPI-SWIGGY ... Avl bal"
// become expenses; "credited" ones become income.
import { guessCategory, isSelfTransfer } from "./pdf_import.js";

const AMT_RE = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const ALL_AMT_RE = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi;

function parseSmsBody(body, ownerName) {
  const all = [...String(body).matchAll(ALL_AMT_RE)];
  if (!all.length) return null;
  let m = all[0];
  // "Avl Bal Rs 125000 ... Rs 450 debited" style: txn amount comes after the balance.
  const beforeFirst = String(body).slice(0, m.index);
  if (/avl|a\/c\s*bal|balance/i.test(beforeFirst) && all.length > 1) m = all[1];
  const amount = parseFloat(m[1].replace(/,/g, ""));
  if (!amount || amount <= 0) return null;
  const b = String(body);
  const credit = /credited|received|deposited|refund|cashback/i.test(b);
  const debit = /debited|spent|paid|withdrawn|purchase|transferred|transact/i.test(b);
  let dir = null;
  if (credit && !debit) dir = "income";
  else if (debit && !credit) dir = "expense";
  else if (credit && debit) dir = /credit/i.test(b.slice(0, b.search(AMT_RE))) ? "income" : "expense";
  if (!dir) return null;
  // note: UPI ref > "towards X" > merchant-ish > trimmed body
  let note = "";
  const upi = b.match(/UPI[\s:\/]*([A-Z0-9][A-Z0-9\-]{3,30})/i);
  const towards = b.match(/towards?\s+([^.;,\n]{3,60})/i);
  const byM = b.match(/\bby\s+([A-Z0-9][A-Z0-9\-]{3,28})/);
  const atM = b.match(/\bat\s+([A-Z0-9][A-Z0-9 .&*\-]{2,34})/i);
  if (upi) note = "UPI " + upi[1].toUpperCase();
  else if (towards) note = towards[1].trim();
  else if (byM) note = byM[1];
  else if (atM && !/avl|bal/i.test(atM[1])) note = atM[1].trim();
  else note = b.replace(/\s+/g, " ").trim().slice(0, 90);
  note = note.replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, "").replace(/\s+/g, " ").replace(/\s+\./g, "").replace(/\s+(on|at|dated?)\s*$/i, "").trim().slice(0, 90) || "SMS transaction";
  const kind = isSelfTransfer(note + " " + b, ownerName) ? "transfer" : dir;
  return { note, amount, kind };
}

export async function parseSmsFile(file, ownerName) {
  const text = await file.text();
  let msgs = [];
  if (/<sms[\s/>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    doc.querySelectorAll("sms").forEach((n) => {
      msgs.push({
        addr: n.getAttribute("address") || "",
        date: Number(n.getAttribute("date")) || Date.now(),
        type: n.getAttribute("type"),
        body: n.getAttribute("body") || "",
      });
    });
  } else {
    for (const ln of text.split(/\r?\n/)) {
      const line = ln.trim();
      if (line) msgs.push({ addr: "", date: Date.now(), type: "1", body: line });
    }
  }
  const txs = [];
  for (const m of msgs) {
    if (m.type && m.type !== "1") continue; // inbox alerts only
    const t = parseSmsBody(m.body, ownerName);
    if (!t) continue;
    txs.push({
      date: new Date(m.date).toISOString().slice(0, 10),
      note: t.note,
      amount: t.amount,
      kind: t.kind,
      category: guessCategory(t.note, t.kind === "income"),
      dbg: "sms:" + String(m.addr || "text").slice(0, 24),
    });
  }
  txs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { transactions: txs, count: msgs.length };
}
