# PillStack — Architecture and Domain Model

Local-first medication and supplement manager. Single user, single machine,
SQLite as the only persistent store, fully usable offline.

This document is the design proposal. The schema it describes lives in
[schema.sql](schema.sql).

---

## 1. Shape of the system

```
┌──────────────────────────────────────────────────────────────┐
│  web/            Vue 3 + Vite SPA                            │
│                  dashboard · daily timeline · products ·     │
│                  inventory · history · settings              │
└────────────────────────────┬─────────────────────────────────┘
                             │  HTTP/JSON, 127.0.0.1 only
┌────────────────────────────▼─────────────────────────────────┐
│  app/  (Node + TypeScript)                                   │
│                                                              │
│   api/            Fastify routes, zod validation, DTO mapping│
│   application/    use-case services, transactions            │
│   notifications/  delivery adapters (browser → native later) │
│   domain/         pure TypeScript, no I/O, no SQL            │
│   persistence/    Kysely, migrations, repositories           │
└────────────────────────────┬─────────────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  pillstack.sqlite│  + backups/*.zip
                    └──────────────────┘
```

Three workspaces, not six. `contracts/` holds the zod schemas and TypeScript
types shared by the API and the SPA, so the frontend is type-safe without a
codegen step.

```
pillstack/
  app/          backend, all layers, boundaries enforced by lint rule
  web/          Vue 3 SPA
  contracts/    zod schemas + inferred types, imported by both
  docs/
```

### Dependency rule

```
api → application → domain
       application → persistence → domain
       notifications → domain
domain → (nothing)
```

`domain/` imports nothing but itself. Every calculation the tests care about —
recurrence expansion, depletion projection, reorder dates, constraint evaluation
— is a pure function over plain objects. Persistence hands it rows, it hands
back answers. That is what makes the domain testable without a database and
what makes desktop packaging a matter of swapping the shell, not rewriting logic.

Enforced with `eslint-plugin-import` `no-restricted-paths`, so a stray import
fails CI rather than being noticed in review a month later.

### Domain modules

`products` · `ingredients` · `substances` · `treatments` · `schedules` ·
`constraints` · `inventory` · `intake-log` · `reminders` · `exports` · `backup`

No `utils/`, no `shared/`. Cross-cutting helpers live with the concept they
serve — date arithmetic in `schedules/calendar.ts`, unit handling in
`inventory/units.ts`.

---

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22+, TypeScript strict | as specified |
| Database | SQLite via **better-sqlite3** | synchronous API keeps services simple, mature, and it exposes the online `.backup()` API we need |
| Query layer | **Kysely** + `kysely-codegen` | typed SQL without an ORM; migrations via Kysely's own `Migrator` |
| HTTP | **Fastify** bound to `127.0.0.1` | small, fast, good schema story |
| Validation | **zod** | one definition serves API validation, JSON-export schemas and backup manifests |
| PDF | **pdfmake** | declarative tables, pure JS, no headless Chromium download — important for an offline app |
| Frontend | Vue 3 + Vite + vue-router | No store library in Milestone 1: the views fetch what they need and hold it locally, which is less machinery than a global store would be for this amount of state |
| Tests | **Vitest** for domain/services, **Playwright** for critical UI flows | |
| IDs | UUIDv7 (TEXT) | time-sortable, stable across export/import/merge |

`node:sqlite` (built into Node) would remove the native dependency, but
better-sqlite3 has the mature Kysely dialect and a proven backup API today.
Worth revisiting when desktop packaging starts, since native rebuilds for
Electron are the one friction point.

### Time handling

All scheduling is wall-clock local time. Instants are stored as ISO-8601 UTC;
clinical dates (`started_on`, `effective_from`, `occurred_on`) are stored as
plain `YYYY-MM-DD` and never converted through UTC — a dose started on
3 September stays 3 September regardless of where the laptop is. The IANA
timezone lives in `app_setting`.

---

## 3. The two designs that matter most

The brief singles out treatment history and inventory as the places where a
naive model loses data. Both are solved the same way: **an immutable record of
what happened, with the current state derived from it.**

### 3.1 Treatment history — versioned plans, not mutated ones

The obvious model is one `intake_plan` row per product that gets `UPDATE`d when
the dose changes. That model cannot answer "what was I taking in March", and it
silently destroys the exact information a physician asks for.

Instead, three concepts:

```
treatment              the therapy. Stable identity, never rewritten.
  └─ intake_plan       versioned. One row per version, only the newest is open.
       └─ intake_plan_dose   the individual doses within the pattern
  └─ treatment_event   append-only narrative
  └─ treatment_pause   queryable pause intervals
```

A dose change is: close the current plan (`effective_to = yesterday`), insert
version N+1 with `supersedes_plan_id` pointing back, write a `dose_changed`
event referencing both. A partial unique index guarantees exactly one open
version per treatment; a `BEFORE UPDATE` trigger makes closed versions
physically immutable.

```
Rosuvastatin — treatment #1, started 2026-09-03, indication "LDL reduction"

  plan v1   2026-09-03 → 2026-11-30    5 mg  daily 21:30
  plan v2   2026-12-01 → (open)       10 mg  daily 21:30

  event  2026-09-03  started          → v1   "Started 5 mg daily at 21:30"
  event  2026-12-01  dose_changed  v1 → v2   "Dose increased 5 mg → 10 mg"
```

"What was the schedule on 15 October?" is
`WHERE effective_from <= date AND (effective_to IS NULL OR effective_to >= date)`.
The treatment history PDF is a straight read of `treatment_event`.

Each event carries a `summary` string rendered and frozen at write time. If the
rendering code changes in two years, historical lines still say what they said
when the change was made.

**Editing today's timeline is deliberately not a plan change.** Dragging iron
from 18:30 to 12:00 for one day writes a `schedule_override` row keyed by
`(dose, date)`. Making it permanent creates a new plan version. Keeping these
separate is what stops the timeline UI from shredding the history.

### 3.2 Inventory — a ledger plus a projection

`inventory_transaction` is append-only; there is no mutable quantity column.
`package_added` and `manual_correction` rows are **anchors**. A manual
correction stores both the counted `absolute_quantity` and the derived
`quantity_delta`, so "I recounted and there were 42" stays legible.

The requirement that inventory must work even when the user never confirms a
dose is handled without a background job:

```
quantityAt(product, date)
  = ledgerSum(transactions up to the most recent anchor)
  − Σ  consumptionOn(product, d)   for each day d from the anchor to `date`

consumptionOn(product, day)
  for each plan dose active on `day`:
    if an intake_log_entry exists for (dose, day)  → use it (taken / skipped)
    else if the treatment is paused on `day`       → 0
    else                                           → the planned amount
```

Confirmed intakes take precedence, unconfirmed days fall back to the plan, and
paused days count as zero. The whole thing is a pure function that is fully
re-derivable from the ledger — no drift, no reconciliation job, and trivially
testable. Logging every dose remains genuinely optional.

Products whose consumption is unpredictable (as-needed painkillers) set
`inventory_policy.consumption_source = 'logged'`, and then only confirmed
intakes count.

Projection forward uses the same function over future dates, respecting plan
end dates and open pauses:

```
runOutDate    = first future day where cumulative projected consumption
                exceeds current quantity
reorderDate   = runOutDate − reorder_lead_time_days
                (or the day stock crosses reorder_threshold_quantity /
                 reorder_threshold_days, whichever comes first)
```

Because consumption is projected from the plan rather than averaged from the
past, a dose change tomorrow immediately moves the run-out date. An averaging
model would take weeks to notice.

`inventory_package` tracks each physical box separately, so different expiry
dates on two packages of the same product are representable and the dashboard
can warn "the open package expires before you finish it."

### 3.3 Why `substance` exists

The brief asks for "minimum time distance to a specific active ingredient".
That only works if ingredients have identity beyond a single product. So
`active_ingredient` links a product to a canonical `substance`, and constraints
reference `substance_id`.

One rule — "iron and calcium, 2 hours apart" — then applies across every product
containing either, including products added next year. It is also the exact join
point a curated interaction catalogue would attach to later
(`intake_constraint.origin = 'catalog'`), with no schema change and without
touching user-authored rules.

---

## 4. Schedules

`intake_plan` carries the recurrence; `intake_plan_dose` carries each dose
occurrence within it.

| Requirement | Representation |
|---|---|
| daily | `recurrence_type = 'daily'` |
| selected weekdays | `'weekdays'` + `weekday_mask` bitfield |
| every N days | `'every_n_days'` + `interval_days` + `anchor_date` |
| multiple times per day | multiple `intake_plan_dose` rows |
| specific time | `timing_type = 'fixed'`, `target_time` |
| flexible window | `timing_type = 'window'`, start/end |
| meal-relative | `timing_type = 'meal_relative'` + `meal_reference` + `meal_offset_minutes` |
| as-needed | `recurrence_type = 'as_needed'`, `max_doses_per_day` |

Dose amount lives on `intake_plan_dose`, not on the plan, deviating slightly
from the brief's field list. Real plans are asymmetric — 2 tablets in the
morning, 1 in the evening — and a single plan-level dose cannot express that.
A one-dose-a-day plan simply has one dose row.

Each dose row carries two amounts: `dose_amount` + `dose_unit` is the clinical
dose shown to the user and printed on the physician plan ("5 mg"), while
`package_unit_quantity` is what it consumes from stock ("1 tablet"). Keeping
both explicit avoids hidden mg→tablet conversion, which is exactly the kind of
implicit arithmetic you do not want in a medication app. The UI proposes the
conversion from the ingredient strength; the user confirms it.

Meal-relative doses resolve against `day_profile` (wake, meals, bedtime), which
is therefore needed in Milestone 1, not later.

### Timeline generation

```ts
expandSchedule(plans, dayProfile, overrides, dateRange): ScheduledIntake[]
```

Pure, deterministic, no I/O. Each occurrence has a stable key
`(intakePlanDoseId, occurrenceDate)` — the same key used by `schedule_override`,
`intake_log_entry` and `notification.dedupe_key`, so nothing double-fires.

### Constraint evaluation

```ts
evaluateConstraints(occurrences, constraints, dayProfile): ConstraintViolation[]
```

Also pure. Runs on every timeline render and again on drag preview. Violations
carry severity and explanation; nothing is ever blocked. `warning` is advisory
and the user can override, which is recorded in
`schedule_override.acknowledged_constraints` so the same acknowledged warning
does not nag again.

### Room for the optimizer

The optimizer is not built in Milestone 1, but the model already carries every
input it needs: `day_profile` anchors, `intake_plan_dose.flexibility`
(`fixed` vs `flexible`), window bounds, meal references, and the constraint set.
It will be a pure function
`optimizeDay(occurrences, constraints, dayProfile) → proposal`, and its output
is a set of `schedule_override` rows the user reviews and accepts — never a
silent rewrite of plans.

---

## 5. Notifications

The domain produces `notification` rows in an outbox with a `dedupe_key`
(`intake:<doseId>:2026-09-03`), unique-indexed so regeneration is idempotent.
A `NotificationDeliveryPort` interface drains them.

```
domain (decides what and when)  →  notification table  →  DeliveryPort
                                                            ├─ BrowserDelivery (v1)
                                                            └─ NativeDelivery  (Electron, later)
```

Adding native notifications is one adapter, no domain change.

---

## 6. Exports

**Physician plan** (pdfmake, 1–2 pages): header with generation date, optional
patient name and date of birth; then a MEDICATIONS table and a SUPPLEMENTS
table — product / active ingredient, dose, schedule, since, indication. Plain
type, no colour blocks, no logos. Optional free-text note field for the
physician.

**Treatment history**: per treatment, the full `treatment_event` chain — start,
each dose change with old and new values, pauses with dates and reasons, stop
date and reason. Grouped by product, ordered chronologically.

**JSON export** (separate from backup — a migration format, not a restore
format):

```json
{
  "format": "pillstack/export",
  "version": 1,
  "exportedAt": "2026-09-03T10:00:00.000Z",
  "products": [], "substances": [], "treatments": [],
  "intakePlans": [], "constraints": [],
  "inventoryTransactions": [], "intakeLog": [], "treatmentEvents": []
}
```

Nested, human-readable, versioned. The zod schema for version 1 is frozen; a
future version 2 gets its own schema plus an upgrade function, so old export
files stay importable.

---

## 7. Backup and restore

Backup produces `pillstack-backup-<timestamp>.zip`:

```
database.sqlite      via better-sqlite3 .backup() — consistent, no downtime
manifest.json        appVersion, schemaVersion, createdAt, sha256, row counts
settings.json        exported app_setting rows, readable without SQLite
```

Restore never silently overwrites:

1. Read and validate `manifest.json` against its zod schema.
2. Verify the sha256 of `database.sqlite`.
3. Run `PRAGMA integrity_check` and `foreign_key_check` on the candidate.
4. Reject if its `schemaVersion` is newer than this build understands.
5. Show creation date, app version and row counts, and require confirmation.
6. Write a `pre_restore_safety` backup of the current database.
7. Swap the file, then run pending migrations forward.

Backup history is kept both in `backup_record` and in
`<backupDirectory>/index.json`, because restoring an older database would
otherwise erase the app's knowledge of backups taken after it was written.

---

## 8. Search

Product names, active ingredients (via `substance.name` and `synonyms`) and
manufacturers. At single-user scale — tens to low hundreds of products — a
`LIKE` query against the `normalized_name` columns returns instantly, so v1
does that and skips FTS5. `normalized_name` (lowercased, accent-folded) is
stored rather than computed so the query stays index-friendly, and it is the
natural upgrade path to an FTS5 virtual table if search ever becomes slow.

---

## 9. Security and data ownership

- Fastify binds `127.0.0.1` explicitly; LAN exposure requires an explicit
  config flag and a warning.
- No registration, telemetry, analytics, cloud sync, or outbound network calls
  of any kind. No third-party fonts or CDNs in the SPA — everything is bundled.
- Strict CSP with no external origins.
- Database and backups live in a single user-chosen data directory.

---

## 10. Test plan

Domain tests (Vitest, no database):

- **Recurrence** — daily, weekday masks, every-N-days across month and DST
  boundaries, plan version handover on the exact switch date.
- **Depletion** — with and without intake log entries, across a dose change,
  across a pause, after a manual correction, with multiple packages.
- **Reorder date** — lead-time and threshold triggers, whichever fires first.
- **Constraints** — every constraint type, substance-level rules matching
  across different products, category rules, acknowledged overrides.
- **Treatment history** — a dose change preserves the previous plan and its
  doses; superseded rows reject updates; point-in-time queries return the plan
  in force on that date.

Integration tests (real SQLite, temp file):

- **Migrations** — up from empty, and forward from a seeded fixture database at
  each historical version.
- **Backup/restore** — round-trip equality, corrupted archive rejected,
  future schema version rejected, safety backup created before restore.
- **JSON export** — round-trip through import produces an identical graph.

UI tests (Playwright): add product with two ingredients → create plan → see it
on today's timeline → drag it into a constraint violation → override → confirm
an intake → watch stock drop.

---

## 11. Milestones

| # | Scope |
|---|---|
| 1 ✅ | Workspaces, SQLite, Kysely migrations, products, substances, ingredients, treatments, versioned intake plans, day profile, daily timeline |
| 2 | Inventory ledger, packages, depletion and reorder projection, treatment history views and events |
| 3 | Constraints, drag-with-warning on the timeline, reminder rules and notification outbox, browser delivery |
| 4 | Physician PDF, treatment history PDF, JSON export/import, backup and restore |
| 5 | UX polish, schedule optimizer, optional Electron packaging |

---

## 12. Deviations from the brief, and why

1. **Dose moved from `intake_plan` to `intake_plan_dose`.** A single plan-level
   dose cannot express "2 in the morning, 1 in the evening", which is common.
2. **`treatment` split out from `intake_plan`.** The brief describes one entity;
   preserving history requires a stable identity separate from the versioned
   schedule. Indication and prescriber live on `treatment` so they are not
   duplicated across every version.
3. **`substance` introduced.** Constraints on active ingredients need canonical
   identity across products. This is also the attachment point for a future
   curated interaction catalogue.
4. **`inventory_package` per physical box.** The brief models inventory as one
   row per product; multiple packages with different expiry dates are the normal
   case, and per-package tracking answers the expiry question the single-row
   model cannot.
5. **`day_profile` pulled into Milestone 1.** Meal-relative doses cannot be
   placed on a timeline without meal times.
