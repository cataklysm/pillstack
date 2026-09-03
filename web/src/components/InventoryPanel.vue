<script setup lang="ts">
import type { InventoryStatus, InventoryTransaction } from '@pillstack/contracts';
import { onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

const props = defineProps<{ productId: string }>();

const status = ref<InventoryStatus | null>(null);
const ledger = ref<InventoryTransaction[]>([]);
const error = ref<string | null>(null);
const showLedger = ref(false);

const addingPackage = ref(false);
const packageForm = ref({ quantity: '', expirationDate: '', lotNumber: '', opened: true });

const correcting = ref(false);
const countedQuantity = ref('');

const editingPolicy = ref(false);
const policyForm = ref({ leadTimeDays: 7, thresholdQuantity: '', thresholdDays: '' });

const reorderExplanation: Record<string, string> = {
  lead_time: 'so a new package arrives before this one runs out',
  threshold_quantity: 'stock drops below the threshold you set',
  threshold_days: 'cover drops below the number of days you set',
};

async function load() {
  error.value = null;
  try {
    status.value = await api.inventory.forProduct(props.productId);
    policyForm.value = {
      leadTimeDays: status.value.policy.reorderLeadTimeDays,
      thresholdQuantity: status.value.policy.reorderThresholdQuantity?.toString() ?? '',
      thresholdDays: status.value.policy.reorderThresholdDays?.toString() ?? '',
    };
    if (showLedger.value) ledger.value = await api.inventory.ledger(props.productId);
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load inventory';
  }
}

async function run(action: () => Promise<InventoryStatus>) {
  error.value = null;
  try {
    status.value = await action();
    if (showLedger.value) ledger.value = await api.inventory.ledger(props.productId);
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'that did not work';
  }
}

async function toggleLedger() {
  showLedger.value = !showLedger.value;
  if (showLedger.value) ledger.value = await api.inventory.ledger(props.productId);
}

function addPackage() {
  void run(() =>
    api.inventory.addPackage(props.productId, {
      quantity: packageForm.value.quantity === '' ? null : Number(packageForm.value.quantity),
      expirationDate: packageForm.value.expirationDate || null,
      lotNumber: packageForm.value.lotNumber || null,
      opened: packageForm.value.opened,
    }),
  ).then(() => {
    addingPackage.value = false;
    packageForm.value = { quantity: '', expirationDate: '', lotNumber: '', opened: true };
  });
}

function correct() {
  void run(() =>
    api.inventory.correct(props.productId, { countedQuantity: Number(countedQuantity.value) }),
  ).then(() => {
    correcting.value = false;
    countedQuantity.value = '';
  });
}

function savePolicy() {
  void run(() =>
    api.inventory.updatePolicy(props.productId, {
      reorderLeadTimeDays: Number(policyForm.value.leadTimeDays),
      reorderThresholdQuantity:
        policyForm.value.thresholdQuantity === '' ? null : Number(policyForm.value.thresholdQuantity),
      reorderThresholdDays:
        policyForm.value.thresholdDays === '' ? null : Number(policyForm.value.thresholdDays),
    }),
  ).then(() => {
    editingPolicy.value = false;
  });
}

function discard(packageId: string) {
  if (!confirm('Discard this package? The remaining stock is written off in the ledger.')) return;
  void run(() => api.inventory.discard(props.productId, packageId));
}

const transactionLabels: Record<string, string> = {
  package_added: 'Package added',
  dose_consumed: 'Dose taken',
  manual_correction: 'Counted',
  package_discarded: 'Package discarded',
  treatment_paused: 'Treatment paused',
  other: 'Other',
};

onMounted(() => void load());
</script>

<template>
  <div v-if="status" class="card">
    <div class="card-body">
      <div style="display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap">
        <h2>Inventory</h2>
        <div class="spacer" style="margin-left: auto"></div>
        <button class="subtle" @click="addingPackage = !addingPackage">Add package</button>
        <button class="subtle" @click="correcting = !correcting">Correct count</button>
        <button class="subtle" @click="toggleLedger">
          {{ showLedger ? 'Hide' : 'Show' }} ledger
        </button>
      </div>

      <p v-if="error" class="banner error" style="margin-top: 0.75rem">{{ error }}</p>

      <div class="field-row" style="margin-top: 1rem">
        <div>
          <div class="small muted">In stock</div>
          <div style="font-size: 1.3rem; font-weight: 600">
            {{ Math.round(status.currentQuantity * 100) / 100 }} {{ status.packageUnit }}
          </div>
        </div>
        <div>
          <div class="small muted">Estimated per day</div>
          <div>{{ status.estimatedDailyConsumption > 0 ? status.estimatedDailyConsumption : '—' }}</div>
        </div>
        <div>
          <div class="small muted">Runs out</div>
          <div>
            {{ status.runOutDate ?? '—' }}
            <span v-if="status.daysOfCover !== null" class="muted small">
              ({{ status.daysOfCover }} days)
            </span>
          </div>
        </div>
        <div>
          <div class="small muted">Reorder</div>
          <div>
            <span :class="status.reorderDue ? 'tag warning' : ''">
              {{ status.reorderDate ?? '—' }}
            </span>
          </div>
        </div>
      </div>

      <p v-if="status.reorderReason" class="small muted" style="margin: 0.7rem 0 0">
        {{ status.reorderDue ? 'Order now:' : 'Reorder date set by' }}
        {{ reorderExplanation[status.reorderReason] }}.
      </p>
      <p v-if="status.expiresBeforeDepletion" class="small" style="margin: 0.4rem 0 0">
        <span class="tag warning">expiry</span>
        A package expires on {{ status.earliestExpiration }}, before this stock would be used up.
      </p>

      <!-- Add a package -->
      <fieldset v-if="addingPackage" style="margin-top: 1rem">
        <legend>New package</legend>
        <div class="field-row">
          <label>
            Quantity (blank = a full package)
            <input v-model="packageForm.quantity" type="number" step="any" min="0" />
          </label>
          <label>
            Expiry date
            <input v-model="packageForm.expirationDate" type="date" />
          </label>
          <label>
            Batch / lot
            <input v-model="packageForm.lotNumber" />
          </label>
          <label style="flex-direction: row; align-items: center; gap: 0.4rem; display: flex; padding-top: 1.2rem">
            <input v-model="packageForm.opened" type="checkbox" />
            Already opened
          </label>
        </div>
        <button class="primary" style="margin-top: 0.6rem" @click="addPackage">Add</button>
      </fieldset>

      <!-- Correct the count -->
      <fieldset v-if="correcting" style="margin-top: 1rem">
        <legend>Counted stock</legend>
        <p class="small muted" style="margin: 0 0 0.6rem">
          Enter what is actually there. This becomes the anchor future estimates start from; the
          count and the derived adjustment are both kept in the ledger.
        </p>
        <div class="field-row">
          <label>
            Counted {{ status.packageUnit }}
            <input v-model="countedQuantity" type="number" step="any" min="0" />
          </label>
        </div>
        <button class="primary" style="margin-top: 0.6rem" @click="correct">Record count</button>
      </fieldset>

      <!-- Packages -->
      <h3 style="margin-top: 1.3rem">Packages</h3>
      <div v-if="status.packages.length === 0" class="muted small">None recorded.</div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Size</th>
              <th>Status</th>
              <th>Opened</th>
              <th>Expires</th>
              <th>Lot</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="stockPackage in status.packages" :key="stockPackage.id">
              <td>{{ stockPackage.packageSize }} {{ stockPackage.unit }}</td>
              <td class="small">{{ stockPackage.status }}</td>
              <td class="small">{{ stockPackage.openedAt ?? '—' }}</td>
              <td class="small">{{ stockPackage.expirationDate ?? '—' }}</td>
              <td class="small muted">{{ stockPackage.lotNumber ?? '—' }}</td>
              <td>
                <button class="subtle" @click="discard(stockPackage.id)">Discard</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Reorder policy -->
      <h3 style="margin-top: 1.3rem">
        Reorder settings
        <button class="subtle" @click="editingPolicy = !editingPolicy">
          {{ editingPolicy ? 'Close' : 'Edit' }}
        </button>
      </h3>
      <div v-if="!editingPolicy" class="small muted">
        Order {{ status.policy.reorderLeadTimeDays }} days before running out<template
          v-if="status.policy.reorderThresholdQuantity !== null"
        >, or when fewer than {{ status.policy.reorderThresholdQuantity }}
          {{ status.packageUnit }} remain</template
        ><template v-if="status.policy.reorderThresholdDays !== null">, or when fewer than
          {{ status.policy.reorderThresholdDays }} days of cover remain</template
        >.
      </div>
      <div v-else>
        <div class="field-row">
          <label>
            Delivery lead time (days)
            <input v-model.number="policyForm.leadTimeDays" type="number" min="0" />
          </label>
          <label>
            Stock threshold ({{ status.packageUnit }})
            <input v-model="policyForm.thresholdQuantity" type="number" step="any" min="0" placeholder="none" />
          </label>
          <label>
            Days-of-cover threshold
            <input v-model="policyForm.thresholdDays" type="number" min="0" placeholder="none" />
          </label>
        </div>
        <button class="primary" style="margin-top: 0.6rem" @click="savePolicy">Save</button>
      </div>

      <!-- Ledger -->
      <template v-if="showLedger">
        <h3 style="margin-top: 1.3rem">Ledger</h3>
        <p class="small muted" style="margin: 0 0 0.5rem">
          Append-only. Days without an entry are inferred from the plan.
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Event</th>
                <th>Change</th>
                <th>Counted</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in ledger" :key="entry.id">
                <td class="small">{{ entry.effectiveOn }}</td>
                <td class="small">{{ transactionLabels[entry.transactionType] }}</td>
                <td class="small">
                  {{ entry.quantityDelta > 0 ? '+' : '' }}{{ entry.quantityDelta || '—' }}
                </td>
                <td class="small">{{ entry.absoluteQuantity ?? '—' }}</td>
                <td class="small muted">{{ entry.note ?? '—' }}</td>
              </tr>
              <tr v-if="ledger.length === 0">
                <td colspan="5" class="muted">Nothing recorded yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>
