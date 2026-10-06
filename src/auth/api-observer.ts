import { createHash } from "node:crypto";
import type { Page, Request, Response } from "playwright";

/**
 * Passive, structure-only record of the application's OWN API responses
 * during the authenticated part of a run. It never sends, replays, routes or
 * alters a request; it only listens to the page's response events.
 *
 * What it can and cannot bound (docs/research/PHASE13_API_OBSERVATION.md):
 * Playwright's Response.body() returns the whole decoded body at once (in
 * Chromium via CDP Network.getResponseBody, after the browser buffered it).
 * There is no partial read, so a size check after body() is not a memory
 * limit. The observer therefore calls body() only when the decoded size is
 * known BEFORE acquisition: the response finished, carries no content
 * coding, and request.sizes() reports that the whole response (headers +
 * body, the bytes actually received) is within the bound. With identity
 * coding the decoded body cannot exceed the bytes received; Playwright's
 * body-only figure is derived by subtracting a header estimate and was
 * observed to undercount chunked bodies, so it is not used alone. Compressed or unknown-size
 * responses are recorded as metadata only, with the omission stated.
 * Memory the browser itself uses to buffer network bodies is outside this
 * observer's control.
 *
 * Privacy: values, query values, cookies and headers are never kept. Field
 * names, query names and path segments are kept only when they are in a
 * small generic vocabulary or configured by the profile; everything else is
 * replaced positionally. This is heuristic: it reduces, but cannot
 * guarantee the absence of, personal data in names chosen by the
 * application. The output is an observation of samples, not an API contract.
 */
export const OBSERVER_LIMITS = {
  maxResponsesConsidered: 500,
  maxConcurrent: 4,
  maxQueue: 16,
  maxBodyBytes: 262_144,
  maxNodesVisited: 5_000,
  maxPropertiesPerObject: 50,
  maxArraySamples: 3,
  maxDepth: 6,
  maxPaths: 200,
  maxEndpoints: 30,
  maxPagesPerEndpoint: 5,
  maxQueryNames: 20,
  maxStringLength: 120,
  maxArtifactBytes: 262_144,
  drainTimeoutMs: 2_000,
  responseTimeoutMs: 5_000,
};
export type ObserverLimits = typeof OBSERVER_LIMITS;

export const OMISSION_REASONS = [
  "body-size-unknown-compressed",
  "body-size-unknown",
  "body-too-large",
  "body-size-mismatch",
  "body-unavailable",
  "not-json",
  "non-2xx",
  "malformed-json",
  "from-service-worker",
  "timeout",
  "interrupted",
  "queue-full",
  "nodes-limit",
  "properties-limit",
  "depth-limit",
  "array-sampled",
  "paths-limit",
  "page-attribution-uncertain",
] as const;
export type OmissionReason = (typeof OMISSION_REASONS)[number];

export type ShapeType = "string" | "integer" | "number" | "boolean" | "null" | "object" | "array";
export type ShapeEntry = { types: ShapeType[]; seenIn: number };
export type ObservedEndpoint = {
  origin: string;
  method: string;
  /** Sanitized route: approved templates verbatim; id-like segments `{id}`; unknown segments `{seg}`. */
  pathTemplate: string;
  /** True when the template contains `{seg}`: masked segments may merge different targets, so no executable draft. */
  ambiguous: boolean;
  /** True when more than one distinct raw path produced this template (only counted, never stored). */
  mergedDistinctPaths: boolean;
  queryNames: string[];
  statuses: number[];
  contentTypes: string[];
  seenOnPages: string[];
  observations: number;
  samplesWithBody: number;
  /** JSON path → types seen and in how many body samples. Masked names appear as `<field#n>` (position, not name). */
  shape: Record<string, ShapeEntry>;
  /** Array paths for which no element was ever observed: nothing is known about their element schema. */
  emptyArrays: string[];
  omissions: Array<{ reason: OmissionReason; count: number }>;
  fromServiceWorker: boolean;
};
export type ApiObservations = {
  schemaVersion: 2;
  label: string;
  limitations: string[];
  limits: ObserverLimits;
  origins: string[];
  endpoints: ObservedEndpoint[];
  responsesConsidered: number;
  responsesSkipped: Array<{ reason: OmissionReason | "responses-limit" | "endpoints-limit"; count: number }>;
  drain: "drained" | "drain-timeout" | "not-stopped";
  artifactTruncated: boolean;
};

export type ObservationVocabulary = { knownFields?: readonly string[]; routeTemplates?: readonly string[] };

/**
 * Generic API words kept as field / query / path names. These are names a
 * developer chooses for structure, not values; anything outside the list is
 * masked unless the profile configures it (apiObservation.knownFields).
 */
const GENERIC_WORDS = [
  "api", "id", "ids", "uuid", "key", "items", "item", "data", "result", "results", "records", "record", "list", "entries", "rows", "content",
  "page", "pages", "size", "limit", "offset", "cursor", "next", "previous", "prev", "first", "last", "total", "count", "number", "has", "more",
  "status", "state", "type", "kind", "name", "code", "label", "title", "description", "message", "error", "errors", "detail", "details",
  "success", "ok", "enabled", "active", "visible", "default", "meta", "metadata", "links", "link", "href", "url", "version", "locale", "language",
  "currency", "currencies", "country", "countries", "rate", "rates", "source", "target", "from", "to", "amount", "value", "fee", "fees",
  "date", "time", "created", "updated", "at", "timestamp", "start", "end", "sort", "order", "by", "filter", "query", "search", "summary",
  "account", "accounts", "available", "customer", "customers", "user", "users", "me", "auth", "session", "profile", "role", "roles",
  "email", "phone", "address", "transaction", "transactions", "transfer", "transfers", "payment", "payments", "bill", "bills", "biller", "billers",
  "beneficiary", "beneficiaries", "recipient", "recipients", "recent", "statement", "statements", "history", "company", "settings", "config",
  "per", "with", "of", "in", "is", "can", "min", "max", "flag", "flags", "category", "categories", "reference", "balance", "home", "health",
];
const GENERIC = new Set(GENERIC_WORDS);
const ID_LIKE_RE = /\d{3,}|@|^[0-9a-f]{8}-?[0-9a-f]{4}|^[0-9a-f]{16,}$|^[A-Za-z0-9+/_-]{24,}={0,2}$/i;
const VERSION_RE = /^v\d{1,2}$/i;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map((w) => w.toLowerCase());
}

/** A name is kept only when it is configured, or every word of it is generic vocabulary. */
export function isKnownName(name: string, configured: ReadonlySet<string> = new Set()): boolean {
  if (configured.has(name)) return true;
  if (!NAME_RE.test(name) || ID_LIKE_RE.test(name)) return false;
  const parts = words(name);
  return parts.length > 0 && parts.every((w) => GENERIC.has(w) || VERSION_RE.test(w));
}

function templateMatches(template: string, segments: string[]): boolean {
  const parts = template.split("/");
  return parts.length === segments.length && parts.every((p, i) => (/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(p) ? segments[i] !== "" : p === segments[i]));
}

/**
 * Sanitized route template. An approved template (profile
 * apiObservation.routeTemplates) is used verbatim; otherwise id-like
 * segments become `{id}`, generic words and versions are kept, and every
 * other segment (e.g. a name in a path) becomes `{seg}`.
 */
export function templatePath(pathname: string, routeTemplates: readonly string[] = []): string {
  const segments = pathname.split("/");
  const approved = routeTemplates.find((t) => templateMatches(t, segments));
  if (approved) return approved;
  return segments.map((seg, i) => {
    if (i === 0 && seg === "") return "";
    if (seg === "") return "";
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { return "{seg}"; }
    if (ID_LIKE_RE.test(decoded)) return "{id}";
    if (VERSION_RE.test(decoded) || isKnownName(decoded)) return decoded;
    return "{seg}";
  }).join("/").slice(0, OBSERVER_LIMITS.maxStringLength);
}

const MEDIA_TYPES = new Set(["application/json", "application/problem+json", "text/html", "text/plain", "text/css", "application/javascript", "text/javascript", "application/xml", "text/xml", "application/octet-stream", "application/pdf", "image/png", "image/jpeg", "image/svg+xml", "text/event-stream"]);

/** Media type only (parameters dropped), from a fixed list; anything else is "other". */
export function safeMediaType(header: string | undefined): string {
  const media = (header ?? "").split(";")[0]!.trim().toLowerCase();
  if (!media) return "";
  return MEDIA_TYPES.has(media) ? media : /^application\/[a-z0-9.-]+\+json$/.test(media) ? "application/*+json" : "other";
}

function isJsonMedia(media: string): boolean {
  return media === "application/json" || media === "application/problem+json" || media === "application/*+json";
}

function typeOf(value: unknown): ShapeType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

export type ShapeWalk = { paths: Map<string, Set<ShapeType>>; omissions: Set<OmissionReason>; nodesVisited: number };

/**
 * Walks a parsed JSON value into key paths and types. Work is bounded by a
 * node counter shared across the whole walk (so a wide object stops as
 * surely as a deep one), plus per-object property, array-sample, depth and
 * path limits. Each limit that cut the walk short is reported.
 */
export function walkShape(value: unknown, configuredFields: ReadonlySet<string> = new Set(), limits: ObserverLimits = OBSERVER_LIMITS): ShapeWalk {
  const walk: ShapeWalk = { paths: new Map(), omissions: new Set(), nodesVisited: 0 };
  const visit = (node: unknown, path: string, depth: number): void => {
    if (walk.nodesVisited >= limits.maxNodesVisited) { walk.omissions.add("nodes-limit"); return; }
    walk.nodesVisited++;
    if (!walk.paths.has(path)) {
      if (walk.paths.size >= limits.maxPaths) { walk.omissions.add("paths-limit"); return; }
      walk.paths.set(path, new Set());
    }
    walk.paths.get(path)!.add(typeOf(node));
    if (node === null || typeof node !== "object") return;
    if (depth >= limits.maxDepth) { walk.omissions.add("depth-limit"); return; }
    if (Array.isArray(node)) {
      if (node.length > limits.maxArraySamples) walk.omissions.add("array-sampled");
      for (let i = 0; i < node.length && i < limits.maxArraySamples; i++) visit(node[i], `${path}[*]`, depth + 1);
      return;
    }
    let position = 0;
    for (const key in node as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      if (position >= limits.maxPropertiesPerObject) { walk.omissions.add("properties-limit"); break; }
      const name = isKnownName(key, configuredFields) ? key : `<field#${position}>`;
      position++;
      visit((node as Record<string, unknown>)[key], `${path}.${name}`, depth + 1);
    }
  };
  visit(value, "$", 0);
  return walk;
}

export type BoundedBody = { ok: true; value: unknown } | { ok: false; reason: OmissionReason };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * Acquires a JSON body only when its decoded size is known to be within
 * the bound before acquisition (see the module comment). Shared by the
 * observer and the rendering-response UI–API comparison mode.
 */
export async function acquireBoundedJson(response: Response, limits: ObserverLimits = OBSERVER_LIMITS, cancelled: () => boolean = () => false, failed?: Promise<void>): Promise<BoundedBody> {
  if (response.fromServiceWorker()) return { ok: false, reason: "from-service-worker" };
  if (response.status() < 200 || response.status() >= 300) return { ok: false, reason: "non-2xx" };
  const headers = response.headers();
  if (!isJsonMedia(safeMediaType(headers["content-type"]))) return { ok: false, reason: "not-json" };
  const coding = (headers["content-encoding"] ?? "").trim().toLowerCase();
  if (coding && coding !== "identity") return { ok: false, reason: "body-size-unknown-compressed" };
  // finished() does not settle for a request that failed in transit; the caller's `failed` signal (requestfailed) ends the wait.
  const finished = await withTimeout(Promise.race([
    response.finished().catch((e: unknown) => (e instanceof Error ? e : new Error("failed"))),
    ...(failed ? [failed.then(() => new Error("request failed"))] : []),
  ]), limits.responseTimeoutMs);
  if (finished === "timeout") return { ok: false, reason: "timeout" };
  if (finished instanceof Error || cancelled()) return { ok: false, reason: "interrupted" };
  const sizes = await withTimeout(response.request().sizes().catch(() => undefined), limits.responseTimeoutMs);
  if (sizes === "timeout") return { ok: false, reason: "timeout" };
  const received = sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0;
  // Cache hits report a non-positive body size (observed in 1.62.1: -135 for a
  // memory-cache hit, 0 for a 304 revalidation whose cached body was 5 027 bytes),
  // so nothing received over the network bounds what body() would return.
  if (!sizes || !(sizes.responseBodySize > 0)) return { ok: false, reason: "body-size-unknown" };
  // Two independent figures must agree: a declared Content-Length that differs
  // from the bytes received means the received count does not describe the body.
  const declared = headers["content-length"];
  if (declared !== undefined && Number(declared) !== sizes.responseBodySize) return { ok: false, reason: "body-size-mismatch" };
  if (received > limits.maxBodyBytes) return { ok: false, reason: "body-too-large" };
  if (cancelled()) return { ok: false, reason: "interrupted" };
  const body = await withTimeout(response.body().catch(() => undefined), limits.responseTimeoutMs);
  if (body === "timeout") return { ok: false, reason: "timeout" };
  if (!body) return { ok: false, reason: "body-unavailable" };
  // Defence in depth: the size was established before acquisition; a body
  // that disagrees is discarded rather than trusted.
  if (body.byteLength > limits.maxBodyBytes || body.byteLength > received) return { ok: false, reason: "body-size-mismatch" };
  try { return { ok: true, value: JSON.parse(body.toString("utf8")) }; } catch { return { ok: false, reason: "malformed-json" }; }
}

type Slot = {
  entry: Omit<ObservedEndpoint, "shape" | "emptyArrays" | "omissions" | "mergedDistinctPaths" | "ambiguous">;
  shape: Map<string, { types: Set<ShapeType>; seenIn: number }>;
  omissions: Map<OmissionReason, number>;
  rawPaths: Set<string>;
};

const LIMITATIONS = [
  "Observed samples only: a field seen in every sample is not shown to be required, and observed values of a type do not define an enumeration.",
  "An array observed only empty provides no evidence about its element schema (listed under emptyArrays).",
  "Responses with content coding (gzip, br, ...) or unknown size are recorded as metadata only: the decoded size cannot be bounded before Playwright acquires the body, so no shape was extracted.",
  "Requests made by a service worker itself are not page events and are not observed; responses served by a service worker are recorded as metadata only. HTTP cache hits cannot be told apart from network responses.",
  "Names are kept only when generic or configured; masking is heuristic and cannot guarantee that no personal data appears in names the application chose.",
  "Browser-owned network buffering is outside the observer's limits.",
];

export class ApiObserver {
  private readonly limits: ObserverLimits;
  private readonly configuredFields: ReadonlySet<string>;
  private readonly routeTemplates: readonly string[];
  private readonly slots = new Map<string, Slot>();
  private readonly skipped = new Map<string, number>();
  private readonly requestPage = new WeakMap<Request, { page: string; navigation: number }>();
  private readonly failures = new WeakMap<Request, { signal: Promise<void>; fire: () => void }>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;
  private considered = 0;
  private navigations = 0;
  private accepting = false;
  /** Set when the drain window ran out: in-flight work then stops at its next step. */
  private drainExpired = false;
  private frozen: ApiObservations | undefined;
  private detach: (() => void) | undefined;

  constructor(
    private readonly apiOrigins: readonly string[],
    private readonly excluded: ReadonlyArray<{ origin: string; method: string; pathname: string }> = [],
    vocabulary: ObservationVocabulary = {},
    limits: Partial<ObserverLimits> = {}
  ) {
    this.limits = { ...OBSERVER_LIMITS, ...limits };
    this.configuredFields = new Set(vocabulary.knownFields ?? []);
    this.routeTemplates = vocabulary.routeTemplates ?? [];
  }

  /** Registers listeners on the page; observation itself starts only with start(). */
  attach(page: Page): void {
    const onRequest = (request: Request): void => {
      if (!this.accepting) return;
      this.requestPage.set(request, { page: this.pageRef(page.url()), navigation: this.navigations });
    };
    const onResponse = (response: Response): void => this.observe(response);
    const onNavigated = (frame: { parentFrame(): unknown }): void => { if (!frame.parentFrame()) this.navigations++; };
    const onFailed = (request: Request): void => this.failureOf(request).fire();
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("framenavigated", onNavigated);
    page.on("requestfailed", onFailed);
    this.detach = () => { page.off("request", onRequest); page.off("response", onResponse); page.off("framenavigated", onNavigated); page.off("requestfailed", onFailed); };
  }

  private failureOf(request: Request): { signal: Promise<void>; fire: () => void } {
    let entry = this.failures.get(request);
    if (!entry) {
      let fire = (): void => {};
      const signal = new Promise<void>((resolve) => { fire = resolve; });
      entry = { signal, fire };
      this.failures.set(request, entry);
    }
    return entry;
  }

  /** Called once authentication has succeeded: the sign-in exchange is never observed. */
  start(): void {
    if (!this.frozen) this.accepting = true;
  }

  private pageRef(url: string): string {
    try { return templatePath(new URL(url).pathname, this.routeTemplates); } catch { return "unattributed"; }
  }

  private skip(reason: string): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + 1);
  }

  private omit(slot: Slot, reason: OmissionReason): void {
    slot.omissions.set(reason, (slot.omissions.get(reason) ?? 0) + 1);
  }

  /** Synchronous intake: metadata is recorded immediately; body work is queued within the concurrency bound. */
  observe(response: Response): void {
    if (!this.accepting || this.frozen) return;
    const request = response.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    let url: URL;
    try { url = new URL(request.url()); } catch { return; }
    if (!this.apiOrigins.includes(url.origin)) return;
    if (this.excluded.some((e) => e.origin === url.origin && e.method === request.method() && e.pathname === url.pathname)) return;
    if (this.considered >= this.limits.maxResponsesConsidered) { this.skip("responses-limit"); return; }
    this.considered++;

    const pathTemplate = templatePath(url.pathname, this.routeTemplates);
    const key = `${url.origin} ${request.method()} ${pathTemplate}`;
    let slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= this.limits.maxEndpoints) { this.skip("endpoints-limit"); return; }
      slot = {
        entry: { origin: url.origin, method: request.method().slice(0, 10), pathTemplate, queryNames: [], statuses: [], contentTypes: [], seenOnPages: [], observations: 0, samplesWithBody: 0, fromServiceWorker: false },
        shape: new Map(), omissions: new Map(), rawPaths: new Set(),
      };
      this.slots.set(key, slot);
    }
    const e = slot.entry;
    e.observations++;
    // Only a digest of the raw path is held, in memory, to detect templates that merged distinct targets.
    if (slot.rawPaths.size < 2) slot.rawPaths.add(createHash("sha256").update(url.pathname).digest("hex"));
    let position = 0;
    for (const name of new Set(url.searchParams.keys())) {
      const safe = isKnownName(name, this.configuredFields) ? name : `<param#${position}>`;
      position++;
      if (!e.queryNames.includes(safe) && e.queryNames.length < this.limits.maxQueryNames) e.queryNames.push(safe);
    }
    if (!e.statuses.includes(response.status()) && e.statuses.length < 10) e.statuses.push(response.status());
    const media = safeMediaType(response.headers()["content-type"]);
    if (media && !e.contentTypes.includes(media) && e.contentTypes.length < 5) e.contentTypes.push(media);
    if (response.fromServiceWorker()) e.fromServiceWorker = true;
    const origin = this.requestPage.get(request);
    const pageRef = !origin ? "unattributed" : origin.page;
    if (origin && origin.navigation !== this.navigations) this.omit(slot, "page-attribution-uncertain");
    if (!e.seenOnPages.includes(pageRef) && e.seenOnPages.length < this.limits.maxPagesPerEndpoint) e.seenOnPages.push(pageRef);

    const work = async (): Promise<void> => {
      const body = await acquireBoundedJson(response, this.limits, () => this.drainExpired, this.failureOf(request).signal);
      if (this.frozen) return; // late completion after finalization changes nothing
      if (!body.ok) { this.omit(slot!, body.reason); return; }
      this.addSample(slot!, body.value);
    };
    if (this.running < this.limits.maxConcurrent) this.run(work);
    else if (this.queue.length < this.limits.maxQueue) this.queue.push(work);
    else this.omit(slot, "queue-full");
  }

  private run(work: () => Promise<void>): void {
    this.running++;
    const task = work().catch(() => {}).finally(() => {
      this.running--;
      this.inflight.delete(task);
      const next = this.accepting ? this.queue.shift() : undefined;
      if (next) this.run(next);
    });
    this.inflight.add(task);
  }

  private addSample(slot: Slot, value: unknown): void {
    const walk = walkShape(value, this.configuredFields, this.limits);
    slot.entry.samplesWithBody++;
    for (const [path, types] of walk.paths) {
      let entry = slot.shape.get(path);
      if (!entry) {
        if (slot.shape.size >= this.limits.maxPaths) { this.omit(slot, "paths-limit"); continue; }
        entry = { types: new Set(), seenIn: 0 };
        slot.shape.set(path, entry);
      }
      for (const t of types) entry.types.add(t);
      entry.seenIn++;
    }
    for (const reason of walk.omissions) this.omit(slot, reason);
  }

  /**
   * Stops observing: detaches listeners, refuses new work, waits for
   * in-flight work up to the drain timeout, then freezes the result. Queued
   * work that never started is recorded as interrupted.
   */
  async stop(): Promise<ApiObservations> {
    if (this.frozen) return this.frozen;
    this.accepting = false;
    this.detach?.();
    this.queue.splice(0).forEach(() => this.skip("interrupted"));
    const pending = [...this.inflight];
    const drained = pending.length === 0 ? "done" : await withTimeout(Promise.allSettled(pending).then(() => "done" as const), this.limits.drainTimeoutMs);
    this.drainExpired = drained !== "done";
    this.frozen = this.build(drained === "done" ? "drained" : "drain-timeout");
    return this.frozen;
  }

  /** The frozen result after stop(); before it, a provisional snapshot marked "not-stopped". */
  summary(): ApiObservations {
    return this.frozen ?? this.build("not-stopped");
  }

  private build(drain: ApiObservations["drain"]): ApiObservations {
    const endpoints: ObservedEndpoint[] = [...this.slots.values()].map((slot) => {
      const shape = Object.fromEntries([...slot.shape.entries()].map(([p, s]) => [p, { types: [...s.types].sort(), seenIn: s.seenIn }]));
      const emptyArrays = Object.entries(shape).filter(([p, s]) => s.types.includes("array") && !(`${p}[*]` in shape)).map(([p]) => p);
      return {
        ...slot.entry,
        statuses: [...slot.entry.statuses],
        contentTypes: [...slot.entry.contentTypes],
        queryNames: [...slot.entry.queryNames],
        seenOnPages: [...slot.entry.seenOnPages],
        ambiguous: slot.entry.pathTemplate.includes("{seg}"),
        mergedDistinctPaths: slot.rawPaths.size > 1,
        shape,
        emptyArrays,
        omissions: [...slot.omissions.entries()].map(([reason, count]) => ({ reason, count })),
      };
    });
    const result: ApiObservations = {
      schemaVersion: 2,
      label: "Observed structure of the application's own API responses during this run: names and types from samples, no values. Not an official API contract.",
      limitations: LIMITATIONS,
      limits: this.limits,
      origins: [...this.apiOrigins],
      endpoints,
      responsesConsidered: this.considered,
      responsesSkipped: [...this.skipped.entries()].map(([reason, count]) => ({ reason: reason as ApiObservations["responsesSkipped"][number]["reason"], count })),
      drain,
      artifactTruncated: false,
    };
    // Total artifact bound: drop the largest shapes first, saying so.
    const size = (): number => Buffer.byteLength(JSON.stringify(result));
    if (size() > this.limits.maxArtifactBytes) {
      result.artifactTruncated = true;
      for (const e of [...result.endpoints].sort((a, b) => Object.keys(b.shape).length - Object.keys(a.shape).length)) {
        e.shape = {};
        e.emptyArrays = [];
        if (size() <= this.limits.maxArtifactBytes) break;
      }
      while (size() > this.limits.maxArtifactBytes && result.endpoints.length) result.endpoints.pop();
    }
    return result;
  }

  /** One recorded endpoint (used to derive check drafts). */
  get(origin: string, method: string, pathTemplate: string): ObservedEndpoint | undefined {
    return this.summary().endpoints.find((e) => e.origin === origin && e.method === method && e.pathTemplate === pathTemplate);
  }
}
