<script setup lang="ts">
import type { Product, TreatmentHistory } from '@pillstack/contracts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';

const props = defineProps<{ id: string }>();
const router = useRouter();

const product = ref<Product | null>(null);
const histories = ref<TreatmentHistory[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    product.value = await api.products.get(props.id);
    const treatments = await api.products.treatments(props.id);
    histories.value = await Promise.all(
      treatments.map((treatment) => api.treatments.history(treatment.id)),
    );
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load this product';
  } finally {
    loading.value = false;
  }
}

async function act(action: () => Promise<unknown>) {
  try {
    await action();
    await load();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'that did not work';
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function archive() {
  if (!confirm('Archive this product? Its history and past intakes stay intact.')) return;
  await act(() => api.products.archive(props.id));
}

function stopTreatment(treatmentId: string) {
  const reason = prompt('Reason for stopping (optional)') ?? undefined;
  void act(() => api.treatments.stop(treatmentId, { endedOn: todayIso(), stopReason: reason }));
}

function pauseTreatment(treatmentId: string) {
  const reason = prompt('Reason for pausing (optional)') ?? undefined;
  void act(() => api.treatments.pause(treatmentId, { pausedFrom: todayIso(), reason }));
}

function resumeTreatment(treatmentId: string) {
  void act(() => api.treatments.resume(treatmentId, { resumedOn: todayIso() }));
}

onMounted(() => void load());
</script>

<template>
  <section v-if="product">
    <div class="page-header">
      <h1>{{ product.name }}</h1>
      <span class="tag" :class="product.category">{{ product.category }}</span>
      <span v-if="product.prescriptionRequired" class="tag neutral">prescription</span>
      <span v-if="!product.active" class="tag neutral">archived</span>
      <div class="spacer"></div>
      <RouterLink :to="`/products/${product.id}/edit`" class="button">Edit</RouterLink>
      <button v-if="product.active" @click="archive">Archive</button>
    </div>

    <p v-if="error" class="banner error">{{ error }}</p>

    <div class="stack">
      <div class="card">
        <div class="card-body">
          <h2>Product</h2>
          <div class="field-row" style="margin-top: 0.75rem">
            <div>
              <div class="small muted">Manufacturer</div>
              <div>{{ product.manufacturer ?? '—' }}</div>
            </div>
            <div>
              <div class="small muted">Package</div>
              <div>{{ product.packageSize }} {{ product.packageUnit }}</div>
            </div>
            <div>
              <div class="small muted">Form</div>
              <div>{{ product.dosageForm }}</div>
            </div>
          </div>
          <p v-if="product.notes" class="small" style="margin-bottom: 0">{{ product.notes }}</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2>Active ingredients</h2>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Substance</th>
                <th>Amount</th>
                <th>As stated on the package</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ingredient in product.ingredients" :key="ingredient.id">
                <td>{{ ingredient.substanceName }}</td>
                <td>
                  {{ ingredient.amount ?? '—' }}
                  {{ ingredient.amount ? (ingredient.unit ?? '') : '' }}
                </td>
                <td class="muted small">{{ ingredient.label ?? '—' }}</td>
              </tr>
              <tr v-if="product.ingredients.length === 0">
                <td colspan="3" class="muted">No ingredients recorded.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div style="display: flex; align-items: baseline; gap: 1rem">
            <h2>Intake plans</h2>
            <div class="spacer" style="margin-left: auto"></div>
            <RouterLink :to="`/products/${product.id}/treatment`" class="button primary">
              Start a treatment
            </RouterLink>
          </div>
        </div>

        <div v-if="histories.length === 0" class="card-body">
          <p class="muted" style="margin: 0">
            No intake plan yet. Start a treatment to put this product on the daily schedule.
          </p>
        </div>

        <div v-for="history in histories" :key="history.treatment.id" class="card-body" style="border-top: 1px solid var(--border)">
          <div style="display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap">
            <strong>{{ history.treatment.currentPlan?.summary ?? 'No current plan' }}</strong>
            <span class="tag neutral">{{ history.treatment.status }}</span>
            <span v-if="history.treatment.indication" class="muted small">
              for {{ history.treatment.indication }}
            </span>
            <div class="spacer" style="margin-left: auto"></div>
            <button v-if="history.treatment.status === 'active'" class="subtle" @click="pauseTreatment(history.treatment.id)">
              Pause
            </button>
            <button v-if="history.treatment.status === 'paused'" class="subtle" @click="resumeTreatment(history.treatment.id)">
              Resume
            </button>
            <button
              v-if="history.treatment.status !== 'stopped'"
              class="subtle"
              @click="router.push(`/products/${product.id}/treatment?treatmentId=${history.treatment.id}`)"
            >
              Change plan
            </button>
            <button v-if="history.treatment.status !== 'stopped'" class="subtle" @click="stopTreatment(history.treatment.id)">
              Stop
            </button>
          </div>

          <p class="small muted" style="margin: 0.35rem 0 0">
            Since {{ history.treatment.startedOn }}
            <template v-if="history.treatment.prescriber"> · {{ history.treatment.prescriber }}</template>
            <template v-if="history.treatment.endedOn"> · ended {{ history.treatment.endedOn }}</template>
          </p>

          <!--
            Every version is kept. Changing a dose closes the current one and
            opens a new one, so this list only ever grows.
          -->
          <h3 style="margin-top: 1.1rem">Plan versions</h3>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Schedule</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="version in history.planVersions" :key="version.id">
                  <td>{{ version.version }}</td>
                  <td>{{ version.summary }}</td>
                  <td class="small">{{ version.effectiveFrom }}</td>
                  <td class="small">{{ version.effectiveTo ?? 'current' }}</td>
                  <td class="small muted">{{ version.changeReason ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 style="margin-top: 1.1rem">History</h3>
          <ul class="event-list">
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

  <p v-else-if="loading" class="muted">Loading…</p>
  <p v-else class="banner error">{{ error }}</p>
</template>
