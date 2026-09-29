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

export type AssertionFailure = { id: string; assertion: string; detail: string };

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
    failures.push({ id: "status", assertion: `status === ${assertions.expectedStatus}`, detail: `got ${status}` });
  }

  if (assertions.expectedContentType !== undefined) {
    const actual = contentType ?? "(none)";
    if (actual.split(";")[0]?.trim().toLowerCase() !== assertions.expectedContentType.split(";")[0]?.trim().toLowerCase()) {
      failures.push({ id: "content-type", assertion: `content-type includes "${assertions.expectedContentType}"`, detail: `got "${actual}"` });
    }
  }

  for (const field of assertions.requiredFields ?? []) {
    if (getByPath(body, field) === undefined) {
      failures.push({ id: `field:${field}`, assertion: `required field "${field}" present`, detail: "missing" });
    }
  }

  for (const [field, expectedType] of Object.entries(assertions.shape ?? {})) {
    const actualType = typeOfValue(getByPath(body, field));
    if (actualType === "undefined") {
      failures.push({ id: `shape:${field}`, assertion: `field "${field}" has type "${expectedType}"`, detail: "field missing" });
    } else if (actualType !== expectedType) {
      failures.push({ id: `shape:${field}`, assertion: `field "${field}" has type "${expectedType}"`, detail: `got type "${actualType}"` });
    }
  }

  for (const [index, invariant] of assertions.invariants.entries()) {
    if (invariant.kind === "range") {
      const value = getByPath(body, invariant.field);
      if (typeof value !== "number") {
        failures.push({ id: `invariant:${index}`, assertion: `"${invariant.field}" is within range`, detail: `field is not a number (got ${typeOfValue(value)})` });
      } else if ((invariant.min !== undefined && value < invariant.min) || (invariant.max !== undefined && value > invariant.max)) {
        failures.push({ id: `invariant:${index}`, assertion: `"${invariant.field}" within [${invariant.min ?? "-inf"}, ${invariant.max ?? "+inf"}]`, detail: `got ${value}` });
      }
    } else if (invariant.kind === "fieldsEqual") {
      const a = getByPath(body, invariant.field);
      const b = invariant.field2 ? getByPath(body, invariant.field2) : undefined;
      if (a === undefined || b === undefined || a !== b) failures.push({ id: `invariant:${index}`, assertion: `"${invariant.field}" === "${invariant.field2}"`, detail: "Fields are missing or unequal; values omitted." });
    } else if (invariant.kind === "fieldLessThan") {
      const a = getByPath(body, invariant.field);
      const b = invariant.field2 ? getByPath(body, invariant.field2) : undefined;
      if (typeof a !== "number" || typeof b !== "number") {
        failures.push({ id: `invariant:${index}`, assertion: `"${invariant.field}" < "${invariant.field2}"`, detail: `non-numeric operand(s)` });
      } else if (!(a < b)) {
        failures.push({ id: `invariant:${index}`, assertion: `"${invariant.field}" < "${invariant.field2}"`, detail: `got ${a} >= ${b}` });
      }
    }
  }

  return failures;
}

export type ApiAssertionResult = { id: string; assertion: string; expected: string; observed: string; passed: boolean };

/**
 * Every declared assertion with a stable identity and its outcome -- the
 * passing ones too -- so a suite run can be compared with a baseline by
 * assertion identity. Values from the response body are never included;
 * `observed` is the same bounded detail the failure list already records.
 */
export function evaluateAssertionResults(assertions: DeclaredApiCheck["assertions"], status: number, contentType: string | undefined, body: unknown): ApiAssertionResult[] {
  const failures = new Map(evaluateAssertions(assertions, status, contentType, body).map((f) => [f.id, f]));
  const declared: Array<{ id: string; assertion: string; expected: string }> = [
    ...(assertions.expectedStatus !== undefined ? [{ id: "status", assertion: "HTTP status", expected: String(assertions.expectedStatus) }] : []),
    ...(assertions.expectedContentType !== undefined ? [{ id: "content-type", assertion: "Content type", expected: assertions.expectedContentType }] : []),
    ...(assertions.requiredFields ?? []).map((f) => ({ id: `field:${f}`, assertion: `Required field "${f}"`, expected: "present" })),
    ...Object.entries(assertions.shape ?? {}).map(([f, t]) => ({ id: `shape:${f}`, assertion: `Field "${f}" type`, expected: t })),
    ...assertions.invariants.map((inv, i) => ({ id: `invariant:${i}`, assertion: `Invariant ${inv.kind} on "${inv.field}"${inv.field2 ? ` and "${inv.field2}"` : ""}`, expected: inv.kind === "range" ? `within [${inv.min ?? "-inf"}, ${inv.max ?? "+inf"}]` : inv.kind })),
  ];
  return declared.map((d) => {
    const failure = failures.get(d.id);
    return { ...d, observed: failure ? failure.detail : "as expected", passed: !failure };
  });
}
