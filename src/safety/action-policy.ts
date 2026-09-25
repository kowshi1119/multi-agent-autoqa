import { isDeepStrictEqual } from "node:util";
import type { WorkflowManifest } from "../pilot/workflow-manifest.js";
import type { ProjectProfile } from "../profiles/schema.js";
import type { QaAction } from "../types.js";

export type ActionPolicyContext = {
  /** The DOM route the action is being attempted on. */
  routePathname?: string;
  /** True when the resolved click/press target is a submit-type control (a <button> without type=button/reset, an <input type=submit>, or Enter pressed in a text-like field that IS inside a <form>) -- resolved live from the DOM, never inferred from a button's label alone. */
  isSubmitControl?: boolean;
  /** The enclosing form's action/method, resolved live from the DOM at the same time as isSubmitControl. */
  formAction?: string;
  formMethod?: string;
  /** Enter pressed in a text-like field with NO enclosing <form> -- a JS-driven implicit submit whose resulting endpoint cannot be resolved from the DOM. Denied by default for real-target profiles rather than silently allowed because it isn't a recognized submit control. */
  isAmbiguousEnter?: boolean;
  /** True when the resolved click target is an <a href> element. */
  isLink?: boolean;
  /** The link's resolved destination pathname, when isLink is true and it was resolvable. */
  linkPathname?: string;
  /** True when the resolved click target's accessible name/label matches a small fixed pagination/sort vocabulary (next/previous/page N/sort/etc), resolved live from the DOM -- never inferred from role alone. */
  isPaginationLike?: boolean;
};

export type ActionClassification = { decision: "allowed" } | { decision: "denied"; reason: string };

function endpointPathname(formAction: string | undefined, routePathname: string | undefined): string {
  if (!formAction) return routePathname ?? "/";
  try {
    return new URL(formAction).pathname;
  } catch {
    // A relative form action, e.g. "/search" or "search" -- resolve against the route.
    try {
      return new URL(formAction, `http://placeholder${routePathname ?? "/"}`).pathname;
    } catch {
      return formAction;
    }
  }
}

/** `/admin` must match `/admin` and `/admin/anything` but never `/administrator`. */
export function pathWithinPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(normalizedPrefix);
}

export const DESTRUCTIVE_PATHNAME_RE = /delete|destroy|purge|\bremove\b/i;
// "document" deliberately excluded (Phase 4 continuation, 2026-09-11
// review fix): Playwright reports resourceType "document" for every
// navigation request, including a native <form method="post"> submission
// -- blanket-exempting it as an "asset" meant a same-origin destructive
// POST navigation was allowed regardless of method/endpoint, as soon as
// (or even before) installRouteGuard's `else if` gap was fixed. True
// static assets (stylesheet/script/image/font/media/manifest) stay
// exempted; a document request now goes through the same origin/path/
// method/endpoint checks as an xhr/fetch request below.
const ASSET_RESOURCE_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "manifest"]);

/**
 * Exported so installRouteGuard() (src/safety/navigation-guard.ts) can
 * decide, before doing any work, whether a request needs the full
 * manual redirect-chase-and-validate treatment (2026-09-14 addendum fix)
 * or can take the cheap native route.continue() path -- single source of
 * truth for "what counts as a static asset" shared between both files.
 */
export function isStaticAssetResourceType(resourceType: string): boolean {
  return ASSET_RESOURCE_TYPES.has(resourceType);
}

function allowed(): ActionClassification {
  return { decision: "allowed" };
}
function denied(reason: string): ActionClassification {
  return { decision: "denied", reason: `ACTION_POLICY_DENIED: ${reason}` };
}

/**
 * Real-target action safety (Phase 4 Milestones A2 and the continuation
 * pass that closed the gap between what this class's own schema declares
 * -- navigation.allowedPathPrefixes, resources.allowedApiOrigins,
 * workflows.allowedWorkflowKinds -- and what it actually enforced. All
 * three were previously declared on ProjectProfile but never read here at
 * all; a plain unscoped click/fill outside any declared path scope, or a
 * cross-origin resource request whose pathname happened to match an
 * allowlisted endpoint, were both silently allowed. Fixed below. A
 * local-fixture profile is exempt -- the fixture keeps today's full
 * Phase 1-3 heuristic set unchanged; this policy applies only to
 * self-hosted-real-app / owned-sandbox profiles, kept structurally
 * separate per the spec ("a real target must never be relabeled
 * local-fixture to unlock heuristics").
 *
 * Default posture for a real-target profile is now deny-unless-explicitly-
 * recognized, not allow-unless-a-submit-click: a plain click on a control
 * that doesn't resolve to a navigation link, a recognized pagination/sort
 * control, or an allowlisted form submit is denied outright -- "unknown
 * actions are not offered" is enforced here, at execution time, not just
 * hoped for from candidate generation.
 */
export class ActionPolicy {
  constructor(private readonly profile: ProjectProfile, private readonly manifest?: WorkflowManifest) {}

  isDeclaredMode(): boolean { return this.profile.workflows.executionMode === "declared"; }

  classifyPlannedAction(action: QaAction, pathname: string): ActionClassification {
    if (!this.isDeclaredMode()) return this.classifyAction(action, { routePathname: pathname });
    if (!this.pathnameInScope(pathname)) return denied("workflow route outside scope");
    const declared = this.manifest?.workflows.some(w => this.profile.workflows.allowedWorkflowKinds.includes(w.kind ?? "navigate") && w.execution?.steps.some(s => s.pathname === pathname && isDeepStrictEqual(s.action, action)));
    if (!declared) return denied("action is not explicitly declared for this route");
    if (action.type === "navigate") {
      try { const url = new URL(action.url);
        if (!this.profile.navigation.allowedOrigins.includes(url.origin) || !this.pathnameInScope(url.pathname)) return denied("workflow destination outside scope");
      } catch { return denied("invalid workflow destination"); }
    }
    return allowed();
  }

  private isExempt(): boolean {
    return this.profile.target.environmentKind === "local-fixture";
  }

  pathnameInScope(pathname: string): boolean {
    const prefixes = this.profile.navigation.allowedPathPrefixes;
    if (prefixes.length === 0) return true; // no declared scope -- nothing to restrict against.
    return prefixes.some((prefix) => pathWithinPrefix(pathname, prefix));
  }

  classifyAction(action: QaAction, context: ActionPolicyContext = {}): ActionClassification {
    if (this.isExempt()) return allowed();

    // General path-scope gate -- applies to every action type (click, fill,
    // press, navigate), not just submits. Fixes the confirmed gap where a
    // `fill` action received zero policy check at all.
    if (context.routePathname && !this.pathnameInScope(context.routePathname)) {
      return denied(`route "${context.routePathname}" is outside the profile's allowed path scope.`);
    }

    if (this.isDeclaredMode()) {
      const scoped = this.classifyPlannedAction(action, context.routePathname ?? "");
      if (scoped.decision === "denied") return scoped;
      // Exact configured SPA controls are permitted; the network guard still denies undeclared mutations.
      if (!context.isSubmitControl && !context.isAmbiguousEnter) return allowed();
    }
    // Choosing an option is only ever an explicitly declared, user-confirmed
    // workflow step; exploration never changes a selection on a real target.
    if (action.type === "select") return denied("Selecting an option is only allowed as a declared workflow step.");
    if (action.type === "fill") return allowed();

    // Enter pressed in a field with no enclosing form -- cannot resolve
    // what endpoint it would hit. "Implicit Enter submissions must not
    // become allowed merely because they are not submit buttons."
    if (action.type === "press" && context.isAmbiguousEnter) {
      return denied("Enter pressed in a field with no enclosing form -- the resulting endpoint cannot be verified against this real-target profile's allowlist.");
    }

    const isSubmitTrigger = (action.type === "click" || action.type === "press") && context.isSubmitControl;
    if (isSubmitTrigger) {
      const pathname = endpointPathname(context.formAction, context.routePathname);
      const method = (context.formMethod ?? "get").toLowerCase();
      const endpointAllowed = this.profile.resources.allowedFormSubmitEndpoints.some(
        (entry) => entry.pathname === pathname && entry.method.toLowerCase() === method
      );
      // Defense in depth: an allowlisted submit endpoint must also belong
      // to a declared search/filter workflow -- the endpoint allowlist
      // alone remains the authoritative check, this is a second signal,
      // never a way to loosen it.
      const workflowDeclared = this.profile.workflows.allowedWorkflowKinds.some((k) => k === "search" || k === "filter");
      if (!endpointAllowed || !workflowDeclared) {
        return denied(`form submit to "${method.toUpperCase()} ${pathname}" is not an explicitly allowlisted endpoint for this real-target profile.`);
      }
      return allowed();
    }

    if (action.type === "click") {
      if (context.isLink) {
        if (!this.profile.workflows.allowedWorkflowKinds.includes("navigate")) {
          return denied(`click on a navigation link is denied -- "navigate" is not a declared workflow kind for this profile.`);
        }
        if (context.linkPathname && !this.pathnameInScope(context.linkPathname)) {
          return denied(`link destination "${context.linkPathname}" is outside the profile's allowed path scope.`);
        }
        return allowed();
      }
      if (context.isPaginationLike) {
        const workflowDeclared = this.profile.workflows.allowedWorkflowKinds.some((k) => k === "paginate" || k === "sort");
        if (!workflowDeclared) {
          return denied(`click on a pagination/sort-like control is denied -- "paginate"/"sort" is not a declared workflow kind for this profile.`);
        }
        return allowed();
      }
      // Deny by default: an unrecognized control (not a submit, not a
      // link, not a recognized pagination/sort control) is never allowed
      // merely because it isn't a submit button.
      return denied("click on an unrecognized control is denied by default for this real-target profile -- only explicitly identified navigate/search/filter/sort/paginate actions are permitted.");
    }

    // 2026-09-14 addendum fix: a direct "navigate" QaAction (a
    // Planner-generated navigation candidate, distinct from a link click
    // that resolves via context.isLink above) previously fell through to
    // the final `return allowed()` below, skipping the exact same
    // "navigate" workflow-kind requirement a link-click navigation already
    // enforces -- the path-scope gate at the top of this function still
    // applied, but nothing checked whether this profile declares
    // navigation as an allowed workflow at all.
    if (action.type === "navigate") {
      if (!this.profile.workflows.allowedWorkflowKinds.includes("navigate")) {
        return denied(`direct navigation is denied -- "navigate" is not a declared workflow kind for this profile.`);
      }
      return allowed();
    }

    return allowed();
  }

  /** Shared by both the document and xhr/fetch branches of classifyResourceRequest() below -- the mutating-method/destructive-GET check is identical either way, only the origin scope differs. */
  private classifyMethodAndPathname(method: string, pathname: string): ActionClassification {
    const upperMethod = method.toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(upperMethod)) {
      const endpointAllowed = this.profile.resources.allowedFormSubmitEndpoints.some(
        (entry) => entry.pathname === pathname && entry.method.toUpperCase() === upperMethod
      );
      if (!endpointAllowed) {
        return denied(`${upperMethod} ${pathname} is not an explicitly allowlisted endpoint for this real-target profile.`);
      }
      return allowed();
    }

    if (upperMethod === "GET" && DESTRUCTIVE_PATHNAME_RE.test(pathname)) {
      // HTTP method alone never proves safety -- a GET to a
      // destructive-looking pathname (e.g. GET /delete-record) is denied
      // by default even though GET is ordinarily allowed. Never blocks an
      // ordinary read that doesn't match this narrow keyword pattern.
      return denied(`GET ${pathname} matches a destructive-keyword pattern and is denied by default for this real-target profile.`);
    }

    return allowed();
  }

  /**
   * Network-layer counterpart to classifyAction()'s click/Enter detection
   * -- catches a state-changing (or destructive-looking read) XHR/fetch,
   * OR a navigation-type request (a native <form> submit, a JS-triggered
   * form.submit()/location assignment, a page.reload() resubmission, or
   * any hop of a redirect chain -- installRouteGuard() now calls this for
   * every request, not just non-navigation ones, see navigation-guard.ts)
   * that never went through an observed submit-type click at all. Never
   * blocks true static-asset requests (stylesheet/script/image/font/
   * media/manifest) regardless of origin -- required application assets
   * are never blanket-blocked. "document" is deliberately NOT in that
   * asset set -- see ASSET_RESOURCE_TYPES's own comment for why.
   */
  classifyResourceRequest(method: string, pathname: string, origin: string, resourceType: string, authenticating = false): ActionClassification {
    if (this.isExempt()) return allowed();
    if (ASSET_RESOURCE_TYPES.has(resourceType) && ["GET", "HEAD"].includes(method.toUpperCase())) return allowed();
    const authException = this.profile.auth.allowedRequests?.some(r => r.origin === origin && r.pathname === pathname && r.method === method.toUpperCase());
    if (authException) return authenticating ? allowed() : denied("authentication endpoint is unavailable outside login");

    if (resourceType === "document") {
      // An ordinary page load/navigation -- governed by the profile's
      // *navigation* scope (allowedOrigins/allowedPathPrefixes), not
      // resources.allowedApiOrigins (a document request is not an "API
      // call" whose origin might legitimately differ from the app's own).
      // Previously classifyResourceRequest never checked path scope at
      // all here -- only classifyAction() did, for click/fill actions.
      if (!this.profile.navigation.allowedOrigins.includes(origin)) {
        return denied(`${method.toUpperCase()} navigation to origin "${origin}" is not within this real-target profile's allowed origins.`);
      }
      if (!this.pathnameInScope(pathname)) {
        return denied(`${method.toUpperCase()} navigation to "${pathname}" is outside the profile's allowed path scope.`);
      }
      return this.classifyMethodAndPathname(method, pathname);
    }

    // xhr/fetch/other API-shaped request: origin must be explicitly in
    // scope. Previously only the pathname was checked, so a cross-origin
    // request whose pathname happened to match an allowlisted endpoint
    // (e.g. https://attacker.example/login) was not denied by this
    // method-based check at all.
    const apiOrigins = this.profile.resources.allowedApiOrigins.length > 0 ? this.profile.resources.allowedApiOrigins : this.profile.navigation.allowedOrigins;
    if (!apiOrigins.includes(origin)) {
      return denied(`${method.toUpperCase()} to origin "${origin}" is not within this real-target profile's allowed API origins.`);
    }
    return this.classifyMethodAndPathname(method, pathname);
  }
}
