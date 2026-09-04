import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { redactSecrets } from "./redact.js";
import type { ActionExecutionResult, ElementTarget, QaAction, SafetyEvent } from "./types.js";

const elementTargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    testId: z.string().optional(),
  })
  .refine(
    (target) =>
      Boolean(target.role || target.name || target.label || target.text || target.testId),
    "ElementTarget requires at least one locator field (role, name, label, text, or testId)"
  );

export const qaActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), target: elementTargetSchema }),
  z.object({ type: z.literal("fill"), target: elementTargetSchema, value: z.string() }),
  z.object({
    type: z.literal("press"),
    target: elementTargetSchema.optional(),
    key: z.string().min(1),
  }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("navigate"), url: z.string().min(1) }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().positive() }),
  z.object({ type: z.literal("stop"), reason: z.string() }),
]);

export const explorerDecisionSchema = z.object({
  candidateId: z.string().min(1),
  testingIntent: z.string(),
  reason: z.string(),
});

const MAX_WAIT_MS = 10_000;
const LOCATOR_TIMEOUT_MS = 5_000;

/** Origin check for explicit "navigate" actions. Page content can never change this. */
export function isOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Playwright's getByRole expects a literal ARIA-role union, but roles here
 * come from untyped model output validated only at runtime by Playwright
 * itself (it throws on an unsupported role). This cast is the sole `any`
 * in the codebase, isolated to this one call.
 */
function buildLocator(page: Page, target: ElementTarget): Locator {
  if (target.testId) return page.getByTestId(target.testId);
  if (target.role) {
    const options = target.name ? { name: target.name } : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return page.getByRole(target.role as any, options);
  }
  if (target.label) return page.getByLabel(target.label);
  if (target.text) return page.getByText(target.text);
  if (target.name) return page.getByText(target.name);
  throw new Error("ElementTarget requires at least one locator field");
}

function resolveFillValue(value: string): string {
  const password = process.env["QA_PASSWORD"];
  if (value === "<QA_PASSWORD>" && password) {
    return password;
  }
  return value;
}

export async function executeAction(
  page: Page,
  action: QaAction,
  config: AppConfig,
  logger: Logger,
  onSafetyEvent: (event: SafetyEvent) => void = () => {}
): Promise<ActionExecutionResult> {
  const urlBefore = page.url();

  try {
    switch (action.type) {
      case "click": {
        const locator = buildLocator(page, action.target);
        await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
        await locator.click({ timeout: LOCATOR_TIMEOUT_MS });
        break;
      }

      case "fill": {
        const locator = buildLocator(page, action.target);
        await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
        await locator.fill(resolveFillValue(action.value), { timeout: LOCATOR_TIMEOUT_MS });
        break;
      }

      case "press": {
        if (action.target) {
          const locator = buildLocator(page, action.target);
          await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
          await locator.press(action.key, { timeout: LOCATOR_TIMEOUT_MS });
        } else {
          await page.keyboard.press(action.key);
        }
        break;
      }

      case "reload": {
        await page.reload();
        break;
      }

      case "navigate": {
        if (!isOriginAllowed(action.url, config.safety.allowedOrigins)) {
          logger.warn(
            { url: action.url },
            "Blocked navigation outside allowed origin."
          );
          return {
            outcome: "blocked",
            reason: "Blocked navigation outside allowed origin.",
          };
        }
        await page.goto(action.url);
        break;
      }

      case "wait": {
        const clamped = Math.min(action.milliseconds, MAX_WAIT_MS);
        await page.waitForTimeout(clamped);
        return { outcome: "success" };
      }

      case "stop": {
        return { outcome: "success" };
      }
    }
  } catch (error) {
    const cause = redactSecrets(error instanceof Error ? error.message : String(error));
    logger.warn(
      { error: cause, action: action.type },
      "AGENT_ACTION_FAILED: the requested locator could not be resolved."
    );
    return {
      outcome: "agent_action_failed",
      reason: `AGENT_ACTION_FAILED: the requested locator could not be resolved. (${cause})`,
    };
  }

  // Layer 2 of off-origin navigation defense (see src/safety/navigation-guard.ts
  // for layers 1/3/4): even when the action itself wasn't an explicit
  // "navigate", a click/form-submit/reload may have caused one. Verify the
  // resulting URL and revert if it left the allowlist.
  const urlAfter = page.url();
  if (urlAfter !== urlBefore && !isOriginAllowed(urlAfter, config.safety.allowedOrigins)) {
    logger.warn(
      { from: urlBefore, to: urlAfter },
      "SAFETY_NAVIGATION_BLOCKED: reverting off-origin navigation caused by action"
    );
    onSafetyEvent({
      code: "SAFETY_NAVIGATION_BLOCKED",
      url: urlAfter,
      mechanism: "post-action",
      timestamp: new Date().toISOString(),
    });
    try {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 5_000 });
    } catch {
      /* best-effort revert */
    }
    if (!isOriginAllowed(page.url(), config.safety.allowedOrigins)) {
      await page.goto(urlBefore, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    return {
      outcome: "blocked",
      reason: "Blocked navigation outside allowed origin.",
    };
  }

  return { outcome: "success" };
}
