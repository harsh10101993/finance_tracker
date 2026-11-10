<template>
  <div class="layout">
    <div v-if="!online" class="offline-banner">⚫ You're offline — changes save locally (PGlite) and sync when you're back.</div>

    <!-- Desktop sidebar -->
    <aside class="sidebar">
      <router-link to="/dashboard" class="brand"><span class="brand-mark">₹</span> Finance</router-link>
      <nav class="mt-24">
        <router-link to="/dashboard">▦ Dashboard</router-link>
        <router-link to="/transactions">⇅ Transactions</router-link>
        <router-link to="/profile">◉ Profile</router-link>
        <router-link to="/settings">⚙ Settings</router-link>
      </nav>
      <div style="flex:1"></div>
      <div class="small muted" style="padding:0 12px">
        <div>{{ auth.user?.full_name || auth.user?.email }}</div>
        <div class="hint">{{ auth.mode === 'supabase' ? '● Supabase connected' : '● Demo / offline mode' }}</div>
      </div>
      <button class="btn btn-outline btn-block mt-16" @click="logout">Log out</button>
    </aside>

    <div class="content-col">
      <!-- Mobile top bar -->
      <header class="topbar">
        <router-link to="/dashboard" class="brand"><span class="brand-mark">₹</span> Finance</router-link>
        <span class="pill" :class="{ off: !online }">{{ online ? '● Online' : '○ Offline' }}</span>
      </header>

      <main class="main">
        <slot />
      </main>
    </div>

    <!-- Mobile bottom nav -->
    <nav class="bottomnav">
      <router-link to="/dashboard"><span class="nav-ico">▦</span>Home</router-link>
      <router-link to="/transactions"><span class="nav-ico">⇅</span>Activity</router-link>
      <router-link to="/profile"><span class="nav-ico">◉</span>Profile</router-link>
      <router-link to="/settings"><span class="nav-ico">⚙</span>Settings</router-link>
      <a href="#" @click.prevent="logout"><span class="nav-ico">↪</span>Logout</a>
    </nav>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const online = ref(navigator.onLine)

function onNet() { online.value = navigator.onLine }
onMounted(() => { window.addEventListener('online', onNet); window.addEventListener('offline', onNet) })
onBeforeUnmount(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet) })

async function logout() {
  await auth.signOut()
  router.push('/login')
}
</script>
