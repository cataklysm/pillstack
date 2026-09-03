-- PillStack - proposed SQLite schema (v1)
--
-- This file is the readable reference. The executable form lives in
-- app/src/persistence/migrations/ as Kysely migrations.
--
-- Conventions
--   ids           TEXT, UUIDv7 (time-sortable, stable across export/import)
--   instants      TEXT, ISO-8601 UTC        e.g. '2026-09-03T19:30:00.000Z'
--   local dates   TEXT, 'YYYY-MM-DD'        clinical dates, never UTC-shifted
--   local times   TEXT, 'HH:MM'             wall-clock in the user's timezone
--   booleans      INTEGER 0/1 with CHECK
--   weekday mask  INTEGER bitfield, bit0(=1) Monday ... bit6(=64) Sunday
--
-- Connection pragmas applied on every open:
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--   PRAGMA synchronous  = NORMAL;
--   PRAGMA busy_timeout = 5000;


-- =====================================================================
-- 1. SETTINGS AND DAY RHYTHM
-- =====================================================================

CREATE TABLE app_setting (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                 -- JSON-encoded
  updated_at  TEXT NOT NULL
);
-- keys: timezone (IANA), patient_name, patient_date_of_birth, locale,
--       backup_directory, last_backup_at

-- Meal and sleep anchors. Required from day one: meal-relative doses cannot be
-- placed on a timeline without them, and the future optimizer reads the same rows.
CREATE TABLE day_profile (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  applies_to_weekday_mask  INTEGER NOT NULL DEFAULT 127,
  wake_up_time             TEXT NOT NULL,
  bed_time                 TEXT NOT NULL,
  breakfast_time           TEXT,
  lunch_time               TEXT,
  dinner_time              TEXT,
  is_default               INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX day_profile_single_default_idx
  ON day_profile (is_default) WHERE is_default = 1;


-- =====================================================================
-- 2. SUBSTANCES, PRODUCTS, INGREDIENTS
-- =====================================================================

-- Canonical substance identity, shared across products.
-- This is what makes "keep iron 2h away from calcium" work no matter which
-- brand of iron or calcium is in the cabinet, and it is the join point where a
-- curated interaction catalogue can later be attached.
CREATE TABLE substance (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,            -- lowercased, accent-folded; search + dedupe
  synonyms         TEXT,                     -- JSON array of strings
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX substance_normalized_name_idx ON substance (normalized_name);

-- The physical package the user owns.
CREATE TABLE product (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  normalized_name       TEXT NOT NULL,
  manufacturer          TEXT,
  category              TEXT NOT NULL CHECK (category IN ('medication','supplement')),
  dosage_form           TEXT NOT NULL CHECK (dosage_form IN
                          ('tablet','capsule','powder','drops','liquid','injection','other')),
  package_size          REAL NOT NULL CHECK (package_size > 0),
  package_unit          TEXT NOT NULL CHECK (package_unit IN
                          ('tablets','capsules','grams','milliliters','doses','other')),
  prescription_required INTEGER NOT NULL DEFAULT 0 CHECK (prescription_required IN (0,1)),
  notes                 TEXT,
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  archived_at           TEXT,                -- soft delete; a product referenced by history
                                             -- is never hard-deleted
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX product_normalized_name_idx ON product (normalized_name);
CREATE INDEX product_category_active_idx ON product (category, active);
CREATE INDEX product_manufacturer_idx    ON product (manufacturer);

-- A product has one or many active ingredients. Never assume 1:1.
CREATE TABLE active_ingredient (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES product(id)   ON DELETE CASCADE,
  substance_id  TEXT NOT NULL REFERENCES substance(id) ON DELETE RESTRICT,
  label         TEXT,                        -- printed form, 'Iron (ferrous bisglycinate)'
  amount        REAL,
  unit          TEXT,                        -- 'mg','mcg','g','ml','IU'
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX active_ingredient_product_idx   ON active_ingredient (product_id);
CREATE INDEX active_ingredient_substance_idx ON active_ingredient (substance_id);


-- =====================================================================
-- 3. TREATMENT AND VERSIONED INTAKE PLANS
-- =====================================================================

-- The therapy itself: "I take rosuvastatin for LDL reduction."
-- Stable identity across every dose change, pause and schedule change.
CREATE TABLE treatment (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  indication   TEXT,                         -- reason, e.g. 'LDL reduction'
  prescriber   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active','paused','stopped')),
  started_on   TEXT NOT NULL,                -- YYYY-MM-DD
  ended_on     TEXT,
  stop_reason  TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX treatment_product_idx ON treatment (product_id);
CREATE INDEX treatment_status_idx  ON treatment (status);

-- One immutable row per version of the schedule. Changing a dose or a time
-- closes the current row (effective_to) and inserts a new one. Nothing is
-- overwritten, so "what was I taking in March?" stays a point-in-time query.
CREATE TABLE intake_plan (
  id                  TEXT PRIMARY KEY,
  treatment_id        TEXT NOT NULL REFERENCES treatment(id) ON DELETE RESTRICT,
  version             INTEGER NOT NULL,
  supersedes_plan_id  TEXT REFERENCES intake_plan(id),
  effective_from      TEXT NOT NULL,         -- YYYY-MM-DD, inclusive
  effective_to        TEXT,                  -- YYYY-MM-DD, inclusive; NULL = current
  recurrence_type     TEXT NOT NULL CHECK (recurrence_type IN
                        ('daily','weekdays','every_n_days','as_needed')),
  interval_days       INTEGER,               -- every_n_days
  anchor_date         TEXT,                  -- every_n_days: phase reference
  weekday_mask        INTEGER,               -- weekdays
  max_doses_per_day   REAL,                  -- as_needed cap
  instructions        TEXT,                  -- free text, shown in UI and on the PDF
  change_reason       TEXT,                  -- why this version replaced the previous one
  created_at          TEXT NOT NULL,
  UNIQUE (treatment_id, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (recurrence_type <> 'every_n_days'
         OR (interval_days >= 1 AND anchor_date IS NOT NULL)),
  CHECK (recurrence_type <> 'weekdays'
         OR (weekday_mask BETWEEN 1 AND 127))
);
-- At most one open (current) version per treatment.
CREATE UNIQUE INDEX intake_plan_current_idx
  ON intake_plan (treatment_id) WHERE effective_to IS NULL;
CREATE INDEX intake_plan_treatment_idx ON intake_plan (treatment_id, effective_from);

-- A closed plan version is history and must not be edited.
CREATE TRIGGER intake_plan_closed_is_immutable
BEFORE UPDATE ON intake_plan
WHEN OLD.effective_to IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'superseded intake_plan rows are immutable');
END;

-- One row per dose occurrence within the pattern. Two rows = twice a day.
-- Dose lives here, not on intake_plan, because real plans are asymmetric
-- (2 tablets morning, 1 tablet evening) and as-needed still needs a dose.
CREATE TABLE intake_plan_dose (
  id                    TEXT PRIMARY KEY,
  intake_plan_id        TEXT NOT NULL REFERENCES intake_plan(id) ON DELETE CASCADE,
  sort_order            INTEGER NOT NULL,
  label                 TEXT,                -- 'morning', 'with dinner'
  timing_type           TEXT NOT NULL CHECK (timing_type IN
                          ('fixed','window','meal_relative','as_needed')),
  target_time           TEXT,                -- HH:MM   (fixed)
  window_start_time     TEXT,                -- HH:MM   (window)
  window_end_time       TEXT,                -- HH:MM   (window)
  meal_reference        TEXT CHECK (meal_reference IN
                          ('breakfast','lunch','dinner','wake_up','bed_time')),
  meal_offset_minutes   INTEGER NOT NULL DEFAULT 0,   -- negative = before the meal
  flexibility           TEXT NOT NULL DEFAULT 'flexible'
                          CHECK (flexibility IN ('fixed','flexible')),
  dose_amount           REAL NOT NULL CHECK (dose_amount > 0),
  dose_unit             TEXT NOT NULL,       -- clinical unit: 'mg','tablet','ml','drop'
  package_unit_quantity REAL,                -- inventory units consumed, e.g. 1.0 tablets.
                                             -- NULL = this dose does not decrement stock.
  UNIQUE (intake_plan_id, sort_order),
  CHECK (timing_type <> 'fixed'         OR target_time IS NOT NULL),
  CHECK (timing_type <> 'window'        OR (window_start_time IS NOT NULL
                                            AND window_end_time IS NOT NULL)),
  CHECK (timing_type <> 'meal_relative' OR meal_reference IS NOT NULL),
  CHECK (package_unit_quantity IS NULL  OR package_unit_quantity >= 0)
);
CREATE INDEX intake_plan_dose_plan_idx ON intake_plan_dose (intake_plan_id, sort_order);


-- =====================================================================
-- 4. TREATMENT HISTORY
-- =====================================================================

-- Append-only narrative. `summary` is rendered and frozen at write time so the
-- physician report stays truthful even if rendering logic changes later.
CREATE TABLE treatment_event (
  id            TEXT PRIMARY KEY,
  treatment_id  TEXT NOT NULL REFERENCES treatment(id) ON DELETE RESTRICT,
  event_type    TEXT NOT NULL CHECK (event_type IN
                  ('started','dose_changed','schedule_changed','paused',
                   'resumed','stopped','product_changed','note_added')),
  occurred_on   TEXT NOT NULL,               -- YYYY-MM-DD, the clinical date
  recorded_at   TEXT NOT NULL,               -- ISO instant, the audit date
  from_plan_id  TEXT REFERENCES intake_plan(id),
  to_plan_id    TEXT REFERENCES intake_plan(id),
  reason        TEXT,
  note          TEXT,
  summary       TEXT NOT NULL                -- 'Dose increased 5 mg -> 10 mg, daily at 21:30'
);
CREATE INDEX treatment_event_treatment_idx ON treatment_event (treatment_id, occurred_on);

-- Pauses need a queryable interval, not just two events, because the depletion
-- projection has to skip paused days.
CREATE TABLE treatment_pause (
  id            TEXT PRIMARY KEY,
  treatment_id  TEXT NOT NULL REFERENCES treatment(id) ON DELETE RESTRICT,
  paused_from   TEXT NOT NULL,               -- YYYY-MM-DD, inclusive
  resumed_on    TEXT,                        -- YYYY-MM-DD, exclusive; NULL = still paused
  reason        TEXT,
  created_at    TEXT NOT NULL,
  CHECK (resumed_on IS NULL OR resumed_on > paused_from)
);
CREATE UNIQUE INDEX treatment_pause_open_idx
  ON treatment_pause (treatment_id) WHERE resumed_on IS NULL;
CREATE INDEX treatment_pause_range_idx ON treatment_pause (treatment_id, paused_from);


-- =====================================================================
-- 5. CONSTRAINTS
-- =====================================================================

-- Entirely user-authored in v1. `origin` and `catalog_ref` reserve the seam for
-- a curated interaction catalogue without a later schema change.
CREATE TABLE intake_constraint (
  id                       TEXT PRIMARY KEY,
  constraint_type          TEXT NOT NULL CHECK (constraint_type IN
                             ('minimum_separation','avoid_together','with_food','without_food',
                              'before_food','after_food','preferred_time_of_day')),
  severity                 TEXT NOT NULL DEFAULT 'warning'
                             CHECK (severity IN ('information','warning')),

  source_kind              TEXT NOT NULL CHECK (source_kind IN
                             ('product','substance','category')),
  source_product_id        TEXT REFERENCES product(id)   ON DELETE CASCADE,
  source_substance_id      TEXT REFERENCES substance(id) ON DELETE CASCADE,
  source_category          TEXT CHECK (source_category IN ('medication','supplement')),

  target_kind              TEXT CHECK (target_kind IN
                             ('product','substance','category','meal','food')),
  target_product_id        TEXT REFERENCES product(id)   ON DELETE CASCADE,
  target_substance_id      TEXT REFERENCES substance(id) ON DELETE CASCADE,
  target_category          TEXT CHECK (target_category IN ('medication','supplement')),
  target_meal              TEXT CHECK (target_meal IN ('breakfast','lunch','dinner')),
  target_food_label        TEXT,             -- free text: 'dairy', 'coffee', 'grapefruit'

  minimum_distance_minutes INTEGER,          -- minimum_separation
  food_offset_minutes      INTEGER,          -- before_food / after_food
  preferred_time_from      TEXT,             -- HH:MM (preferred_time_of_day)
  preferred_time_to        TEXT,             -- HH:MM

  explanation              TEXT,
  origin                   TEXT NOT NULL DEFAULT 'user'
                             CHECK (origin IN ('user','catalog')),
  catalog_ref              TEXT,
  enabled                  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,

  -- exactly one source reference, matching source_kind
  CHECK (
    (source_kind = 'product'   AND source_product_id   IS NOT NULL
                               AND source_substance_id IS NULL AND source_category IS NULL) OR
    (source_kind = 'substance' AND source_substance_id IS NOT NULL
                               AND source_product_id   IS NULL AND source_category IS NULL) OR
    (source_kind = 'category'  AND source_category     IS NOT NULL
                               AND source_product_id   IS NULL AND source_substance_id IS NULL)
  ),
  -- pairwise types require a target
  CHECK (constraint_type NOT IN ('minimum_separation','avoid_together')
         OR target_kind IS NOT NULL),
  CHECK (constraint_type <> 'minimum_separation' OR minimum_distance_minutes >= 0),
  CHECK (constraint_type <> 'preferred_time_of_day'
         OR (preferred_time_from IS NOT NULL AND preferred_time_to IS NOT NULL))
);
CREATE INDEX intake_constraint_source_product_idx   ON intake_constraint (source_product_id);
CREATE INDEX intake_constraint_source_substance_idx ON intake_constraint (source_substance_id);
CREATE INDEX intake_constraint_target_product_idx   ON intake_constraint (target_product_id);
CREATE INDEX intake_constraint_target_substance_idx ON intake_constraint (target_substance_id);


-- =====================================================================
-- 6. INVENTORY
-- =====================================================================

-- Per-product reorder policy (one row per product).
CREATE TABLE inventory_policy (
  product_id                 TEXT PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
  tracking_enabled           INTEGER NOT NULL DEFAULT 1 CHECK (tracking_enabled IN (0,1)),
  consumption_source         TEXT NOT NULL DEFAULT 'planned'
                               CHECK (consumption_source IN ('planned','logged')),
  reorder_threshold_quantity REAL,           -- reorder below N units left
  reorder_threshold_days     INTEGER,        -- ...or below N days of cover
  reorder_lead_time_days     INTEGER NOT NULL DEFAULT 7,
  updated_at                 TEXT NOT NULL
);

-- One row per physical package owned. Multiple packages of the same product with
-- different expiry dates are normal; this makes "which one expires first" answerable.
CREATE TABLE inventory_package (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  package_size    REAL NOT NULL CHECK (package_size > 0),
  unit            TEXT NOT NULL,             -- matches product.package_unit
  acquired_on     TEXT,
  opened_at       TEXT,
  expiration_date TEXT,
  lot_number      TEXT,
  status          TEXT NOT NULL DEFAULT 'sealed'
                    CHECK (status IN ('sealed','open','depleted','discarded')),
  notes           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX inventory_package_product_idx ON inventory_package (product_id, status);
CREATE INDEX inventory_package_expiry_idx  ON inventory_package (expiration_date);

-- Append-only ledger. Current stock is derived, never stored as a mutable number.
CREATE TABLE inventory_transaction (
  id                   TEXT PRIMARY KEY,
  product_id           TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  inventory_package_id TEXT REFERENCES inventory_package(id) ON DELETE RESTRICT,
  transaction_type     TEXT NOT NULL CHECK (transaction_type IN
                         ('package_added','dose_consumed','manual_correction',
                          'package_discarded','treatment_paused','other')),
  quantity_delta       REAL NOT NULL,        -- in product.package_unit; negative = consumed;
                                             -- 0 = annotation only (e.g. treatment_paused)
  absolute_quantity    REAL,                 -- manual_correction: the counted stock. The delta
                                             -- is derived from it and both are kept.
  occurred_at          TEXT NOT NULL,        -- ISO instant
  effective_on         TEXT NOT NULL,        -- YYYY-MM-DD, the day it counts against
  intake_log_entry_id  TEXT REFERENCES intake_log_entry(id) ON DELETE SET NULL,
  treatment_id         TEXT REFERENCES treatment(id)        ON DELETE SET NULL,
  note                 TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX inventory_transaction_product_idx ON inventory_transaction (product_id, effective_on);
CREATE INDEX inventory_transaction_type_idx
  ON inventory_transaction (product_id, transaction_type, effective_on);


-- =====================================================================
-- 7. INTAKE LOG (optional confirmations)
-- =====================================================================

CREATE TABLE intake_log_entry (
  id                    TEXT PRIMARY KEY,
  product_id            TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  treatment_id          TEXT REFERENCES treatment(id)        ON DELETE SET NULL,
  intake_plan_dose_id   TEXT REFERENCES intake_plan_dose(id) ON DELETE SET NULL,
  is_ad_hoc             INTEGER NOT NULL DEFAULT 0 CHECK (is_ad_hoc IN (0,1)),
  occurrence_date       TEXT,                -- YYYY-MM-DD, the scheduled day
  scheduled_at          TEXT,                -- ISO instant the dose was due
  actual_at             TEXT,                -- ISO instant it was actually taken
  recorded_at           TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('taken','skipped','postponed')),
  postponed_to          TEXT,                -- ISO instant
  dose_amount           REAL,
  dose_unit             TEXT,
  package_unit_quantity REAL,
  note                  TEXT
);
-- One confirmation per planned occurrence; as-needed / ad-hoc entries are exempt.
CREATE UNIQUE INDEX intake_log_occurrence_idx
  ON intake_log_entry (intake_plan_dose_id, occurrence_date)
  WHERE intake_plan_dose_id IS NOT NULL AND is_ad_hoc = 0;
CREATE INDEX intake_log_product_idx ON intake_log_entry (product_id, occurrence_date);


-- =====================================================================
-- 8. SCHEDULE OVERRIDES (drag / edit a single day)
-- =====================================================================

-- Moving today's iron to 12:00 is an exception, not a schedule change.
-- Permanent changes create a new intake_plan version instead.
CREATE TABLE schedule_override (
  id                       TEXT PRIMARY KEY,
  intake_plan_dose_id      TEXT NOT NULL REFERENCES intake_plan_dose(id) ON DELETE CASCADE,
  occurrence_date          TEXT NOT NULL,    -- YYYY-MM-DD
  override_type            TEXT NOT NULL CHECK (override_type IN ('moved','skipped','added')),
  overridden_time          TEXT,             -- HH:MM
  acknowledged_constraints TEXT,             -- JSON array of intake_constraint ids the user
                                             -- consciously overrode; keeps that warning silent
  reason                   TEXT,
  created_at               TEXT NOT NULL,
  UNIQUE (intake_plan_dose_id, occurrence_date),
  CHECK (override_type <> 'moved' OR overridden_time IS NOT NULL)
);


-- =====================================================================
-- 9. REMINDERS AND NOTIFICATIONS
-- =====================================================================

CREATE TABLE reminder_rule (
  id                    TEXT PRIMARY KEY,
  reminder_type         TEXT NOT NULL CHECK (reminder_type IN
                          ('intake','reorder','prescription')),
  scope_kind            TEXT NOT NULL DEFAULT 'global'
                          CHECK (scope_kind IN ('global','product','treatment')),
  product_id            TEXT REFERENCES product(id)   ON DELETE CASCADE,
  treatment_id          TEXT REFERENCES treatment(id) ON DELETE CASCADE,
  lead_time_minutes     INTEGER,             -- intake: fire N minutes before
  lead_time_days        INTEGER,             -- reorder / prescription: N days before run-out
  repeat_after_minutes  INTEGER,             -- unacknowledged intake nag interval
  quiet_hours_from      TEXT,
  quiet_hours_to        TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (scope_kind <> 'product'   OR product_id   IS NOT NULL),
  CHECK (scope_kind <> 'treatment' OR treatment_id IS NOT NULL)
);

-- Outbox. The domain writes rows; a delivery adapter (browser now, native later)
-- drains them. dedupe_key makes generation idempotent and safely re-runnable.
CREATE TABLE notification (
  id                TEXT PRIMARY KEY,
  reminder_rule_id  TEXT REFERENCES reminder_rule(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN
                      ('intake','reorder','prescription','expiry')),
  dedupe_key        TEXT NOT NULL,           -- 'intake:<doseId>:2026-09-03'
  due_at            TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  payload           TEXT,                    -- JSON
  delivered_at      TEXT,
  dismissed_at      TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX notification_dedupe_idx ON notification (dedupe_key);
CREATE INDEX notification_pending_idx       ON notification (due_at) WHERE delivered_at IS NULL;


-- =====================================================================
-- 10. BACKUP JOURNAL
-- =====================================================================

CREATE TABLE backup_record (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  file_size_bytes  INTEGER NOT NULL,
  checksum_sha256  TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  app_version      TEXT NOT NULL,
  trigger_source   TEXT NOT NULL CHECK (trigger_source IN
                     ('manual','automatic','pre_restore_safety')),
  note             TEXT
);
-- Mirrored to <backupDirectory>/index.json, because a restored older database
-- would otherwise not know about backups taken after it was written.


-- =====================================================================
-- 11. CONVENIENCE VIEWS
-- =====================================================================

CREATE VIEW current_intake_plan AS
  SELECT * FROM intake_plan WHERE effective_to IS NULL;

CREATE VIEW ledger_stock AS
  SELECT product_id,
         SUM(quantity_delta) AS ledger_quantity,
         MAX(CASE WHEN transaction_type IN ('manual_correction','package_added')
                  THEN effective_on END) AS last_anchor_on
  FROM inventory_transaction
  GROUP BY product_id;
