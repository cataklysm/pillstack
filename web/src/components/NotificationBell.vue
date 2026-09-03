<script setup lang="ts">
import type { AppNotification } from '@pillstack/contracts';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';

/**
 * Polls the outbox and shows what is due.
 *
 * The server never pushes: generation is idempotent and happens on each poll,
 * so nothing is missed when the app has been closed and there is no background
 * process to keep running. Browser notifications are used only if the user has
 * granted permission; the in-app list works either way.
 */

const POLL_INTERVAL_MS = 60_000;

const notifications = ref<AppNotification[]>([]);
const open = ref(false);
const nativePermission = ref<NotificationPermission>('default');

let timer: ReturnType<typeof setInterval> | undefined;

async function poll() {
  try {
    const due = await api.reminders.due();
    const unseen = due.filter(
      (entry) => !notifications.value.some((existing) => existing.id === entry.id),
    );
    notifications.value = due;

    if (unseen.length > 0 && nativePermission.value === 'granted') {
      for (const notification of unseen) showNative(notification);
      // Only what was actually shown gets marked delivered.
      await api.reminders.markDelivered(unseen.map((entry) => entry.id));
      notifications.value = await api.reminders.due();
    }
  } catch {
    // A reminder poll failing must never take the rest of the app down.
  }
}

function showNative(notification: AppNotification) {
  try {
    new Notification(notification.title, { body: notification.body, tag: notification.dedupeKey });
  } catch {
    // Some browsers refuse the constructor outside a service worker; the
    // in-app list is the fallback and needs no permission at all.
  }
}

async function enableNative() {
  nativePermission.value = await Notification.requestPermission();
}

async function dismiss(notification: AppNotification) {
  await api.reminders.dismiss(notification.id);
  notifications.value = notifications.value.filter((entry) => entry.id !== notification.id);
}

const typeLabels: Record<string, string> = {
  intake: 'Intake',
  reorder: 'Reorder',
  prescription: 'Prescription',
  expiry: 'Expiry',
};

onMounted(() => {
  if ('Notification' in window) nativePermission.value = Notification.permission;
  void poll();
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="notification-bell">
    <button class="subtle" :aria-expanded="open" @click="open = !open">
      Reminders
      <span v-if="notifications.length" class="tag warning">{{ notifications.length }}</span>
    </button>

    <div v-if="open" class="notification-panel card">
      <div class="card-body">
        <div style="display: flex; align-items: baseline; gap: 0.5rem">
          <h3>Due now</h3>
          <div class="spacer" style="margin-left: auto"></div>
          <button class="subtle" @click="poll">Refresh</button>
        </div>

        <p v-if="notifications.length === 0" class="muted small" style="margin: 0.6rem 0 0">
          Nothing due.
        </p>

        <ul v-else style="list-style: none; margin: 0.6rem 0 0; padding: 0; display: grid; gap: 0.5rem">
          <li
            v-for="notification in notifications"
            :key="notification.id"
            style="display: flex; gap: 0.6rem; align-items: start"
          >
            <div style="flex: 1; min-width: 0">
              <div>
                <span class="tag neutral">{{ typeLabels[notification.notificationType] }}</span>
                <strong style="margin-left: 0.4rem">{{ notification.title }}</strong>
              </div>
              <div class="small muted">{{ notification.body }}</div>
            </div>
            <button class="subtle" @click="dismiss(notification)">Dismiss</button>
          </li>
        </ul>

        <p
          v-if="nativePermission !== 'granted'"
          class="small muted"
          style="margin: 0.9rem 0 0; border-top: 1px solid var(--border); padding-top: 0.7rem"
        >
          Reminders appear here whenever PillStack is open.
          <button class="subtle" @click="enableNative">Also show desktop notifications</button>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-bell {
  position: relative;
}

.notification-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 0.5rem);
  width: min(380px, calc(100vw - 2rem));
  z-index: 20;
}
</style>
