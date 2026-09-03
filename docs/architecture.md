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

A correction's delta is deliberately **not** the difference from the projected
figure. It is `counted − (cumulative ledger sum through that day)`, so that
after applying it the ledger sum *equals* what the user counted. That is the
invariant that lets inference restart cleanly the next day and never re-derive
the days before — otherwise a correction's meaning would drift the moment an
older plan version was touched. `correctionDelta()` in
`domain/inventory/projection.ts` is the only place that computes it.

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
| 2 ✅ | Inventory ledger, packages, depletion and reorder projection, intake log, treatment history views |
| 3 ✅ | Constraints, move-with-warning on the timeline, reminder rules and notification outbox, browser delivery |
| 4 ✅ | Physician PDF, treatment history PDF, JSON export/import, backup and restore |
| 5 ◐ | UX polish and schedule optimizer done; Electron packaging documented but not built |

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

---

## 13. Constraints and reminders (Milestone 3)

### Constraint evaluation

`domain/constraints/evaluation.ts` is a pure function over a day's arrangement,
the user's rules and the meal times. It contains **no medical knowledge at all**:
every rule it evaluates was entered by the user. `intake_constraint.origin`
already distinguishes `user` from `catalog`, so a curated interaction set can be
layered in later without touching what the user wrote, and rules that reference a
*substance* apply to every product containing it — including products added
afterwards.

Three behaviours worth stating explicitly:

- **Nothing is ever blocked.** A violation is advisory. The user may keep any
  schedule and acknowledge the warning, which is recorded in
  `schedule_override.acknowledged_constraints` so it stops being raised for that
  occurrence.
- **A move is previewed before it is saved.** `previewMove` evaluates the day
  with the occurrence relocated and compares the result against the violations
  already present, so the user is only asked about clashes their edit actually
  *introduces* — not about something that was already broken.
- **A missing meal time silences a food rule** rather than firing against a time
  we do not have.

### Reminders

`domain/reminders/generation.ts` decides what to announce and when; it knows
nothing about how a notification reaches a human.

```
domain/reminders     →  notification outbox  →  NotificationDeliveryPort
 (what, and when)        (dedupe_key unique)      ├─ OutboxDeliveryPort (default)
                                                  └─ native port (desktop, later)
```

Generation is **idempotent**: every notification carries a `dedupe_key` that is
unique-indexed, so it simply runs on each client poll. There is no cron job, no
background worker, and nothing is lost when the app has been closed for a week.
Notifications for occurrences that no longer stand — a dose taken, skipped or
moved — are discarded rather than left to fire wrongly.

Two rules the smoke test forced into the open:

- A reminder whose moment has just passed is exactly the one worth showing, so
  intake reminders survive for `MISSED_DOSE_GRACE_MINUTES` past their time
  instead of vanishing. Beyond that they are dropped, so a user who never
  confirms doses does not accumulate a pile of stale reminders.
- A product whose stock was never recorded produces no reorder reminder at all.
  Without a package or a count there is nothing to run out of, and reporting
  "runs out tomorrow" for every untracked product is pure noise.

---

## 14. Exports and backup (Milestone 4)

### PDFs without a font problem, and with one

pdfmake draws both documents using the 14 standard PDF fonts, so no font file is
bundled and no headless browser is downloaded — a physician plan is a 3 KB file
produced entirely offline.

The cost is that those fonts cover Latin-1 only, and the failure is silent
rather than loud: an arrow prints as `!`, while en dashes, ellipses and curly
quotes disappear without trace. Event summaries are frozen in the database at
write time and render correctly in the web UI, so the substitution belongs at
the moment of drawing, not in what is stored. `toPdfSafeText()` maps the
offenders to ASCII equivalents and marks anything else with `?` rather than
letting it vanish; `sanitizeDocument()` applies it to every string in a
document definition, wrapping callbacks so header and footer text is covered too.

### What goes on the page is separate from how it is drawn

`domain/exports/` builds the medication plan and the history report as plain
data; `exports/*Document.ts` turns that into pdfmake definitions. The content
is therefore assertable in a test without generating a PDF, and the same
structure feeds the on-screen preview.

The medication plan reads the plan version *in force on the report date*, so
asking for an earlier date prints what was actually being taken then rather than
today's dose.

### JSON export is not a backup

`pillstack/export` v1 is a nested, readable, versioned snapshot for moving the
data to another application. Import deliberately refuses a database that already
holds products: merging two medication histories needs conflict rules nobody has
specified, and guessing at them is how this kind of data gets corrupted.
Restoring into an existing install is what backups are for.

### Restore, and the two things that make it safe

A backup is taken through SQLite's own online backup API — a consistent snapshot
even mid-write, which copying the file by hand would not give. The archive holds
`database.sqlite`, a `manifest.json` (checksum, schema version, row counts) and
a plain `settings.json` so a human can see what is inside without SQLite.

Restoring never silently overwrites. The archive is read into memory, its
checksum verified, its database opened read-only and put through
`integrity_check` and `foreign_key_check`, and its schema version compared
against this build. Only then is a `pre_restore_safety` backup taken, the
connection closed, the file swapped, and the service graph rebuilt.

Two details that only showed up under test:

- **A backup must never overwrite another one.** With two backups in the same
  millisecond the filename collided — and during a restore the safety copy
  landed on the very archive being restored, so the restore read back the
  database it had just replaced. Names are now made unique, and the archive is
  read into memory before anything is written.
- **The WAL sidecars must go with the database file.** Leaving a `-wal` from the
  old database beside the restored one lets SQLite replay it and quietly
  resurrect the rows the restore was meant to discard.

### Swapping the database under a running server

`ApplicationHost` owns the open database and the service graph. Routes read
`host.services` per request rather than capturing it, so a restore can rebuild
every service on the new file without a restart — and a request that arrives a
moment later talks to the restored database rather than a closed handle.

---

## 15. The schedule optimizer, and packaging (Milestone 5)

### Tidying a day

`domain/schedules/optimizer.ts` proposes arranging a day into fewer separate
intake events. It is a greedy merge rather than a search, chosen because it is
deterministic, and because every move it makes can be justified in one sentence
to someone deciding whether to take their medication differently.

Four properties it guarantees, each with a test:

- it only ever moves a dose **into an intake event that already exists**, so it
  never invents a new time of day;
- it never moves a dose the user pinned (`flexibility: 'fixed'`), one tied to a
  meal, or one outside its own window;
- it never introduces a constraint violation — *and never aggravates one that
  already exists*. Comparing violation identity alone turned out not to be
  enough: pushing two substances that are already too close from 60 minutes
  apart to 0 keeps the same violation on the books while plainly making the day
  worse, so the distance is compared too;
- it only proposes a move that actually removes an event, so shuffling one dose
  out of a pair is never suggested.

The result is a proposal. Nothing is written until the user accepts, and
accepting writes single-day `schedule_override` rows like any other timeline
edit — the plan versions behind them are untouched, and tomorrow is back on plan.

The inputs the brief listed have been in the model since Milestone 1:
`day_profile` anchors, `intake_plan_dose.flexibility`, window bounds, meal
references and the constraint set. No schema change was needed.

### Desktop packaging: the seam, not the installer

`app/src/embedded.ts` exposes `startPillstack({ dataDirectory, port, webRoot })`.
The command-line entry point is now a thin wrapper over it, and a desktop shell
would call the same function and point a window at the returned URL. Passing
port `0` asks the operating system for a free port, which a packaged app wants
rather than fighting over a fixed one.

That seam is tested: `tests/embedded.test.ts` boots the real application in
process, checks it binds to loopback only, exercises the API, serves the SPA
with client-side routing intact, and reopens the same data on a restart.

**An Electron build is not included.** Two things stand in the way, and both are
better stated than glossed over:

1. Electron's runtime binary is a separate ~100 MB download that did not
   complete in this environment, so nothing could be run or verified.
2. `better-sqlite3` is a native module and would need rebuilding against
   Electron's ABI (`@electron/rebuild`). This is the friction point flagged in
   the technology table from the start, and the reason `node:sqlite` is worth
   revisiting when packaging actually begins.

Neither is a design problem — the shell is thin and the seam it would attach to
is proven — but shipping an unverified Electron target would be worse than
shipping none.
