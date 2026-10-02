import { createHash } from "node:crypto";
import { z } from "zod";
import type { AssertionOutcome } from "../outcomes/outcome.js";

/**
 * A bounded OpenAPI 3.0 contract slice for read-only API checks.
 *
 * Supported (documented in README "API contract testing"):
 *  - JSON documents with `openapi: "3.0.x"` (3.1 and Swagger 2.0 are rejected as unsupported versions);
 *  - local `$ref`s of the form `#/components/schemas/<Name>` (remote or file refs are rejected, never fetched);
 *  - response schemas using `type` (string, number, integer, boolean, array, object), `properties`,
 *    `required`, `items`, `enum`, `nullable`, plus annotation keywords that do not constrain values
 *    (description, title, format, example, deprecated, readOnly, writeOnly, default, externalDocs, xml);
 *  - path and query parameters with explicit, non-secret test values.
 * Every other schema keyword (oneOf, anyOf, allOf, not, additionalProperties, pattern, minimum, …) is kept
 * as an *unsupported* assertion at that location, so an unsupported schema can never produce a PASS.
 *
 * The document's `servers` list is informational only: checks run against the profile's own approved origin
 * and path prefixes, and importing an operation never authorizes it. Only GET operations can be approved.
 * No assertion is generated from examples.
 */
export const CONTRACT_LIMITS = {
  maxDocumentBytes: 1_048_576,
  maxRefDepth: 16,
  maxSchemaNodes: 2_000,
  maxValidationSteps: 20_000,
  maxArrayItemsChecked: 50,
  maxOperations: 500,
  maxParamValueLength: 100,
} as const;

export class ContractError extends Error {
  constructor(message: string, readonly code: "invalid-document" | "unsupported-version" | "remote-reference" | "bounds-exceeded" | "invalid-selection" = "invalid-document") {
    super(message);
    this.name = "ContractError";
  }
}

const PRIMITIVES = ["string", "number", "integer", "boolean"] as const;
type Primitive = (typeof PRIMITIVES)[number];
const ANNOTATIONS = new Set(["description", "title", "format", "example", "deprecated", "readOnly", "writeOnly", "default", "externalDocs", "xml"]);
const STRUCTURAL = new Set(["type", "properties", "required", "items", "enum", "nullable", "$ref"]);

/** A validated, self-contained schema (refs already resolved). Stored inside the approved check. */
export type ContractSchema = {
  type?: Primitive | "array" | "object";
  nullable?: boolean;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, ContractSchema>;
  required?: string[];
  items?: ContractSchema;
  /** Keywords present in the contract that this slice cannot validate. Each becomes an `unsupported` assertion. */
  unsupported?: string[];
};

export const contractSchemaSchema: z.ZodType<ContractSchema> = z.lazy(() => z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array", "object"]).optional(),
  nullable: z.boolean().optional(),
  enum: z.array(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).max(100).optional(),
  properties: z.record(z.string().max(100), contractSchemaSchema).optional(),
  required: z.array(z.string().max(100)).max(200).optional(),
  items: contractSchemaSchema.optional(),
  unsupported: z.array(z.string().max(100)).max(50).optional(),
}).strict());

export type ContractOperation = {
  key: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  readOnly: boolean;
  parameters: Array<{ name: string; in: string; required: boolean; supported: boolean }>;
  responses: Array<{ status: string; contentTypes: string[] }>;
  notes: string[];
};

export type ParsedContract = { title: string; version: string; openapi: string; sha256: string; operations: ContractOperation[]; notes: string[]; doc: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/** Rejects any `$ref` that is not a local JSON pointer; nothing is ever fetched. Bounded walk. */
function scanRefs(value: unknown, budget: { nodes: number }): void {
  if (++budget.nodes > 200_000) throw new ContractError("The document is too large to scan within the validation bound.", "bounds-exceeded");
  if (Array.isArray(value)) { for (const v of value) scanRefs(v, budget); return; }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref") {
      if (typeof v !== "string" || !v.startsWith("#/")) throw new ContractError(`Remote or file references are not supported and are never fetched: ${String(v).slice(0, 120)}`, "remote-reference");
    } else scanRefs(v, budget);
  }
}

export function parseContract(text: string): ParsedContract {
  if (Buffer.byteLength(text, "utf8") > CONTRACT_LIMITS.maxDocumentBytes) throw new ContractError(`The contract exceeds ${CONTRACT_LIMITS.maxDocumentBytes} bytes.`, "bounds-exceeded");
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new ContractError("The contract is not valid JSON. Only JSON OpenAPI documents are supported (YAML is not)."); }
  if (!isObject(doc)) throw new ContractError("The contract must be a JSON object.");
  if (typeof doc["swagger"] === "string") throw new ContractError(`Swagger ${doc["swagger"]} is not supported; only OpenAPI 3.0.x JSON documents are.`, "unsupported-version");
  const version = doc["openapi"];
  if (typeof version !== "string" || !/^3\.0\.\d+$/.test(version)) throw new ContractError(`OpenAPI version ${JSON.stringify(version)} is not supported; only 3.0.x is (3.1 uses a different schema dialect).`, "unsupported-version");
  const info = doc["info"];
  if (!isObject(info) || typeof info["title"] !== "string" || typeof info["version"] !== "string") throw new ContractError("The contract needs info.title and info.version.");
  const paths = doc["paths"];
  if (!isObject(paths)) throw new ContractError("The contract needs a paths object.");
  scanRefs(doc, { nodes: 0 });
  const notes: string[] = [];
  const servers = doc["servers"];
  if (Array.isArray(servers) && servers.length) notes.push(`The contract lists ${servers.length} server(s); they are informational only. Checks run only against the application's approved origin and paths.`);
  const operations: ContractOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith("/") || !isObject(item)) throw new ContractError(`Invalid path entry ${JSON.stringify(path).slice(0, 120)}.`);
    const shared = Array.isArray(item["parameters"]) ? item["parameters"] : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      if (operations.length >= CONTRACT_LIMITS.maxOperations) throw new ContractError(`More than ${CONTRACT_LIMITS.maxOperations} operations.`, "bounds-exceeded");
      const params = [...shared, ...(Array.isArray(op["parameters"]) ? op["parameters"] : [])].map((p) => resolveLocal(doc as Record<string, unknown>, p, 0)).filter(isObject);
      const responses = isObject(op["responses"]) ? op["responses"] : {};
      const opNotes: string[] = [];
      if (Array.isArray(op["servers"]) || Array.isArray(item["servers"])) opNotes.push("This operation declares its own servers; they are ignored (never contacted).");
      if (op["requestBody"] !== undefined) opNotes.push("Declares a request body; request bodies are not sent by contract checks.");
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        ...(typeof op["operationId"] === "string" ? { operationId: op["operationId"].slice(0, 100) } : {}),
        ...(typeof op["summary"] === "string" ? { summary: op["summary"].slice(0, 200) } : {}),
        readOnly: method === "get",
        parameters: params.map((p) => ({ name: String(p["name"] ?? "").slice(0, 100), in: String(p["in"] ?? ""), required: p["required"] === true || p["in"] === "path", supported: p["in"] === "path" || p["in"] === "query" })),
        responses: Object.entries(responses).map(([status, r]) => {
          const resolved = resolveLocal(doc as Record<string, unknown>, r, 0);
          return { status, contentTypes: isObject(resolved) && isObject(resolved["content"]) ? Object.keys(resolved["content"]).slice(0, 20) : [] };
        }),
        notes: opNotes,
      });
    }
  }
  return { title: String(info["title"]).slice(0, 200), version: String(info["version"]).slice(0, 50), openapi: version, sha256: createHash("sha256").update(text).digest("hex"), operations, notes, doc };
}

/** Follows local refs (any component kind) for parameters/responses, bounded. */
function resolveLocal(doc: Record<string, unknown>, value: unknown, depth: number): unknown {
  if (!isObject(value) || typeof value["$ref"] !== "string") return value;
  if (depth >= CONTRACT_LIMITS.maxRefDepth) throw new ContractError("Reference chain exceeds the depth bound.", "bounds-exceeded");
  return resolveLocal(doc, pointer(doc, value["$ref"]), depth + 1);
}

function pointer(doc: Record<string, unknown>, ref: string): unknown {
  let current: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current) || !(key in current)) throw new ContractError(`Unresolvable local reference ${ref.slice(0, 120)}.`);
    current = current[key];
  }
  return current;
}

/**
 * Converts a response schema into the supported subset. Cycles and deep
 * reference chains become `unsupported` markers (never a silent pass); a
 * schema larger than the node bound is rejected.
 */
export function normalizeSchema(doc: Record<string, unknown>, schema: unknown): ContractSchema {
  const budget = { nodes: 0 };
  const walk = (node: unknown, refChain: string[]): ContractSchema => {
    if (++budget.nodes > CONTRACT_LIMITS.maxSchemaNodes) throw new ContractError(`The response schema exceeds ${CONTRACT_LIMITS.maxSchemaNodes} nodes.`, "bounds-exceeded");
    if (!isObject(node)) return { unsupported: ["non-object-schema"] };
    if (typeof node["$ref"] === "string") {
      const ref = node["$ref"];
      if (!ref.startsWith("#/components/schemas/")) return { unsupported: [`$ref:${ref.slice(0, 60)}`] };
      if (refChain.includes(ref)) return { unsupported: ["cyclic-$ref"] };
      if (refChain.length >= CONTRACT_LIMITS.maxRefDepth) return { unsupported: ["$ref-depth"] };
      return walk(pointer(doc, ref), [...refChain, ref]);
    }
    const out: ContractSchema = {};
    const unsupported = Object.keys(node).filter((k) => !STRUCTURAL.has(k) && !ANNOTATIONS.has(k) && !k.startsWith("x-"));
    const type = node["type"];
    if (typeof type === "string" && [...PRIMITIVES, "array", "object"].includes(type)) out.type = type as ContractSchema["type"];
    else if (type !== undefined) unsupported.push(`type:${String(type).slice(0, 30)}`);
    else if (!isObject(node["properties"]) && node["items"] === undefined && node["enum"] === undefined) unsupported.push("missing-type");
    else if (isObject(node["properties"])) out.type = "object";
    if (node["nullable"] === true) out.nullable = true;
    if (Array.isArray(node["enum"])) {
      const values = node["enum"].filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
      if (values.length !== node["enum"].length || values.length > 100) unsupported.push("enum:complex-values");
      else out.enum = values as ContractSchema["enum"];
    }
    if (isObject(node["properties"])) {
      out.properties = {};
      for (const [name, child] of Object.entries(node["properties"])) {
        if (name.length > 100 || !/^[^.\[\]]+$/.test(name)) { unsupported.push(`property-name:${name.slice(0, 30)}`); continue; }
        out.properties[name] = walk(child, refChain);
      }
    }
    if (Array.isArray(node["required"])) out.required = node["required"].filter((r): r is string => typeof r === "string").slice(0, 200);
    if (out.type === "array") {
      if (node["items"] === undefined) unsupported.push("array-without-items");
      else out.items = walk(node["items"], refChain);
    }
    if (unsupported.length) out.unsupported = unsupported.slice(0, 50);
    return out;
  };
  return walk(schema, []);
}

// --- Drafts ------------------------------------------------------------------------------------------

/** Shared with observation drafts (src/checks/observed-drafts.ts): explicit, non-secret test values only. */
export const PARAM_VALUE_RE = /^[A-Za-z0-9._~-]{1,100}$/;
export const SECRET_PARAM_RE = /token|password|passwd|secret|api[-_]?key|auth|session|cookie|signature|credential/i;

export const contractSelectionSchema = z.object({
  operation: z.string().min(3).max(300),
  status: z.string().regex(/^[1-5][0-9][0-9]$/).optional(),
  pathParams: z.record(z.string().max(100), z.string().max(100)).default({}),
  queryParams: z.record(z.string().max(100), z.string().max(100)).default({}),
}).strict();
export type ContractSelection = z.infer<typeof contractSelectionSchema>;

export type ContractCheckDraft = {
  executable: boolean;
  problems: string[];
  notes: string[];
  check?: {
    id: string;
    method: "GET";
    pathname: string;
    query?: Record<string, string>;
    description: string;
    assertions: { invariants: [] };
    contract: { source: string; documentSha256: string; operation: string; status: string; contentType: string | null; schema: ContractSchema | null };
  };
  operation: string;
};

const slug = (text: string): string => text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 60) || "OPERATION";

/**
 * Builds reviewable check drafts for explicitly selected operations. A draft
 * is `executable` only for GET operations whose concrete path, built from
 * explicit non-secret values, passes `inScope` (the profile's own origin and
 * path prefixes). Nothing is executed here.
 */
export function buildContractDrafts(contract: ParsedContract, source: string, selections: ContractSelection[], inScope: (pathname: string) => boolean): ContractCheckDraft[] {
  if (selections.length > 50) throw new ContractError("Select at most 50 operations at a time.", "invalid-selection");
  return selections.map((selection): ContractCheckDraft => {
    const op = contract.operations.find((o) => o.key === selection.operation);
    if (!op) return { executable: false, operation: selection.operation, problems: [`Operation ${selection.operation.slice(0, 120)} is not in the contract.`], notes: [] };
    const problems: string[] = [];
    const notes = [...contract.notes, ...op.notes];
    if (!op.readOnly) problems.push(`${op.method} operations cannot be approved: importing a contract never authorizes a mutation. Only GET is executable in this phase.`);
    let pathname = op.path;
    const query: Record<string, string> = {};
    for (const p of op.parameters) {
      if (!p.supported) { if (p.required) problems.push(`Required ${p.in} parameter "${p.name}" is not supported (only path and query parameters are).`); continue; }
      const provided = p.in === "path" ? selection.pathParams[p.name] : selection.queryParams[p.name];
      if (SECRET_PARAM_RE.test(p.name)) { problems.push(`Parameter "${p.name}" looks credential-bearing; contract checks accept only non-secret test values.`); continue; }
      if (provided === undefined || provided === "") { if (p.required) problems.push(`Provide an explicit test value for required ${p.in} parameter "${p.name}".`); continue; }
      if (!PARAM_VALUE_RE.test(provided)) { problems.push(`The value for "${p.name}" must be 1–${CONTRACT_LIMITS.maxParamValueLength} characters of letters, digits, ".", "_", "~" or "-".`); continue; }
      if (p.in === "path") pathname = pathname.replace(`{${p.name}}`, provided);
      else query[p.name] = provided;
    }
    const unknownPath = Object.keys(selection.pathParams).filter((k) => !op.parameters.some((p) => p.in === "path" && p.name === k));
    const unknownQuery = Object.keys(selection.queryParams).filter((k) => !op.parameters.some((p) => p.in === "query" && p.name === k));
    if (unknownPath.length || unknownQuery.length) problems.push(`Unknown parameter(s): ${[...unknownPath, ...unknownQuery].join(", ").slice(0, 200)}.`);
    if (/[{}]/.test(pathname)) problems.push("Not every path parameter has a value.");
    else if (!inScope(pathname)) problems.push(`${pathname} is outside the application's approved origin/path prefixes; nothing will be sent there.`);

    const status = selection.status ?? op.responses.map((r) => r.status).filter((s) => /^2\d\d$/.test(s)).sort()[0];
    if (!status || !op.responses.some((r) => r.status === status)) {
      problems.push(`No declared ${selection.status ?? "2xx"} response to assert.`);
      return { executable: false, operation: op.key, problems, notes };
    }
    const response = resolveLocal(contract.doc, (contract.doc["paths"] as Record<string, Record<string, Record<string, unknown>>>)[op.path]![op.method.toLowerCase()]!["responses"] as unknown, 0) as Record<string, unknown>;
    const resolvedResponse = resolveLocal(contract.doc, response[status], 0);
    const content = isObject(resolvedResponse) && isObject(resolvedResponse["content"]) ? resolvedResponse["content"] : {};
    const contentType = Object.keys(content).find((ct) => ct.split(";")[0]!.trim().toLowerCase() === "application/json") ?? Object.keys(content)[0] ?? null;
    let schema: ContractSchema | null = null;
    if (contentType) {
      const media = content[contentType];
      if (isObject(media) && media["schema"] !== undefined) {
        try { schema = normalizeSchema(contract.doc, media["schema"]); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
      }
      if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") notes.push(`Response content type ${contentType} is not JSON; only status and content type are asserted.`);
    } else notes.push("The response declares no content; only the status is asserted.");
    const id = `CONTRACT-${slug(op.operationId ?? `${op.method}-${op.path}`)}`;
    return {
      executable: problems.length === 0,
      operation: op.key,
      problems,
      notes,
      check: {
        id,
        method: "GET",
        pathname,
        ...(Object.keys(query).length ? { query } : {}),
        description: `Contract ${op.key} → ${status}${contentType ? ` ${contentType}` : ""} (${source}, ${contract.sha256.slice(0, 12)})`,
        assertions: { invariants: [] },
        contract: { source: source.slice(0, 200), documentSha256: contract.sha256, operation: op.key, status, contentType, schema },
      },
    };
  });
}

// --- Evaluation ------------------------------------------------------------------------------------------

type EvalInput = { status: number; contentType: string | undefined; body: unknown; jsonParseFailed?: boolean };
const typeName = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const matchesType = (type: ContractSchema["type"], v: unknown): boolean =>
  type === "integer" ? Number.isInteger(v) : type === "number" ? typeof v === "number" : type === "array" ? Array.isArray(v) : type === "object" ? isObject(v) : typeof v === type;

/**
 * Evaluates a response against an approved contract. Every assertion has a
 * stable id: `contract:status`, `contract:content-type`, `contract:json`,
 * `contract:<path>:required|type|enum|unsupported:<keyword>` with JSON paths
 * such as `$.balance.minorUnits` and `$.tags[*]`. The id set depends on the
 * schema only, never on the response data. Observations never contain
 * response values.
 */
export function evaluateContract(contract: NonNullable<ContractCheckDraft["check"]>["contract"], response: EvalInput): AssertionOutcome[] {
  const results: AssertionOutcome[] = [];
  const statusOk = String(response.status) === contract.status;
  results.push({ id: "contract:status", assertion: "Declared response status", expected: contract.status, observed: String(response.status), verdict: statusOk ? "pass" : "fail", reasonCode: statusOk ? "ok" : "assertion-failed" });
  if (contract.contentType) {
    const expected = contract.contentType.split(";")[0]!.trim().toLowerCase();
    const actual = (response.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    results.push({ id: "contract:content-type", assertion: "Declared content type", expected, observed: actual || "(none)", verdict: actual === expected ? "pass" : "fail", reasonCode: actual === expected ? "ok" : "assertion-failed" });
  }
  if (!contract.schema) return results;
  const jsonExpected = (contract.contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
  if (!jsonExpected) return results;
  const parsed = !response.jsonParseFailed && (response.contentType ?? "").toLowerCase().includes("application/json");
  results.push({ id: "contract:json", assertion: "Body is well-formed JSON", expected: "valid JSON", observed: response.jsonParseFailed ? "malformed JSON" : parsed ? "valid JSON" : "not a JSON response", verdict: parsed ? "pass" : "fail", reasonCode: parsed ? "ok" : response.jsonParseFailed ? "malformed-response" : "assertion-failed" });

  let steps = 0;
  const assess = (id: string, assertion: string, expected: string, check: () => { verdict: AssertionOutcome["verdict"]; observed: string }) => {
    if (!parsed) { results.push({ id, assertion, expected, observed: "body not validated (not well-formed JSON)", verdict: "not-assessed", reasonCode: "malformed-response" }); return; }
    if (++steps > CONTRACT_LIMITS.maxValidationSteps) { results.push({ id, assertion, expected, observed: "validation work bound reached", verdict: "unsupported", reasonCode: "bounds-exceeded" }); return; }
    const r = check();
    results.push({ id, assertion, expected, observed: r.observed, verdict: r.verdict, reasonCode: r.verdict === "pass" ? "ok" : r.verdict === "fail" ? "assertion-failed" : "unsupported-validation" });
  };

  /** Values at a JSON path: arrays expand to (bounded) elements; `absent` means the parent chain did not reach this node. */
  const walk = (schema: ContractSchema, path: string, values: () => { found: unknown[]; absent: boolean; note: string }) => {
    for (const keyword of schema.unsupported ?? []) {
      results.push({ id: `contract:${path}:unsupported:${keyword}`, assertion: `Schema keyword "${keyword}" at ${path}`, expected: "validated", observed: "not supported by this contract slice", verdict: "unsupported", reasonCode: "unsupported-validation", limitations: "This keyword is outside the documented OpenAPI 3.0 subset; it is never treated as a pass." });
    }
    if (schema.type) {
      assess(`contract:${path}:type`, `Type at ${path}`, `${schema.type}${schema.nullable ? " or null" : ""}`, () => {
        const { found, absent, note } = values();
        if (absent || !found.length) return { verdict: "pass", observed: note || "not present (allowed)" };
        const bad = found.findIndex((v) => !(v === null ? schema.nullable === true : matchesType(schema.type, v)));
        return bad < 0 ? { verdict: "pass", observed: `${found.length} value(s) match` } : { verdict: "fail", observed: `${found.length > 1 ? `element ${bad}: ` : ""}got ${typeName(found[bad])}` };
      });
    }
    if (schema.enum) {
      assess(`contract:${path}:enum`, `Allowed values at ${path}`, `one of ${schema.enum.length} declared values`, () => {
        const { found, absent, note } = values();
        if (absent || !found.length) return { verdict: "pass", observed: note || "not present (allowed)" };
        const bad = found.findIndex((v) => !(v === null && schema.nullable) && !schema.enum!.includes(v as string));
        return bad < 0 ? { verdict: "pass", observed: "all values declared" } : { verdict: "fail", observed: `${found.length > 1 ? `element ${bad}: ` : ""}value not in the declared set (${typeName(found[bad])}; value omitted)` };
      });
    }
    for (const name of schema.required ?? []) {
      assess(`contract:${path}.${name}:required`, `Required property ${path}.${name}`, "present", () => {
        const { found, absent, note } = values();
        const objects = found.filter(isObject);
        if (absent || !objects.length) return { verdict: "pass", observed: note || "parent not present (allowed)" };
        const bad = objects.findIndex((o) => !Object.prototype.hasOwnProperty.call(o, name));
        return bad < 0 ? { verdict: "pass", observed: "present" } : { verdict: "fail", observed: `${objects.length > 1 ? `element ${bad}: ` : ""}missing` };
      });
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      walk(child, `${path}.${name}`, () => {
        const parent = values();
        const found = parent.found.filter(isObject).filter((o) => Object.prototype.hasOwnProperty.call(o, name)).map((o) => o[name]);
        return { found, absent: parent.absent || !found.length, note: parent.absent ? parent.note : found.length ? "" : "not present (optional)" };
      });
    }
    if (schema.items) {
      walk(schema.items, `${path}[*]`, () => {
        const parent = values();
        const arrays = parent.found.filter(Array.isArray) as unknown[][];
        const all = arrays.flat();
        const found = all.slice(0, CONTRACT_LIMITS.maxArrayItemsChecked);
        const note = all.length > found.length ? `checked the first ${found.length} of ${all.length} elements` : "";
        return { found, absent: parent.absent || !all.length, note: parent.absent ? parent.note : all.length ? note : "array empty" };
      });
    }
  };
  walk(contract.schema, "$", () => ({ found: [response.body], absent: false, note: "" }));
  return results;
}
