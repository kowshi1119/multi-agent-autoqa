import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ESM equivalent of CommonJS's `require.main === module` -- true only when
 * this module was the actual script Node was invoked with (`node
 * dist/src/foo.js`), false when it was merely `import`ed by something else
 * (e.g. a test file pulling in a few exported helpers). Every CLI entry
 * point (index.ts, benchmark.ts, phase2-experiment.ts, phase3-experiment.ts)
 * must guard its top-level `main().catch(...)` call with this, or importing
 * the module for its other exports launches a real browser/fixture server
 * as a side effect -- confirmed as a live bug: importing phase2-experiment.ts
 * from a unit test used to do exactly this.
 *
 * A naive `fileURLToPath(import.meta.url) === process.argv[1]` comparison
 * is unreliable: `process.argv[1]` is whatever was typed on the command
 * line (e.g. the relative "dist/src/foo.js" from a package.json script),
 * while fileURLToPath() always returns an absolute, OS-native path -- they
 * would never be strictly equal even in the genuine entry-point case, on
 * any platform. Resolving argv[1] through realpathSync() first (absolute,
 * symlink-resolved, OS-native separators) before comparing is Node's own
 * documented idiom for this exact check.
 */
export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
