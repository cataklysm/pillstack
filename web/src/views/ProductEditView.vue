<script setup lang="ts">
import type { DosageForm, PackageUnit, ProductCategory } from '@pillstack/contracts';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';

const props = defineProps<{ id?: string }>();
const router = useRouter();

const isEditing = Boolean(props.id);
const saving = ref(false);
const error = ref<string | null>(null);
const details = ref<unknown>(null);

interface IngredientRow {
  substanceName: string;
  label: string;
  amount: string;
  unit: string;
}

const form = reactive({
  name: '',
  manufacturer: '',
  category: 'medication' as ProductCategory,
  dosageForm: 'tablet' as DosageForm,
  packageSize: 100,
  packageUnit: 'tablets' as PackageUnit,
  prescriptionRequired: false,
  notes: '',
  ingredients: [{ substanceName: '', label: '', amount: '', unit: 'mg' }] as IngredientRow[],
});

const categories: ProductCategory[] = ['medication', 'supplement'];
const dosageForms: DosageForm[] = [
  'tablet',
  'capsule',
  'powder',
  'drops',
  'liquid',
  'injection',
  'other',
];
const packageUnits: PackageUnit[] = [
  'tablets',
  'capsules',
  'grams',
  'milliliters',
  'doses',
  'other',
];

function addIngredient() {
  form.ingredients.push({ substanceName: '', label: '', amount: '', unit: 'mg' });
}

function removeIngredient(index: number) {
  form.ingredients.splice(index, 1);
}

async function load() {
  if (!props.id) return;
  const product = await api.products.get(props.id);

  form.name = product.name;
  form.manufacturer = product.manufacturer ?? '';
  form.category = product.category;
  form.dosageForm = product.dosageForm;
  form.packageSize = product.packageSize;
  form.packageUnit = product.packageUnit;
  form.prescriptionRequired = product.prescriptionRequired;
  form.notes = product.notes ?? '';
  form.ingredients = product.ingredients.map((ingredient) => ({
    substanceName: ingredient.substanceName,
    label: ingredient.label ?? '',
    amount: ingredient.amount == null ? '' : String(ingredient.amount),
    unit: ingredient.unit ?? '',
  }));
  if (form.ingredients.length === 0) addIngredient();
}

async function save() {
  saving.value = true;
  error.value = null;
  details.value = null;

  const payload = {
    name: form.name.trim(),
    manufacturer: form.manufacturer.trim() || null,
    category: form.category,
    dosageForm: form.dosageForm,
    packageSize: Number(form.packageSize),
    packageUnit: form.packageUnit,
    prescriptionRequired: form.prescriptionRequired,
    notes: form.notes.trim() || null,
    ingredients: form.ingredients
      .filter((ingredient) => ingredient.substanceName.trim().length > 0)
      .map((ingredient) => ({
        substanceName: ingredient.substanceName.trim(),
        label: ingredient.label.trim() || null,
        amount: ingredient.amount === '' ? null : Number(ingredient.amount),
        unit: ingredient.unit.trim() || null,
      })),
  };

  try {
    const saved = props.id
      ? await api.products.update(props.id, payload)
      : await api.products.create(payload);
    await router.push(`/products/${saved.id}`);
  } catch (cause) {
    if (cause instanceof ApiError) {
      error.value = cause.message;
      details.value = cause.details;
    } else {
      error.value = 'could not save this product';
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
      <h1>{{ isEditing ? 'Edit product' : 'New product' }}</h1>
    </div>

    <p v-if="error" class="banner error">
      {{ error }}
      <span v-if="details" class="small"> — {{ JSON.stringify(details) }}</span>
    </p>

    <form class="stack" @submit.prevent="save">
      <div class="card">
        <div class="card-body stack">
          <label>
            Name
            <input v-model="form.name" required placeholder="Rosuvastatin 5 mg" />
          </label>

          <div class="field-row">
            <label>
              Manufacturer
              <input v-model="form.manufacturer" placeholder="optional" />
            </label>
            <label>
              Category
              <select v-model="form.category">
                <option v-for="value in categories" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
            <label>
              Dosage form
              <select v-model="form.dosageForm">
                <option v-for="value in dosageForms" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
          </div>

          <div class="field-row">
            <label>
              Package size
              <input v-model.number="form.packageSize" type="number" min="0.01" step="any" required />
            </label>
            <label>
              Package unit
              <select v-model="form.packageUnit">
                <option v-for="value in packageUnits" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
            <label style="flex-direction: row; align-items: center; gap: 0.45rem; display: flex; padding-top: 1.2rem">
              <input v-model="form.prescriptionRequired" type="checkbox" />
              Prescription required
            </label>
          </div>

          <label>
            Notes
            <textarea v-model="form.notes" rows="2" placeholder="optional"></textarea>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <div style="display: flex; align-items: baseline">
            <h2>Active ingredients</h2>
            <div class="spacer" style="margin-left: auto"></div>
            <button type="button" class="subtle" @click="addIngredient">Add ingredient</button>
          </div>
          <p class="small muted" style="margin: 0">
            A product can contain several. Names are matched to a shared substance, so a rule
            written once applies to every product containing it.
          </p>

          <fieldset v-for="(ingredient, index) in form.ingredients" :key="index">
            <legend>Ingredient {{ index + 1 }}</legend>
            <div class="field-row">
              <label>
                Substance
                <input v-model="ingredient.substanceName" placeholder="Magnesium" />
              </label>
              <label>
                Amount
                <input v-model="ingredient.amount" type="number" step="any" min="0" placeholder="150" />
              </label>
              <label>
                Unit
                <input v-model="ingredient.unit" placeholder="mg" />
              </label>
              <label>
                As printed on the package
                <input v-model="ingredient.label" placeholder="optional" />
              </label>
            </div>
            <button
              v-if="form.ingredients.length > 1"
              type="button"
              class="subtle"
              style="margin-top: 0.5rem"
              @click="removeIngredient(index)"
            >
              Remove
            </button>
          </fieldset>
        </div>
      </div>

      <div style="display: flex; gap: 0.6rem">
        <button type="submit" class="primary" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save product' }}
        </button>
        <RouterLink to="/products" class="button">Cancel</RouterLink>
      </div>
    </form>
  </section>
</template>
