const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType
} = require('docx');

const GREY = "F2F2F2";

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, bold: !!opts.bold, italics: !!opts.italics, size: opts.size || 22 })],
  });
}
function h(text, level) {
  return new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text })] });
}
function cell(text, opts = {}) {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.shade ? { fill: opts.shade, type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!opts.bold, size: 19, color: opts.shade === "2F5597" ? "FFFFFF" : undefined })] })],
  });
}
const TABLE_WIDTH_DXA = 9350;
function scaleWidths(widths) {
  const sum = widths.reduce((a, b) => a + b, 0);
  return widths.map(w => Math.round((w / sum) * TABLE_WIDTH_DXA));
}
function table(headerRow, rows, rawWidths) {
  const widths = scaleWidths(rawWidths);
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headerRow.map((t, i) => cell(t, { bold: true, shade: "2F5597", width: widths[i] })) }),
      ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: widths[i] })) })),
    ],
  });
}
function metaTable(rows) {
  const widths = scaleWidths([3000, 7000]);
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(([k, v]) => new TableRow({ children: [cell(k, { bold: true, shade: GREY, width: widths[0] }), cell(v, { width: widths[1] })] })),
  });
}

function bugBlock(b) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${b.id} — ${b.title}`)] }));
  els.push(metaTable([
    ["Bug ID", b.id], ["Page", b.page], ["Module / Area", b.module], ["URL", b.url],
    ["Bug Type", b.bugType], ["Priority", b.priority], ["Severity", b.severity],
    ["Confidence", b.confidence], ["Status", "New"], ["Reproducibility", b.repro],
    ["Viewport", b.viewport], ["Zoom", "Not applicable — zoom not testable this session"], ["Browser", "Chromium 153.0.0.0 (Playwright-driven)"],
  ]));
  els.push(h("PRECONDITIONS", HeadingLevel.HEADING_3)); b.precondition.forEach(t => els.push(p(t)));
  els.push(h("TEST DATA / STATE", HeadingLevel.HEADING_3)); b.testData.forEach(t => els.push(p(t)));
  els.push(h("STEPS TO REPRODUCE", HeadingLevel.HEADING_3)); b.steps.forEach((t, i) => els.push(p(`${i + 1}. ${t}`)));
  els.push(h("ACTUAL RESULT", HeadingLevel.HEADING_3)); els.push(p(b.actual));
  els.push(h("EXPECTED RESULT", HeadingLevel.HEADING_3)); els.push(p(b.expected));
  els.push(h("EXPECTED-RESULT BASIS", HeadingLevel.HEADING_3)); els.push(p(b.basis));
  els.push(h("WHAT THE EVIDENCE PROVES", HeadingLevel.HEADING_3)); els.push(p(b.proves));
  if (b.doesNotProve) { els.push(h("WHAT THE EVIDENCE DOES NOT PROVE", HeadingLevel.HEADING_3)); els.push(p(b.doesNotProve)); }
  els.push(h("CUSTOMER IMPACT", HeadingLevel.HEADING_3)); els.push(p(b.customerImpact));
  els.push(h("UI / UX IMPACT", HeadingLevel.HEADING_3)); els.push(p(b.uiImpact));
  if (b.responsiveImpact) { els.push(h("RESPONSIVE IMPACT", HeadingLevel.HEADING_3)); els.push(p(b.responsiveImpact)); }
  if (b.a11yImpact) { els.push(h("ACCESSIBILITY IMPACT", HeadingLevel.HEADING_3)); els.push(p(b.a11yImpact)); }
  if (b.rootCause) { els.push(h("ROOT-CAUSE HYPOTHESIS", HeadingLevel.HEADING_3)); els.push(p(b.rootCause, { italics: true })); }
  els.push(h("RECOMMENDATION", HeadingLevel.HEADING_3)); els.push(p(b.recommendation));
  els.push(h("EVIDENCE", HeadingLevel.HEADING_3)); b.evidence.forEach(e => els.push(p(e)));
  return els;
}
function clarBlock(c) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${c.id} — ${c.title}`)] }));
  els.push(metaTable([["Page", c.page], ["Area", c.area], ["Status", c.status || "Requirement/Design Clarification"]]));
  els.push(h("Observed behaviour", HeadingLevel.HEADING_3)); els.push(p(c.observed));
  els.push(h("Why not classified as a bug", HeadingLevel.HEADING_3)); els.push(p(c.whyNotBug));
  els.push(h("Question for BA/PO", HeadingLevel.HEADING_3)); els.push(p(c.question));
  els.push(h("Customer risk", HeadingLevel.HEADING_3)); els.push(p(c.risk));
  els.push(h("Evidence", HeadingLevel.HEADING_3)); els.push(p(c.evidence));
  return els;
}
function sugBlock(s) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${s.id} — ${s.title}`)] }));
  els.push(metaTable([["Page", s.page], ["Area", s.area], ["Priority", s.priority], ["Severity", s.severity], ["Status", "Suggestion"]]));
  els.push(h("CURRENT BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.current));
  els.push(h("SUGGESTED BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.suggested));
  els.push(h("WHY THIS IS AN IMPROVEMENT, NOT A DEFECT", HeadingLevel.HEADING_3)); els.push(p(s.why));
  els.push(h("EVIDENCE", HeadingLevel.HEADING_3)); els.push(p(s.evidence));
  return els;
}

// ---------------- CONTENT ----------------

const coverMeta = metaTable([
  ["Project", "Ajeer Money — Sandbox Portal"],
  ["Report Title", "Core Portal Pages UI/UX QA Review"],
  ["Prepared By", "M. Kowshikan (QA Trainee)"],
  ["Submitted To", "Nixsala"],
  ["Organization", "10Qbit"],
  ["Environment", "Sandbox — https://portal.sandbox.ajeer.money"],
  ["Browser", "Chromium 153.0.0.0 (Playwright-driven)"],
  ["Test Type", "UI/UX Visual Audit — Layout, Responsive, Typography, Accessibility Observation"],
  ["Pages Covered", "Home, Recipients, Bill Payments, Transaction History, My Account"],
  ["Report Date", "17.09.2026"],
]);

const execSummary = table(["Metric", "Count"], [
  ["Pages tested", "5"],
  ["Viewports tested", "1440×900, 390×844 (Tier 1)"],
  ["Zoom levels tested", "None executable — see Zoom Verification statement"],
  ["Confirmed UI defects", "2"],
  ["Improvement suggestions", "2"],
  ["Accessibility findings", "2 (1 Improvement, 1 split Bug/Improvement by viewport)"],
  ["Requirement/design clarifications", "1"],
  ["Minor UI observations", "1"],
  ["Rejected / not-a-bug candidates", "3"],
  ["Known findings revalidated", "3"],
], [7000, 3000]);

const confirmedBugSummary = table(
  ["ID", "Page", "Title", "Priority", "Severity", "Reproducibility", "Evidence"],
  [
    ["BUG_UI_001", "Recipients", "Distinct recipient nicknames are truncated to the same visible text in the desktop table.", "P2", "Medium", "2/2", "UI_REC_001_CONTEXT.png"],
    ["BUG_UI_002", "Transaction History", "Transaction ID is truncated on desktop with no tooltip fallback (not reproduced at mobile width).", "P2", "Medium", "2/2", "UI_TXN_001_CONTEXT.png"],
  ], [1300, 1300, 3200, 700, 700, 900, 1250]
);

const knownFindingsTable = table(
  ["Existing ID", "Original Finding", "This Session's Result", "Evidence"],
  [
    ["BUG_ACCOUNT_001", "Approved-account KYC Verification link silently redirects to Home", "STILL REPRODUCIBLE — re-checked live, same redirect to /home", "Live navigation check, 17.09.2026"],
    ["SUG_ACCESS_001 (Escape-dismiss)", "Escape does not dismiss the Home account-switcher or Bill Payments ellipsis menu", "STILL REPRODUCIBLE — reconfirmed on Home dropdown and on a 3rd component (Recipients \"More actions\" popover)", "Live Escape-key test on 2 components"],
    ["SUG_ACCESS_002 (unlabeled recipient icons)", "3 of 4 Recipients row-action icons lack aria-label", "SPLIT RESULT: NOT REPRODUCED at 1440×900 (now \"Send money\" text + labelled \"More actions\" → text-labelled View/Edit/Delete); STILL REPRODUCIBLE at 390×844 (3 of 4 icons remain unlabeled)", "DOM audit at both viewports — see AO-002"],
  ], [2600, 3200, 3300, 250]
);

const reqClarSummary = table(
  ["ID", "Page", "Status", "Question"],
  [["REQ_CLAR_ACCOUNT_001", "Transaction History / My Account", "Requirement/Design Clarification (not promoted to a bug)", "Is the shorter mobile heading/button text (\"History\"/\"Export\", \"Account\") an intentional abbreviation vs. the desktop text (\"Transaction History\"/\"Export CSV\", \"Account Settings\"), confirmed this session to be 100% viewport-driven, not a load-timing fluke?"]],
  [1600, 2000, 3200, 2550]
);

const sugSummary = table(
  ["ID", "Page", "Title", "Priority"],
  [
    ["SUG_UI_001", "Home", "Recent-recipient shortcut shows a bare, potentially ambiguous first-word label with no tooltip", "P3"],
    ["SUG_UI_002", "My Account", "Change Password's third field uses a different label component/capitalization than the first two", "P3"],
  ], [1600, 1600, 4750, 1400]
);

const notABugTable = table(
  ["#", "Candidate", "Why it looked suspicious", "Verification performed", "Why rejected"],
  [
    ["1", "Bill Payments search-to-button gap", "~325px gap looked inconsistent vs. Recipients", "Measured both pages' bounding boxes: both anchor the primary button's right edge to the identical x=1336.3px", "Pixel-consistent grid alignment, not an inconsistency"],
    ["2", "Mobile bottom nav appearing mid-content (fullPage screenshot)", "Full-page capture suggested the nav sat between page sections", "Computed CSS confirmed position:fixed;bottom:0px; real-scroll viewport screenshot confirmed correct pinned behavior", "Screenshot-stitching artifact, reconfirmed from prior session's methodology"],
    ["3", "tenant-bill-logo.png badge near Bill Payments heading", "Looked like a possible debug/misplaced element", "Confirmed via elementFromPoint/querySelectorAll as a genuine, correctly-proportioned image element, present in a dual mobile/desktop DOM pattern", "Genuine element; downgraded to a Minor UI Observation (cosmetic placement only), not rejected as a defect nor kept as a full clarification"],
  ], [400, 2350, 2100, 2600, 1900]
);

const coverageTable = table(
  ["Category", "Executed", "Passed", "Failed", "Not Executed"],
  [
    ["Home", "5", "4", "0", "10 (of ~15 planned)"],
    ["Recipients", "7", "5", "2", "11 (of ~18 planned)"],
    ["Bill Payments", "3", "2", "0", "14 (of ~17 planned)"],
    ["Transaction History", "3", "1", "1", "17 (of ~20 planned)"],
    ["My Account", "5", "3", "1", "15 (of ~20 planned)"],
    ["Cross-page consistency", "2", "1", "0", "16 (of ~18 planned)"],
    ["UI/Responsive (Tier 1 only)", "10", "10", "0", "Tier 2 (16 combos) + Tier 3 not executed"],
    ["Accessibility", "4", "1", "1", "Full keyboard Tab-order pass not executed"],
  ], [2600, 1300, 1300, 1300, 2850]
);

const uiResponsiveMatrix = table(
  ["Page", "1440×900", "390×844", "Result"],
  [
    ["Home", "PASS", "PASS (real-scroll nav verified)", "Clean at both tiers"],
    ["Recipients", "FAIL — BUG_UI_001 (name truncation)", "PASS — full names shown, defect not present", "Desktop-specific defect"],
    ["Bill Payments", "PASS (tenant-logo observation only)", "PASS (logo position differs — cosmetic)", "Clean, one minor observation"],
    ["Transaction History", "FAIL — BUG_UI_002 (ID truncation)", "PASS — full ID shown, defect not present", "Desktop-specific defect; mobile is better"],
    ["My Account", "PASS", "PASS", "Clean at both tiers"],
  ], [1600, 2900, 2900, 1950]
);

const bugUI001 = bugBlock({
  id: "BUG_UI_001",
  title: "Distinct recipient nicknames are truncated to the same visible text in the desktop table.",
  page: "Recipients (Bank Account Holder tab)",
  module: "Desktop table — \"Recipient\" column",
  url: "https://portal.sandbox.ajeer.money/recipients",
  bugType: "Layout / Typography-Truncation / Information-Availability",
  priority: "P2", severity: "Medium", confidence: "High",
  repro: "Reproducible — 2/2 (fresh page load each time)",
  viewport: "1440×900",
  precondition: ["Logged in as a Personal customer with 4 saved bank recipients, two of whose nicknames share the prefix \"QA Perso...\"."],
  testData: ["Recipients: \"QA Switch Test 001\" (Kamal Fernando), \"QA Personal XSS 001\" (Jose O'Connor), \"QA Personal 001\" (John Silva), \"Test Recipient\" (John Silva)."],
  steps: ["Navigate to Recipients at 1440×900, Bank Account Holder tab.", "Observe the \"Recipient\" column for rows 2 and 3.", "Inspect the nickname <p> element's clientWidth vs scrollWidth via DOM query.", "Reload and repeat."],
  actual: "The nickname column renders at a fixed clientWidth of 77px. All 4 visible nicknames are truncated (measured scrollWidth 96–143px). \"QA Personal XSS 001\" and \"QA Personal 001\" both render as the identical string \"QA Perso...\".",
  expected: "The Recipient name column should be wide enough to avoid two different recipients rendering as visually identical text, or should provide an immediately-discoverable way to tell them apart.",
  basis: "Direct functional/visual-hierarchy expectation — a recipient-selection table exists specifically so a customer can tell recipients apart.",
  proves: "DOM measurement (repeated twice) confirms genuine CSS truncation (77px column vs 96–143px needed content). Screenshot shows two different customers both labelled \"QA Perso... Personal\".",
  doesNotProve: "Does not prove customers actually pick the wrong recipient in practice — the secondary line below each nickname does show the distinct full legal name, partially mitigating the ambiguity.",
  customerImpact: "A customer scanning by nickname (their own chosen identifier) cannot distinguish two recipients without reading the smaller, secondary legal-name line.",
  uiImpact: "Undermines the primary purpose of the \"Recipient\" column as a scannable identifier; unused width exists in the adjacent Bank Details column (measured 209px, not truncated), indicating a fixable column-width imbalance rather than a fundamental space constraint.",
  responsiveImpact: "Confirmed desktop-only. At 390×844, the same four recipients render with full, untruncated nicknames in a card layout.",
  a11yImpact: "A native title attribute carrying the full nickname is present (partial mitigation for mouse users), but there is no visible affordance inviting a hover, and no equivalent for touch users.",
  rootCause: "Hypothesis only: the desktop table likely allocates column widths from a fixed grid template that under-sizes \"Recipient\" relative to \"Bank Details\" — a column-width rebalancing issue, not a structural constraint.",
  recommendation: "Widen the Recipient column using the measured spare width in Bank Details, and/or add a visible affordance for the existing title tooltip.",
  evidence: ["Figure 1 — evidence-uiux/UI_REC_001_CONTEXT.png: Recipients table at 1440×900 showing \"QA Perso...\" rendered identically for two different customers."],
});

const bugUI002 = bugBlock({
  id: "BUG_UI_002",
  title: "Transaction ID is truncated on the desktop table with no tooltip fallback",
  page: "Transaction History",
  module: "Desktop table — \"Transaction ID\" column",
  url: "https://portal.sandbox.ajeer.money/history",
  bugType: "Layout / Typography-Truncation / Information-Availability",
  priority: "P2", severity: "Medium", confidence: "High",
  repro: "Reproducible — 2/2 (fresh page load each time)",
  viewport: "1440×900",
  precondition: ["Logged in customer with one visible transaction, ID AMB2026091600001."],
  testData: ["Transaction AMB2026091600001, 1,000.01 GBP → 451,297.30 LKR, status Initiated."],
  steps: ["Navigate to Transaction History at 1440×900.", "Observe the Transaction ID cell.", "Inspect the <p> element's clientWidth/scrollWidth/title via DOM query.", "Reload and repeat."],
  actual: "The Transaction ID renders as \"AMB2026091600...\". DOM measurement confirms clientWidth 134px vs scrollWidth 139px (truncated by 5px) with no title attribute anywhere on the element.",
  expected: "A Transaction ID should be fully visible or recoverable via a hover/tooltip/copy affordance from the primary transaction list, since it is the identifier a customer would quote for support or reconciliation.",
  basis: "Direct functional expectation grounded in the field's own stated purpose as a unique reference, reinforced by the fact this ID is fully retrievable elsewhere in the product (Download Receipt PDF and Export CSV, both confirmed in the prior functional session) — the primary list view is the one place it is not recoverable.",
  proves: "Repeated (2×) DOM measurement confirms genuine CSS truncation with zero fallback (no title, no visible affordance) on the Transaction ID and the adjacent secondary amount text.",
  doesNotProve: "Does not prove a customer cannot obtain the full ID from the product at all — it is available via Download Receipt and Export CSV. Does not evidence any actual transaction failure, data loss, or misidentification; the ID's correctness elsewhere in the product was independently confirmed in the prior session's receipt/CSV data-integrity checks.",
  customerImpact: "A customer reading or quoting their transaction ID from the main History screen — the most likely place to look for it — cannot do so without leaving the page. The truncation margin is only 5px.",
  uiImpact: "The column is under-provisioned by a small, measurable margin; the same field renders in full one viewport tier down.",
  responsiveImpact: "Confirmed desktop-only. At 390×844, the full ID \"AMB2026091600001\" renders unclipped on its own row — mobile is not affected, and in this case out-performs desktop.",
  a11yImpact: "No title/aria-label fallback exists for this truncated value, unlike the Recipients page's equivalent truncation pattern (which does have a title) — a strictly weaker accessibility posture than a comparable pattern elsewhere in the same app.",
  rootCause: "Hypothesis only: the column width appears set a few pixels short of the fixed AMB+13-digit ID format, compounded by the absence of the title-fallback pattern used on the Recipients page.",
  recommendation: "Widen the Transaction ID column by the small measured margin, and add a title attribute consistent with the Recipients page's own pattern as a low-effort safety net.",
  evidence: ["Figure 2 — evidence-uiux/UI_TXN_001_CONTEXT.png: Transaction History at 1440×900 showing the truncated ID \"AMB2026091600...\"."],
});

const clarAccount001 = clarBlock({
  id: "REQ_CLAR_ACCOUNT_001",
  title: "Mobile vs. desktop heading/button text divergence — intentional abbreviation or content drift?",
  page: "Transaction History and My Account",
  area: "Page heading and primary button label",
  observed: "Toggling the same live page's viewport width between 1440×900 and 390×844 — with no reload — deterministically switches the text: \"Transaction History\"/\"Export CSV\" (desktop) vs. \"History\"/\"Export\" (mobile) on Transaction History; \"Account Settings\"/\"Manage your profile and preferences\" (desktop) vs. \"Account\"/\"Manage your account settings\" (mobile) on My Account. This is 100% reproducible this session via direct viewport toggling — a genuine dual-DOM content difference between separately-rendered mobile and desktop component instances, not a load-timing race as originally suspected in the prior session.",
  whyNotBug: "Abbreviating copy for mobile is a legitimate, common responsive pattern. Without a stated content-parity requirement, this cannot be objectively called incorrect — it remains a design/requirement question, not a confirmed defect, and is explicitly not promoted to a bug despite now being fully reproducible.",
  question: "Is the mobile/desktop heading and button text supposed to differ (intentional abbreviation), or should both breakpoints show identical copy?",
  risk: "Low-Medium — a customer switching between phone and desktop could notice the same page presenting itself with different names.",
  evidence: "Live viewport-toggle test (1440×900 ↔ 390×844) on the same loaded page, no reload, DOM h1.textContent read at each width, on both Transaction History and My Account.",
});

const sugUI001 = sugBlock({
  id: "SUG_UI_001", title: "Home's recent-recipient shortcut shows a bare, potentially ambiguous label with no tooltip",
  page: "Home", area: "\"Bank Account Holders\" recent-recipient shortcut", priority: "P3", severity: "Low",
  current: "The recent-recipient shortcut shows initials \"QS\" with a caption below showing only the first word of the nickname (\"QA\", from \"QA Switch Test 001\"). DOM inspection confirms this is not CSS-truncated (scrollWidth equals clientWidth) — the app generates this short label directly. No title/aria-label exposes the full nickname.",
  suggested: "Show a more complete or distinguishing identifier, or add a tooltip exposing the full nickname on hover/long-press.",
  why: "The shortcut works correctly (navigates to the right recipient) — this is a clarity opportunity for the edge case of recipients sharing a nickname prefix, not a functional failure.",
  evidence: "DOM inspection of the Home shortcut button's innerHTML, cross-referenced against the full recipient name known from the Send Money flow.",
});
const sugUI002 = sugBlock({
  id: "SUG_UI_002", title: "Change Password's third field uses a different labelling pattern than the first two",
  page: "My Account → Change Password", area: "Password form fields", priority: "P3", severity: "Low",
  current: "Evaluated independently first: the form's single-screen, 3-field layout with a Security Tips panel is clear, efficient, and standard — no progressive-disclosure suggestion is warranted, as no demonstrable usability benefit over the current design was found. One structural inconsistency was found: fields 1–2 use instructional placeholders (\"Enter your current password\", \"Enter new password\"), while field 3 uses a static label (\"Confirm New Password\", Title Case) with an invisible placeholder — a different component pattern producing a capitalization mismatch.",
  suggested: "Use one consistent labelling component and capitalization convention across all three fields.",
  why: "The form functions correctly; this is a component/style consistency observation, not broken behavior.",
  evidence: "DOM comparison of the three password inputs' placeholder attributes and sibling label text.",
});

const notABugSection = [
  h("17. Not-a-Bug / Rejected Candidates", HeadingLevel.HEADING_1),
  notABugTable,
];

const a11ySection = [
  h("14. Accessibility Details", HeadingLevel.HEADING_1),
  p("AO-001 — Popover dismissal semantics (Home account-switcher; Recipients \"More actions\")", { bold: true }),
  p("Verified via DOM inspection, not assumed: the trigger buttons for both popovers carry no role, aria-haspopup, aria-expanded, or aria-controls attributes. The popover panels themselves are plain <div> elements with no role=\"menu\" or role=\"dialog\", and their items are plain <button> elements with no role=\"menuitem\". Since neither component implements any formal ARIA menu/dialog contract, there is no ARIA Authoring-Practices requirement for Escape-dismissal being violated."),
  p("Classification: Accessibility IMPROVEMENT (not a Bug) — confirmed by evidence, not assumed, per this session's explicit verification requirement. Escape does not dismiss either popover (reconfirmed live on both the Home dropdown and the Recipients \"More actions\" popover); outside-click does."),
  p("AO-002 — Row-action icon accessible names (Recipients) — SPLIT finding by viewport", { bold: true }),
  p("At 1440×900: \"Send money\" (visible text) + a single \"More actions\" icon button carrying aria-label=\"More actions\", opening a popover with text-labelled \"View\"/\"Edit\"/\"Delete\" buttons. This is a genuine improvement over the previously-reported unlabeled-icon state — classification: NOT REPRODUCED at this viewport."),
  p("At 390×844: the row instead renders 4 separate icon buttons (Send/View/Edit/Delete equivalents); only \"Send money\" carries an accessible name (visible text) — the other 3 have no text, no aria-label, no title. Classification: STILL REPRODUCIBLE at this viewport — the original defect persists specifically in the mobile card layout, even though the desktop table layout has been improved."),
  p("This split result corrects an initial same-session misreading caused by a stale (390px) viewport carried over from an earlier test step; both the desktop and mobile findings above were independently re-verified at their correct, explicitly-set viewport before being finalized."),
];

const netSection = [
  h("15. Network / API Observations", HeadingLevel.HEADING_1),
  p("No dedicated network/API testing was performed in this session (out of scope for a UI/UX visual audit); no new network findings are reported. Network behavior for these five pages was covered in the prior functional-QA session."),
];

const blockedSection = [
  h("16. Blocked / Not Executed", HeadingLevel.HEADING_1),
  p("• Tier 2 viewports (1024×768, 768×1024, 430×932, 360×800) — NOT EXECUTED; reserved for follow-up depth, no Tier-1 finding required pulling these in."),
  p("• Tier 3 viewports (1920×1080, 1366×768, 375×812, ~320px) — NOT EXECUTED; reserved for breakpoint investigation triggers, none arose this session."),
  p("• Browser zoom 100/125/150/200% — NOT EXECUTABLE (see Zoom Verification Statement)."),
  p("• Cash Pickup / Wallets recipient tabs — NOT VISUALLY RE-AUDITED this session (covered functionally in the prior session)."),
  p("• Devices / Terms & Conditions / Privacy Policy pages — NOT VISUALLY RE-AUDITED this session."),
  p("• Full keyboard Tab-order / Shift+Tab / Enter / Space pass — NOT EXECUTED beyond the two Escape-key checks performed."),
  p("• Multi-record pagination visual behavior — NOT EXECUTABLE; dataset limited to 4 bank recipients, 1 saved biller, 1 transaction; no test data was fabricated."),
  h("Zoom Verification Statement", HeadingLevel.HEADING_2),
  p("\"Browser zoom testing was not executable with the available Playwright MCP environment because genuine browser zoom could not be changed and verified. No CSS zoom, device emulation, or simulated zoom result is presented as browser zoom.\"", { italics: true }),
];

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Core Portal Pages UI/UX QA Review")] }),
      p("Ajeer Money — Sandbox Portal", { bold: true, size: 26 }),
      coverMeta,

      h("2. Executive Summary", HeadingLevel.HEADING_1),
      execSummary,
      p("The application's cross-page visual consistency is strong — sidebar, header, pagination, and button-alignment patterns are reused correctly and measurably across all five pages, and mobile responsive reflow is well-executed, in two cases (Recipients, Transaction History) outperforming the desktop layout. Both confirmed defects share one root theme: desktop table columns sized a small, fixable margin too narrow for their content, with inconsistent tooltip-fallback support. No pass-percentage is calculated for this exploratory audit; raw execution counts are reported instead."),

      h("3. Confirmed Bug Summary", HeadingLevel.HEADING_1),
      confirmedBugSummary,

      h("4. Known Findings Revalidation", HeadingLevel.HEADING_1),
      p("The following were already documented in prior sessions and are not counted as newly discovered bugs; each was re-tested this session and is recorded with its current outcome only."),
      knownFindingsTable,

      h("5. Requirement Clarification Summary", HeadingLevel.HEADING_1),
      reqClarSummary,

      h("6. Improvement / Suggestion Summary", HeadingLevel.HEADING_1),
      sugSummary,

      h("7. Accessibility Findings (Summary)", HeadingLevel.HEADING_1),
      p("AO-001 (Improvement — verified via DOM role/ARIA inspection, not assumed) and AO-002 (split: Not Reproduced at desktop / Still Reproducible at mobile) — see Section 14 for full detail."),

      h("8. Page Coverage Summary", HeadingLevel.HEADING_1),
      coverageTable,

      h("9. Full Test Execution Matrix", HeadingLevel.HEADING_1),
      p("The complete, unabridged matrix (every action actually executed this session, with NOT EXECUTED items listed with reasons) is provided in the companion file AjeerMoney_Core5Pages_TestExecution.md.", { italics: true }),

      h("10. Confirmed Bug Details", HeadingLevel.HEADING_1),
      ...bugUI001,
      ...bugUI002,

      h("11. Requirement Clarification Details", HeadingLevel.HEADING_1),
      ...clarAccount001,

      h("12. Improvement Details", HeadingLevel.HEADING_1),
      ...sugUI001,
      ...sugUI002,

      h("13. UI / Responsive Matrix", HeadingLevel.HEADING_1),
      uiResponsiveMatrix,
      p("Note: this section covers viewport-resize (responsive) testing only. Browser zoom is a separate concern, addressed in Section 16 — viewport resizing is never described as zoom in this report."),

      ...a11ySection,
      ...netSection,
      ...blockedSection,
      ...notABugSection,

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("18. Evidence Index")] }),
      p("BASELINE_HOME_1440x900.png, BASELINE_RECIPIENTS_1440x900.png, BASELINE_BILLPAYMENTS_1440x900.png, BASELINE_TRANSACTIONS_1440x900.png, BASELINE_MYACCOUNT_1440x900.png — desktop baselines."),
      p("BASELINE_HOME_390x844.png, BASELINE_RECIPIENTS_390x844.png, BASELINE_BILLPAYMENTS_390x844.png, BASELINE_TRANSACTIONS_390x844.png, BASELINE_MYACCOUNT_390x844.png — mobile baselines."),
      p("UI_HOME_scrolled_390x844.png — real-scroll mobile-nav verification."),
      p("UI_REC_001_CONTEXT.png — BUG_UI_001 evidence."),
      p("UI_TXN_001_CONTEXT.png — BUG_UI_002 evidence."),
      p("UI_ACCOUNT_CHANGEPASSWORD_CONTEXT.png — SUG_UI_002 evidence / Change Password independent review."),
      p("Environment record: Chromium 153.0.0.0 (Win32, Playwright-driven), account kowshikan@spoton.money (Personal, KYC Approved), dataset at test time: 4 bank recipients, 1 saved biller, 1 transaction; test date 17.09.2026."),

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("19. Appendix — Baseline Screenshots")] }),
      p("All ten baseline screenshots listed in the Evidence Index above are the Appendix reference set for cross-page and cross-viewport comparison; see the evidence-uiux/ folder for the image files."),

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("Final QA Lead Assessment")] }),
      p("Every confirmed bug and known-finding revalidation in this report was checked against six questions before finalizing: was it reproduced (both bugs 2/2; all known findings re-tested live this session); does evidence prove it (DOM measurements and screenshots for both bugs; role/ARIA readouts for AO-001; viewport-toggle DOM reads for REQ_CLAR_ACCOUNT_001); is the expected result objectively justified (yes, grounded in each field's own stated functional purpose, not an invented design-system rule); is severity proportionate (both bugs corrected to Medium/P2 — no evidence of transaction failure, data loss, or total unretrievability was found for either); is it actually a clarification or suggestion rather than a bug (REQ_CLAR_ACCOUNT_001 and both SUG_UI items were deliberately kept out of the Confirmed Bug table); and is it a previously known finding (BUG_ACCOUNT_001 and the Escape-key pattern are revalidated, not re-counted as new). One classification (AO-002) was corrected mid-session after a stale-viewport measurement produced a contradictory result — the corrected, viewport-specific split finding is what appears in this final report."),
      p("Prepared by: M. Kowshikan (QA Trainee) — 10Qbit  |  Submitted to: Nixsala  |  Report date: 17.09.2026", { italics: true }),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  require('fs').writeFileSync('AjeerMoney_Core5Pages_UIUX_QA_Report.docx', buf);
  console.log('done');
});
