<script setup lang="ts">
import type { SearchHit } from '@pillstack/contracts';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

/**
 * Search across product names, manufacturers and active ingredients from
 * anywhere in the app. Opens with "/" and is driven entirely by the keyboard,
 * which is what makes it faster than navigating to the products page.
 */
const router = useRouter();

const open = ref(false);
const query = ref('');
const hits = ref<SearchHit[]>([]);
const highlighted = ref(0);
const input = ref<HTMLInputElement | null>(null);

let debounce: ReturnType<typeof setTimeout> | undefined;

watch(query, () => {
  clearTimeout(debounce);
  const term = query.value.trim();

  if (term.length === 0) {
    hits.value = [];
    return;
  }

  debounce = setTimeout(async () => {
    try {
      hits.value = (await api.search(term)).hits;
      highlighted.value = 0;
    } catch {
      hits.value = [];
    }
  }, 120);
});

function show() {
  open.value = true;
  void nextTick(() => input.value?.focus());
}

/** Delayed so a click on a result lands before the list disappears. */
function hideSoon() {
  setTimeout(hide, 150);
}

function hide() {
  open.value = false;
  query.value = '';
  hits.value = [];
}

function go(hit: SearchHit) {
  // A substance has no page of its own; searching for it again from the
  // products list is the useful landing place.
  if (hit.kind === 'product' && hit.productId) {
    void router.push(`/products/${hit.productId}`);
  } else {
    void router.push({ path: '/products', query: { q: hit.name } });
  }
  hide();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlighted.value = Math.min(highlighted.value + 1, hits.value.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted.value = Math.max(highlighted.value - 1, 0);
  } else if (event.key === 'Enter') {
    const hit = hits.value[highlighted.value];
    if (hit) go(hit);
  } else if (event.key === 'Escape') {
    hide();
  }
}

/** "/" opens search, unless the user is already typing in a field. */
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || open.value) return;

  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

  event.preventDefault();
  show();
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  clearTimeout(debounce);
});
</script>

<template>
  <div class="global-search">
    <button v-if="!open" class="subtle" @click="show">
      Search <kbd>/</kbd>
    </button>

    <div v-else class="global-search-field">
      <input
        ref="input"
        v-model="query"
        type="search"
        placeholder="product, manufacturer or ingredient…"
        aria-label="Search"
        @keydown="onKeydown"
        @blur="hideSoon"
      />

      <ul v-if="hits.length" class="global-search-results card">
        <li
          v-for="(hit, index) in hits"
          :key="`${hit.kind}:${hit.id}`"
          :class="{ highlighted: index === highlighted }"
          @mousedown.prevent="go(hit)"
          @mouseenter="highlighted = index"
        >
          <span>{{ hit.name }}</span>
          <span class="small muted">{{ hit.matchedOn }}</span>
        </li>
      </ul>

      <div v-else-if="query.trim()" class="global-search-results card">
        <div class="card-body small muted">Nothing matched.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.global-search {
  position: relative;
}

.global-search-field {
  position: relative;
  width: min(320px, 60vw);
}

kbd {
  padding: 0 0.3rem;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font-size: 0.75rem;
  font-family: inherit;
}

.global-search-results {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  right: 0;
  z-index: 30;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 60vh;
  overflow-y: auto;
}

.global-search-results li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
}

.global-search-results li.highlighted {
  background: var(--accent-soft);
}
</style>
