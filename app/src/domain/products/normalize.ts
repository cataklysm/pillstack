/**
 * Normalized names power search and substance de-duplication: "Vitamin D3",
 * "vitamin d3" and "Vitamín D3" all collapse to the same key, so the user does
 * not end up with three separate substances that constraints cannot match.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
