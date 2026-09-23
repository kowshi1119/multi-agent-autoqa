import type { DeclaredApiCheck } from "./checks-manifest.js";

/** Reads a dot-path (e.g. "user.id") out of a parsed JSON value. Returns undefined for any missing segment, never throws. */
export function getByPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function typeOfValue(value: unknown): "string" | "number" | "boolean" | "array" | "object" | "undefined" | "other" {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value === null) return "other";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "other";
}

export type AssertionFailure = { assertion: string; detail: string };

/**
 * Evaluates one declared check's `assertions` against a parsed response
 * body deterministically -- no model call, no judgment call. Returns every
 * failure found (not just the first), so a single check's ledger entry can
 * report a complete, specific reason.
 */
export function evaluateAssertions(
  assertions: DeclaredApiCheck["assertions"],
  status: number,
  contentType: string | undefined,
  body: unknown
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  if (assertions.expectedStatus !== undefined && status !== assertions.expectedStatus) {
    failures.push({ assertion: `status === ${assertions.expectedStatus}`, detail: `got ${status}` });
  }

  if (assertions.expectedContentType !== undefined) {
    const actual = contentType ?? "(none)";
    if (actual.split(";")[0]?.trim().toLowerCase() !== assertions.expectedContentType.split(";")[0]?.trim().toLowerCase()) {
      failures.push({ assertion: `content-type includes "${assertions.expectedContentType}"`, detail: `got "${actual}"` });
    }
  }

  for (const field of assertions.requiredFields ?? []) {
    if (getByPath(body, field) === undefined) {
      failures.push({ assertion: `required field "${field}" present`, detail: "missing" });
    }
  }

  for (const [field, expectedType] of Object.entries(assertions.shape ?? {})) {
    const actualType = typeOfValue(getByPath(body, field));
    if (actualType === "undefined") {
      failures.push({ assertion: `field "${field}" has type "${expectedType}"`, detail: "field missing" });
    } else if (actualType !== expectedType) {
      failures.push({ assertion: `field "${field}" has type "${expectedType}"`, detail: `got type "${actualType}"` });
    }
  }

  for (const invariant of assertions.invariants) {
    if (invariant.kind === "range") {
      const value = getByPath(body, invariant.field);
      if (typeof value !== "number") {
        failures.push({ assertion: `"${invariant.field}" is within range`, detail: `field is not a number (got ${typeOfValue(value)})` });
      } else if ((invariant.min !== undefined && value < invariant.min) || (invariant.max !== undefined && value > invariant.max)) {
        failures.push({ assertion: `"${invariant.field}" within [${invariant.min ?? "-inf"}, ${invariant.max ?? "+inf"}]`, detail: `got ${value}` });
      }
    } else if (invariant.kind === "fieldsEqual") {
      const a = getByPath(body, invariant.field);
      const b = invariant.field2 ? getByPath(body, invariant.field2) : undefined;
      if (a === undefined || b === undefined || a !== b) failures.push({ assertion: `"${invariant.field}" === "${invariant.field2}"`, detail: "Fields are missing or unequal; values omitted." });
    } else if (invariant.kind === "fieldLessThan") {
      const a = getByPath(body, invariant.field);
      const b = invariant.field2 ? getByPath(body, invariant.field2) : undefined;
      if (typeof a !== "number" || typeof b !== "number") {
        failures.push({ assertion: `"${invariant.field}" < "${invariant.field2}"`, detail: `non-numeric operand(s)` });
      } else if (!(a < b)) {
        failures.push({ assertion: `"${invariant.field}" < "${invariant.field2}"`, detail: `got ${a} >= ${b}` });
      }
    }
  }

  return failures;
}
