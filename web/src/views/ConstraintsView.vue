<script setup lang="ts">
import type {
  ConstraintEndpoint,
  ConstraintType,
  IntakeConstraint,
  Product,
} from '@pillstack/contracts';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';

const constraints = ref<IntakeConstraint[]>([]);
const products = ref<Product[]>([]);
const substances = ref<{ id: string; name: string }[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const details = ref<unknown>(null);
const editingId = ref<string | null>(null);
const showForm = ref(false);

type EndpointKind = 'product' | 'substance' | 'category' | 'meal' | 'food';

const form = reactive({
  constraintType: 'minimum_separation' as ConstraintType,
  severity: 'warning' as 'warning' | 'information',
  sourceKind: 'substance' as EndpointKind,
  sourceId: '',
  sourceCategory: 'medication' as 'medication' | 'supplement',
  targetKind: 'substance' as EndpointKind,
  targetId: '',
  targetCategory: 'supplement' as 'medication' | 'supplement',
  targetMeal: 'dinner' as 'breakfast' | 'lunch' | 'dinner',
  targetFood: '',
  minimumDistanceMinutes: 120,
  foodOffsetMinutes: 30,
  preferredTimeFrom: '06:00',
  preferredTimeTo: '10:00',
  explanation: '',
});

const constraintTypes: { value: ConstraintType; label: string }[] = [
  { value: 'minimum_separation', label: 'Keep a minimum distance from something' },
  { value: 'avoid_together', label: 'Never take together with something' },
  { value: 'with_food', label: 'Take with food' },
  { value: 'without_food', label: 'Take without food' },
  { value: 'before_food', label: 'Take before food' },
  { value: 'after_food', label: 'Take after food' },
  { value: 'preferred_time_of_day', label: 'Prefer a time of day' },
];

const needsTarget = computed(
  () => form.constraintType === 'minimum_separation' || form.constraintType === 'avoid_together',
);
const isFoodRule = computed(() =>
  ['with_food', 'without_food', 'before_food', 'after_food'].includes(form.constraintType),
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    [constraints.value, products.value, substances.value] = await Promise.all([
      api.constraints.list(),
      api.products.list({ active: true }),
      api.constraints.substances(),
    ]);
    if (!form.sourceId && substances.value[0]) form.sourceId = substances.value[0].id;
    if (!form.targetId && substances.value[1]) form.targetId = substances.value[1].id;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load the rules';
  } finally {
    loading.value = false;
  }
}

function buildEndpoint(side: 'source' | 'target'): ConstraintEndpoint | null {
  const kind = side === 'source' ? form.sourceKind : form.targetKind;
  const id = side === 'source' ? form.sourceId : form.targetId;
  const category = side === 'source' ? form.sourceCategory : form.targetCategory;

  switch (kind) {
    case 'product':
      return id ? { kind: 'product', productId: id } : null;
    case 'substance':
      return id ? { kind: 'substance', substanceId: id } : null;
    case 'category':
      return { kind: 'category', category };
    case 'meal':
      return { kind: 'meal', meal: form.targetMeal };
    case 'food':
      return form.targetFood ? { kind: 'food', label: form.targetFood } : null;
    default:
      return null;
  }
}

async function save() {
  error.value = null;
  details.value = null;

  const source = buildEndpoint('source');
  if (!source) {
    error.value = 'pick what this rule is about';
    return;
  }

  const payload = {
    constraintType: form.constraintType,
    severity: form.severity,
    source,
    target: needsTarget.value || isFoodRule.value ? buildEndpoint('target') : null,
    minimumDistanceMinutes: needsTarget.value ? Number(form.minimumDistanceMinutes) : null,
    foodOffsetMinutes: isFoodRule.value ? Number(form.foodOffsetMinutes) : null,
    preferredTimeFrom:
      form.constraintType === 'preferred_time_of_day' ? form.preferredTimeFrom : null,
    preferredTimeTo: form.constraintType === 'preferred_time_of_day' ? form.preferredTimeTo : null,
    explanation: form.explanation.trim() || null,
  };

  try {
    if (editingId.value) await api.constraints.update(editingId.value, payload);
    else await api.constraints.create(payload);
    showForm.value = false;
    editingId.value = null;
    form.explanation = '';
    await load();
  } catch (cause) {
    if (cause instanceof ApiError) {
      error.value = cause.message;
      details.value = cause.details;
    } else {
      error.value = 'could not save that rule';
    }
  }
}

function edit(constraint: IntakeConstraint) {
  editingId.value = constraint.id;
  showForm.value = true;
  form.constraintType = constraint.constraintType;
  form.severity = constraint.severity;
  form.sourceKind = constraint.source.kind;
  form.sourceId =
    constraint.source.kind === 'product'
      ? constraint.source.productId
      : constraint.source.kind === 'substance'
        ? constraint.source.substanceId
        : '';
  if (constraint.source.kind === 'category') form.sourceCategory = constraint.source.category;

  if (constraint.target) {
    form.targetKind = constraint.target.kind;
    form.targetId =
      constraint.target.kind === 'product'
        ? constraint.target.productId
        : constraint.target.kind === 'substance'
          ? constraint.target.substanceId
          : '';
    if (constraint.target.kind === 'category') form.targetCategory = constraint.target.category;
    if (constraint.target.kind === 'meal') form.targetMeal = constraint.target.meal as never;
    if (constraint.target.kind === 'food') form.targetFood = constraint.target.label;
  }

  form.minimumDistanceMinutes = constraint.minimumDistanceMinutes ?? 120;
  form.foodOffsetMinutes = constraint.foodOffsetMinutes ?? 30;
  form.preferredTimeFrom = constraint.preferredTimeFrom ?? '06:00';
  form.preferredTimeTo = constraint.preferredTimeTo ?? '10:00';
  form.explanation = constraint.explanation ?? '';
}

async function toggle(constraint: IntakeConstraint) {
  await api.constraints.setEnabled(constraint.id, !constraint.enabled);
  await load();
}

async function remove(constraint: IntakeConstraint) {
  if (!confirm(`Delete this rule?\n\n${constraint.summary}`)) return;
  await api.constraints.remove(constraint.id);
  await load();
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>Rules</h1>
      <div class="spacer"></div>
      <button class="primary" @click="showForm = !showForm; editingId = null">
        {{ showForm ? 'Close' : 'Add a rule' }}
      </button>
    </div>

    <!--
      Nothing medical is built in. These are the user's own rules, and the
      schema already distinguishes them from a curated catalogue that could be
      added later without touching what is written here.
    -->
    <p class="banner">
      PillStack ships with no interaction knowledge of its own. Every rule below is one you wrote,
      and a warning never blocks anything — you can always keep a schedule and acknowledge it.
    </p>

    <p v-if="error" class="banner error">
      {{ error }}
      <span v-if="details" class="small"> — {{ JSON.stringify(details) }}</span>
    </p>

    <div v-if="showForm" class="card" style="margin-bottom: 1.25rem">
      <div class="card-body stack">
        <h2>{{ editingId ? 'Edit rule' : 'New rule' }}</h2>

        <label>
          Rule
          <select v-model="form.constraintType">
            <option v-for="option in constraintTypes" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>

        <fieldset>
          <legend>This applies to</legend>
          <div class="field-row">
            <label>
              Kind
              <select v-model="form.sourceKind">
                <option value="substance">an active ingredient</option>
                <option value="product">one product</option>
                <option value="category">a whole category</option>
              </select>
            </label>
            <label v-if="form.sourceKind === 'substance'">
              Ingredient
              <select v-model="form.sourceId">
                <option v-for="substance in substances" :key="substance.id" :value="substance.id">
                  {{ substance.name }}
                </option>
              </select>
            </label>
            <label v-if="form.sourceKind === 'product'">
              Product
              <select v-model="form.sourceId">
                <option v-for="product in products" :key="product.id" :value="product.id">
                  {{ product.name }}
                </option>
              </select>
            </label>
            <label v-if="form.sourceKind === 'category'">
              Category
              <select v-model="form.sourceCategory">
                <option value="medication">medications</option>
                <option value="supplement">supplements</option>
              </select>
            </label>
          </div>
          <p v-if="form.sourceKind === 'substance'" class="small muted" style="margin: 0.5rem 0 0">
            Choosing an ingredient makes the rule apply to every product containing it, including
            ones you add later.
          </p>
        </fieldset>

        <fieldset v-if="needsTarget">
          <legend>Keep it away from</legend>
          <div class="field-row">
            <label>
              Kind
              <select v-model="form.targetKind">
                <option value="substance">an active ingredient</option>
                <option value="product">one product</option>
                <option value="category">a whole category</option>
                <option value="food">a food or drink</option>
              </select>
            </label>
            <label v-if="form.targetKind === 'substance'">
              Ingredient
              <select v-model="form.targetId">
                <option v-for="substance in substances" :key="substance.id" :value="substance.id">
                  {{ substance.name }}
                </option>
              </select>
            </label>
            <label v-if="form.targetKind === 'product'">
              Product
              <select v-model="form.targetId">
                <option v-for="product in products" :key="product.id" :value="product.id">
                  {{ product.name }}
                </option>
              </select>
            </label>
            <label v-if="form.targetKind === 'category'">
              Category
              <select v-model="form.targetCategory">
                <option value="medication">medications</option>
                <option value="supplement">supplements</option>
              </select>
            </label>
            <label v-if="form.targetKind === 'food'">
              Food or drink
              <input v-model="form.targetFood" placeholder="coffee, dairy…" />
            </label>
            <label v-if="form.constraintType === 'minimum_separation'">
              Minimum distance (minutes)
              <input v-model.number="form.minimumDistanceMinutes" type="number" min="0" />
            </label>
          </div>
        </fieldset>

        <fieldset v-if="isFoodRule">
          <legend>Meal</legend>
          <div class="field-row">
            <label>
              Relative to
              <select v-model="form.targetKind">
                <option value="category">any meal</option>
                <option value="meal">a specific meal</option>
              </select>
            </label>
            <label v-if="form.targetKind === 'meal'">
              Meal
              <select v-model="form.targetMeal">
                <option value="breakfast">breakfast</option>
                <option value="lunch">lunch</option>
                <option value="dinner">dinner</option>
              </select>
            </label>
            <label>
              Window (minutes)
              <input v-model.number="form.foodOffsetMinutes" type="number" min="0" />
            </label>
          </div>
        </fieldset>

        <fieldset v-if="form.constraintType === 'preferred_time_of_day'">
          <legend>Preferred window</legend>
          <div class="field-row">
            <label>
              From
              <input v-model="form.preferredTimeFrom" type="time" />
            </label>
            <label>
              To
              <input v-model="form.preferredTimeTo" type="time" />
            </label>
          </div>
        </fieldset>

        <div class="field-row">
          <label>
            Severity
            <select v-model="form.severity">
              <option value="warning">warning</option>
              <option value="information">information</option>
            </select>
          </label>
          <label style="grid-column: span 2">
            Why (shown with the warning)
            <input v-model="form.explanation" placeholder="Calcium reduces iron absorption." />
          </label>
        </div>

        <div><button class="primary" @click="save">Save rule</button></div>
      </div>
    </div>

    <p v-if="loading" class="muted">Loading…</p>

    <div v-else-if="constraints.length === 0" class="card">
      <p class="empty-state">No rules yet.</p>
    </div>

    <div v-else class="card">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Severity</th>
              <th>Why</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="constraint in constraints" :key="constraint.id">
              <td :style="constraint.enabled ? '' : 'opacity: 0.5'">
                {{ constraint.summary }}
              </td>
              <td>
                <span class="tag" :class="constraint.severity === 'warning' ? 'warning' : 'neutral'">
                  {{ constraint.severity }}
                </span>
              </td>
              <td class="small muted">{{ constraint.explanation ?? '—' }}</td>
              <td>
                <div class="intake-actions">
                  <button class="subtle" @click="toggle(constraint)">
                    {{ constraint.enabled ? 'Disable' : 'Enable' }}
                  </button>
                  <button class="subtle" @click="edit(constraint)">Edit</button>
                  <button class="subtle" @click="remove(constraint)">Delete</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
