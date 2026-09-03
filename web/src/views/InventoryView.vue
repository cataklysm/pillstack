<script setup lang="ts">
import type { InventoryStatus } from '@pillstack/contracts';
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

const statuses = ref<InventoryStatus[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const needsReorder = computed(() => statuses.value.filter((status) => status.reorderDue));
const expiringSoon = computed(() =>
  statuses.value.filter((status) => status.expiresBeforeDepletion && !status.reorderDue),
);
const tracked = computed(() =>
  [...statuses.value].sort((left, right) => {
    // Whatever runs out first is what the user needs to see first.
    if (left.runOutDate === right.runOutDate) return left.productName.localeCompare(right.productName);
    if (left.runOutDate === null) return 1;
    if (right.runOutDate === null) return -1;
    return left.runOutDate.localeCompare(right.runOutDate);
  }),
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    statuses.value = await api.inventory.list();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load inventory';
  } finally {
    loading.value = false;
  }
}

const reorderExplanation: Record<string, string> = {
  lead_time: 'delivery lead time',
  threshold_quantity: 'stock threshold',
  threshold_days: 'days-of-cover threshold',
};

function formatQuantity(status: InventoryStatus): string {
  const rounded = Math.round(status.currentQuantity * 100) / 100;
  return `${rounded} ${status.packageUnit}`;
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>Inventory</h1>
      <div class="spacer"></div>
      <button class="subtle" @click="load">Refresh</button>
    </div>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <template v-else>
      <div v-if="needsReorder.length" class="card" style="margin-bottom: 1.25rem">
        <div class="card-body">
          <h2>Order now</h2>
          <p class="small muted" style="margin-top: 0.2rem">
            The reorder date for these has already passed.
          </p>
          <ul class="stack" style="margin: 0.75rem 0 0; padding-left: 1.1rem">
            <li v-for="status in needsReorder" :key="status.productId">
              <RouterLink :to="`/products/${status.productId}`">{{ status.productName }}</RouterLink>
              — {{ formatQuantity(status) }} left,
              <template v-if="status.runOutDate">runs out {{ status.runOutDate }}</template>
              <template v-else>no schedule</template>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="expiringSoon.length" class="card" style="margin-bottom: 1.25rem">
        <div class="card-body">
          <h2>Expiring before use</h2>
          <ul class="stack" style="margin: 0.6rem 0 0; padding-left: 1.1rem">
            <li v-for="status in expiringSoon" :key="status.productId" class="small">
              <RouterLink :to="`/products/${status.productId}`">{{ status.productName }}</RouterLink>
              expires {{ status.earliestExpiration }}, but the stock would last until
              {{ status.runOutDate ?? 'indefinitely' }}.
            </li>
          </ul>
        </div>
      </div>

      <div v-if="tracked.length === 0" class="card">
        <p class="empty-state">
          No stock recorded yet. Open a product and add a package to start tracking it.
        </p>
      </div>

      <div v-else class="card">
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>In stock</th>
                <th>Per day</th>
                <th>Cover</th>
                <th>Runs out</th>
                <th>Reorder</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="status in tracked" :key="status.productId">
                <td>
                  <RouterLink :to="`/products/${status.productId}`">
                    {{ status.productName }}
                  </RouterLink>
                  <span class="tag" :class="status.category" style="margin-left: 0.4rem">
                    {{ status.category }}
                  </span>
                </td>
                <td>{{ formatQuantity(status) }}</td>
                <td class="muted small">
                  {{ status.estimatedDailyConsumption > 0 ? status.estimatedDailyConsumption : '—' }}
                </td>
                <td class="small">
                  {{ status.daysOfCover === null ? '—' : `${status.daysOfCover} days` }}
                </td>
                <td class="small">{{ status.runOutDate ?? '—' }}</td>
                <td class="small">
                  <template v-if="status.reorderDate">
                    <span :class="status.reorderDue ? 'tag warning' : ''">
                      {{ status.reorderDate }}
                    </span>
                    <div v-if="status.reorderReason" class="muted" style="font-size: 0.78rem">
                      {{ reorderExplanation[status.reorderReason] }}
                    </div>
                  </template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p class="small muted" style="margin-top: 1rem">
        Every figure here is derived from the transaction ledger and the current plans — nothing is
        stored as a running total, so corrections, pauses and dose changes are reflected
        immediately.
      </p>
    </template>
  </section>
</template>
