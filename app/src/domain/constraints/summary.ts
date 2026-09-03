import type { ConstraintEndpoint, IntakeConstraint } from '@pillstack/contracts';

/**
 * Renders a rule as the sentence shown in the constraint list, so the user can
 * check at a glance that what they entered means what they intended.
 */

export type SummarizableConstraint = Omit<IntakeConstraint, 'summary'>;

export function describeEndpoint(endpoint: ConstraintEndpoint | null): string {
  if (!endpoint) return 'anything';

  switch (endpoint.kind) {
    case 'product':
      return endpoint.name ?? 'this product';
    case 'substance':
      return endpoint.name ?? 'this substance';
    case 'category':
      return endpoint.category === 'medication' ? 'any medication' : 'any supplement';
    case 'meal':
      return endpoint.meal.replace(/_/g, ' ');
    case 'food':
      return endpoint.label;
    default:
      return 'anything';
  }
}

export function describeConstraint(constraint: SummarizableConstraint): string {
  const source = describeEndpoint(constraint.source);
  const target = describeEndpoint(constraint.target);

  switch (constraint.constraintType) {
    case 'minimum_separation':
      return `Keep ${source} at least ${formatMinutes(constraint.minimumDistanceMinutes ?? 0)} away from ${target}`;

    case 'avoid_together':
      return `Do not take ${source} together with ${target}`;

    case 'with_food':
      return `Take ${source} with food${offsetSuffix(constraint.foodOffsetMinutes, 'within')}`;

    case 'without_food':
      return `Take ${source} without food${offsetSuffix(constraint.foodOffsetMinutes, 'at least')}`;

    case 'before_food':
      return `Take ${source} before food${offsetSuffix(constraint.foodOffsetMinutes, 'up to')}`;

    case 'after_food':
      return `Take ${source} after food${offsetSuffix(constraint.foodOffsetMinutes, 'within')}`;

    case 'preferred_time_of_day':
      return `Prefer ${source} between ${constraint.preferredTimeFrom} and ${constraint.preferredTimeTo}`;

    default:
      return source;
  }
}

function offsetSuffix(minutes: number | null, preposition: string): string {
  return minutes == null ? '' : ` (${preposition} ${formatMinutes(minutes)})`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rendered} ${hours === 1 ? 'hour' : 'hours'}`;
}
