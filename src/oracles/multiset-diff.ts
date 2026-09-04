/**
 * Multiset diff: items in `after` not matched (by key) against an item in
 * `before`. Not a simple length compare — a `before` item removes at most
 * one matching `after` item, so a persisting duplicate is never
 * miscounted as new. Shared by every oracle that compares two point-in-time
 * record lists (console-error, page-error, http-failure).
 */
export function newItemsByKey<T>(before: T[], after: T[], keyOf: (item: T) => string): T[] {
  const remaining = [...after];
  for (const item of before) {
    const key = keyOf(item);
    const index = remaining.findIndex((candidate) => keyOf(candidate) === key);
    if (index !== -1) {
      remaining.splice(index, 1);
    }
  }
  return remaining;
}
