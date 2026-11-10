export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD']
export const PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank', 'wallet', 'other']
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']

export function formatMoney(amount, currency = 'INR') {
  const n = Number(amount || 0)
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

export function formatDate(iso, fmt = 'DD/MM/YYYY') {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso)
  if (isNaN(d)) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  if (fmt === 'MM/DD/YYYY') return `${mm}/${dd}/${yyyy}`
  if (fmt === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`
  return `${dd}/${mm}/${yyyy}`
}

// Normalise any date-ish value (PGlite returns JS Date objects, Supabase returns strings)
// to a plain YYYY-MM-DD string so <input type="date"> and the API stay happy.
export function toISODate(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d)) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' })
}

// Monochrome category mark: first letter of the category name.
// Emoji were dropped so the UI stays strictly black & white on every platform.
export function catMark(name = '') {
  const ch = (name || '').trim().charAt(0).toUpperCase()
  return /[A-Z0-9]/.test(ch) ? ch : '•'
}

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'
}

export function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
