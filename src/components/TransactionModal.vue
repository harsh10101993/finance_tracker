<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <div class="modal">
      <div class="row-between mb-16">
        <h2>{{ editing ? 'Edit transaction' : 'New transaction' }}</h2>
        <button class="icon-btn" @click="close" aria-label="Close">✕</button>
      </div>

      <div class="seg">
        <button :class="{ active: form.type === 'expense' }" @click="form.type = 'expense'">Expense</button>
        <button :class="{ active: form.type === 'income' }" @click="form.type = 'income'">Income</button>
      </div>

      <form @submit.prevent="save">
        <div class="field">
          <label>Amount ({{ currency }})</label>
          <input class="input" type="number" min="0.01" step="0.01" required v-model.number="form.amount" placeholder="0.00" />
        </div>
        <div class="field">
          <label>Description</label>
          <input class="input" required v-model="form.description" placeholder="e.g. Groceries" maxlength="200" />
        </div>
        <div class="field">
          <label>Category</label>
          <select class="input" v-model="form.category_id">
            <option :value="null">— No category —</option>
            <option v-for="c in filteredCats" :key="c.id" :value="c.id">{{ catMark(c.name) }} — {{ c.name }}</option>
          </select>
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label>Date</label>
            <input class="input" type="date" required v-model="form.transaction_date" />
          </div>
          <div class="field">
            <label>Payment method</label>
            <select class="input" v-model="form.payment_method">
              <option v-for="m in PAYMENT_METHODS" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Notes (optional)</label>
          <textarea class="input" rows="2" v-model="form.notes" placeholder="Anything extra…"></textarea>
        </div>
        <div v-if="err" class="alert alert-error">{{ err }}</div>
        <button class="btn btn-block" :disabled="saving">{{ saving ? 'Saving…' : (editing ? 'Save changes' : 'Add transaction') }}</button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed } from 'vue'
import { useFinanceStore } from '../stores/finance.js'
import { PAYMENT_METHODS, todayISO, toISODate, catMark } from '../lib/utils.js'

const props = defineProps({ open: Boolean, editing: Object })
const emit = defineEmits(['close'])
const finance = useFinanceStore()
const saving = ref(false)
const err = ref('')

const form = reactive({
  type: 'expense', amount: '', description: '', category_id: null,
  transaction_date: todayISO(), payment_method: 'cash', notes: ''
})

const currency = computed(() => finance.currency)
const filteredCats = computed(() => finance.categories.filter(c => c.type === form.type))

function reset() {
  Object.assign(form, {
    type: 'expense', amount: '', description: '', category_id: null,
    transaction_date: todayISO(), payment_method: 'cash', notes: ''
  })
  err.value = ''
}

function openWith(tx) {
  reset()
  if (tx) {
    Object.assign(form, {
      type: tx.type, amount: Number(tx.amount), description: tx.description,
      category_id: tx.category_id || null, transaction_date: toISODate(tx.transaction_date),
      payment_method: tx.payment_method || 'cash', notes: tx.notes || ''
    })
  }
}

async function save() {
  saving.value = true; err.value = ''
  try {
    const payload = {
      type: form.type, amount: Number(form.amount), description: form.description.trim(),
      category_id: form.category_id, transaction_date: form.transaction_date,
      payment_method: form.payment_method, notes: form.notes || null
    }
    if (props.editing) await finance.editTransaction(props.editing.id, payload)
    else await finance.addTransaction(payload)
    close()
  } catch (e) { err.value = e.message }
  finally { saving.value = false }
}

function close() { emit('close'); reset() }

defineExpose({ openWith })
</script>
