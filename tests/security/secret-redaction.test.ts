import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeCriticArtifact, writeFindingEvidence } from "../../src/evidence.js";
import { createLogger } from "../../src/logger.js";
import { credentialSecrets, redactSecrets } from "../../src/redact.js";
import { captureManifest } from "../../src/experiments/manifest.js";
import { exportForBlindReview } from "../../src/human-review/export.js";
import { loadTestConfig } from "../helpers/test-config.js";
import { observe, createPageRecords, attachPageRecorders } from "../../src/browser/observation.js";
import { parseProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { resolveArtifactPath } from "../../src/server/security.js";
import type { Finding } from "../../src/types.js";

const fakeCredential = "test_key_DO_NOT_USE_12345";
const originalCredential = process.env.EXPLABS_API_KEY;

afterEach(() => {
  if (originalCredential === undefined) delete process.env.EXPLABS_API_KEY;
  else process.env.EXPLABS_API_KEY = originalCredential;
});

describe("secret redaction", () => {
  it("redacts experimental credentials and authorization values", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const output = redactSecrets(`credential=${fakeCredential} Authorization: Bearer ${fakeCredential}`);

    expect(output).not.toContain(fakeCredential);
    expect(output).toContain("<REDACTED>");
  });

  it("does not persist an environment credential in critic evidence", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-redaction-test-"));
    const filename = writeCriticArtifact(evidenceDir, {
      provider: "explabs",
      verdict: "needs_human",
      confidence: 0,
      summary: fakeCredential,
      evidenceReferences: [],
      missingEvidence: [],
    });
    const saved = readFileSync(join(evidenceDir, filename), "utf-8");

    expect(saved).not.toContain(fakeCredential);
    expect(saved).toContain("<REDACTED>");
  });

  it("Phase 3 experiment manifest artifacts are redacted before persisting (same writeJsonRedacted idiom as evidence.ts)", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-redaction-manifest-test-"));
    mkdirSync(join(runDir, "findings", "FINDING-001"), { recursive: true });
    writeFileSync(join(runDir, "findings", "FINDING-001", "oracle.json"), "{}", "utf-8");

    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
      // A stray field that, if ever mistakenly populated from an env var
      // upstream, must still never survive to disk unredacted.
      explorerModel: fakeCredential,
    });

    const serialized = redactSecrets(JSON.stringify(manifest, null, 2));
    expect(serialized).not.toContain(fakeCredential);
    expect(serialized).toContain("<REDACTED>");
  });

  it("human-review blind export artifacts are redacted before persisting", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const leaky: Finding = {
      id: "FINDING-001",
      title: `New browser console error appears after form submission: ${fakeCredential}`,
      status: "validated",
      category: "console",
      pageId: "PAGE-001",
      url: "http://localhost:4173/form",
      pathname: "/form",
      expected: "e",
      actual: "a",
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
      steps: [],
      reproduction: { attempts: 3, successes: 3 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "report",
    };

    const { export: blindExport } = exportForBlindReview([leaky]);
    const serialized = redactSecrets(JSON.stringify(blindExport, null, 2));
    expect(serialized).not.toContain(fakeCredential);
    expect(serialized).toContain("<REDACTED>");
  });

  it("(Phase 4 Milestone D2) a blind review item's evidenceReferences are actually reachable through the sanitized artifact route, not just present as filenames", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-blind-reachability-test-"));
    const runId = "RUN-BLIND-TEST";
    const findingId = "FINDING-001";
    const evidenceDir = join(runsDir, runId, "findings", findingId);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "oracle.json"), "{}", "utf-8");
    writeFileSync(join(evidenceDir, "screenshot.png"), "fake-png-bytes", "utf-8");

    const reachable: Finding = {
      id: findingId,
      title: "t",
      status: "validated",
      category: "console",
      pageId: "PAGE-001",
      url: "http://localhost:4173/form",
      pathname: "/form",
      expected: "e",
      actual: "a",
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
      steps: [],
      reproduction: { attempts: 3, successes: 3 },
      occurrenceCount: 1,
      evidence: ["oracle.json", "screenshot.png"],
      evidenceLevel: "L3",
      reportDisposition: "report",
    };

    const { export: blindExport } = exportForBlindReview([reachable]);
    const item = blindExport.items[0]!;
    expect(item.findingSummary.evidenceReferences).toEqual(["oracle.json", "screenshot.png"]);

    // A rater's UI resolves each reference as findings/<opaque-but-real-on-disk-id>/<filename>
    // relative to the run -- reachability is checked here at the actual
    // artifact-route resolver (src/server/security.ts), not merely
    // asserted from the filename strings.
    for (const reference of item.findingSummary.evidenceReferences) {
      const resolved = resolveArtifactPath(runsDir, runId, join("findings", findingId, reference));
      expect(resolved).toBeDefined();
    }
  });
});

describe("Phase 4 Milestone A3: authenticated real-target secret hygiene", () => {
  const fakePassword = "test_password_DO_NOT_USE_98765";
  const originalPassword = process.env["QA_PASSWORD"];

  afterEach(() => {
    if (originalPassword === undefined) delete process.env["QA_PASSWORD"];
    else process.env["QA_PASSWORD"] = originalPassword;
  });

  let server: Server;
  let ORIGIN: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body>
        <input type="password" aria-label="Password" />
        <script>console.log("a log line, not the secret itself")</script>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    const port = (server.address() as AddressInfo).port;
    ORIGIN = `http://localhost:${port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a QA_PASSWORD env var value never survives to persisted finding evidence JSON", () => {
    process.env["QA_PASSWORD"] = fakePassword;
    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-auth-redaction-test-"));
    const config = loadTestConfig();

    const result = writeFindingEvidence(evidenceDir, config, {
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
      attempts: [],
      reproduction: { attempts: 1, successes: 1 },
      representativeAttempt: 1,
      evidenceCompleteness: "representative-success",
      // Simulates a console message or network record that happened to
      // capture the literal password value (e.g. a login form's own
      // client-side validation error echoing it back).
      consoleMessages: [{ type: "log", text: `login attempt with password=${fakePassword}`, timestamp: new Date().toISOString() }],
      networkRequests: [],
      pageErrors: [],
      visibleTextExcerpt: `password field contained ${fakePassword}`,
    });

    for (const filename of result.filenames) {
      const saved = readFileSync(join(evidenceDir, filename), "utf-8");
      expect(saved).not.toContain(fakePassword);
    }
  });

  it("trace capture is absent (not silently present) for a real-target profile by default", () => {
    const profile = parseProfile({
      schemaVersion: 1,
      id: "test-real-target-trace",
      name: "Test",
      target: { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" },
      navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });
    const config = profileToAppConfig(profile);
    expect(config.evidence.trace).toBe(false);

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-auth-redaction-trace-test-"));
    const result = writeFindingEvidence(evidenceDir, config, {
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
      attempts: [],
      reproduction: { attempts: 1, successes: 1 },
      representativeAttempt: 1,
      evidenceCompleteness: "representative-success",
      consoleMessages: [],
      networkRequests: [],
      pageErrors: [],
      visibleTextExcerpt: "",
      tracePath: join(evidenceDir, "trace.tmp.zip"), // even if a trace WAS somehow captured, config.evidence.trace=false must still keep it out
    });

    expect(result.filenames).not.toContain("trace.zip");
    expect(result.skipped.some((s) => s.includes("trace.zip"))).toBe(true);
  });

  it("the masking CSS is actually injected into the page before a screenshot is captured for an authenticated run", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const records = createPageRecords();
    attachPageRecorders(page, records);

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-auth-redaction-mask-test-"));
    const screenshotPath = join(evidenceDir, "screenshot.png");

    await observe(page, records, { screenshotPath, maskSecrets: true });

    const maskInjected = await page.evaluate(() => Boolean(document.getElementById("__autoqa_mask_style")));
    expect(maskInjected).toBe(true);

    const style = await page.evaluate(() => document.getElementById("__autoqa_mask_style")?.textContent ?? "");
    expect(style).toContain("input[type=password]");

    await context.close();
  });

  it("no masking CSS is injected when maskSecrets is not requested (fixture/unauthenticated runs unchanged)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const records = createPageRecords();
    attachPageRecorders(page, records);

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-no-mask-test-"));
    const screenshotPath = join(evidenceDir, "screenshot.png");

    await observe(page, records, { screenshotPath });

    const maskInjected = await page.evaluate(() => Boolean(document.getElementById("__autoqa_mask_style")));
    expect(maskInjected).toBe(false);

    await context.close();
  });

  // Phase 4 continuation: transient (UI-submitted, non-env) credential
  // redaction. Deliberately never assigned to process.env anywhere in this
  // suite -- this is the exact category of value the old redactSecrets()
  // (env-only) could never scrub: a password typed into the local UI's
  // login form and passed straight through as TransientCredentials.
  const transientUsername = "ui_submitted_user_98431";
  const transientPassword = "ui_submitted_pw_DO_NOT_USE_55219";

  it("credentialSecrets() extracts username+password and nothing when credentials are absent", () => {
    expect(credentialSecrets({ username: transientUsername, password: transientPassword })).toEqual([transientUsername, transientPassword]);
    expect(credentialSecrets(undefined)).toEqual([]);
  });

  it("redactSecrets() scrubs an extraSecrets value even though it was never in process.env", () => {
    expect(process.env["QA_PASSWORD"]).not.toBe(transientPassword);
    // Avoid a "password=..."-shaped string here -- the generic
    // authorization/token/password/secret keyword pattern (applied after
    // the extraSecrets substitution) would additionally rewrite the
    // <REDACTED_CREDENTIAL> placeholder itself into the generic
    // <REDACTED> label. That layered behavior is still safe (the real
    // value is gone either way); this test isolates the extraSecrets path
    // specifically, so it uses a value with no such keyword nearby.
    const output = redactSecrets(`login attempt used value ${transientPassword} twice`, [transientPassword]);
    expect(output).not.toContain(transientPassword);
    expect(output).toContain("<REDACTED_CREDENTIAL>");
  });

  it("a transient credential embedded in console/visible-text evidence is scrubbed from the persisted finding evidence files", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-transient-redaction-test-"));
    const extraSecrets = credentialSecrets({ username: transientUsername, password: transientPassword });

    const result = writeFindingEvidence(
      evidenceDir,
      loadTestConfig(),
      {
        oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
        attempts: [],
        reproduction: { attempts: 1, successes: 1 },
        representativeAttempt: 1,
        evidenceCompleteness: "representative-success",
        consoleMessages: [{ type: "log", text: `login attempt user=${transientUsername} password=${transientPassword}`, timestamp: new Date().toISOString() }],
        networkRequests: [],
        pageErrors: [{ message: `auth error for ${transientPassword}`, timestamp: new Date().toISOString() }],
        visibleTextExcerpt: `field contained ${transientPassword}`,
      },
      extraSecrets
    );

    for (const filename of result.filenames) {
      const saved = readFileSync(join(evidenceDir, filename), "utf-8");
      expect(saved).not.toContain(transientPassword);
      expect(saved).not.toContain(transientUsername);
    }
  });

  it("a transient credential is scrubbed from critic evidence via the same extraSecrets path", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-transient-critic-redaction-test-"));
    const extraSecrets = credentialSecrets({ username: transientUsername, password: transientPassword });

    const filename = writeCriticArtifact(
      evidenceDir,
      {
        provider: "mock",
        verdict: "needs_human",
        confidence: 0,
        summary: `saw password ${transientPassword} in the transcript`,
        evidenceReferences: [],
        missingEvidence: [],
      },
      extraSecrets
    );
    const saved = readFileSync(join(evidenceDir, filename), "utf-8");
    expect(saved).not.toContain(transientPassword);
  });

  it("createLogger() accepts extraSecrets and never throws building the redacting logger", () => {
    expect(() => createLogger(undefined, credentialSecrets({ username: transientUsername, password: transientPassword }))).not.toThrow();
  });

  it("attachPageRecorders()+observe() scrub a transient credential from console/page-error/visible-text at the moment they are first captured, not only at write time", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const records = createPageRecords();
    const extraSecrets = credentialSecrets({ username: transientUsername, password: transientPassword });
    attachPageRecorders(page, records, extraSecrets);

    await page.evaluate((pw: string) => console.log(`submitting value ${pw} now`), transientPassword);
    // give the async console event a moment to be delivered and recorded
    await page.waitForTimeout(100);

    expect(records.consoleMessages.some((m) => m.text.includes(transientPassword))).toBe(false);
    expect(records.consoleMessages.some((m) => m.text.includes("<REDACTED_CREDENTIAL>"))).toBe(true);

    const observation = await observe(page, records, {}, extraSecrets);
    expect(observation.visibleText).not.toContain(transientPassword);

    await context.close();
  });
});