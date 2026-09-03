<script setup lang="ts">
import type { Product } from '@pillstack/contracts';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

const route = useRoute();

const products = ref<Product[]>([]);
const query = ref('');
const showArchived = ref(false);
const loading = ref(true);

const medications = computed(() => products.value.filter((p) => p.category === 'medication'));
const supplements = computed(() => products.value.filter((p) => p.category === 'supplement'));

async function load() {
  loading.value = true;
  try {
    products.value = await api.products.list({
      ...(query.value ? { query: query.value } : {}),
      ...(showArchived.value ? {} : { active: true }),
    });
  } finally {
    loading.value = false;
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch([query, showArchived], () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(), 150);
});

function ingredientLine(product: Product): string {
  if (product.ingredients.length === 0) return '—';
  return product.ingredients
    .map((ingredient) =>
      ingredient.amount
        ? `${ingredient.substanceName} ${ingredient.amount} ${ingredient.unit ?? ''}`.trim()
        : ingredient.substanceName,
    )
    .join(', ');
}

onMounted(() => {
  // Arriving from global search: pre-fill the filter with what was searched for.
  const initial = route.query.q;
  if (typeof initial === 'string') query.value = initial;
  void load();
});
</script>

<template>
  <section>
    <div class="page-header">
      <h1>Products</h1>
      <div class="spacer"></div>
      <RouterLink to="/products/new" class="button primary">Add product</RouterLink>
    </div>

    <div class="card" style="margin-bottom: 1.25rem">
      <div class="card-body" style="display: flex; gap: 1rem; align-items: end; flex-wrap: wrap">
        <label style="flex: 1; min-width: 220px">
          Search name, manufacturer or active ingredient
          <input v-model="query" type="search" placeholder="magnesium, Acme, rosuva…" />
        </label>
        <label style="flex-direction: row; align-items: center; gap: 0.45rem; display: flex">
          <input v-model="showArchived" type="checkbox" />
          Include archived
        </label>
      </div>
    </div>

    <p v-if="loading" class="muted">Loading…</p>

    <div v-else-if="products.length === 0" class="card">
      <p class="empty-state">
        {{ query ? 'Nothing matched that search.' : 'No products yet.' }}
      </p>
    </div>

    <div v-else class="stack">
      <template v-for="group in [
        { title: 'Medications', items: medications },
        { title: 'Supplements', items: supplements },
      ]">
        <div v-if="group.items.length" :key="group.title" class="card">
          <div class="card-body">
            <h2>{{ group.title }}</h2>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Active ingredients</th>
                  <th>Package</th>
                  <th>Manufacturer</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="product in group.items" :key="product.id">
                  <td>
                    <RouterLink :to="`/products/${product.id}`">{{ product.name }}</RouterLink>
                    <span v-if="product.prescriptionRequired" class="tag neutral" style="margin-left: 0.4rem">
                      Rx
                    </span>
                    <span v-if="!product.active" class="tag neutral" style="margin-left: 0.4rem">
                      archived
                    </span>
                  </td>
                  <td class="muted small">{{ ingredientLine(product) }}</td>
                  <td class="muted small">{{ product.packageSize }} {{ product.packageUnit }}</td>
                  <td class="muted small">{{ product.manufacturer ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
