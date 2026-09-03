<script setup lang="ts">
import type { MedicationPlan } from '@pillstack/contracts';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';

const preview = ref<MedicationPlan | null>(null);
const error = ref<string | null>(null);
const importing = ref(false);
const importMessage = ref<string | null>(null);

const details = reactive({
  patientName: '',
  dateOfBirth: '',
  physicianNote: '',
  from: '',
  includeStopped: true,
});

/** Only non-empty values, so blank fields do not print as empty columns. */
const query = computed<Record<string, string>>(() => {
  const params: Record<string, string> = {};
  if (details.patientName.trim()) params.patientName = details.patientName.trim();
  if (details.dateOfBirth) params.dateOfBirth = details.dateOfBirth;
  if (details.physicianNote.trim()) params.physicianNote = details.physicianNote.trim();
  return params;
});

const historyQuery = computed<Record<string, string>>(() => {
  const params = { ...query.value };
  if (details.from) params.from = details.from;
  if (!details.includeStopped) params.includeStopped = 'false';
  return params;
});

async function loadPreview() {
  error.value = null;
  try {
    preview.value = await api.exports.medicationPlan(query.value);
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not build the plan';
  }
}

async function importJson(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  importing.value = true;
  importMessage.value = null;
  error.value = null;

  try {
    const document = JSON.parse(await file.text()) as unknown;
    const result = await api.exports.import(document);
    importMessage.value = `Imported ${result.products} products, ${result.treatments} treatments and ${result.inventoryTransactions} stock entries.`;
  } catch (cause) {
    error.value =
      cause instanceof ApiError ? cause.message : 'that file could not be read as an export';
  } finally {
    importing.value = false;
    input.value = '';
  }
}

onMounted(() => void loadPreview());
</script>

<template>
  <section>
    <div class="page-header"><h1>Export</h1></div>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="importMessage" class="banner">{{ importMessage }}</p>

    <div class="stack">
      <div class="card">
        <div class="card-body stack">
          <h2>For your physician</h2>
          <p class="small muted" style="margin: 0">
            These details are optional and are only printed on the document. Nothing is sent
            anywhere — the PDF is generated on this machine.
          </p>

          <div class="field-row">
            <label>
              Patient name
              <input v-model="details.patientName" placeholder="optional" @blur="loadPreview" />
            </label>
            <label>
              Date of birth
              <input v-model="details.dateOfBirth" type="date" @change="loadPreview" />
            </label>
          </div>

          <label>
            Note for the physician
            <input v-model="details.physicianNote" placeholder="optional" />
          </label>

          <div style="display: flex; gap: 0.6rem; flex-wrap: wrap">
            <a
              class="button primary"
              :href="api.exports.medicationPlanPdfUrl(query)"
              target="_blank"
              rel="noopener"
            >
              Medication plan (PDF)
            </a>
            <button class="subtle" @click="loadPreview">Refresh preview</button>
          </div>
        </div>
      </div>

      <!-- What the physician will see, on screen, before anything is printed. -->
      <div v-if="preview" class="card">
        <div class="card-body">
          <h2>Preview</h2>
          <p class="small muted" style="margin: 0.2rem 0 0">As at {{ preview.asOf }}</p>
        </div>

        <template v-for="group in [
          { title: 'MEDICATIONS', rows: preview.medications },
          { title: 'SUPPLEMENTS', rows: preview.supplements },
        ]">
          <div v-if="group.rows.length" :key="group.title">
            <div class="card-body" style="padding-bottom: 0">
              <h3>{{ group.title }}</h3>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product / active ingredient</th>
                    <th>Dose</th>
                    <th>Schedule</th>
                    <th>Since</th>
                    <th>Indication / note</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in group.rows" :key="entry.productId">
                    <td>
                      <div>{{ entry.productName }}</div>
                      <div class="small muted">{{ entry.activeIngredients }}</div>
                    </td>
                    <td>{{ entry.dose }}</td>
                    <td class="small">{{ entry.schedule }}</td>
                    <td class="small">{{ entry.since }}</td>
                    <td class="small muted">
                      {{ [entry.indication, entry.note].filter(Boolean).join(' — ') || '—' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <div
          v-if="preview.medications.length === 0 && preview.supplements.length === 0"
          class="card-body"
        >
          <p class="muted" style="margin: 0">Nothing is currently being taken.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <h2>Treatment history</h2>
          <p class="small muted" style="margin: 0">
            The longitudinal report: every start, dose change, pause and stop, with the reasons
            recorded at the time.
          </p>

          <div class="field-row">
            <label>
              From (optional)
              <input v-model="details.from" type="date" />
            </label>
            <label style="flex-direction: row; align-items: center; gap: 0.45rem; display: flex; padding-top: 1.2rem">
              <input v-model="details.includeStopped" type="checkbox" />
              Include stopped treatments
            </label>
          </div>

          <div>
            <a
              class="button primary"
              :href="api.exports.treatmentHistoryPdfUrl(historyQuery)"
              target="_blank"
              rel="noopener"
            >
              Treatment history (PDF)
            </a>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <h2>Your data as JSON</h2>
          <!--
            Deliberately not a backup: this is for moving the data to another
            application. Restoring PillStack itself is on the Backup page.
          -->
          <p class="small muted" style="margin: 0">
            A readable, versioned snapshot for moving your data to another application. To restore
            PillStack itself, use <RouterLink to="/backup">Backup</RouterLink> instead.
          </p>

          <div style="display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap">
            <a class="button" :href="api.exports.jsonUrl()" download>Download JSON</a>
            <label style="display: inline-flex; align-items: center; gap: 0.5rem">
              <span class="small muted">Import into an empty PillStack:</span>
              <input type="file" accept="application/json,.json" style="width: auto" @change="importJson" />
            </label>
            <span v-if="importing" class="small muted">Importing…</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
