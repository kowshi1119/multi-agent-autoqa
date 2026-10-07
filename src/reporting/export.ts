import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { EVIDENCE_POLICY_VERSION, readPolicyFile, stopReasonCode } from "../privacy/evidence-policy.js";
import { resolveArtifactPath } from "../server/security.js";

/**
 * Safe local export of one run (docs/privacy/EVIDENCE_POLICY.md).
 *
 * The export is a PROJECTION built from an allow-list of fields in known
 * artifact types; no file is copied and the run directory is never zipped.
 * It contains identifiers, verdicts, reason codes, counts, revisions and
 * hashes. Free text is included only where the run's own policy already
 * minimized it, and approved configuration labels only on request.
 * Binary and unknown artifacts are listed as excluded, with reasons.
 * Nothing is sent anywhere: the result is two local files.
 *
 * Wording: "sanitized under evidence-policy/1", never "free of personal data".
 */
export type ExportClassification = "minimal" | "diagnostic" | "legacy";
export type ExportCategory = { artifact: string; disposition: "projected" | "counts-only" | "omitted" | "excluded"; reason: string };
export type ExportOptions = { includeApprovedLabels?: boolean };

type Json = Record<string, unknown>;
const RUN_ID_RE = /^RUN-[A-Za-z0-9-]{1,80}$/;
const MAX_FILES_LISTED = 2_000;

export class ExportError extends Error {
  constructor(message: string, readonly code: "not-found" | "invalid" | "incomplete") {
    super(message);
    this.name = "ExportError";
  }
}

const KNOWN: Array<{ match: RegExp; disposition: ExportCategory["disposition"]; reason: string }> = [
  { match: /^suite-result\.json$/, disposition: "projected", reason: "Suite decision and items: identities, verdicts, reason codes, attempts, definition hashes." },
  { match: /^suite-comparison\.json$/, disposition: "projected", reason: "Baseline comparison: identities and change categories." },
  { match: /^requirement-coverage\.json$/, disposition: "projected", reason: "Requirement and criterion identities, revisions and statuses." },
  { match: /^check-results\.json$/, disposition: "projected", reason: "Check identities, verdicts and reason codes." },
  { match: /^run-summary\.json$/, disposition: "projected", reason: "Run status, times, counts and the stop-reason code." },
  { match: /^evidence-policy\.json$/, disposition: "projected", reason: "Policy version, mode and generation failures." },
  { match: /^suite-run\.json$/, disposition: "projected", reason: "Suite identity and revision." },
  { match: /^api-observations\.json$/, disposition: "counts-only", reason: "Endpoint and response counts only; route templates stay local." },
  { match: /^check-usage\.json$/, disposition: "counts-only", reason: "Request counts only." },
  { match: /^(report\.json|report\.md|application-map\.json|grouping\.json)$/, disposition: "omitted", reason: "Application map and findings stay local; the projection carries their verdicts." },
  { match: /^(qa-summary\.json|pilot-summary(\.latest)?\.json|coverage-report\.(json|md)|workflow-status\.json|triage\.json)$/, disposition: "omitted", reason: "Narrative summaries stay local; the projection carries their structured content." },
  { match: /^(workflow-manifest\.json|authentication\.json|auth-mechanism\.json|benchmark\.json|phase2-metrics\.json)$/, disposition: "omitted", reason: "Configuration and diagnostics stay local." },
  { match: /^run\.log$/, disposition: "omitted", reason: "Logs stay local." },
  { match: /^workflows\/[^/]+\.json$/, disposition: "omitted", reason: "Per-workflow records stay local; verdicts are in the suite items." },
  { match: /^findings\/[^/]+\/[^/]+\.json$/, disposition: "omitted", reason: "Per-finding evidence stays local." },
  { match: /^checks\/[^/]+\/[^/]+\.json$/, disposition: "omitted", reason: "Per-check evidence stays local; verdicts are in the check ledger." },
  { match: /\.(png|jpe?g|webp|zip|webm|har)$/i, disposition: "excluded", reason: "binary-unsupported: images, traces and archives are not sanitized by this export (JSON minimization does not reach their contents)." },
];

/** Known disposition for a run-relative path, or "excluded: unknown-type" -- unknown artifacts are never included. */
export function categorize(relativePath: string): ExportCategory {
  const known = KNOWN.find((k) => k.match.test(relativePath));
  return known ? { artifact: relativePath, disposition: known.disposition, reason: known.reason } : { artifact: relativePath, disposition: "excluded", reason: "unknown-type: not a recognised artifact, so it is not included." };
}

/** Lists the run's files without following symbolic links or junctions (those are reported, never read). */
function listRunFiles(runDir: string): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (files.length + links.length >= MAX_FILES_LISTED) return;
      const path = join(dir, name);
      const rel = relative(runDir, path).split(sep).join("/");
      if (rel === "exports" || rel.startsWith("exports/")) continue; // earlier exports are not inputs
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push(rel);
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(rel);
    }
  };
  walk(runDir);
  return { files: files.sort(), links: links.sort() };
}

const readJson = (runDir: string, name: string): Json | undefined => {
  const path = join(runDir, name);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return undefined;
  try { return JSON.parse(readFileSync(path, "utf-8")) as Json; } catch { return undefined; }
};

const pick = (source: Json | undefined, keys: string[]): Json => Object.fromEntries(keys.filter((k) => source && source[k] !== undefined).map((k) => [k, source![k]]));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 120): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** The projection. Text fields are included only for minimal-policy runs (already minimized) or as approved labels on request. */
export function buildExportData(runsRoot: string, runId: string, options: ExportOptions = {}) {
  if (!RUN_ID_RE.test(runId)) throw new ExportError("Invalid run ID.", "invalid");
  const runDir = resolveArtifactPath(runsRoot, runId, ".");
  if (!runDir) throw new ExportError("That run does not exist.", "not-found");
  const policy = readPolicyFile(runDir);
  const classification: ExportClassification = !policy ? "legacy" : policy.mode === "minimal" ? "minimal" : "diagnostic";
  const textAllowed = classification === "minimal";
  const labels = Boolean(options.includeApprovedLabels);
  const { files, links } = listRunFiles(runDir);

  const summary = readJson(runDir, "run-summary.json");
  const suiteRun = readJson(runDir, "suite-run.json");
  const suiteResult = readJson(runDir, "suite-result.json");
  const comparison = readJson(runDir, "suite-comparison.json");
  // requirement-coverage.json is { coverage: RequirementCoverage, comparison }.
  const coverage = readJson(runDir, "requirement-coverage.json")?.["coverage"] as Json | undefined;
  const ledger = readJson(runDir, "check-results.json");
  const observations = readJson(runDir, "api-observations.json");
  const usage = readJson(runDir, "check-usage.json");

  const suite = suiteRun?.["suite"] as Json | undefined;
  const items = (suiteResult?.["items"] as Json[] | undefined) ?? [];
  const missing: string[] = [];
  if (!summary) missing.push("run-summary.json");
  if (suiteRun && !suiteResult) missing.push("suite-result.json");

  const data = {
    run: {
      runId,
      status: str(summary?.["status"], 20),
      startedAt: str(summary?.["startedAt"], 40),
      finishedAt: str(summary?.["finishedAt"], 40),
      stopReasonCode: stopReasonCode(typeof summary?.["stopReason"] === "string" ? summary["stopReason"] as string : undefined) ?? null,
      actionsPerformed: num(summary?.["actionsPerformed"]),
    },
    suite: suite ? { id: str(suite["id"], 64), revision: num(suite["revision"]), contentHash: str(suite["contentHash"], 64), ...(labels ? { name: str(suite["name"], 120) } : {}) } : null,
    assessment: suiteResult ? {
      decision: str(suiteResult["decision"], 20),
      authentication: str(suiteResult["authentication"], 30),
      counts: suiteResult["counts"] ?? null,
      coverageGaps: ((suiteResult["coverageGaps"] as Json[] | undefined) ?? []).map((g) => pick(g, ["identity", "status", "reasonCode"])),
      items: items.map((i): Json => ({
        ...pick(i, ["identity", "kind", "itemId", "required", "status", "reasonCode", "attempts", "reproduced", "definitionHash"]),
        assertions: ((i["assertions"] as Json[] | undefined) ?? []).map((a) => ({
          ...pick(a, ["id", "identity", "verdict", "reasonCode", "passed"]),
          ...(textAllowed ? { observed: str(a["observed"], 200) } : {}),
          ...(labels ? { expected: str(a["expected"], 200) } : {}),
        })),
      })),
    } : null,
    comparison: comparison ? {
      comparable: comparison["comparable"] ?? null,
      baselineRunId: str((comparison["baseline"] as Json | undefined)?.["runId"], 80),
      counts: comparison["counts"] ?? null,
      entries: ((comparison["entries"] as Json[] | undefined) ?? []).map((e) => pick(e, ["identity", "category", "required"])),
    } : null,
    requirements: coverage ? ((coverage["requirements"] as Json[] | undefined) ?? []).map((r): Json => ({
      ...pick(r, ["requirementId", "revision", "importance", "status"]),
      ...(labels ? { title: str(r["title"], 200) } : {}),
      criteria: ((r["criteria"] as Json[] | undefined) ?? []).map((c) => pick(c, ["identity", "required", "status"])),
    })) : null,
    checks: ledger ? ((ledger["entries"] as Json[] | undefined) ?? []).map((e): Json => ({
      ...pick(e, ["checkId", "kind", "ran", "classification", "reasonCode", "attempts"]),
      assertions: ((e["assertionResults"] as Json[] | undefined) ?? []).map((a) => pick(a, ["id", "verdict", "reasonCode", "passed"])),
    })) : null,
    observation: observations ? { endpoints: Array.isArray(observations["endpoints"]) ? (observations["endpoints"] as unknown[]).length : null, responsesConsidered: num(observations["responsesConsidered"]), drain: str(observations["drain"], 20) } : null,
    checkRequests: usage ? num(usage["requests"]) : null,
  };

  const categories = [...files.map(categorize), ...links.map((l) => ({ artifact: l, disposition: "excluded" as const, reason: "symbolic link or junction: never followed." }))];
  const generationFailures = policy?.generationFailures ?? [];
  const evidenceComplete = missing.length === 0 && generationFailures.length === 0;
  const manifest = {
    schemaVersion: 1 as const,
    sanitizedUnder: EVIDENCE_POLICY_VERSION,
    statement: `Sanitized under ${EVIDENCE_POLICY_VERSION}: a projection of allow-listed fields. It is not a guarantee that no personal information remains.`,
    source: { runId, classification, runPolicy: policy ? { version: policy.policyVersion, mode: policy.mode } : null, ...(classification === "legacy" ? { note: "Legacy run: written before evidence policies (privacy-unclassified). Its original files are unchanged and stay local; only structured fields are exported." } : classification === "diagnostic" ? { note: "Diagnostic run: its local files may contain page text, so only structured fields are exported." } : {}) },
    options: { includeApprovedLabels: labels },
    assessmentStatus: suiteResult ? `suite ${String(suiteResult["decision"])}` : `run ${String(summary?.["status"] ?? "unknown")}`,
    evidenceCompleteness: { complete: evidenceComplete, missing, generationFailures },
    included: categories.filter((c) => c.disposition === "projected" || c.disposition === "counts-only"),
    omitted: categories.filter((c) => c.disposition === "omitted"),
    excluded: categories.filter((c) => c.disposition === "excluded"),
    textPolicy: textAllowed ? "Observed text included only as already minimized by the run's policy." : "No observed text included (run is legacy or diagnostic).",
  };
  return { manifest, data };
}

/** Markdown-inert text: control characters removed, newlines folded, Markdown/HTML metacharacters escaped (no links, images or tags can form). */
export function escapeMarkdown(value: unknown): string {
  const text = value === null || value === undefined ? "—" : String(value);
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&"']/g, (c) => `\\${c}`)
    .slice(0, 300);
}

export function renderExportMarkdown(exported: ReturnType<typeof buildExportData>): string {
  const { manifest: m, data: d } = exported;
  const e = escapeMarkdown;
  const lines: string[] = [];
  lines.push(`# AutoQA run export — sanitized under ${e(m.sanitizedUnder)}`, "", e(m.statement), "");
  lines.push(`Run ${e(d.run.runId)} · status ${e(d.run.status)} · ${e(m.source.classification)} run · assessment ${e(m.assessmentStatus)} · evidence ${m.evidenceCompleteness.complete ? "complete" : "incomplete"}`, "");
  if ("note" in m.source) lines.push(`> ${e(m.source.note)}`, "");
  if (d.suite) lines.push(`Suite ${e(d.suite.id)} revision ${e(d.suite.revision)}${"name" in d.suite ? ` (${e(d.suite.name)})` : ""}`, "");
  if (d.assessment) {
    lines.push(`## Decision: ${e(d.assessment.decision)}`, "", "| Item | Required | Status | Reason |", "|---|---|---|---|");
    for (const i of d.assessment.items) lines.push(`| ${e(i["identity"])} | ${e(i["required"])} | ${e(i["status"])} | ${e(i["reasonCode"])} |`);
    lines.push("");
  }
  if (d.comparison) {
    lines.push("## Baseline comparison", "", `Comparable: ${e(d.comparison.comparable)} · baseline ${e(d.comparison.baselineRunId)}`, "");
    for (const c of d.comparison.entries) lines.push(`- ${e(c["identity"])}: ${e(c["category"])}`);
    lines.push("");
  }
  if (d.requirements) {
    lines.push("## Requirements", "");
    for (const r of d.requirements) lines.push(`- ${e(r["requirementId"])} rev ${e(r["revision"])}: ${e(r["status"])}${"title" in r ? ` (${e(r["title"])})` : ""}`);
    lines.push("");
  }
  if (d.checks?.length) {
    lines.push("## Checks", "");
    for (const c of d.checks) lines.push(`- ${e(c["checkId"])} (${e(c["kind"])}): ${e(c["classification"])}, ${e(c["reasonCode"])}`);
    lines.push("");
  }
  lines.push("## Artifacts", "", "| Artifact | Disposition | Reason |", "|---|---|---|");
  for (const c of [...m.included, ...m.omitted, ...m.excluded]) lines.push(`| ${e(c.artifact)} | ${e(c.disposition)} | ${e(c.reason)} |`);
  lines.push("");
  return lines.join("\n");
}

/** Writes export.json and export.md under runs/<id>/exports/<EXP-…>/ and returns their run-relative paths. */
export function writeExport(runsRoot: string, runId: string, options: ExportOptions = {}, now = new Date()) {
  const exported = buildExportData(runsRoot, runId, options);
  const exportId = `EXP-${now.toISOString().replace(/[-:.]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex")}`;
  const runDir = resolveArtifactPath(runsRoot, runId, ".")!;
  const dir = join(runDir, "exports", exportId);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({ ...exported, exportId, exportedAt: now.toISOString() }, null, 2);
  writeFileSync(join(dir, "export.json"), json, "utf-8");
  writeFileSync(join(dir, "export.md"), renderExportMarkdown(exported), "utf-8");
  return { exportId, files: [`exports/${exportId}/export.json`, `exports/${exportId}/export.md`], manifest: exported.manifest };
}
