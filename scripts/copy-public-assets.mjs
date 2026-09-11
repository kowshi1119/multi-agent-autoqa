// tsc only compiles .ts files -- the static UI page under src/server/public
// isn't copied to dist/ on its own. This script mirrors it there after
// every build, so `node dist/src/server/app.js` can find it at the same
// relative path its own __dirname resolves to.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(repoRoot, "src", "server", "public");
const dest = join(repoRoot, "dist", "src", "server", "public");

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
