<script setup lang="ts">
import type { TreatmentEvent, TreatmentHistory } from '@pillstack/contracts';
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

/**
 * The longitudinal view a physician asks for: every treatment, every dose
 * change, every pause, in one chronological list. This is the data the
 * treatment-history PDF will render in Milestone 4.
 */

interface DatedEvent {
  event: TreatmentEvent;
  productName: string;
  productId: string;
  indication: string | null;
}

const histories = ref<TreatmentHistory[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const grouping = ref<'chronological' | 'by-product'>('chronological');

const events = computed<DatedEvent[]>(() =>
  histories.value
    .flatMap((history) =>
      history.events.map((event) => ({
        event,
        productName: history.treatment.productName,
        productId: history.treatment.productId,
        indication: history.treatment.indication,
      })),
    )
    .sort((left, right) => right.event.occurredOn.localeCompare(left.event.occurredOn)),
);

const activeCount = computed(
  () => histories.value.filter((history) => history.treatment.status === 'active').length,
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const treatments = await api.treatments.list();
    histories.value = await Promise.all(
      treatments.map((treatment) => api.treatments.history(treatment.id)),
    );
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load the history';
  } finally {
    loading.value = false;
  }
}

const eventLabels: Record<string, string> = {
  started: 'Started',
  dose_changed: 'Dose changed',
  schedule_changed: 'Schedule changed',
  paused: 'Paused',
  resumed: 'Resumed',
  stopped: 'Stopped',
  product_changed: 'Product changed',
  note_added: 'Note',
};

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>Treatment history</h1>
      <span class="muted small">
        {{ histories.length }} treatment{{ histories.length === 1 ? '' : 's' }},
        {{ activeCount }} active
      </span>
      <div class="spacer"></div>
      <div class="intake-actions">
        <button
          class="subtle"
          :class="{ primary: grouping === 'chronological' }"
          @click="grouping = 'chronological'"
        >
          Chronological
        </button>
        <button
          class="subtle"
          :class="{ primary: grouping === 'by-product' }"
          @click="grouping = 'by-product'"
        >
          By product
        </button>
      </div>
    </div>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <div v-else-if="histories.length === 0" class="card">
      <p class="empty-state">
        No treatments recorded yet. Start one from a product to build up its history.
      </p>
    </div>

    <div v-else-if="grouping === 'chronological'" class="card">
      <div class="card-body">
        <ul class="event-list">
          <li v-for="entry in events" :key="entry.event.id" class="event">
            <span class="event-date">{{ entry.event.occurredOn }}</span>
            <span>
              <RouterLink :to="`/products/${entry.productId}`">
                <strong>{{ entry.productName }}</strong>
              </RouterLink>
              <span class="tag neutral" style="margin-left: 0.4rem">
                {{ eventLabels[entry.event.eventType] }}
              </span>
              <div class="small" style="margin-top: 0.15rem">{{ entry.event.summary }}</div>
              <div v-if="entry.event.reason" class="small muted">{{ entry.event.reason }}</div>
            </span>
          </li>
        </ul>
      </div>
    </div>

    <div v-else class="stack">
      <div v-for="history in histories" :key="history.treatment.id" class="card">
        <div class="card-body">
          <div style="display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap">
            <h2>
              <RouterLink :to="`/products/${history.treatment.productId}`">
                {{ history.treatment.productName }}
              </RouterLink>
            </h2>
            <span class="tag neutral">{{ history.treatment.status }}</span>
            <span v-if="history.treatment.indication" class="muted small">
              for {{ history.treatment.indication }}
            </span>
          </div>

          <p class="small muted" style="margin: 0.35rem 0 0.9rem">
            {{ history.treatment.startedOn }}
            &ndash;
            {{ history.treatment.endedOn ?? 'ongoing' }}
            <template v-if="history.treatment.prescriber">
              · {{ history.treatment.prescriber }}
            </template>
          </p>

          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Schedule</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="version in history.planVersions" :key="version.id">
                  <td>{{ version.version }}</td>
                  <td>{{ version.summary }}</td>
                  <td class="small">{{ version.effectiveFrom }}</td>
                  <td class="small">{{ version.effectiveTo ?? 'current' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul class="event-list" style="margin-top: 1rem">
            <li v-for="event in history.events" :key="event.id" class="event">
              <span class="event-date">{{ event.occurredOn }}</span>
              <span>
                {{ event.summary }}
                <span v-if="event.reason" class="muted small"> — {{ event.reason }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
