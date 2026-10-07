import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

/** A raw GET with an explicit Host header (fetch() does not allow overriding Host). */
function get(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

describe("local server Host check on reads", () => {
  it("refuses GET requests whose Host is not the loopback address (DNS rebinding), and serves loopback hosts", async () => {
    const root = mkdtempSync(join(tmpdir(), "autoqa-host-"));
    const runsDir = join(root, "runs");
    mkdirSync(join(runsDir, "RUN-20261007-000000000Z-abcd"), { recursive: true });
    writeFileSync(join(runsDir, "RUN-20261007-000000000Z-abcd", "run-summary.json"), "{}");
    const ui = await startServer({ port: 0, profilesDir: join(root, "profiles"), runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    const artifact = "/api/artifacts/RUN-20261007-000000000Z-abcd/run-summary.json";
    expect(await get(ui.port, artifact, `127.0.0.1:${ui.port}`)).toBe(200);
    expect(await get(ui.port, artifact, `localhost:${ui.port}`)).toBe(200);
    expect(await get(ui.port, artifact, `evil.example:${ui.port}`)).toBe(403);
    expect(await get(ui.port, "/api/profiles", `attacker.test:${ui.port}`)).toBe(403);
    expect(await get(ui.port, "/", `attacker.test:${ui.port}`)).toBe(403);
  });
});
