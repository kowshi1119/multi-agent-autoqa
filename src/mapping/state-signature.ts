import { createHash } from "node:crypto";
import type { InteractiveElement } from "../types.js";

/**
 * URL pathname only — no query string or fragment, empty normalizes to "/".
 * Case is preserved (not lowercased): pathnames are case-sensitive on most
 * real servers, and silently folding case risks conflating distinct routes.
 * This is the single normalization rule shared by the page mapper (§10),
 * heuristic tracking key (§14), and finding dedup/benchmark keys (§25/§35)
 * — do not reimplement it elsewhere.
 */
export function normalizePathname(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

/**
 * Normalized control key: "role:name" when an accessible name exists,
 * else "role:label", else "role:" with an empty value. Shared by the
 * state signature, heuristic tracking key, and dedup key.
 */
export function controlKey(el: Pick<InteractiveElement, "role" | "name" | "label">): string {
  const role = el.role ?? "";
  if (el.name) return `${role}:${el.name}`;
  if (el.label) return `${role}:${el.label}`;
  return `${role}:`;
}

const VISIBLE_TEXT_SIGNATURE_CHARS = 300;

/**
 * Pinned formula (spec §11):
 *   sha256(normalizedPathname + "|" + sortedControlKeys.join(",") + "|" + visibleText.slice(0,300))
 * Deliberately excludes screenshots, timestamps, query strings, random IDs,
 * and network data — only what a human would call "the same page state".
 */
export function computeStateSignature(
  pathname: string,
  controls: InteractiveElement[],
  visibleText: string
): string {
  const sortedControlKeys = [...new Set(controls.map(controlKey))].sort();
  const input = `${pathname}|${sortedControlKeys.join(",")}|${visibleText.slice(0, VISIBLE_TEXT_SIGNATURE_CHARS)}`;
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
