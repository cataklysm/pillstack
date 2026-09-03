<script setup lang="ts">
import type { DayProfile } from '@pillstack/contracts';
import { onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';

const saved = ref(false);
const error = ref<string | null>(null);
const timeZone = ref('');

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
