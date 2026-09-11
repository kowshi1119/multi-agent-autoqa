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

const DESTRUCTIVE_PATHNAME_RE = /delete|destroy|purge|\bremove\b/i;
const ASSET_RESOURCE_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "document", "manifest"]);

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
  constructor(private readonly profile: ProjectProfile) {}

  private isExempt(): boolean {
    return this.profile.target.environmentKind === "local-fixture";
  }

  private pathnameInScope(pathname: string): boolean {
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

    return allowed();
  }

  /**
   * Network-layer counterpart to classifyAction()'s click/Enter detection
   * -- catches a state-changing (or destructive-looking read) XHR/fetch
   * that never went through an observed submit-type click at all. Wired
   * into installRouteGuard() (src/safety/navigation-guard.ts). Never
   * blocks asset-shaped requests (stylesheet/script/image/font/media/
   * document) regardless of origin -- required application assets are
   * never blanket-blocked.
   */
  classifyResourceRequest(method: string, pathname: string, origin: string, resourceType: string): ActionClassification {
    if (this.isExempt()) return allowed();
    if (ASSET_RESOURCE_TYPES.has(resourceType)) return allowed();

    // API-shaped request (xhr/fetch/other): origin must be explicitly in
    // scope. Previously only the pathname was checked, so a cross-origin
    // request whose pathname happened to match an allowlisted endpoint
    // (e.g. https://attacker.example/login) was not denied by this
    // method-based check at all.
    const apiOrigins = this.profile.resources.allowedApiOrigins.length > 0 ? this.profile.resources.allowedApiOrigins : this.profile.navigation.allowedOrigins;
    if (!apiOrigins.includes(origin)) {
      return denied(`${method.toUpperCase()} to origin "${origin}" is not within this real-target profile's allowed API origins.`);
    }

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
}
