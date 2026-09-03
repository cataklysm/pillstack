<script setup lang="ts">
import type { MealReference, RecurrenceType, TimingType } from '@pillstack/contracts';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();

/** Present when superseding an existing plan rather than starting a treatment. */
const treatmentId = computed(() => (route.query.treatmentId as string | undefined) ?? null);
const isPlanChange = computed(() => treatmentId.value !== null);

const productName = ref('');
const currentSummary = ref<string | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);
const details = ref<unknown>(null);

interface DoseRow {
  timingType: TimingType;
  targetTime: string;
  windowStartTime: string;
  windowEndTime: string;
  mealReference: MealReference;
  mealOffsetMinutes: number;
  doseAmount: string;
  doseUnit: string;
  packageUnitQuantity: string;
}

function emptyDose(): DoseRow {
  return {
    timingType: 'fixed',
    targetTime: '08:00',
    windowStartTime: '08:00',
    windowEndTime: '10:00',
    mealReference: 'breakfast',
    mealOffsetMinutes: 0,
    doseAmount: '1',
    doseUnit: 'tablet',
    packageUnitQuantity: '1',
  };
}

const form = reactive({
  indication: '',
  prescriber: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  changeReason: '',
  recurrenceType: 'daily' as RecurrenceType,
  intervalDays: 2,
  anchorDate: new Date().toISOString().slice(0, 10),
  weekdays: [true, true, true, true, true, true, true],
  maxDosesPerDay: 3,
  instructions: '',
  doses: [emptyDose()] as DoseRow[],
});

const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const recurrenceTypes: RecurrenceType[] = ['daily', 'weekdays', 'every_n_days', 'as_needed'];
const timingTypes: TimingType[] = ['fixed', 'window', 'meal_relative'];
const mealReferences: MealReference[] = ['breakfast', 'lunch', 'dinner', 'wake_up', 'bed_time'];

const weekdayMask = computed(() =>
  form.weekdays.reduce((mask, selected, index) => (selected ? mask | (1 << index) : mask), 0),
);

async function load() {
  productName.value = (await api.products.get(props.id)).name;

  if (treatmentId.value) {
    const history = await api.treatments.history(treatmentId.value);
    currentSummary.value = history.treatment.currentPlan?.summary ?? null;
    form.indication = history.treatment.indication ?? '';
    form.prescriber = history.treatment.prescriber ?? '';

    const plan = history.treatment.currentPlan;
    if (plan) {
      form.recurrenceType = plan.recurrenceType;
      form.intervalDays = plan.intervalDays ?? 2;
      form.anchorDate = plan.anchorDate ?? form.anchorDate;
      form.instructions = plan.instructions ?? '';
      if (plan.weekdayMask != null) {
        form.weekdays = weekdayLabels.map((_, index) => ((plan.weekdayMask as number) >> index & 1) === 1);
      }
      form.doses = plan.doses.map((dose) => ({
        timingType: dose.timingType,
        targetTime: dose.targetTime ?? '08:00',
        windowStartTime: dose.windowStartTime ?? '08:00',
        windowEndTime: dose.windowEndTime ?? '10:00',
        mealReference: dose.mealReference ?? 'breakfast',
        mealOffsetMinutes: dose.mealOffsetMinutes,
        doseAmount: String(dose.doseAmount),
        doseUnit: dose.doseUnit,
        packageUnitQuantity: dose.packageUnitQuantity == null ? '' : String(dose.packageUnitQuantity),
      }));

      // A new version must start after the one it replaces.
      const tomorrow = new Date(`${plan.effectiveFrom}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const today = new Date().toISOString().slice(0, 10);
      form.effectiveFrom = today > tomorrow.toISOString().slice(0, 10)
        ? today
        : tomorrow.toISOString().slice(0, 10);
    }
  }
}

function buildPlan() {
  return {
    recurrenceType: form.recurrenceType,
    ...(form.recurrenceType === 'every_n_days'
      ? { intervalDays: Number(form.intervalDays), anchorDate: form.anchorDate }
      : {}),
    ...(form.recurrenceType === 'weekdays' ? { weekdayMask: weekdayMask.value } : {}),
    ...(form.recurrenceType === 'as_needed' ? { maxDosesPerDay: Number(form.maxDosesPerDay) } : {}),
    instructions: form.instructions.trim() || null,
    doses: form.doses.map((dose) => {
      const timingType: TimingType = form.recurrenceType === 'as_needed' ? 'as_needed' : dose.timingType;
      return {
        timingType,
        targetTime: timingType === 'fixed' ? dose.targetTime : null,
        windowStartTime: timingType === 'window' ? dose.windowStartTime : null,
        windowEndTime: timingType === 'window' ? dose.windowEndTime : null,
        mealReference: timingType === 'meal_relative' ? dose.mealReference : null,
        mealOffsetMinutes: Number(dose.mealOffsetMinutes) || 0,
        doseAmount: Number(dose.doseAmount),
        doseUnit: dose.doseUnit.trim(),
        packageUnitQuantity:
          dose.packageUnitQuantity === '' ? null : Number(dose.packageUnitQuantity),
      };
    }),
  };
}

async function save() {
  saving.value = true;
  error.value = null;
  details.value = null;

  try {
    if (treatmentId.value) {
      await api.treatments.changePlan(treatmentId.value, {
        effectiveFrom: form.effectiveFrom,
        changeReason: form.changeReason.trim() || null,
        plan: buildPlan(),
      });
    } else {
      await api.treatments.start({
        productId: props.id,
        indication: form.indication.trim() || null,
        prescriber: form.prescriber.trim() || null,
        startedOn: form.effectiveFrom,
        plan: buildPlan(),
      } as never);
    }
    await router.push(`/products/${props.id}`);
  } catch (cause) {
    if (cause instanceof ApiError) {
      error.value = cause.message;
      details.value = cause.details;
    } else {
      error.value = 'could not save this plan';
    }
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>{{ isPlanChange ? 'Change plan' : 'Start a treatment' }}</h1>
      <span class="muted">{{ productName }}</span>
    </div>

    <!--
      A plan change never edits the existing version. The current one is closed
      the day before the new one starts, and both stay in the history.
    -->
    <p v-if="isPlanChange" class="banner">
      Current plan: <strong>{{ currentSummary }}</strong
      >. Saving creates a new version from the date below — the current one is kept and closed the
      day before.
    </p>

    <p v-if="error" class="banner error">
      {{ error }}
      <span v-if="details" class="small"> — {{ JSON.stringify(details) }}</span>
    </p>

    <form class="stack" @submit.prevent="save">
      <div class="card">
        <div class="card-body stack">
          <div class="field-row">
            <label>
              {{ isPlanChange ? 'New version effective from' : 'Started on' }}
              <input v-model="form.effectiveFrom" type="date" required />
            </label>
            <label v-if="!isPlanChange">
              Indication / reason
              <input v-model="form.indication" placeholder="LDL reduction" />
            </label>
            <label v-if="!isPlanChange">
              Prescribing physician
              <input v-model="form.prescriber" placeholder="optional" />
            </label>
            <label v-if="isPlanChange">
              Reason for the change
              <input v-model="form.changeReason" placeholder="LDL still above target" />
            </label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <h2>Schedule</h2>

          <div class="field-row">
            <label>
              Repeats
              <select v-model="form.recurrenceType">
                <option v-for="value in recurrenceTypes" :key="value" :value="value">
                  {{ value.replace(/_/g, ' ') }}
                </option>
              </select>
            </label>

            <label v-if="form.recurrenceType === 'every_n_days'">
              Every N days
              <input v-model.number="form.intervalDays" type="number" min="1" />
            </label>
            <label v-if="form.recurrenceType === 'every_n_days'">
              Counting from
              <input v-model="form.anchorDate" type="date" />
            </label>
            <label v-if="form.recurrenceType === 'as_needed'">
              Maximum doses per day
              <input v-model.number="form.maxDosesPerDay" type="number" min="1" />
            </label>
          </div>

          <div v-if="form.recurrenceType === 'weekdays'">
            <div class="small muted" style="margin-bottom: 0.35rem">On these days</div>
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap">
              <label
                v-for="(day, index) in weekdayLabels"
                :key="day"
                style="flex-direction: row; align-items: center; gap: 0.35rem; display: flex"
              >
                <input v-model="form.weekdays[index]" type="checkbox" />
                {{ day }}
              </label>
            </div>
          </div>

          <label>
            Instructions shown with each intake
            <input v-model="form.instructions" placeholder="e.g. swallow whole with water" />
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <div style="display: flex; align-items: baseline">
            <h2>Doses per day</h2>
            <div class="spacer" style="margin-left: auto"></div>
            <button type="button" class="subtle" @click="form.doses.push(emptyDose())">
              Add a dose
            </button>
          </div>
          <p class="small muted" style="margin: 0">
            One entry per intake. Two entries means twice a day, and the amounts may differ.
          </p>

          <fieldset v-for="(dose, index) in form.doses" :key="index">
            <legend>Dose {{ index + 1 }}</legend>

            <div class="field-row">
              <label v-if="form.recurrenceType !== 'as_needed'">
                Timing
                <select v-model="dose.timingType">
                  <option v-for="value in timingTypes" :key="value" :value="value">
                    {{ value.replace(/_/g, ' ') }}
                  </option>
                </select>
              </label>

              <label v-if="form.recurrenceType !== 'as_needed' && dose.timingType === 'fixed'">
                At
                <input v-model="dose.targetTime" type="time" required />
              </label>

              <template v-if="form.recurrenceType !== 'as_needed' && dose.timingType === 'window'">
                <label>
                  Between
                  <input v-model="dose.windowStartTime" type="time" />
                </label>
                <label>
                  And
                  <input v-model="dose.windowEndTime" type="time" />
                </label>
              </template>

              <template
                v-if="form.recurrenceType !== 'as_needed' && dose.timingType === 'meal_relative'"
              >
                <label>
                  Relative to
                  <select v-model="dose.mealReference">
                    <option v-for="value in mealReferences" :key="value" :value="value">
                      {{ value.replace(/_/g, ' ') }}
                    </option>
                  </select>
                </label>
                <label>
                  Offset in minutes (negative is before)
                  <input v-model.number="dose.mealOffsetMinutes" type="number" step="5" />
                </label>
              </template>
            </div>

            <div class="field-row" style="margin-top: 0.6rem">
              <label>
                Dose amount
                <input v-model="dose.doseAmount" type="number" step="any" min="0" required />
              </label>
              <label>
                Dose unit
                <input v-model="dose.doseUnit" placeholder="mg, tablet, ml" required />
              </label>
              <label>
                Taken from stock
                <input v-model="dose.packageUnitQuantity" type="number" step="any" min="0" placeholder="1" />
              </label>
            </div>
            <p class="small muted" style="margin: 0.4rem 0 0">
              The clinical dose (5 mg) and what it consumes from the package (1 tablet) are kept
              separate, so nothing is converted behind your back.
            </p>

            <button
              v-if="form.doses.length > 1"
              type="button"
              class="subtle"
              style="margin-top: 0.5rem"
              @click="form.doses.splice(index, 1)"
            >
              Remove this dose
            </button>
          </fieldset>
        </div>
      </div>

      <div style="display: flex; gap: 0.6rem">
        <button type="submit" class="primary" :disabled="saving">
          {{ saving ? 'Saving…' : isPlanChange ? 'Create new version' : 'Start treatment' }}
        </button>
        <RouterLink :to="`/products/${props.id}`" class="button">Cancel</RouterLink>
      </div>
    </form>
  </section>
</template>
