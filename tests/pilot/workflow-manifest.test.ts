import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadWorkflowManifest,
  loadWorkflowStatus,
  saveWorkflowStatus,
  WorkflowManifestError,
} from "../../src/pilot/workflow-manifest.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoqa-workflow-manifest-test-"));
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  profileId: "orangehrm",
  pages: ["/web/index.php/dashboard/index", "/web/index.php/pim/viewEmployeeList"],
  workflows: [
    {
      id: "wf-search-employee",
      page: "/web/index.php/pim/viewEmployeeList",
      description: "Search the employee list by name",
      preconditions: "Authenticated session, employee list page loaded",
      authorizedActions: "Type a name into the search field, submit search",
      expectedOutcome: "The list filters to matching employees; no server error",
    },
  ],
};

describe("loadWorkflowManifest (2026-09-15 fix: a genuine declared-workflow manifest, previously entirely absent)", () => {
  it("is honestly undefined when no manifest file exists for the profile -- the common case", () => {
    const dir = tempDir();
    expect(loadWorkflowManifest(dir, "no-such-profile")).toBeUndefined();
  });

  it("loads and validates a real manifest file, <profileId>.workflows.json", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "orangehrm.workflows.json"), JSON.stringify(VALID_MANIFEST, null, 2), "utf-8");

    const manifest = loadWorkflowManifest(dir, "orangehrm");

    expect(manifest).toBeDefined();
    expect(manifest?.workflows).toHaveLength(1);
    expect(manifest?.workflows[0]?.id).toBe("wf-search-employee");
  });

  it("throws WorkflowManifestError (not a silent pass-through) for a manifest missing required fields", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "broken.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "broken" }), "utf-8");

    expect(() => loadWorkflowManifest(dir, "broken")).toThrow(WorkflowManifestError);
  });

  it("throws WorkflowManifestError for invalid JSON, not an unhandled crash", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "invalid.workflows.json"), "{not valid json", "utf-8");

    expect(() => loadWorkflowManifest(dir, "invalid")).toThrow(WorkflowManifestError);
  });
});

describe("saveWorkflowStatus / loadWorkflowStatus (2026-09-15 fix, mirrors human-review/triage.ts's exact runDir-scoped pattern)", () => {
  it("round-trips a recorded status", () => {
    const runDir = tempDir();
    saveWorkflowStatus(runDir, "wf-search-employee", "completed", ["screenshot.png"], "Search filtered correctly", "worked as expected");

    const loaded = loadWorkflowStatus(runDir);

    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.workflowId).toBe("wf-search-employee");
    expect(loaded.entries[0]?.status).toBe("completed");
    expect(loaded.entries[0]?.evidenceRefs).toEqual(["screenshot.png"]);
    expect(loaded.entries[0]?.humanReviewStatus).toBe("not-reviewed");
  });

  it("a re-record for the same workflow replaces the prior entry, not accumulates history (mirrors triage.ts)", () => {
    const runDir = tempDir();
    saveWorkflowStatus(runDir, "wf-1", "attempted");
    saveWorkflowStatus(runDir, "wf-1", "completed");

    const loaded = loadWorkflowStatus(runDir);

    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.status).toBe("completed");
  });

  it("rejects an invalid status rather than writing a broken file", () => {
    const runDir = tempDir();
    expect(() => saveWorkflowStatus(runDir, "wf-1", "not-a-real-status" as never)).toThrow(WorkflowManifestError);
  });

  it("returns an empty entries array when no status file exists yet", () => {
    const runDir = tempDir();
    expect(loadWorkflowStatus(runDir)).toEqual({ schemaVersion: 1, entries: [] });
  });

  it("redacts an env-derived credential embedded in notes before writing to disk (proves the write path genuinely goes through redactSecrets(), mirroring evidence.ts/triage.ts's existing idiom)", () => {
    const runDir = tempDir();
    const fakeSecret = "workflow_notes_secret_DO_NOT_USE_44120";
    process.env["QA_PASSWORD"] = fakeSecret;
    try {
      saveWorkflowStatus(runDir, "wf-1", "blocked", [], undefined, `login failed with ${fakeSecret}`);
      const raw = readFileSync(join(runDir, "workflow-status.json"), "utf-8");
      expect(raw).not.toContain(fakeSecret);
    } finally {
      delete process.env["QA_PASSWORD"];
    }
  });
});
