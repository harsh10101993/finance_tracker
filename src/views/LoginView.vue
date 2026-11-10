<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-hero">
        <h1>Welcome back</h1>
        <p>Log in to your Finance Tracker dashboard.</p>
      </div>
      <div class="card">
        <form @submit.prevent="submit">
          <div class="field">
            <label>Email</label>
            <input class="input" type="email" required v-model="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div class="field">
            <label>Password</label>
            <input class="input" type="password" required v-model="password" placeholder="••••••••" autocomplete="current-password" />
          </div>
          <div v-if="err" class="alert alert-error">{{ err }}</div>
          <button class="btn btn-block" :disabled="busy">{{ busy ? 'Logging in…' : 'Log in' }}</button>
        </form>
        <div class="auth-links">
          <router-link to="/forgot-password">Forgot password?</router-link>
          <router-link to="/signup">Create account</router-link>
        </div>
        <div v-if="auth.mode === 'demo'" class="demo-box">
          <strong>Demo mode</strong> (no Supabase keys set) — try:
          <br /><code>demo@finance.local</code> / <code>demo1234</code>
          <br />Or sign up with any email — it works fully offline via PGlite.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const email = ref('')
const password = ref('')
const err = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true; err.value = ''
  try {
    await auth.signIn({ email: email.value, password: password.value })
    router.push(route.query.redirect || '/dashboard')
  } catch (e) { err.value = e.message }
  finally { busy.value = false }
}
</script>
