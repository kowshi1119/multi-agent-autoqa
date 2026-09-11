import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { redactSecrets } from "./redact.js";
import type { ActionPolicy } from "./safety/action-policy.js";
import type { ActionExecutionResult, ElementTarget, QaAction, SafetyEvent } from "./types.js";

export const elementTargetSchema = z
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
 *
 * Every name-based locator is built with { exact: true }. Playwright's
 * default string matching is a case-insensitive *substring* match, which
 * silently makes any two controls whose accessible names are one a
 * substring of the other (e.g. "Amount" and "Payment Amount") mutually
 * ambiguous -- getByRole(...).fill() then throws a strict-mode violation
 * every single time either is targeted. Confirmed by actually running the
 * fixture: a candidate whose action fails is never marked executed (see
 * Orchestrator.execute()), so it gets re-offered every cycle and silently
 * burns the entire model-call budget without ever reaching most of the
 * app. `name`/`label`/`text` in ElementTarget are always populated from
 * the exact accessible name the observation step already captured, so
 * requiring an exact match here costs nothing when names are unambiguous
 * and turns this whole failure class into a normal, resolvable locator.
 */
export function buildLocator(page: Page, target: ElementTarget): Locator {
  if (target.testId) return page.getByTestId(target.testId);
  if (target.role) {
    const options = target.name ? { name: target.name, exact: true } : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return page.getByRole(target.role as any, options);
  }
  if (target.label) return page.getByLabel(target.label, { exact: true });
  if (target.text) return page.getByText(target.text, { exact: true });
  if (target.name) return page.getByText(target.name, { exact: true });
  throw new Error("ElementTarget requires at least one locator field");
}

type ActionDomContext = {
  isSubmitControl: boolean;
  formAction?: string;
  formMethod?: string;
  isAmbiguousEnter: boolean;
  isLink: boolean;
  linkPathname?: string;
  isPaginationLike: boolean;
};

const EMPTY_ACTION_DOM_CONTEXT: ActionDomContext = {
  isSubmitControl: false,
  isAmbiguousEnter: false,
  isLink: false,
  isPaginationLike: false,
};

/**
 * Resolved live from the DOM, never inferred from a button's label or a
 * heuristic's own risk field -- "stronger contextual identification than a
 * button name" per the Phase 4 action-safety spec. Detects: an actual
 * submit-type control (<button> without type=button/reset, or
 * <input type=submit>); Enter pressed in a text-like field, distinguishing
 * a form-wrapped field (resolvable endpoint) from an unwrapped one (an
 * "ambiguous" implicit submit whose endpoint can't be verified, denied by
 * default rather than silently allowed); a navigation link and its
 * destination pathname; and a small fixed pagination/sort label
 * vocabulary, for src/safety/action-policy.ts#ActionPolicy to classify.
 */
async function resolveActionContext(locator: Locator, isEnterKey: boolean): Promise<ActionDomContext> {
  return locator.evaluate(
    (el: Element, enterKey: boolean): ActionDomContext => {
      const tag = el.tagName;
      const type = (el as HTMLInputElement | HTMLButtonElement).type?.toLowerCase();
      const form = el.closest("form");

      const isExplicitSubmitControl =
        (tag === "BUTTON" && type !== "button" && type !== "reset") || (tag === "INPUT" && type === "submit");
      const isTextLikeField = tag === "INPUT" && type !== "button" && type !== "submit" && type !== "reset" && type !== "checkbox" && type !== "radio";
      const isEnterInFormField = enterKey && Boolean(form) && isTextLikeField;
      const isEnterOutsideForm = enterKey && !form && isTextLikeField;

      if (isExplicitSubmitControl || isEnterInFormField) {
        return {
          isSubmitControl: true,
          formAction: form ? (form as HTMLFormElement).action : undefined,
          formMethod: form ? (form as HTMLFormElement).method || "get" : "get",
          isAmbiguousEnter: false,
          isLink: false,
          isPaginationLike: false,
        };
      }
      if (isEnterOutsideForm) {
        return { isSubmitControl: false, isAmbiguousEnter: true, isLink: false, isPaginationLike: false };
      }

      const isLink = tag === "A" && el.hasAttribute("href");
      let linkPathname: string | undefined;
      if (isLink) {
        try {
          linkPathname = new URL((el as HTMLAnchorElement).href, location.href).pathname;
        } catch {
          /* unresolvable href -- leave undefined, policy treats a link with no resolvable pathname conservatively */
        }
      }

      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      const isPaginationLike = /^(next|previous|prev|»|«|›|‹|page\s*\d+)$/i.test(label) || /\bsort(ed)?\b/i.test(label);

      return { isSubmitControl: false, isAmbiguousEnter: false, isLink, linkPathname, isPaginationLike };
    },
    isEnterKey
  );
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
  onSafetyEvent: (event: SafetyEvent) => void = () => {},
  policy?: ActionPolicy,
  extraSecrets: readonly string[] = []
): Promise<ActionExecutionResult> {
  const urlBefore = page.url();

  async function checkPolicy(locator: Locator | undefined, isEnterKey: boolean): Promise<ActionExecutionResult | undefined> {
    if (!policy) return undefined;
    const domContext = locator
      ? await resolveActionContext(locator, isEnterKey).catch(() => EMPTY_ACTION_DOM_CONTEXT)
      : EMPTY_ACTION_DOM_CONTEXT;
    let routePathname: string | undefined;
    try {
      routePathname = new URL(page.url()).pathname;
    } catch {
      routePathname = undefined;
    }
    const classification = policy.classifyAction(action, {
      routePathname,
      isSubmitControl: domContext.isSubmitControl,
      formAction: domContext.formAction,
      formMethod: domContext.formMethod,
      isAmbiguousEnter: domContext.isAmbiguousEnter,
      isLink: domContext.isLink,
      linkPathname: domContext.linkPathname,
      isPaginationLike: domContext.isPaginationLike,
    });
    if (classification.decision === "denied") {
      logger.warn({ action: action.type, reason: classification.reason }, "ACTION_POLICY_DENIED");
      onSafetyEvent({ code: "ACTION_POLICY_DENIED", reason: classification.reason, mechanism: "execute-action", timestamp: new Date().toISOString() });
      return { outcome: "blocked", reason: classification.reason };
    }
    return undefined;
  }

  try {
    switch (action.type) {
      case "click": {
        const locator = buildLocator(page, action.target);
        await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
        const denied = await checkPolicy(locator, false);
        if (denied) return denied;
        await locator.click({ timeout: LOCATOR_TIMEOUT_MS });
        break;
      }

      case "fill": {
        const locator = buildLocator(page, action.target);
        await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
        const denied = await checkPolicy(locator, false);
        if (denied) return denied;
        await locator.fill(resolveFillValue(action.value), { timeout: LOCATOR_TIMEOUT_MS });
        break;
      }

      case "press": {
        if (action.target) {
          const locator = buildLocator(page, action.target);
          await locator.waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT_MS });
          const denied = await checkPolicy(locator, action.key === "Enter");
          if (denied) return denied;
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
        if (policy) {
          const destinationPathname = (() => {
            try {
              return new URL(action.url).pathname;
            } catch {
              return undefined;
            }
          })();
          const classification = policy.classifyAction(action, { routePathname: destinationPathname });
          if (classification.decision === "denied") {
            logger.warn({ action: action.type, reason: classification.reason }, "ACTION_POLICY_DENIED");
            onSafetyEvent({ code: "ACTION_POLICY_DENIED", reason: classification.reason, mechanism: "execute-action", timestamp: new Date().toISOString() });
            return { outcome: "blocked", reason: classification.reason };
          }
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
    const cause = redactSecrets(error instanceof Error ? error.message : String(error), extraSecrets);
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
