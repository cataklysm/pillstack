<script setup lang="ts">
import type { DayProfile, ReminderRule, ReminderType } from '@pillstack/contracts';
import { onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';

const saved = ref(false);
const error = ref<string | null>(null);
const timeZone = ref('');

const reminderRules = ref<ReminderRule[]>([]);
const showReminderForm = ref(false);
const reminderForm = reactive({
  reminderType: 'intake' as ReminderType,
  leadTimeMinutes: 15,
  leadTimeDays: 14,
  quietHoursFrom: '',
  quietHoursTo: '',
});

const profile = reactive({
  wakeUpTime: '07:00',
  breakfastTime: '08:00',
  lunchTime: '12:30',
  dinnerTime: '18:30',
  bedTime: '23:00',
});

function apply(loaded: DayProfile) {
  profile.wakeUpTime = loaded.wakeUpTime;
  profile.breakfastTime = loaded.breakfastTime ?? '';
  profile.lunchTime = loaded.lunchTime ?? '';
  profile.dinnerTime = loaded.dinnerTime ?? '';
  profile.bedTime = loaded.bedTime;
}

async function load() {
  apply(await api.settings.dayProfile());
  timeZone.value = (await api.settings.timeZone()).timeZone;
  reminderRules.value = await api.reminders.rules();
}

async function saveReminder() {
  error.value = null;
  try {
    await api.reminders.createRule({
      reminderType: reminderForm.reminderType,
      leadTimeMinutes:
        reminderForm.reminderType === 'intake' ? Number(reminderForm.leadTimeMinutes) : null,
      leadTimeDays:
        reminderForm.reminderType === 'intake' ? null : Number(reminderForm.leadTimeDays),
      quietHoursFrom: reminderForm.quietHoursFrom || null,
      quietHoursTo: reminderForm.quietHoursTo || null,
    });
    showReminderForm.value = false;
    reminderRules.value = await api.reminders.rules();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not add that reminder';
  }
}

async function deleteReminder(id: string) {
  await api.reminders.deleteRule(id);
  reminderRules.value = await api.reminders.rules();
}

async function save() {
  saved.value = false;
  error.value = null;
  try {
    apply(
      await api.settings.updateDayProfile({
        wakeUpTime: profile.wakeUpTime,
        bedTime: profile.bedTime,
        breakfastTime: profile.breakfastTime || null,
        lunchTime: profile.lunchTime || null,
        dinnerTime: profile.dinnerTime || null,
      }),
    );
    saved.value = true;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'could not save';
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="page-header"><h1>Settings</h1></div>

    <p v-if="error" class="banner error">{{ error }}</p>
    <p v-if="saved" class="banner">Saved.</p>

    <div class="stack">
      <div class="card">
        <div class="card-body stack">
          <h2>Daily rhythm</h2>
          <!--
            Meal-relative doses ("with dinner") are placed on the timeline from
            these times. A dose whose meal is left blank is not shown at all,
            rather than being given an invented time.
          -->
          <p class="small muted" style="margin: 0">
            Doses scheduled around meals are placed on the timeline using these times. Leave a meal
            blank if you do not want it used as an anchor.
          </p>

          <div class="field-row">
            <label>
              Wake up
              <input v-model="profile.wakeUpTime" type="time" />
            </label>
            <label>
              Breakfast
              <input v-model="profile.breakfastTime" type="time" />
            </label>
            <label>
              Lunch
              <input v-model="profile.lunchTime" type="time" />
            </label>
            <label>
              Dinner
              <input v-model="profile.dinnerTime" type="time" />
            </label>
            <label>
              Bedtime
              <input v-model="profile.bedTime" type="time" />
            </label>
          </div>

          <div><button class="primary" @click="save">Save</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-body stack">
          <div style="display: flex; align-items: baseline">
            <h2>Reminders</h2>
            <div class="spacer" style="margin-left: auto"></div>
            <button class="subtle" @click="showReminderForm = !showReminderForm">
              {{ showReminderForm ? 'Close' : 'Add a reminder' }}
            </button>
          </div>
          <!--
            Reminders are generated on demand and wait in an outbox, so nothing
            is missed while PillStack is closed and no background process runs.
          -->
          <p class="small muted" style="margin: 0">
            Reminders appear in the app whenever it is open, and as desktop notifications if you
            allow them. Nothing is sent anywhere.
          </p>

          <fieldset v-if="showReminderForm">
            <legend>New reminder</legend>
            <div class="field-row">
              <label>
                For
                <select v-model="reminderForm.reminderType">
                  <option value="intake">intakes</option>
                  <option value="reorder">reordering</option>
                  <option value="prescription">prescriptions</option>
                </select>
              </label>
              <label v-if="reminderForm.reminderType === 'intake'">
                Minutes before the dose
                <input v-model.number="reminderForm.leadTimeMinutes" type="number" min="0" />
              </label>
              <label v-else>
                Days before the reorder date
                <input v-model.number="reminderForm.leadTimeDays" type="number" min="0" />
              </label>
              <label>
                Quiet from
                <input v-model="reminderForm.quietHoursFrom" type="time" />
              </label>
              <label>
                Quiet until
                <input v-model="reminderForm.quietHoursTo" type="time" />
              </label>
            </div>
            <button class="primary" style="margin-top: 0.6rem" @click="saveReminder">Add</button>
          </fieldset>

          <div v-if="reminderRules.length === 0" class="muted small">
            No reminders set. Without one, PillStack stays silent.
          </div>
          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reminder</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="rule in reminderRules" :key="rule.id">
                  <td>{{ rule.summary }}</td>
                  <td>
                    <button class="subtle" @click="deleteReminder(rule.id)">Delete</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2>Timezone</h2>
          <p class="small muted">
            All schedules are wall-clock times in <strong>{{ timeZone }}</strong
            >. It is stored with your data, so moving the database to another machine does not
            reinterpret existing schedules.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2>Your data</h2>
          <p class="small muted" style="margin-bottom: 0">
            Everything lives in a single SQLite file on this machine. No account, no telemetry, no
            analytics, and no data leaves this computer. Backup, restore and the physician PDF
            export arrive in Milestone 4.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
