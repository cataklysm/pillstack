<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="app-brand">PillStack</RouterLink>
      <nav class="app-nav">
        <RouterLink to="/">Today</RouterLink>
        <RouterLink to="/products">Products</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <span class="small muted">local only &middot; no account, no cloud</span>
    </header>

    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>
