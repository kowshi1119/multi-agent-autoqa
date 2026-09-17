import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.js";
import { parseProfile, ProfileError, type ProjectProfile } from "./schema.js";

/**
 * Profiles never contain secrets (see schema.ts), but every write still
 * goes through redactSecrets() first -- the same defense-in-depth idiom
 * evidence.ts#writeJson and export-cli.ts use for every other artifact
 * writer, applied here even though the happy path never needs it.
 */
export class ProfileStore {
  constructor(private readonly dir: string) {}

  /** Where a sibling `<id>.workflows.json` declared-workflow manifest (see src/pilot/workflow-manifest.ts) would live, if the profile has one. */
  getDir(): string {
    return this.dir;
  }

  private pathFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ProfileError("Invalid profile ID");
    return join(this.dir, `${id}.json`);
  }

  list(): ProjectProfile[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".workflows.json"))
      .map((f) => this.load(f.replace(/\.json$/, "")));
  }

  load(id: string): ProjectProfile {
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      throw new ProfileError(`AutoQA profile error\n\nNo profile found with id "${id}" at ${path}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new ProfileError(`AutoQA profile error\n\nInvalid JSON in ${path}\n${cause}`);
    }
    return parseProfile(raw);
  }

  save(profile: ProjectProfile): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(profile.id), redactSecrets(JSON.stringify(profile, null, 2)), "utf-8");
  }
}
