<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-hero">
        <h1>Reset password</h1>
        <p>Enter your email and we'll send you a reset link.</p>
      </div>
      <div class="card">
        <form @submit.prevent="submit">
          <div class="field">
            <label>Email</label>
            <input class="input" type="email" required v-model="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div v-if="err" class="alert alert-error">{{ err }}</div>
          <div v-if="ok" class="alert alert-ok">{{ ok }}</div>
          <button class="btn btn-block" :disabled="busy">{{ busy ? 'Sending…' : 'Send reset link' }}</button>
        </form>
        <div class="auth-links">
          <router-link to="/login">← Back to login</router-link>
          <router-link to="/signup">Create account</router-link>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const email = ref('')
const err = ref('')
const ok = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true; err.value = ''; ok.value = ''
  try { ok.value = await auth.forgotPassword(email.value) }
  catch (e) { err.value = e.message }
  finally { busy.value = false }
}
</script>
