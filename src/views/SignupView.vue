<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-hero">
        <h1>Create account</h1>
        <p>Start tracking income & expenses in seconds. Works offline.</p>
      </div>
      <div class="card">
        <form @submit.prevent="submit">
          <div class="field">
            <label>Full name</label>
            <input class="input" required v-model="fullName" placeholder="Your name" autocomplete="name" />
          </div>
          <div class="field">
            <label>Email</label>
            <input class="input" type="email" required v-model="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div class="field">
            <label>Password (min 6 characters)</label>
            <input class="input" type="password" required minlength="6" v-model="password" placeholder="••••••••" autocomplete="new-password" />
          </div>
          <div v-if="err" class="alert alert-error">{{ err }}</div>
          <div v-if="ok" class="alert alert-ok">{{ ok }}</div>
          <button class="btn btn-block" :disabled="busy">{{ busy ? 'Creating…' : 'Sign up' }}</button>
        </form>
        <div class="auth-links">
          <router-link to="/login">← Back to login</router-link>
          <router-link to="/forgot-password">Forgot password?</router-link>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const fullName = ref('')
const email = ref('')
const password = ref('')
const err = ref('')
const ok = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true; err.value = ''; ok.value = ''
  try {
    await auth.signUp({ email: email.value, password: password.value, fullName: fullName.value })
    ok.value = 'Account created! Taking you to your dashboard…'
    setTimeout(() => router.push('/dashboard'), 600)
  } catch (e) { err.value = e.message }
  finally { busy.value = false }
}
</script>
