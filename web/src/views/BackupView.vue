<script setup lang="ts">
import type { BackupInspection, BackupRecord, BackupSettings } from '@pillstack/contracts';
import { onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

const settings = ref<BackupSettings | null>(null);
const backups = ref<BackupRecord[]>([]);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const busy = ref(false);

const directoryDraft = ref('');
const note = ref('');

/** The archive the user is considering restoring, with what it holds. */
const pending = ref<BackupInspection | null>(null);

async function load() {
  error.value = null;
  try {
    settings.value = await api.backup.settings();
    directoryDraft.value = settings.value.directory;
    backups.value = await api.backup.list();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not load backups';
  }
}

async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = null;
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'that did not work';
  } finally {
    busy.value = false;
  }
}

function createBackup() {
  void run(async () => {
    const record = await api.backup.create(note.value.trim() || undefined);
    note.value = '';
    message.value = `Backup written to ${record.fileName}.`;
    await load();
  });
}

function saveDirectory() {
  void run(async () => {
    settings.value = await api.backup.setDirectory(directoryDraft.value.trim());
    message.value = 'Backup folder updated.';
    await load();
  });
}

/** Inspect first, always. A restore is never one click away. */
function inspect(record: BackupRecord) {
  void run(async () => {
    pending.value = await api.backup.inspect(record.filePath);
    message.value = null;
  });
}

function confirmRestore() {
  const target = pending.value;
  if (!target) return;

  void run(async () => {
    const result = await api.backup.restore(target.filePath);
    pending.value = null;
    message.value = `Restored from ${target.fileName}. Your previous database was saved first, as ${result.safetyBackupPath.split(/[\\/]/).pop()}.`;
    await load();
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatInstant(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

const triggerLabels: Record<string, string> = {
  manual: 'manual',
  automatic: 'automatic',
  pre_restore_safety: 'safety copy',
};

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header">
      <h1>Backup</h1>
      <span v-if="settings" class="muted small">
        Last backup: {{ formatInstant(settings.lastBackupAt) }}
      </span>
    </div>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="message" class="banner">{{ message }}</p>

    <!--
      Restoring is destructive, so it happens in two steps: the archive is read
      and reported on, and only then can it replace the live database.
    -->
    <div v-if="pending" class="card warning-card" style="margin-bottom: 1.25rem">
      <div class="card-body">
        <h2>Restore from {{ pending.fileName }}?</h2>

        <div v-if="!pending.valid">
          <p class="small" style="margin: 0.4rem 0">This backup cannot be restored:</p>
          <ul style="margin: 0; padding-left: 1.1rem">
            <li v-for="problem in pending.problems" :key="problem" class="small">{{ problem }}</li>
          </ul>
        </div>

        <template v-else>
          <p class="small muted" style="margin: 0.3rem 0 0.8rem">
            Written {{ formatInstant(pending.manifest?.createdAt ?? null) }} by PillStack
            {{ pending.manifest?.appVersion }}. Your current database is backed up automatically
            before anything is replaced.
          </p>

          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Contents</th>
                  <th>In this backup</th>
                  <th>In use now</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(count, table) in pending.manifest?.rowCounts ?? {}" :key="table">
                  <td>{{ String(table).replace(/_/g, ' ') }}</td>
                  <td>{{ count }}</td>
                  <td :class="{ muted: pending.currentRowCounts[table] === count }">
                    {{ pending.currentRowCounts[table] ?? 0 }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div style="display: flex; gap: 0.6rem; margin-top: 1rem">
          <button v-if="pending.valid" class="primary" :disabled="busy" @click="confirmRestore">
            Replace my data with this backup
          </button>
          <button @click="pending = null">Cancel</button>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-body stack">
          <h2>Create a backup</h2>
          <p class="small muted" style="margin: 0">
            A single ZIP holding the database, a manifest and your settings. It is a consistent
            snapshot taken through SQLite's own backup API, so it is safe to take at any moment.
          </p>
          <div style="display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap">
            <label style="flex: 1; min-width: 220px">
              Note (optional)
              <input v-model="note" placeholder="before changing my statin dose" />
            </label>
            <button class="primary" :disabled="busy" @click="createBackup">Back up now</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <h2>Where backups are kept</h2>
          <div style="display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap">
            <label style="flex: 1; min-width: 260px">
              Folder on this computer
              <input v-model="directoryDraft" spellcheck="false" />
            </label>
            <button :disabled="busy" @click="saveDirectory">Save</button>
          </div>
          <p class="small muted" style="margin: 0">
            Point this at a synced or external drive if you want a copy off this machine. PillStack
            never uploads anything itself.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2>Backups</h2>
        </div>

        <div v-if="backups.length === 0" class="card-body" style="padding-top: 0">
          <p class="muted" style="margin: 0">No backups yet.</p>
        </div>

        <div v-else class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>File</th>
                <th>Size</th>
                <th>Kind</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in backups" :key="record.id">
                <td class="small">{{ formatInstant(record.createdAt) }}</td>
                <td class="small muted" style="overflow-wrap: anywhere">{{ record.fileName }}</td>
                <td class="small">{{ formatBytes(record.fileSizeBytes) }}</td>
                <td class="small">
                  <span class="tag neutral">{{ triggerLabels[record.trigger] ?? record.trigger }}</span>
                </td>
                <td class="small muted">{{ record.note ?? '—' }}</td>
                <td>
                  <div class="intake-actions">
                    <a class="button subtle" :href="api.backup.downloadUrl(record.filePath)" download>
                      Download
                    </a>
                    <button class="subtle" :disabled="busy" @click="inspect(record)">Restore…</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
