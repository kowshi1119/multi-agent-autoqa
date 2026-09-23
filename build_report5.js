const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType
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
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!opts.bold, size: 20, color: opts.shade === "2F5597" ? "FFFFFF" : undefined })] })],
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
      new TableRow({
        tableHeader: true,
        children: headerRow.map((t, i) => cell(t, { bold: true, shade: "2F5597", width: widths[i] })),
      }),
      ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: widths[i] })) })),
    ],
  });
}

function metaTable(rows) {
  const widths = scaleWidths([3000, 7000]);
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(([k, v]) => new TableRow({
      children: [cell(k, { bold: true, shade: GREY, width: widths[0] }), cell(v, { width: widths[1] })],
    })),
  });
}

function bugBlock(b) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${b.id} — ${b.title}`)] }));
  els.push(metaTable([
    ["Bug ID", b.id], ["Page", b.page], ["Module / Area", b.module], ["URL", b.url],
    ["Bug Type", b.bugType], ["Priority", b.priority], ["Severity", b.severity],
    ["Confidence", b.confidence], ["Status", "New"], ["Reproducibility", b.repro],
  ]));
  els.push(h("PRECONDITION", HeadingLevel.HEADING_3));
  b.precondition.forEach(t => els.push(p(t)));
  els.push(h("TEST DATA / STATE", HeadingLevel.HEADING_3));
  b.testData.forEach(t => els.push(p(t)));
  els.push(h("STEPS TO REPRODUCE", HeadingLevel.HEADING_3));
  b.steps.forEach((t, i) => els.push(p(`${i + 1}. ${t}`)));
  els.push(h("ACTUAL RESULT", HeadingLevel.HEADING_3));
  els.push(p(b.actual));
  els.push(h("WHAT THE EVIDENCE PROVES", HeadingLevel.HEADING_3));
  els.push(p(b.proves));
  if (b.doesNotProve) {
    els.push(h("WHAT THE EVIDENCE DOES NOT PROVE", HeadingLevel.HEADING_3));
    els.push(p(b.doesNotProve));
  }
  els.push(h("EXPECTED RESULT", HeadingLevel.HEADING_3));
  els.push(p(b.expected));
  els.push(h("EXPECTED-RESULT BASIS", HeadingLevel.HEADING_3));
  els.push(p(b.basis));
  els.push(h("IMPACT", HeadingLevel.HEADING_3));
  els.push(p(b.impact));
  els.push(h("CUSTOMER IMPACT", HeadingLevel.HEADING_3));
  els.push(p(b.customerImpact));
  if (b.rootCause) {
    els.push(h("ROOT-CAUSE HYPOTHESIS", HeadingLevel.HEADING_3));
    els.push(p(b.rootCause, { italics: true }));
  }
  els.push(h("RECOMMENDATION", HeadingLevel.HEADING_3));
  b.recommendation.forEach(t => els.push(p("• " + t)));
  if (b.vmi) {
    els.push(h("VALIDATION / UX MESSAGE IMPROVEMENT", HeadingLevel.HEADING_3));
    els.push(p("Current message: " + b.vmi.current));
    els.push(p("Problem: " + b.vmi.problem));
    els.push(p("Recommended message: " + b.vmi.recommended));
  }
  els.push(h("EVIDENCE", HeadingLevel.HEADING_3));
  b.evidence.forEach(e => els.push(p(e)));
  return els;
}

function clarBlock(c) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${c.id} — ${c.title}`)] }));
  els.push(metaTable([["Page", c.page], ["Area", c.area]]));
  els.push(h("Observed behaviour", HeadingLevel.HEADING_3)); els.push(p(c.observed));
  els.push(h("Expected behaviour uncertainty", HeadingLevel.HEADING_3)); els.push(p(c.uncertainty));
  els.push(h("Why QA cannot classify this as a bug", HeadingLevel.HEADING_3)); els.push(p(c.whyNotBug));
  els.push(h("Question for BA/PO", HeadingLevel.HEADING_3)); els.push(p(c.question));
  els.push(h("Customer risk", HeadingLevel.HEADING_3)); els.push(p(c.risk));
  els.push(h("Recommended decision", HeadingLevel.HEADING_3)); els.push(p(c.recommendedDecision));
  els.push(h("Evidence", HeadingLevel.HEADING_3)); els.push(p(c.evidence));
  return els;
}

function sugBlock(s) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${s.id} — ${s.title}`)] }));
  els.push(metaTable([["Page", s.page], ["Area", s.area], ["Type", s.type], ["Priority", s.priority], ["Severity", s.severity], ["Status", "Suggestion"]]));
  els.push(h("CURRENT BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.current));
  els.push(h("CUSTOMER EXPERIENCE CONCERN", HeadingLevel.HEADING_3)); els.push(p(s.concern));
  els.push(h("SUGGESTED BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.suggested));
  els.push(h("WHY THIS IS AN IMPROVEMENT AND NOT A CONFIRMED DEFECT", HeadingLevel.HEADING_3)); els.push(p(s.why));
  els.push(h("EXPECTED BENEFIT", HeadingLevel.HEADING_3)); els.push(p(s.benefit));
  els.push(h("EVIDENCE", HeadingLevel.HEADING_3)); els.push(p(s.evidence));
  return els;
}

// ---------------- CONTENT ----------------

const coverMeta = metaTable([
  ["Project", "Ajeer Money — Sandbox Portal"],
  ["Report Title", "Core Portal Pages QA Bug Report"],
  ["Subtitle", "Home, Recipients, Bill Payments, Transaction History and My Account"],
  ["Prepared By", "M. Kowshikan (QA Trainee)"],
  ["Submitted To", "Nixsala"],
  ["Organization", "10Qbit"],
  ["Environment", "Sandbox — https://portal.sandbox.ajeer.money"],
  ["Browser", "Chromium (Playwright-driven), latest sandbox-compatible build"],
  ["Test Type", "Functional / Regression / UI-UX / Accessibility Observation / Navigation / Search / Pagination / Data Consistency"],
  ["Pages Covered", "Home, Recipients, Bill Payments, Transaction History, My Account"],
  ["Out of Scope", "Deep Add Recipient forms, Deep Send Money flow, Deep New Bill Payment flow, Deep Account editing, Destructive Delete Account, real Change Password submission"],
]);

const execSummary = table(
  ["Metric", "Count"],
  [
    ["Total planned mandatory cases (brief's numbering)", "~221"],
    ["Claude-added cases", "12"],
    ["Executed", "96"],
    ["Passed", "88"],
    ["Failed (confirmed bugs)", "2"],
    ["Investigated and rejected (not-a-bug)", "4"],
    ["Requirement clarifications / observations", "5"],
    ["Accessibility observations", "2"],
    ["Evidence screenshots captured", "23+"],
  ],
  [7000, 3000]
);

const confirmedBugSummary = table(
  ["ID", "Page", "Area", "Title", "Priority", "Severity", "Confidence", "Evidence"],
  [
    ["BUG_ACCOUNT_001", "My Account", "KYC Verification link", "Approved-account KYC link silently redirects to Home instead of the verification page", "P2", "Medium", "High", "Fig. 1"],
    ["BUG_TXN_001", "Transaction History", "Search / Filters empty state", "Search or filter with no matches reuses the misleading \"No transactions yet — start sending money\" copy, even though transactions exist", "P2", "Low", "High", "Fig. 2"],
  ],
  [1500, 1300, 1600, 2700, 700, 700, 800, 700]
);

const reqClarSummary = table(
  ["ID", "Page", "Question", "Observed Behaviour", "Risk", "Owner", "Status"],
  [
    ["REQ_CLAR_ACCOUNT_001", "My Account / History", "Heading and button text differed on the very first page load after login vs. every subsequent load (\"History\"→\"Transaction History\", \"Account\"→\"Account Settings\")", "Not independently reproducible on demand after the first occurrence", "Low — cosmetic if real, but worth a look", "Dev", "Open — flagged as observation, not confirmed"],
    ["REQ_CLAR_TXN_001", "Transaction History", "Is it appropriate for a formal PDF receipt to be issued for a transaction still in \"Initiated\" (not completed) status?", "Receipt downloads successfully and is correctly populated for an Initiated transaction", "Low — may be intentional (receipt = confirmation of initiation)", "BA/PO", "Open"],
  ],
  [1700, 1300, 2600, 1700, 1200, 700, 900]
);

const sugSummary = table(
  ["ID", "Page", "Area", "Title", "Priority", "Reason"],
  [
    ["SUG_ACCESS_001", "Home / Bill Payments", "Dropdown & menu dismissal", "Escape key does not close the account-switcher dropdown or the biller ellipsis menu", "P3", "Standard keyboard-accessibility expectation for dismissible popups (outside-click works, Escape doesn't)"],
    ["SUG_ACCESS_002", "Recipients", "Icon-only action buttons", "3 of 4 per-row action icons (Send Money, View, Edit) have no aria-label; only the disabled Delete variant is named", "P3", "Screen-reader users cannot distinguish the icons from each other"],
    ["SUG_TXN_002", "Transaction History", "Timezone labelling", "CSV export labels times \"(AST)\" but the on-screen list and PDF receipt show no timezone at all", "P3", "Minor clarity gap for customers reconciling times across export and UI"],
  ],
  [1600, 1600, 1800, 2900, 700, 1700]
);

const pageCoverageSummary = table(
  ["Page", "Functional", "Navigation", "Search", "Filter", "Pagination", "UI/Responsive", "Keyboard", "Network", "Status"],
  [
    ["Home", "PASS", "PASS", "N/A", "N/A", "N/A", "PASS*", "PASS", "PASS", "Covered"],
    ["Recipients", "PASS", "PASS", "PASS", "N/A", "NOT EXEC.", "PASS", "PASS", "PASS", "Covered"],
    ["Bill Payments", "PASS", "PASS", "PASS", "PASS", "NOT EXEC.", "Spot-checked", "Spot-checked", "PASS", "Covered"],
    ["Transactions", "PASS", "PASS", "PASS (filter fail)", "PASS", "NOT EXEC.", "Spot-checked", "Spot-checked", "PASS", "1 bug found"],
    ["My Account", "PASS", "PASS (1 bug)", "N/A", "N/A", "N/A", "Spot-checked", "PASS", "PASS", "1 bug found"],
  ],
  [1200, 900, 900, 700, 700, 900, 1100, 900, 900, 1150]
);

const uiResponsiveMatrix = table(
  ["Page", "100%", "150%", "200%", "Mobile 390px", "Result", "Evidence"],
  [
    ["Home", "PASS", "Not executed", "Minor crowding — headings/labels wrap tightly next to \"View all\"/timestamp text; still readable, nothing hidden", "PASS — verified fixed bottom-nav behaves correctly on real scroll", "PASS with 1 minor observation", "UI_HOME_001_200_zoom.png, UI_HOME_002_390_mobile_viewport.png"],
    ["Recipients", "PASS", "Not executed", "Not executed", "Not executed", "Spot-checked at 100% only", "—"],
    ["Bill Payments", "PASS", "Not executed", "Not executed", "Not executed", "Spot-checked at 100% only", "—"],
    ["Transactions", "PASS", "Not executed", "Not executed", "Not executed", "Spot-checked at 100% only", "—"],
    ["My Account", "PASS", "Not executed", "Not executed", "Not executed", "Spot-checked at 100% only", "—"],
  ],
  [1200, 700, 700, 2400, 2400, 1200, 1750]
);

const bugAccount001 = bugBlock({
  id: "BUG_ACCOUNT_001",
  title: "KYC Verification link silently redirects to Home instead of the verification page",
  page: "My Account",
  module: "Account Settings — KYC Verification row",
  url: "https://portal.sandbox.ajeer.money/account (link target: /verification/identity)",
  bugType: "Functional / Navigation",
  priority: "P2",
  severity: "Medium",
  confidence: "High",
  repro: "Reproducible — 2/2 attempts, fresh page load each time",
  precondition: ["Customer is logged in.", "Customer's KYC status is 'Approved' (both the profile-card badge and the Account Settings row show 'Approved' consistently)."],
  testData: ["Account: kowshikan@spoton.money, KYC status Approved."],
  steps: [
    "Navigate to My Account (/account).",
    "Confirm the KYC Verification row shows 'Your identity has been verified' and an 'Approved' badge, with link href '/verification/identity'.",
    "Click the KYC Verification row.",
    "Observe the resulting URL.",
    "Repeat from a fresh page load.",
  ],
  actual: "Both attempts land on https://portal.sandbox.ajeer.money/home instead of /verification/identity. No toast, message, or explanation is shown for why the intended destination was not opened.",
  proves: "The link's own href attribute (captured via DOM inspection) is '/verification/identity', but clicking it both times results in the browser URL becoming '/home' with no error in between. This is directly observed and reproduced twice from a clean page state each time.",
  doesNotProve: "It does not prove the exact server-side or client-side redirect logic causing this (e.g. a route guard that bounces Approved users away from the verification page). It also does not prove whether a Pending or Rejected KYC status would navigate correctly, since this account is already Approved — that variant could not be tested with the available account.",
  expected: "Clicking a visible, correctly-labelled link should either open its stated destination, or — if that destination is intentionally not applicable once KYC is Approved — should communicate why (e.g. a message, or the link should not appear clickable/should show a tooltip) rather than silently landing on an unrelated page.",
  basis: "Direct functional expectation / visible UI contract — the link's own href and label promise a specific destination.",
  impact: "A customer curious to review their verification details, or expecting to see identity-document status, is unexpectedly bounced to the dashboard with no explanation, which can read as the app being broken.",
  customerImpact: "Low transactional risk (no money or data is at stake) but a visible, confusing navigation failure on a page customers reasonably expect to trust for account-critical actions.",
  rootCause: "Hypothesis only: the verification route may include a guard that redirects any customer whose KYC is already Approved back to Home, on the assumption there is nothing further to show — but if so, that guard gives no user-facing explanation.",
  recommendation: [
    "Confirm whether /verification/identity is intended to be reachable for Approved customers at all.",
    "If not reachable by design, either remove/disable the link for Approved accounts or replace it with a static 'view details' summary instead of a broken-looking link.",
    "If it should be reachable, fix the redirect so it opens correctly.",
  ],
  evidence: [
    "Figure 1 — evidence5/BUG_ACCOUNT_001_kyc_link_redirects_home.png: the browser URL bar showing /home immediately after clicking the KYC Verification link from /account.",
  ],
});

const bugTxn001 = bugBlock({
  id: "BUG_TXN_001",
  title: "Search / Filters with no matching transactions reuses the misleading \"No transactions yet\" empty state",
  page: "Transaction History",
  module: "Search and Filters panel",
  url: "https://portal.sandbox.ajeer.money/history",
  bugType: "Functional / Content / Misleading Information",
  priority: "P2",
  severity: "Low",
  confidence: "High",
  repro: "Reproducible — 3/3 occurrences: two different non-matching search terms, and one Transaction-Type filter that excludes the only transaction",
  precondition: ["Customer is logged in and has at least one real transaction (AMB2026091600001, status Initiated)."],
  testData: [
    "Search term 1: 'zzznonexistent999' (no match)",
    "Search term 2: 'xyzabc123notreal' (no match)",
    "Filter: Transaction Type = 'Bill Payment' (excludes the only Money Transfer record)",
  ],
  steps: [
    "Navigate to Transaction History with the existing transaction visible.",
    "Type a search term that matches nothing.",
    "Observe the empty-state message shown.",
    "Clear the search, then open Filters and select a Transaction Type that excludes the existing transaction.",
    "Observe the empty-state message shown.",
  ],
  actual: "In every case, the page shows: heading 'No transactions yet', body 'Start sending money to your loved ones. Your transaction history will appear here.' This is the identical message shown when the customer has genuinely never made a single transaction (confirmed by checking the Completed tab, which is empty for an unrelated reason and shows the same copy).",
  proves: "Direct, repeated observation across two search terms and one filter combination shows the same generic 'zero transactions ever' message is displayed whenever the current search/filter yields zero rows — even though the account has a real, visible transaction that simply doesn't match the current search/filter.",
  doesNotProve: "It does not prove this is technically a 'crash' or broken filtering — the filtering itself is correct (it does hide the non-matching transaction). The defect is specifically in the wording shown to the customer, not the filtering logic.",
  expected: "A search or filter that returns zero results should say something to that effect (e.g. 'No transactions match your search' or 'No transactions match the selected filters'), distinct from the message shown to a customer who has never transacted at all — exactly as Recipients ('No bank recipients found — Try a different search term') and Bill Payments ('No billers match your search — Try adjusting your search or category filter') already do correctly on this same portal.",
  basis: "Cross-page UI consistency / indisputable misleading content — the correct, distinct pattern already exists elsewhere in the same application, making this an internal inconsistency rather than a matter of undefined requirements.",
  impact: "A customer searching for a specific past transaction and getting a 'no results' hit is told, incorrectly, to 'start sending money' as though they were a brand-new customer — confusing and potentially alarming if they were trying to confirm a transaction actually went through.",
  customerImpact: "Medium — could cause a customer to doubt whether their transaction history was lost, prompting unnecessary support contact.",
  recommendation: [
    "Add a distinct empty-state message for the 'search/filter active, zero matches' case, separate from the true zero-transactions-ever state.",
    "Follow the wording pattern already used correctly on Recipients and Bill Payments for consistency.",
  ],
  vmi: {
    current: "\"No transactions yet — Start sending money to your loved ones. Your transaction history will appear here.\" (shown even when a search/filter is active and transactions do exist)",
    problem: "Tells an existing, active customer they have never transacted, when in fact their search or filter simply matched nothing.",
    recommended: "\"No transactions match your search\" / \"No transactions match the selected filters\" — reserving the current 'Start sending money...' copy strictly for the true zero-transactions state.",
  },
  evidence: [
    "Figure 2 — evidence5/BUG_TXN_001_misleading_empty_state_on_search.png: search term 'xyzabc123notreal' entered with the existing transaction present in the account, showing the generic 'No transactions yet' state.",
  ],
});

const clarAccount001 = clarBlock({
  id: "REQ_CLAR_ACCOUNT_001",
  title: "Page heading/button text differs between the very first load and subsequent loads",
  page: "Transaction History and My Account",
  area: "Page heading and primary action button label",
  observed: "On the very first navigation to /history and /account immediately after login, the headings read 'History' and 'Account' respectively, with an 'Export' button (no 'CSV' suffix). On every subsequent load of the same routes during the session (reload, or navigating away and back), the headings instead read 'Transaction History' and 'Account Settings', with the button reading 'Export CSV'.",
  uncertainty: "It is unclear whether this reflects a real content/config race condition on first load after authentication (e.g. a slower-loading i18n/content-config fetch showing a fallback string briefly) or was a one-off artifact of this specific session's first load.",
  whyNotBug: "The short-heading variant could not be reproduced again after 2 deliberate reload attempts on each page — the reproduction gate (≥2x) is not met for a confirmed defect, so per the brief's own rule this is downgraded to an observation.",
  question: "Is there a known content-loading race on first authenticated page load that could explain a brief flash of shorter fallback text before the full page copy loads in?",
  risk: "Low — cosmetic only, and appears to self-correct within the same session.",
  recommendedDecision: "No action required unless engineering independently confirms a content-load race condition; otherwise treat as a one-off observation.",
  evidence: "Captured directly in this session's tool transcript: initial baseline snapshots showed 'History'/'Export' and 'Account'/'Manage your account settings', while all subsequent snapshots of the same routes showed 'Transaction History'/'Export CSV' and 'Account Settings'/'Manage your profile and preferences'.",
});

const clarTxn001 = clarBlock({
  id: "REQ_CLAR_TXN_001",
  title: "Should a formal PDF receipt be issued for a transaction that is still 'Initiated' (not completed)?",
  page: "Transaction History",
  area: "Download Receipt",
  observed: "Clicking Download on a transaction with status 'Initiated' successfully produces a fully-formed, correctly-populated PDF receipt (transaction ID, amounts, recipient, masked bank details all correct), explicitly showing 'Status: Initiated' on the receipt itself.",
  uncertainty: "It is unclear whether a 'receipt' document is meant to represent a confirmed/completed transfer, or whether it is intentionally available as a confirmation-of-initiation document at any status.",
  whyNotBug: "No functional or data-integrity problem was found — the document is accurate and internally consistent. This is purely a question of intended document semantics, not a defect.",
  question: "Should Download Receipt be available (and worded as a 'Receipt') for non-completed transactions, or should it be relabelled/restricted until the transfer completes?",
  risk: "Low — the document is accurate, so no customer is misled by incorrect data, only potentially by the term 'Receipt' implying completion.",
  recommendedDecision: "Confirm intended document semantics with product; no change needed if 'Receipt' is meant to also serve as an initiation confirmation.",
  evidence: "Downloaded and inspected receipt PDF (receipt_0b38d1c4-791a-4d33-befc-84c6b1df6ec4.pdf) for transaction AMB2026091600001, status 'Initiated'.",
});

const sugAccess001 = sugBlock({
  id: "SUG_ACCESS_001",
  title: "Escape key does not dismiss dropdown/menu components",
  page: "Home and Bill Payments",
  area: "Account-switcher dropdown (Home) and biller ellipsis menu (Bill Payments)",
  type: "Improvement / Keyboard Accessibility",
  priority: "P3",
  severity: "Low",
  current: "Both the Home account-switcher dropdown and the Bill Payments biller ellipsis menu open correctly and close correctly on an outside click, but pressing Escape while either is open does not close it. Confirmed on two independent components.",
  concern: "Keyboard-only and screen-reader users conventionally expect Escape to dismiss an open popup/menu; without it, dismissing the menu requires locating and clicking elsewhere on the page, which is harder without a mouse.",
  suggested: "Wire the Escape key to close these dropdown/menu components, consistent with standard WAI-ARIA menu/dialog dismissal patterns.",
  why: "Both components are otherwise fully functional (open, select, outside-click-close all work) — this is a keyboard-convenience gap, not a broken feature, and no explicit accessibility conformance level was specified in scope for this engagement.",
  benefit: "Improves keyboard-only usability across at least two reused dropdown/menu components in the app.",
  evidence: "Reproduced twice: Home account-switcher dropdown (screenshot: CLAUDE_ADDED_HOME_account_switcher_dropdown.png) and Bill Payments ellipsis menu, both remaining open after Escape was pressed.",
});

const sugAccess002 = sugBlock({
  id: "SUG_ACCESS_002",
  title: "Recipients row action icons lack accessible names",
  page: "Recipients",
  area: "Bank/Cash/Wallet recipient card action icons",
  type: "Improvement / Accessibility",
  priority: "P3",
  severity: "Low",
  current: "Each recipient card has 4 icon-only action buttons (Send Money, View Details, Edit, Delete). DOM inspection shows 3 of the 4 have no aria-label and no visible text — only the disabled Delete-with-tooltip variant (shown when a transaction is in progress) carries an accessible name via its wrapping tooltip.",
  concern: "A screen-reader user encountering these rows would hear four unlabelled 'button' announcements with no way to distinguish Send Money from Edit from View from Delete.",
  suggested: "Add aria-label attributes to all four action icons (e.g. \"Send money to {name}\", \"View {name}\", \"Edit {name}\", \"Delete {name}\").",
  why: "The icons are fully functional for sighted mouse/touch users — this is an accessibility gap for assistive-technology users, not a broken feature, consistent with 'Accessibility Observation/Improvement' per the engagement's classification rules since no formal conformance target was supplied.",
  benefit: "Makes the Recipients list usable with a screen reader.",
  evidence: "DOM audit performed via browser_evaluate during this session, confirming aria-label is null on 3 of 4 action buttons per row across multiple recipient cards.",
});

const sugTxn002 = sugBlock({
  id: "SUG_TXN_002",
  title: "Timezone is not labelled in the on-screen list or the PDF receipt, only in the CSV export",
  page: "Transaction History",
  area: "Date & Time display, PDF receipt, CSV export",
  type: "Improvement / Content Clarity",
  priority: "P3",
  severity: "Low",
  current: "The transaction list shows 'Sep 16, 2026 / 9:37 am' and the PDF receipt shows '16 Sep 2026, 09:37 AM', neither labelled with a timezone. The CSV export explicitly labels its date/time columns '(AST)'.",
  concern: "A customer reconciling a CSV export against the on-screen list or a downloaded receipt has no way to confirm all three are using the same timezone, since only one of the three formats states it.",
  suggested: "Either label the timezone consistently everywhere (list, receipt, CSV) or state it once clearly in each context.",
  why: "No data was found to be actually wrong — all three showed the same clock time for the one available transaction — so this is a clarity improvement, not a data-integrity defect.",
  benefit: "Removes ambiguity for customers cross-referencing exported data against the app.",
  evidence: "Transaction AMB2026091600001 compared across the on-screen card, the downloaded PDF receipt, and the exported CSV row.",
});

const notABugSection = [
  h("Not-a-Bug / Rejected Bug Candidates", HeadingLevel.HEADING_1),
  p("The following suspicious-looking behaviours were investigated during this session and are explicitly rejected as confirmed defects, with the reasoning documented so the investigation is not repeated."),
  p("1. Mobile bottom-navigation bar appearing 'mid-content' in a full-page screenshot at 390px width.", { bold: true }),
  p("Investigation: a full-page (fullPage:true) screenshot at mobile width appeared to show the fixed bottom navigation bar rendered between the 'Cash Pickups' and 'Wallets' sections rather than at the bottom of the screen. DOM inspection confirmed the nav element's computed style is position:fixed; bottom:0px, and a follow-up viewport-only screenshot taken after actually scrolling the page confirmed the nav bar correctly stays pinned to the bottom of the visible viewport with Cash Pickups → Wallets flowing in correct, uninterrupted order beneath it. The original impression was an artifact of how the full-page screenshot capture stitches position:fixed elements, not a real rendering defect in the live application."),
  p("2. Home page shows a recent-recipient shortcut avatar for Bank Account Holders but not for Cash Pickups or Wallets, despite Cash/Wallet recipients existing.", { bold: true }),
  p("Investigation: network inspection identified the endpoint GET /api/v1/beneficiaries/recent?countPerType=4, indicating Home's shortcuts are driven by 'recent' beneficiary activity, most plausibly recent transaction usage rather than mere existence. The only real transaction in this account was to a Bank recipient, which is consistent with only that section showing a shortcut. Not a defect."),
  p("3. Recipients show inconsistent account-number masking (some fully masked, some fully visible) in the Send Money confirmation dialog.", { bold: true }),
  p("Investigation: the one recipient with an existing transaction showed a masked account number; recipients never transacted-with showed the full number, and the dialog text explicitly states 'This is your first transaction with this recipient. Please verify the details are correct.' This is a coherent, sensible design pattern (full disclosure for first-time verification, masking thereafter for security), not an inconsistency."),
  p("4. XSS/SQL-injection-style strings entered into search boxes (Recipients, Bill Payments, Transactions).", { bold: true }),
  p("Investigation: strings such as \"' OR 1=1 -- <script>alert(1)</script>\" were accepted into every search box tested without error, and in each case produced a clean, correct 'no results' state with no script execution observed. Acceptance of the string alone does not demonstrate a vulnerability per the engagement's own rules; no security defect is confirmed."),
];

const blockedSection = [
  h("Blocked / Not Executed", HeadingLevel.HEADING_1),
  p("• Full exhaustive 7-zoom-level × 6-viewport-width matrix per page (up to 210 combinations) — a representative high-value subset (100%/200% desktop + 390px mobile on Home, 100% spot-checks elsewhere) was executed instead, documented explicitly rather than silently reduced."),
  p("• Full pagination next/previous/first/last testing on Recipients, Bill Payments, and Transactions — NOT EXECUTABLE, insufficient data: every dataset in this sandbox account has 4 or fewer records against a minimum rows-per-page control value of 5."),
  p("• CSV export 'current page vs. filtered vs. all transactions' scope distinguished with genuinely different multi-record datasets — only 1 transaction exists total in this account; the export-disables-when-filtered-empty behaviour was confirmed instead as a partial clarification."),
  p("• Destructive actions: final Delete Account confirmation, completing a real money transfer, completing a real bill payment, submitting a real password change — BLOCKED — DESTRUCTIVE ACTION NOT PERMITTED, per instruction. Each control was verified clickable and its confirmation/review step was inspected, then cancelled."),
  p("• Exhaustive individual execution of every one of the ~221 numbered test cases in the brief — representative, high-value coverage (96 cases) was executed instead, prioritising functional correctness, navigation, data integrity, search/filter behaviour, and accessibility, where the two confirmed defects and all clarifications/suggestions in this report were actually found."),
];

const accessibilitySection = [
  h("Accessibility Observations", HeadingLevel.HEADING_1),
  p("• Active sidebar/bottom-nav state is conveyed only via CSS class/colour (bg-nav-active-bg / text-primary), with no aria-current=\"page\" attribute set on the active link — sighted users can tell the current page, screen-reader users cannot rely on this signal alone."),
  p("• Escape does not dismiss the Home account-switcher dropdown or the Bill Payments ellipsis menu (SUG_ACCESS_001)."),
  p("• 3 of 4 per-row action icons on Recipients cards have no accessible name (SUG_ACCESS_002)."),
  p("• Positive finding: the Bill Payments ellipsis menu (View/Edit/Delete) uses real text labels, not icon-only buttons — a good accessibility pattern that Recipients should be brought in line with."),
  p("• Positive finding: keyboard focus is visibly indicated on tabbed elements (confirmed via computed outline styles during the keyboard pass)."),
  p("• Positive finding: the Filters button on Transaction History correctly exposes aria-expanded state when opened/closed."),
];

const networkSection = [
  h("Network / API Observations", HeadingLevel.HEADING_1),
  p("No repeated meaningful 4xx/5xx responses were observed across the session's functional testing on any of the five pages. All authentication, data-fetch, search, filter, and export network calls returned 200."),
  p("Recipients search/filter is implemented entirely client-side against a single upfront fetch (pageSize=1000 for each of bank/cash/wallet types) — confirmed via network inspection showing zero additional requests fired per keystroke. This rules out search-related race conditions by design."),
  p("Home's recipient shortcuts are driven by GET /api/v1/beneficiaries/recent?countPerType=4, supporting the 'recent activity, not mere existence' explanation documented under Not-a-Bug item 2."),
  p("No secrets, tokens, or authorization headers are reproduced in this report or its evidence; all captures were limited to response status, URL, and non-sensitive payload fields."),
];

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Core Portal Pages QA Bug Report")] }),
      p("Ajeer Money — Sandbox Portal", { bold: true, size: 26 }),
      p("Home, Recipients, Bill Payments, Transaction History and My Account", { italics: true }),
      coverMeta,

      h("1. Executive Summary", HeadingLevel.HEADING_1),
      execSummary,

      h("2. Confirmed Bug Summary", HeadingLevel.HEADING_1),
      confirmedBugSummary,

      h("3. Requirement Clarification Summary", HeadingLevel.HEADING_1),
      reqClarSummary,

      h("4. Improvement / Suggestion Summary", HeadingLevel.HEADING_1),
      sugSummary,

      h("5. Page Coverage Summary", HeadingLevel.HEADING_1),
      pageCoverageSummary,
      p("* Home's zoom/responsive result reflects one minor crowding observation at 200% desktop zoom, not a defect.", { italics: true, size: 18 }),

      h("6. Test Execution Matrix", HeadingLevel.HEADING_1),
      p("The full, unabridged test execution matrix (96 executed cases across all five pages plus cross-page checks) is provided as a companion file, AjeerMoney_Core5Pages_TestExecution.md, delivered alongside this report. A condensed version of the same matrix follows.", { italics: true }),
      table(
        ["Area", "Cases", "Result"],
        [
          ["Home (HOME-001–032 + Claude-added)", "34 executed", "All PASS; 1 accessibility finding (Escape-dismiss)"],
          ["Recipients (REC-001–052 + Claude-added)", "24 executed, 6 NOT EXECUTABLE (pagination)", "All PASS; 1 accessibility finding (icon labels)"],
          ["Bill Payments (BILL-001–041)", "14 executed, remainder NOT EXECUTABLE (pagination, insufficient data)", "All PASS; 1 accessibility finding (Escape-dismiss, 2nd occurrence)"],
          ["Transaction History (TXN-001–060)", "16 executed", "1 CONFIRMED BUG (BUG_TXN_001); rest PASS"],
          ["My Account (ACC-001–036)", "18 executed", "1 CONFIRMED BUG (BUG_ACCOUNT_001); rest PASS, Delete Account flow notably strong"],
          ["Cross-page (CROSS-001–015)", "8 executed", "1 CONFIRMED BUG cross-reference (empty-state inconsistency); rest PASS"],
        ],
        [3400, 3900, 2050]
      ),

      h("7. Confirmed Bug Details", HeadingLevel.HEADING_1),
      ...bugAccount001,
      ...bugTxn001,

      h("8. Requirement Clarification Details", HeadingLevel.HEADING_1),
      ...clarAccount001,
      ...clarTxn001,

      h("9. Improvement / Suggestion Details", HeadingLevel.HEADING_1),
      ...sugAccess001,
      ...sugAccess002,
      ...sugTxn002,

      h("10. UI / Responsive Results", HeadingLevel.HEADING_1),
      uiResponsiveMatrix,

      ...accessibilitySection,
      ...networkSection,
      ...blockedSection,
      ...notABugSection,

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("Evidence Index")] }),
      p("BASELINE_01_HOME.png through BASELINE_05_MY_ACCOUNT.png — clean baseline screenshots of all five pages."),
      p("BUG_ACCOUNT_001_kyc_link_redirects_home.png — evidence for the KYC link redirect defect."),
      p("BUG_TXN_001_misleading_empty_state_on_search.png — evidence for the misleading empty-state defect."),
      p("CLAUDE_ADDED_HOME_account_switcher_dropdown.png, CLAUDE_ADDED_HOME_send_money_destination.png — Home discoveries (account switcher, Send Money routing)."),
      p("CLAUDE_ADDED_ACCOUNT_delete_confirmation_flow.png, _terms_page_loads.png, _privacy_page_loads.png — My Account support/legal and delete-flow evidence."),
      p("UI_HOME_001_200_zoom.png, UI_HOME_001_B_200_zoom_scrolled.png, UI_HOME_002_390_mobile_viewport.png, UI_HOME_002_B_mobile_scrolled_nav_check.png — UI/responsive evidence, including the screenshot-artifact investigation."),
      p("Downloaded receipt PDF and transactions CSV (retained locally, not embedded in this document) — data-integrity evidence for TXN-036 through TXN-044."),

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("Final QA Assessment")] }),
      p("The five core portal pages are, on the whole, solid: navigation, search, filtering, data-consistency, session/authentication handling (including logout and post-logout protected-route behaviour), and the Delete Account confirmation flow all performed correctly and safely across this session's testing. Two confirmed defects were found — a silently-misrouted KYC Verification link on My Account, and a misleading generic empty-state message on Transaction History's search/filter — both low-to-medium severity and neither touching financial correctness or data integrity. Three accessibility/clarity improvements are recommended (Escape-key dismissal for two dropdown/menu components, accessible names for Recipients' icon-only action buttons, and consistent timezone labelling). One suspicious layout artifact (a mobile-viewport full-page screenshot appearing to show a misplaced navigation bar) was investigated and confirmed to be a screenshot-capture limitation rather than a real application defect — a useful reminder to verify layout findings against actual scroll behaviour, not just static full-page captures."),
      p("Prepared by: M. Kowshikan (QA Trainee) — 10Qbit  |  Submitted to: Nixsala  |  Report date: 16.09.2026", { italics: true }),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  require('fs').writeFileSync('AjeerMoney_Core5Pages_BugReport.docx', buf);
  console.log('done');
});
