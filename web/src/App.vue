<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import NotificationBell from './components/NotificationBell.vue';
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="app-brand">PillStack</RouterLink>
      <nav class="app-nav">
        <RouterLink to="/">Today</RouterLink>
        <RouterLink to="/products">Products</RouterLink>
        <RouterLink to="/inventory">Inventory</RouterLink>
        <RouterLink to="/rules">Rules</RouterLink>
        <RouterLink to="/history">History</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <NotificationBell />
      <span class="small muted">local only &middot; no account, no cloud</span>
    </header>

    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>
