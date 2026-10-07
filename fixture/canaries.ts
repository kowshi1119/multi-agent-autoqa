/**
 * Test-owned synthetic canaries for evidence-privacy tests. Each string is
 * unique, appears only in the synthetic fixture's pages and API responses
 * (fixture/auth-server.ts option `canaries`), and must never appear in a
 * minimal-evidence artifact, log, event, preview or export. They are not
 * real data and are never loaded from anywhere else.
 */
export const CANARIES = {
  controlName: "CanaryCtrlZq81",
  ariaLabel: "CanaryAriaXv72",
  heading: "CanaryHeadPm63",
  title: "CanaryTitleRk54",
  linkText: "CanaryLinkTw45",
  pathSegment: "canary-seg-ny36",
  queryValue: "CanaryQueryHb27",
  fragment: "CanaryFragLs18",
  console: "CanaryConsoleGd09",
  error: "CanaryErrorQf90",
  jsonValue: "CanaryJsonVal7c",
  jsonKey: "canaryKeyMb8d",
  nested: "CanaryNestedWe5e",
  reportLike: "CanaryReportLike4f",
} as const;

export const CANARY_VALUES: readonly string[] = Object.values(CANARIES);

/** Markup-like payloads used to prove untrusted text stays inert (never executed or rendered as markup). */
export const INERT_PAYLOADS = [
  `<img src=x onerror="window.__autoqaXss=1">`,
  `<script>window.__autoqaXss=2</script>`,
  `[click](javascript:window.__autoqaXss=3)`,
  `![remote](http://remote.invalid/pixel.png)`,
  `"quoted" 'single' \u0000nul \u001b[31mansi\r\n## injected heading`,
] as const;
