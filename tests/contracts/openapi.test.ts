import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContractDrafts, ContractError, CONTRACT_LIMITS, evaluateContract, parseContract } from "../../src/contracts/openapi.js";
import { FIXTURE_ACCOUNTS } from "../../fixture/auth-server.js";

const accountsDoc = readFileSync("fixture/contracts/accounts.openapi.json", "utf-8");
const cyclicDoc = readFileSync("fixture/contracts/cyclic.openapi.json", "utf-8");
const inScope = (p: string) => p.startsWith("/api/") && !p.includes("..");
const minimal = (extra: Record<string, unknown> = {}) => JSON.stringify({ openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {}, ...extra });

describe("contract document validation", () => {
  it("lists operations, marks only GET as read-only, and treats servers as informational", () => {
    const c = parseContract(accountsDoc);
    expect(c.operations.map((o) => [o.key, o.readOnly])).toEqual([["GET /api/accounts/{accountId}", true], ["GET /api/statements", true], ["POST /api/transfer", false]]);
    expect(c.notes.join(" ")).toContain("informational only");
    expect(c.operations.find((o) => o.key === "GET /api/statements")?.notes.join(" ")).toContain("ignored (never contacted)");
    expect(c.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unsupported versions, remote references, non-JSON and oversized documents", () => {
    const err = (text: string) => { try { parseContract(text); return undefined; } catch (e) { return e as ContractError; } };
    expect(err(JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} }))?.code).toBe("unsupported-version");
    expect(err(JSON.stringify({ swagger: "2.0", info: { title: "t", version: "1" }, paths: {} }))?.code).toBe("unsupported-version");
    expect(err(minimal({ components: { schemas: { A: { $ref: "https://evil.example/schema.json" } } } }))?.code).toBe("remote-reference");
    expect(err(minimal({ components: { schemas: { A: { $ref: "other-file.json#/A" } } } }))?.code).toBe("remote-reference");
    expect(err("openapi: 3.0.0")?.message).toContain("not valid JSON");
    expect(err(" ".repeat(CONTRACT_LIMITS.maxDocumentBytes + 1))?.code).toBe("bounds-exceeded");
  });
});

describe("contract check drafts", () => {
  const c = parseContract(accountsDoc);

  it("builds an executable GET draft from explicit values; never from servers; POST never authorized", () => {
    const [account, transfer] = buildContractDrafts(c, "accounts.openapi.json", [
      { operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" }, queryParams: {} },
      { operation: "POST /api/transfer", pathParams: {}, queryParams: {} },
    ], inScope);
    expect(account).toMatchObject({ executable: true, check: { id: "CONTRACT-GETACCOUNT", method: "GET", pathname: "/api/accounts/acc-1", contract: { status: "200", contentType: "application/json" } } });
    expect(JSON.stringify(account!.check)).not.toContain("untrusted.example");
    expect(transfer!.executable).toBe(false);
    expect(transfer!.problems.join(" ")).toContain("never authorizes a mutation");
    // No assertion is derived from the contract's example values.
    expect(JSON.stringify(account!.check!.contract.schema)).not.toContain("Everyday");
  });

  it("requires explicit, non-secret, in-scope parameter values", () => {
    const draft = (pathParams: Record<string, string>) => buildContractDrafts(c, "a.json", [{ operation: "GET /api/accounts/{accountId}", pathParams, queryParams: {} }], inScope)[0]!;
    expect(draft({}).problems.join(" ")).toContain("Provide an explicit test value");
    expect(draft({ accountId: "a/b" }).problems.join(" ")).toContain("must be 1–100 characters");
    expect(draft({ accountId: ".." }).problems.join(" ")).toContain("outside the application's approved origin/path prefixes");
    const secretDoc = parseContract(JSON.stringify({ openapi: "3.0.1", info: { title: "t", version: "1" }, paths: { "/api/x": { get: { parameters: [{ name: "api_key", in: "query", required: true }], responses: { "200": { description: "ok" } } } } } }));
    expect(buildContractDrafts(secretDoc, "s.json", [{ operation: "GET /api/x", pathParams: {}, queryParams: { api_key: "abc" } }], inScope)[0]!.problems.join(" ")).toContain("credential-bearing");
  });

  it("keeps unsupported keywords and cycles as unsupported markers, and bounds schema size", () => {
    const statements = buildContractDrafts(c, "a.json", [{ operation: "GET /api/statements", pathParams: {}, queryParams: {} }], inScope)[0]!;
    expect(statements.executable).toBe(true);
    expect(statements.check!.contract.schema!.properties!["items"]!.items!.unsupported).toEqual(["oneOf", "missing-type"]);
    const cyclic = buildContractDrafts(parseContract(cyclicDoc), "c.json", [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" }, queryParams: {} }], inScope)[0]!;
    expect(cyclic.check!.contract.schema!.properties!["parent"]!.unsupported).toEqual(["cyclic-$ref"]);
    // A long chain of local references is cut at the depth bound and reported, never followed indefinitely.
    const chain = Object.fromEntries(Array.from({ length: CONTRACT_LIMITS.maxRefDepth + 4 }, (_, i) => [`S${i}`, i === CONTRACT_LIMITS.maxRefDepth + 3 ? { type: "string" } : { $ref: `#/components/schemas/S${i + 1}` }]));
    const chainDoc = parseContract(JSON.stringify({ openapi: "3.0.2", info: { title: "t", version: "1" }, components: { schemas: chain }, paths: { "/api/c": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } } } } } } }));
    const chainDraft = buildContractDrafts(chainDoc, "c.json", [{ operation: "GET /api/c", pathParams: {}, queryParams: {} }], inScope)[0]!;
    expect(chainDraft.check!.contract.schema!.unsupported).toEqual(["$ref-depth"]);
    const huge = Object.fromEntries(Array.from({ length: CONTRACT_LIMITS.maxSchemaNodes + 5 }, (_, i) => [`p${i}`, { type: "string" }]));
    const hugeDoc = parseContract(JSON.stringify({ openapi: "3.0.2", info: { title: "t", version: "1" }, paths: { "/api/h": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: huge } } } } } } } } }));
    const hugeDraft = buildContractDrafts(hugeDoc, "h.json", [{ operation: "GET /api/h", pathParams: {}, queryParams: {} }], inScope)[0]!;
    expect(hugeDraft.executable).toBe(false);
    expect(hugeDraft.problems.join(" ")).toContain("exceeds");
  });
});

describe("contract evaluation", () => {
  const draft = buildContractDrafts(parseContract(accountsDoc), "a.json", [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" }, queryParams: {} }], inScope)[0]!;
  const contract = draft.check!.contract;
  const run = (body: unknown, extra: Partial<{ status: number; contentType: string; jsonParseFailed: boolean }> = {}) => evaluateContract(contract, { status: 200, contentType: "application/json", body, ...extra });
  const verdict = (results: ReturnType<typeof run>, id: string) => results.find((r) => r.id === id)?.verdict;
  const healthy = () => structuredClone(FIXTURE_ACCOUNTS["acc-1"]) as Record<string, unknown>;

  it("passes a valid body with nested, nullable and array values; ids depend on the schema only", () => {
    const ok = run(healthy());
    expect(ok.filter((r) => r.verdict !== "pass")).toEqual([]);
    expect(ok.map((r) => r.id)).toEqual(expect.arrayContaining(["contract:status", "contract:content-type", "contract:json", "contract:$.balance.minorUnits:type", "contract:$.status:enum", "contract:$.nickname:type", "contract:$.tags[*]:type", "contract:$.balance:required", "contract:$.balance.currency:required"]));
    const other = run({ ...healthy(), nickname: "set", tags: ["a", "b"] });
    expect(other.map((r) => r.id)).toEqual(ok.map((r) => r.id));
  });

  it("detects missing fields, wrong types and enum values without echoing response values", () => {
    const missing = healthy(); delete missing["status"];
    expect(verdict(run(missing), "contract:$.status:required")).toBe("fail");
    const wrongType = healthy(); (wrongType["balance"] as Record<string, unknown>)["minorUnits"] = "1250";
    const typeResult = run(wrongType).find((r) => r.id === "contract:$.balance.minorUnits:type")!;
    expect(typeResult).toMatchObject({ verdict: "fail", observed: "got string" });
    const badEnum = { ...healthy(), status: "frozen-secret-value" };
    const enumResult = run(badEnum).find((r) => r.id === "contract:$.status:enum")!;
    expect(enumResult.verdict).toBe("fail");
    expect(JSON.stringify(run(badEnum))).not.toContain("frozen-secret-value");
    expect(verdict(run({ ...healthy(), nickname: 5 }), "contract:$.nickname:type")).toBe("fail");
  });

  it("separates unexpected content types, malformed JSON and unsupported validation; none of them pass", () => {
    const html = run("<p>Account</p>", { contentType: "text/html" });
    expect(verdict(html, "contract:content-type")).toBe("fail");
    expect(verdict(html, "contract:json")).toBe("fail");
    const malformed = run('{"id": ', { jsonParseFailed: true });
    expect(malformed.find((r) => r.id === "contract:json")).toMatchObject({ verdict: "fail", reasonCode: "malformed-response" });
    expect(verdict(malformed, "contract:$.balance.minorUnits:type")).toBe("not-assessed");
    const statements = buildContractDrafts(parseContract(accountsDoc), "a.json", [{ operation: "GET /api/statements", pathParams: {}, queryParams: {} }], inScope)[0]!.check!.contract;
    const unsupported = evaluateContract(statements, { status: 200, contentType: "application/json", body: { owner: "demo-a", items: [{ id: "st-1" }] } });
    expect(unsupported.filter((r) => r.verdict === "unsupported").map((r) => r.id)).toEqual(["contract:$.items[*]:unsupported:oneOf", "contract:$.items[*]:unsupported:missing-type"]);
    expect(unsupported.some((r) => r.verdict === "fail")).toBe(false);
  });
});
