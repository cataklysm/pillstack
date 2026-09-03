<script setup lang="ts">
import type { DayTimeline, ScheduledIntake } from '@pillstack/contracts';
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

const timeline = ref<DayTimeline | null>(null);
const nextIntake = ref<ScheduledIntake | null>(null);
const date = ref<string>('');
const today = ref<string>('');
const error = ref<string | null>(null);
const loading = ref(true);

/** The occurrence whose time input is currently open. */
const editing = ref<string | null>(null);
const editedTime = ref('');

const isToday = computed(() => date.value === today.value);

const totalIntakes = computed(
  () => timeline.value?.slots.reduce((count, slot) => count + slot.intakes.length, 0) ?? 0,
);

async function load(target?: string) {
  loading.value = true;
  error.value = null;
  try {
    if (!today.value) today.value = (await api.schedule.today()).date;
    date.value = target ?? (date.value || today.value);

    timeline.value = await api.schedule.day(date.value);
    nextIntake.value = isToday.value ? (await api.schedule.next()).intake : null;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load the schedule';
  } finally {
    loading.value = false;
  }
}

function shiftDay(days: number) {
  const shifted = new Date(`${date.value}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  void load(shifted.toISOString().slice(0, 10));
}

function startEditing(intake: ScheduledIntake) {
  editing.value = intake.occurrenceKey;
  editedTime.value = intake.scheduledTime;
}

/**
 * Moving an intake is an exception for this day only — the plan version behind
 * it is untouched. Making the change permanent is a plan change on the product
 * page, which creates a new version and keeps the old one in the history.
 */
async function applyMove(intake: ScheduledIntake) {
  if (!editedTime.value || editedTime.value === intake.scheduledTime) {
    editing.value = null;
    return;
  }
  try {
    timeline.value = await api.schedule.move({
      planDoseId: intake.planDoseId,
      occurrenceDate: intake.occurrenceDate,
      time: editedTime.value,
    });
    editing.value = null;
    if (isToday.value) nextIntake.value = (await api.schedule.next()).intake;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not move that intake';
  }
}

async function resetMove(intake: ScheduledIntake) {
  timeline.value = await api.schedule.clearOverride({
    planDoseId: intake.planDoseId,
    occurrenceDate: intake.occurrenceDate,
  });
}

function formatDate(value: string): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>{{ isToday ? 'Today' : formatDate(date) }}</h1>
      <span v-if="isToday" class="muted">{{ formatDate(date) }}</span>
      <div class="spacer"></div>
      <div class="intake-actions">
        <button class="subtle" @click="shiftDay(-1)">&larr; Previous</button>
        <button v-if="!isToday" class="subtle" @click="load(today)">Today</button>
        <button class="subtle" @click="shiftDay(1)">Next &rarr;</button>
      </div>
    </div>

    <p v-if="error" class="banner error">{{ error }}</p>

    <div v-if="nextIntake" class="card" style="margin-bottom: 1.25rem">
      <div class="card-body">
        <div class="small muted">Next intake</div>
        <div style="display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap">
          <strong style="font-size: 1.15rem">{{ nextIntake.scheduledTime }}</strong>
          <span>{{ nextIntake.productName }}</span>
          <span class="muted">{{ nextIntake.doseAmount }} {{ nextIntake.doseUnit }}</span>
        </div>
      </div>
    </div>

    <p v-if="loading" class="muted">Loading…</p>

    <div v-else-if="totalIntakes === 0" class="card">
      <p class="empty-state">
        Nothing scheduled for this day.<br />
        <RouterLink to="/products">Add a product and an intake plan</RouterLink> to see it here.
      </p>
    </div>

    <div v-else class="timeline">
      <div v-for="slot in timeline?.slots ?? []" :key="slot.time" class="timeline-slot">
        <div class="timeline-time" :class="{ 'is-next': slot.time === nextIntake?.scheduledTime }">
          {{ slot.time }}
        </div>

        <div class="intake-list">
          <div
            v-for="intake in slot.intakes"
            :key="intake.occurrenceKey"
            class="intake"
            :class="intake.category"
          >
            <div class="intake-main">
              <div class="intake-name">
                <RouterLink :to="`/products/${intake.productId}`">{{ intake.productName }}</RouterLink>
              </div>
              <div class="intake-dose">
                {{ intake.doseAmount }} {{ intake.doseUnit }}
                <template v-if="intake.mealReference"> · with {{ intake.mealReference.replace('_', ' ') }}</template>
                <template v-if="intake.instructions"> · {{ intake.instructions }}</template>
              </div>
            </div>

            <div class="intake-actions">
              <span v-if="intake.movedByUser" class="tag warning">moved</span>
              <span v-else-if="intake.timeIsDerived" class="tag neutral">from meal time</span>

              <template v-if="editing === intake.occurrenceKey">
                <input
                  v-model="editedTime"
                  type="time"
                  class="inline-time"
                  aria-label="New time"
                  @keyup.enter="applyMove(intake)"
                />
                <button class="primary" @click="applyMove(intake)">Save</button>
                <button class="subtle" @click="editing = null">Cancel</button>
              </template>
              <template v-else>
                <button class="subtle" @click="startEditing(intake)">Change time</button>
                <button v-if="intake.movedByUser" class="subtle" @click="resetMove(intake)">
                  Reset
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="timeline?.asNeeded.length" class="card" style="margin-top: 1.5rem">
      <div class="card-body">
        <h2>As needed</h2>
        <p class="small muted">Available today, taken only when required.</p>
        <div class="intake-list" style="margin-top: 0.75rem">
          <div
            v-for="intake in timeline.asNeeded"
            :key="intake.occurrenceKey"
            class="intake"
            :class="intake.category"
          >
            <div class="intake-main">
              <div class="intake-name">{{ intake.productName }}</div>
              <div class="intake-dose">{{ intake.doseAmount }} {{ intake.doseUnit }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
