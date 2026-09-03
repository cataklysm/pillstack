import type {
  DosageForm,
  DoseFlexibility,
  IntakeStatus,
  MealReference,
  PackageUnit,
  ProductCategory,
  RecurrenceType,
  TimingType,
  TreatmentEventType,
  TreatmentStatus,
} from '@pillstack/contracts';

/**
 * Kysely's view of the SQLite schema.
 *
 * Column names stay snake_case exactly as in docs/schema.sql; repositories are
 * the single place that maps rows to camelCase domain objects, so the mapping
 * is never scattered across services.
 *
 * SQLite has no boolean type: 0/1 integers are surfaced as `number` here and
 * converted in the repositories.
 */

export interface AppSettingTable {
  key: string;
  value: string;
  updated_at: string;
}

export interface DayProfileTable {
  id: string;
  name: string;
  applies_to_weekday_mask: number;
  wake_up_time: string;
  bed_time: string;
  breakfast_time: string | null;
  lunch_time: string | null;
  dinner_time: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface SubstanceTable {
  id: string;
  name: string;
  normalized_name: string;
  synonyms: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductTable {
  id: string;
  name: string;
  normalized_name: string;
  manufacturer: string | null;
  category: ProductCategory;
  dosage_form: DosageForm;
  package_size: number;
  package_unit: PackageUnit;
  prescription_required: number;
  notes: string | null;
  active: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActiveIngredientTable {
  id: string;
  product_id: string;
  substance_id: string;
  label: string | null;
  amount: number | null;
  unit: string | null;
  description: string | null;
  sort_order: number;
}

export interface TreatmentTable {
  id: string;
  product_id: string;
  indication: string | null;
  prescriber: string | null;
  status: TreatmentStatus;
  started_on: string;
  ended_on: string | null;
  stop_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntakePlanTable {
  id: string;
  treatment_id: string;
  version: number;
  supersedes_plan_id: string | null;
  effective_from: string;
  effective_to: string | null;
  recurrence_type: RecurrenceType;
  interval_days: number | null;
  anchor_date: string | null;
  weekday_mask: number | null;
  max_doses_per_day: number | null;
  instructions: string | null;
  change_reason: string | null;
  created_at: string;
}

export interface IntakePlanDoseTable {
  id: string;
  intake_plan_id: string;
  sort_order: number;
  label: string | null;
  timing_type: TimingType;
  target_time: string | null;
  window_start_time: string | null;
  window_end_time: string | null;
  meal_reference: MealReference | null;
  meal_offset_minutes: number;
  flexibility: DoseFlexibility;
  dose_amount: number;
  dose_unit: string;
  package_unit_quantity: number | null;
}

export interface TreatmentEventTable {
  id: string;
  treatment_id: string;
  event_type: TreatmentEventType;
  occurred_on: string;
  recorded_at: string;
  from_plan_id: string | null;
  to_plan_id: string | null;
  reason: string | null;
  note: string | null;
  summary: string;
}

export interface TreatmentPauseTable {
  id: string;
  treatment_id: string;
  paused_from: string;
  resumed_on: string | null;
  reason: string | null;
  created_at: string;
}

export interface IntakeConstraintTable {
  id: string;
  constraint_type: string;
  severity: string;
  source_kind: string;
  source_product_id: string | null;
  source_substance_id: string | null;
  source_category: string | null;
  target_kind: string | null;
  target_product_id: string | null;
  target_substance_id: string | null;
  target_category: string | null;
  target_meal: string | null;
  target_food_label: string | null;
  minimum_distance_minutes: number | null;
  food_offset_minutes: number | null;
  preferred_time_from: string | null;
  preferred_time_to: string | null;
  explanation: string | null;
  origin: string;
  catalog_ref: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryPolicyTable {
  product_id: string;
  tracking_enabled: number;
  consumption_source: 'planned' | 'logged';
  reorder_threshold_quantity: number | null;
  reorder_threshold_days: number | null;
  reorder_lead_time_days: number;
  updated_at: string;
}

export interface InventoryPackageTable {
  id: string;
  product_id: string;
  package_size: number;
  unit: string;
  acquired_on: string | null;
  opened_at: string | null;
  expiration_date: string | null;
  lot_number: string | null;
  status: 'sealed' | 'open' | 'depleted' | 'discarded';
  notes: string | null;
  created_at: string;
}

export interface InventoryTransactionTable {
  id: string;
  product_id: string;
  inventory_package_id: string | null;
  transaction_type:
    | 'package_added'
    | 'dose_consumed'
    | 'manual_correction'
    | 'package_discarded'
    | 'treatment_paused'
    | 'other';
  quantity_delta: number;
  absolute_quantity: number | null;
  occurred_at: string;
  effective_on: string;
  intake_log_entry_id: string | null;
  treatment_id: string | null;
  note: string | null;
  created_at: string;
}

export interface IntakeLogEntryTable {
  id: string;
  product_id: string;
  treatment_id: string | null;
  intake_plan_dose_id: string | null;
  is_ad_hoc: number;
  occurrence_date: string | null;
  scheduled_at: string | null;
  actual_at: string | null;
  recorded_at: string;
  status: IntakeStatus;
  postponed_to: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  package_unit_quantity: number | null;
  note: string | null;
}

export interface ScheduleOverrideTable {
  id: string;
  intake_plan_dose_id: string;
  occurrence_date: string;
  override_type: 'moved' | 'skipped' | 'added';
  overridden_time: string | null;
  acknowledged_constraints: string | null;
  reason: string | null;
  created_at: string;
}

export interface ReminderRuleTable {
  id: string;
  reminder_type: 'intake' | 'reorder' | 'prescription';
  scope_kind: 'global' | 'product' | 'treatment';
  product_id: string | null;
  treatment_id: string | null;
  lead_time_minutes: number | null;
  lead_time_days: number | null;
  repeat_after_minutes: number | null;
  quiet_hours_from: string | null;
  quiet_hours_to: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationTable {
  id: string;
  reminder_rule_id: string | null;
  notification_type: 'intake' | 'reorder' | 'prescription' | 'expiry';
  dedupe_key: string;
  due_at: string;
  title: string;
  body: string;
  payload: string | null;
  delivered_at: string | null;
  dismissed_at: string | null;
  created_at: string;
}

export interface BackupRecordTable {
  id: string;
  created_at: string;
  file_path: string;
  file_size_bytes: number;
  checksum_sha256: string;
  schema_version: number;
  app_version: string;
  trigger_source: 'manual' | 'automatic' | 'pre_restore_safety';
  note: string | null;
}

export interface Database {
  app_setting: AppSettingTable;
  day_profile: DayProfileTable;
  substance: SubstanceTable;
  product: ProductTable;
  active_ingredient: ActiveIngredientTable;
  treatment: TreatmentTable;
  intake_plan: IntakePlanTable;
  intake_plan_dose: IntakePlanDoseTable;
  treatment_event: TreatmentEventTable;
  treatment_pause: TreatmentPauseTable;
  intake_constraint: IntakeConstraintTable;
  inventory_policy: InventoryPolicyTable;
  inventory_package: InventoryPackageTable;
  inventory_transaction: InventoryTransactionTable;
  intake_log_entry: IntakeLogEntryTable;
  schedule_override: ScheduleOverrideTable;
  reminder_rule: ReminderRuleTable;
  notification: NotificationTable;
  backup_record: BackupRecordTable;
}
