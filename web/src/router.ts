import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'today', component: () => import('./views/TodayView.vue') },
    { path: '/products', name: 'products', component: () => import('./views/ProductsView.vue') },
    { path: '/products/new', name: 'product-new', component: () => import('./views/ProductEditView.vue') },
    {
      path: '/products/:id',
      name: 'product-detail',
      component: () => import('./views/ProductDetailView.vue'),
      props: true,
    },
    {
      path: '/products/:id/edit',
      name: 'product-edit',
      component: () => import('./views/ProductEditView.vue'),
      props: true,
    },
    {
      path: '/products/:id/treatment',
      name: 'treatment-new',
      component: () => import('./views/TreatmentEditView.vue'),
      props: true,
    },
    { path: '/inventory', name: 'inventory', component: () => import('./views/InventoryView.vue') },
    { path: '/rules', name: 'rules', component: () => import('./views/ConstraintsView.vue') },
    { path: '/history', name: 'history', component: () => import('./views/HistoryView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
  ],
});
