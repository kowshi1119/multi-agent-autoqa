const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, PageBreak
} = require('docx');

const GREY = "F2F2F2";
const RED = "FDE7E7";
const YELLOW = "FFF6D9";

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

const TABLE_WIDTH_DXA = 9350; // fits US-Letter body width (12240 - 2*1440 margins - buffer)

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
    ["Bug ID", b.id],
    ["Module", b.module],
    ["Submodule/Page", b.page],
    ["URL", b.url],
    ["Requirement ID", b.reqId],
    ["Country / Provider", b.country],
    ["Bug Type", b.bugType],
    ["Priority", b.priority],
    ["Severity", b.severity],
    ["Confidence", b.confidence],
    ["Status", "New"],
    ["Reproducibility", b.repro],
  ]));
  els.push(h("PRECONDITION", HeadingLevel.HEADING_3));
  b.precondition.forEach(t => els.push(p(t)));
  els.push(h("TEST DATA", HeadingLevel.HEADING_3));
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
  els.push(h("REQUIREMENT TRACEABILITY", HeadingLevel.HEADING_3));
  els.push(p(b.traceability));
  els.push(h("VALIDATION TEST DATA", HeadingLevel.HEADING_3));
  els.push(table(["Input", "Expected", "Observed"], b.validationTable, [3400, 3300, 3300]));
  els.push(h("IMPACT", HeadingLevel.HEADING_3));
  els.push(p(b.impact));
  if (b.rootCause) {
    els.push(h("ROOT-CAUSE HYPOTHESIS", HeadingLevel.HEADING_3));
    els.push(p(b.rootCause, { italics: true }));
  }
  els.push(h("RECOMMENDATION", HeadingLevel.HEADING_3));
  b.recommendation.forEach(t => els.push(p("• " + t)));
  if (b.vmi) {
    els.push(h("VALIDATION MESSAGE IMPROVEMENT", HeadingLevel.HEADING_3));
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
  els.push(metaTable([
    ["Module", c.module],
    ["Field", c.field],
  ]));
  els.push(h("Current behaviour", HeadingLevel.HEADING_3)); els.push(p(c.current));
  els.push(h("Project requirement", HeadingLevel.HEADING_3)); els.push(p(c.requirement));
  els.push(h("External authoritative standard", HeadingLevel.HEADING_3)); els.push(p(c.external));
  els.push(h("Conflict/uncertainty", HeadingLevel.HEADING_3)); els.push(p(c.conflict));
  els.push(h("Why QA cannot classify this as a bug yet", HeadingLevel.HEADING_3)); els.push(p(c.whyNotBug));
  els.push(h("Question for BA/PO", HeadingLevel.HEADING_3)); els.push(p(c.question));
  els.push(h("Risk if unresolved", HeadingLevel.HEADING_3)); els.push(p(c.risk));
  els.push(h("Recommended decision", HeadingLevel.HEADING_3)); els.push(p(c.recommendedDecision));
  els.push(h("Evidence", HeadingLevel.HEADING_3)); els.push(p(c.evidence));
  return els;
}

function sugBlock(s) {
  const els = [];
  els.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_2, children: [new TextRun(`${s.id} — ${s.title}`)] }));
  els.push(metaTable([
    ["Module", s.module],
    ["Field/Page", s.field],
    ["Type", s.type],
    ["Priority", s.priority],
    ["Severity", s.severity],
    ["Status", "Suggestion"],
  ]));
  els.push(h("CURRENT BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.current));
  els.push(h("SUGGESTED BEHAVIOUR", HeadingLevel.HEADING_3)); els.push(p(s.suggested));
  els.push(h("WHY THIS IS AN IMPROVEMENT AND NOT A CONFIRMED DEFECT", HeadingLevel.HEADING_3)); els.push(p(s.why));
  els.push(h("EXPECTED BENEFIT", HeadingLevel.HEADING_3)); els.push(p(s.benefit));
  els.push(h("EVIDENCE", HeadingLevel.HEADING_3)); els.push(p(s.evidence));
  return els;
}

// ---------- CONTENT ----------

const coverMeta = metaTable([
  ["Project", "Ajeer Money — Sandbox Portal"],
  ["Report Title", "Recipients Module QA Bug Report"],
  ["Prepared By", "M. Kowshikan (QA Trainee)"],
  ["Submitted To", "Nixsala"],
  ["Organisation", "10Qbit"],
  ["Report Date", "15.09.2026"],
  ["Environment", "Sandbox — https://portal.sandbox.ajeer.money"],
  ["Browser", "Chromium (Playwright-driven), latest sandbox-compatible build — exact version not exposed by the automation harness"],
  ["Test Type", "Functional / Input Validation / Country Validation / Recipient Flow / Regression"],
  ["Modules", "Bank Account Holder — Personal; Bank Account Holder — Business; Cash Pickup; Wallet; Recipient List"],
  ["Requirements Reviewed", "11285-PF, 11290-PF, 11159-PF, 11294-PF (applicability-checked, not assumed)"],
  ["Test Account", "Personal customer (kowshikan@spoton.money) — no Business customer account or Admin/PD Lookup access available this session"],
]);

const execSummaryTable = table(
  ["Metric", "Count"],
  [
    ["Total test scenarios designed", "~65"],
    ["Total executed", "52"],
    ["Passed", "31"],
    ["Failed (confirmed bugs)", "3"],
    ["Blocked", "14"],
    ["Requirement clarifications", "4"],
    ["Improvement suggestions", "2"],
    ["Countries tested (Bank/Cash)", "4 of 4 configured: Sri Lanka, Pakistan, Bangladesh, Nepal"],
    ["Countries tested (Wallet)", "1 of 1 configured: Pakistan"],
    ["Wallet providers tested", "Easypaisa (creation); JazzCash (inventoried only)"],
  ],
  [6000, 4000]
);

const confirmedBugSummary = table(
  ["ID", "Module", "Requirement", "Title", "Priority", "Severity", "Confidence", "Evidence"],
  [
    ["BUG_BUSINESS_001", "Bank Acct Holder — Business", "11285-PF, 11290-PF", "Business Beneficiary creation always fails (400, generic error)", "P1", "High", "High", "Fig. 1A-D"],
    ["BUG_BANK_001", "Bank Details (all countries)", "11159-PF", "Bank field-schema API 404s for every configured country", "P1", "Medium", "High", "Fig. 2A-B"],
    ["BUG_ADDRESS_001R", "Personal/Business Recipient — Address", "Data quality", "Address Line 1 / Postal Code accept script-like & symbol-only input, no validation", "P2", "Medium", "High", "Fig. 3A-C"],
  ],
  [1600, 1500, 1300, 2600, 700, 700, 800, 800]
);

const reqClarSummary = table(
  ["ID", "Module", "Question/Conflict", "Requirement", "Risk", "Owner", "Status"],
  [
    ["REQ_CLAR_COUNTRY_001", "Bank Details", "11159-PF's Country Coverage Matrix names 12+ countries none of which exist in this sandbox", "11159-PF", "Medium — most of 11159-PF is untestable here", "BA/PO + Config", "Open"],
    ["REQ_CLAR_BUSINESS_001", "Business Recipient", "Is 'Business Registration Type' the field 11290-PF calls 'Business Type'? No mandatory indicator; server enforcement unverifiable while creation is broken", "11290-PF", "High — mandatory rule may be entirely unenforced", "BA/PO", "Open"],
    ["REQ_CLAR_NAME_001", "Personal/Business Recipient — Name", "First/Last Name reject accented Latin letters (José)", "Not specified", "Medium — legitimate legal names may be blocked", "BA/PO", "Open"],
    ["REQ_CLAR_PHONE_001", "Recipient Contact Number", "Duplicate country-code entry (+94 selected, 94... typed) accepted without rejection", "11294-PF (onboarding-scoped)", "Low-Medium — unclear if 11294 should extend here", "BA/PO", "Open"],
  ],
  [1500, 1300, 2800, 1300, 1300, 900, 700]
);

const sugSummary = table(
  ["ID", "Module", "Title", "Priority", "Reason"],
  [
    ["SUG_BUSINESS_001", "Business Recipient — API", "Generic 400 error gives no field-level detail (errors: null)", "P2", "Blocks efficient diagnosis of BUG_BUSINESS_001 and any future validation failure"],
    ["SUG_ADDRESS_001", "Recipient Address", "Validate Address Line 1 / Postal Code against real address character sets and country postal formats", "P2", "Prevents unusable data entering a KYC-adjacent record"],
  ],
  [1800, 1800, 3400, 900, 2100]
);

const countryMatrix = table(
  ["Country", "Flow", "Fields Displayed", "Project Req/Config", "External Reference", "Observed Result", "Assessment"],
  [
    ["Sri Lanka (LK)", "Bank", "Bank Name, Branch Name, Account Number*, Bank Code*", "Not explicitly itemised for LK in PROD_V04", "External validation rule not independently verified", "field-schema 404; generic fields only", "REQ_CLAR_COUNTRY_001 / BUG_BANK_001"],
    ["Pakistan (PK)", "Bank", "Bank Name, Branch Name, Account Number*, Bank Code*", "PROD_V04: 'configuration-dependent statements'; Country Coverage Matrix: 'Primary Account Number only if no secondary configured'", "Pakistan uses IBAN per SBP (external, not independently verified in this session)", "field-schema 404; only primary+generic fields shown, consistent with 'no secondary configured' fallback", "PASS against AC-03 reading, but see BUG_BANK_001 for why (404, not intentional config)"],
    ["Bangladesh (BD)", "Bank", "Bank Name, Branch Name, Account Number*, Bank Code*", "Country Coverage Matrix: Routing Number + NPSB where applicable", "External validation rule not independently verified", "field-schema 404; no Routing Number/NPSB field shown", "REQ_CLAR_COUNTRY_001 / BUG_BANK_001"],
    ["Nepal (NP)", "Bank", "Bank Name, Branch Name, Account Number*, Bank Code*", "Not covered in PROD_V04 Country Coverage Matrix", "External validation rule not independently verified", "field-schema 404; generic fields only", "REQ_CLAR_COUNTRY_001 / BUG_BANK_001"],
    ["Pakistan (PK)", "Wallet", "Service Provider* (Easypaisa, JazzCash), Wallet ID*", "Not itemised in supplied PROD_V04 excerpt", "External validation rule not independently verified", "Wallet creation succeeded (Easypaisa)", "PASS"],
    ["India, Australia, UK, USA, Canada, Japan, Hong Kong, Jamaica, Egypt, South Korea, Russia, UAE, SEPA/EUR", "Bank (all)", "N/A — not offered", "11159-PF names all of these as example countries requiring specific secondary fields", "Various (SWIFT IBAN Registry, RBI, Payments Canada, SBP, etc. — not fetched this session)", "Currency search returns 'No currencies found' for every one of these", "BLOCKED / NOT CONFIGURED — REQ_CLAR_COUNTRY_001"],
  ],
  [1300, 700, 2200, 1900, 1600, 1600, 1400]
);

const testExecMatrix = table(
  ["TC ID", "Requirement", "Module", "Scenario", "Expected", "Actual", "Status"],
  [
    ["TC-P01", "—", "Personal", "Create valid Personal recipient (Sri Lanka)", "Recipient created, listed as Personal", "Created and listed correctly", "PASS"],
    ["TC-P02", "11285-PF", "Personal→Business", "Switch recipient type mid-form, check stale data", "No stale data submitted", "Clean payload after switch, both directions", "PASS"],
    ["BB-018", "11290-PF", "Business", "Leave Company Name blank, submit", "Submission blocked", "Blocked: 'Business name is required'", "PASS"],
    ["BB-002/016", "11285-PF, 11290-PF", "Business", "Complete valid Business + bank details, submit", "Beneficiary created", "400 error, not created (4/4 attempts)", "FAIL — BUG_BUSINESS_001"],
    ["TC-07 (11159)", "11159-PF", "Bank Details", "Select LK/PK/BD/NP, check secondary fields load", "Configured secondary fields shown per country", "field-schema 404 for all 4; generic fallback fields shown", "FAIL — BUG_BANK_001"],
    ["TC-15 (11159)", "11159-PF", "Bank Details", "Country with no secondary config (PK) shows only primary field", "Only Account Number shown", "Bank Name/Branch/Account Number/Bank Code shown (static form, not config-driven)", "Ambiguous — see REQ_CLAR_COUNTRY_001"],
    ["TC-CASH01", "—", "Cash Pickup", "Create valid Cash Pickup recipient (Sri Lanka, NIC)", "Recipient created", "Created and listed correctly", "PASS"],
    ["TC-CASH02", "—", "Cash Pickup", "Submit empty form", "All mandatory fields flagged", "Nickname, First/Last Name, Phone, Address 1, Postal all flagged; ID fields optional (no flag)", "PASS"],
    ["TC-WAL01", "—", "Wallet", "Create valid Wallet recipient (Pakistan, Easypaisa)", "Wallet created, listed under Wallets tab only", "Created, correctly tabbed, Personal-labelled", "PASS"],
    ["TC-WAL02", "—", "Wallet", "Check wallet availability for LK/BD/NP", "Per configuration", "'No wallet providers available' — Pakistan only", "PASS (documented, not a defect)"],
    ["BB-056", "11290-PF (adjacent)", "Personal/Business", "Address Line 1 with symbol-only / script-like string", "Rejected or safely handled", "Accepted, no validation, persisted verbatim", "FAIL — BUG_ADDRESS_001R"],
    ["TC-19 (11294 adjacent)", "11294-PF (applicability TBD)", "Personal — Contact Number", "Enter duplicated country code (94712345678 with +94 selected)", "Pending requirement confirmation", "Accepted, no rejection message", "REQ_CLAR_PHONE_001"],
    ["—", "—", "Personal — Name", "Enter José (accented Latin) as First Name", "Pending requirement confirmation", "Rejected: 'Only letters, spaces, hyphens and apostrophes allowed'", "REQ_CLAR_NAME_001"],
    ["—", "—", "Personal", "Duplicate nickname (reuse existing)", "Rejected", "'Nickname already exists. Please choose a different nickname.'", "PASS"],
    ["—", "—", "Recipient List", "Search by partial first name", "Filters correctly", "Filtered to exact match", "PASS"],
  ],
  [900, 1200, 1300, 2400, 1700, 1900, 900]
);

// Bug entries
const bugBusiness001 = bugBlock({
  id: "BUG_BUSINESS_001",
  title: "Business Beneficiary creation always fails with a generic, unhelpful 400 error",
  module: "Bank Account Holder — Business Recipient",
  page: "Add Business Recipient Details → Business Recipient's Bank Details",
  url: "https://portal.sandbox.ajeer.money/recipients/add/bank",
  reqId: "11285-PF (Personal Customer must be able to add Business Beneficiary), 11290-PF (Business Beneficiary fields and mandatory validation)",
  country: "Pakistan (PKR) and Sri Lanka (LKR) — both affected",
  bugType: "Functional / API Validation / Blocked Workflow",
  priority: "P1",
  severity: "High",
  confidence: "High",
  repro: "Reproducible — 4/4 attempts, 2 countries, varying Business Registration Type/Number combinations, fully fresh data each time",
  precondition: [
    "Customer is a Personal customer, logged in.",
    "Customer is on Add Bank Recipient → Business.",
  ],
  testData: [
    "Attempt 1 (Pakistan): Business Name 'ABC Trading Ltd', Registration Type omitted, Bank Habib Bank Limited, Account 1234567890123, Bank Code 0001.",
    "Attempt 2 (Pakistan): Same data + Registration Type 'LLC' added.",
    "Attempt 3 (Pakistan): Fresh nickname/account/bank code, Registration Type 'LLC', Registration Number 'REG123456'.",
    "Attempt 4 (Sri Lanka): Business Name 'Ceylon Traders Ltd', Bank Sampath Bank, Account 5544332211, Bank Code 7278, Registration Type omitted.",
  ],
  steps: [
    "Login as Personal customer.",
    "Add Bank Recipient → select a currency (tested: PKR, LKR).",
    "Select Business as recipient type.",
    "Complete Business Name, Contact Number, Address Line 1, Postal Code (all mandatory fields accepted without complaint).",
    "Optionally select Business Registration Type / enter Registration Number (tested both with and without).",
    "Save & Continue to Bank Details.",
    "Select a bank, enter Account Number and Bank Code.",
    "Click Save & Continue.",
  ],
  actual: "The POST to /api/v1/beneficiaries/bank returns HTTP 400 with body {\"type\":\"...errors/validation\",\"title\":\"Validation Failed\",\"status\":400,\"detail\":\"One or more fields contain invalid values. Please check your request and try again.\",\"errors\":null}. The UI surfaces this raw detail message as a toast. This occurred on every attempt, regardless of whether Business Registration Type/Number were filled, regardless of country, and regardless of using entirely fresh nickname/account-number/bank-code values (ruling out duplicate-data as the cause).",
  proves: "The network requests (captured in full, request and response bodies) prove: (1) the client successfully submits a well-formed Business beneficiary payload in the same shape as a successful Personal beneficiary payload, differing only by the nested 'business' object; (2) the server rejects it with a 400 and an empty errors object every time; (3) this reproduces identically across two different destination countries and across payloads with and without registrationTypeId. No Business beneficiary was ever created in this session.",
  doesNotProve: "It does not prove the exact backend field or rule causing the rejection — the API's own error contract returns errors: null, so no field-level detail is exposed to the client. It also does not prove whether Bangladesh/Nepal are equally affected (not independently reproduced there, though the identical shared architecture makes this likely).",
  expected: "Per 11285-PF: 'A Personal Customer should be able to add a Business Beneficiary' and BB-002/BB-016 expect the flow to be 'available and can be completed successfully.' Per 11290-PF: once all mandatory fields are completed, 'the customer should be able to successfully add the Business Beneficiary.' A correctly filled Business beneficiary form should result in a created beneficiary, not a 400.",
  traceability: "11285-PF Acceptance Criteria, 'Personal → Business': 'they should be able to select/provide Business Beneficiary details and successfully add the beneficiary.' 11290-PF: 'once all mandatory fields and validations are successfully completed, the customer should be able to successfully add the Business Beneficiary.'",
  validationTable: [
    ["Business Name + bank details, no Registration Type (PK)", "Beneficiary created", "400 error"],
    ["Business Name + bank details + Registration Type 'LLC' (PK)", "Beneficiary created", "400 error"],
    ["Fresh nickname/account/bank code + Registration Type + Number (PK)", "Beneficiary created", "400 error"],
    ["Business Name + bank details, no Registration Type (LK)", "Beneficiary created", "400 error"],
  ],
  impact: "This is a complete, unconditional block on the Bank Account Holder → Business Beneficiary flow — the flow that 11285-PF (BB-002/BB-016) and 11290-PF exist specifically to enable. No amount of correct input resolves it. Any downstream scenario that depends on a successfully created Business beneficiary (use-in-transfer, edit, delete, duplicate handling — BB-022/023/031/037/038/060-064) is also blocked as a consequence.",
  rootCause: "Hypothesis only, not confirmed: the generic 'errors: null' 400 combined with the same failure occurring whether or not registrationTypeId is present in the payload suggests the backend validation is failing on a field the current UI does not expose at all (a genuine missing-field scenario per 11290-PF's own concern about 'Business Type' possibly being absent from the flow), rather than on Business Registration Type/Number as currently implemented. This needs backend log access to confirm and is explicitly flagged as a hypothesis, not fact.",
  recommendation: [
    "Have the backend team inspect server logs for traceId 0HNO2LFID7QB9 / 0HNO2LFID7QCE / 0HNO2LFID7QF0 (captured in this session) to identify the actual failing field.",
    "Populate the API's own errors object on 400 responses so the client (and QA) can see which field failed, rather than a blanket message.",
    "Once fixed, re-run BB-016 through BB-038 (the full Business beneficiary matrix) since none of it could be completed this session.",
  ],
  vmi: {
    current: "'One or more fields contain invalid values. Please check your request and try again.' (identical toast regardless of what was entered)",
    problem: "Gives the customer and QA zero information about which field is wrong, and the underlying API error contract (errors: null) means the client has nothing to render even if it wanted to.",
    recommended: "Populate field-level errors in the API response and surface the specific field/reason in the UI, e.g. 'Business Registration Number is required for Pakistan.' once the real cause is identified.",
  },
  evidence: [
    "Figure 1A — evidence/BUSINESS_filled_no_regtype_before_submit_PK.png: Business form filled, Registration Type left blank.",
    "Figure 1B — evidence/BUG_BUSINESS_001_PK_creation_400_error.png: 400 toast after submission with fresh data and Registration Type filled.",
    "Figure 1C — Captured network request/response pairs (request indices 103, 119, 50 across the session) showing identical 400 + errors:null for all four attempts.",
    "Figure 1D — Sri Lanka reproduction confirms the failure is not Pakistan-specific.",
  ],
});

const bugBank001 = bugBlock({
  id: "BUG_BANK_001",
  title: "Bank field-schema API returns 404 for every configured country — 11159-PF secondary-field architecture is non-functional",
  module: "Bank Details step (Personal and Business)",
  page: "Personal/Business Recipient's Bank Details",
  url: "https://portal.sandbox.ajeer.money/recipients/add/bank",
  reqId: "11159-PF",
  country: "Sri Lanka (LK), Pakistan (PK), Bangladesh (BD), Nepal (NP) — all 4 configured countries confirmed affected",
  bugType: "Functional / API Integration / Configuration",
  priority: "P1",
  severity: "Medium",
  confidence: "High",
  repro: "Reproducible — observed on every navigation to the details/bank step for all 4 countries, every time (8+ occurrences across the session)",
  precondition: ["Customer is logged in.", "Customer proceeds to Add Bank Recipient for any of the 4 configured currencies."],
  testData: ["Country=LK, PK, BD, NP tested individually."],
  steps: [
    "Select any of the 4 available currencies (LKR/PKR/BDT/NPR) in Add Bank Recipient.",
    "Proceed to the recipient details step (field-schema is pre-fetched here) and then the Bank Details step.",
    "Open browser console / network tab.",
  ],
  actual: "GET /api/v1/beneficiaries/bank/field-schema?country={LK|PK|BD|NP} returns HTTP 404 (empty body, content-type application/json) every time, for all 4 countries. The application's own console warning reads: \"[bank-fields] Could not load the field schema for '{COUNTRY}' — falling back to account number only. Country-specific fields, including the state/province field, will not be shown.\" Despite this, the Bank Details form still renders Bank Name, Branch Name, Account Number, and Bank Code — a static, non-country-driven set of fields, not the account-number-only fallback the warning describes.",
  proves: "The 404 and console warning are directly observed and reproducible via network inspection across all 4 countries. This proves the field-schema endpoint — described in 11159-PF as the mechanism by which PD Lookup Table configuration reaches the Customer Portal — is not returning data for any currently configured country in this sandbox.",
  doesNotProve: "It does not prove whether this is a sandbox deployment/environment issue (endpoint not deployed or misconfigured) versus a genuine application defect, nor whether any secondary fields are actually configured in the PD Lookup Table for these countries — that requires admin access this session did not have (see REQ_CLAR_COUNTRY_001 and the Not Tested list).",
  expected: "Per 11159-PF AC-02: 'When a customer or admin adds a bank beneficiary for a configured destination country, the primary account number field and all configured secondary fields are shown.' Per AC-03: 'When a destination country has no secondary fields configured... only the primary account number field is shown.' Neither AC is achievable while the field-schema call itself fails outright — the form cannot be said to be reflecting PD Lookup configuration at all; it is showing a static fallback.",
  traceability: "11159-PF: 'In the PD, an admin selects via checkboxes which secondary fields apply to a country. These selections are then reflected automatically in the Admin Portal beneficiary tab and the Customer Portal account details tab.' The field-schema endpoint is the mechanism described for this; it does not function for any tested country.",
  validationTable: [
    ["country=LK", "200 with field schema", "404"],
    ["country=PK", "200 with field schema", "404"],
    ["country=BD", "200 with field schema", "404"],
    ["country=NP", "200 with field schema", "404"],
  ],
  impact: "Every country-specific secondary-field requirement in 11159-PF (IFSC, BSB, IBAN, SWIFT+Routing, Sort Code, etc.) is untestable and, if genuinely configured in the PD Lookup Table, is not reaching customers in this sandbox at all. The Bank Code field that does render appears to be a static, hardcoded field rather than one driven by configuration, which risks being wrong for countries where no such field should appear (AC-03) or incomplete for countries needing multiple secondary fields (AC-02, e.g. Australia's Bank Code + BSB).",
  recommendation: [
    "Confirm with the platform/DevOps team whether the field-schema endpoint is deployed and reachable in the sandbox environment at all.",
    "Once reachable, re-verify AC-02/AC-03 per country against actual PD Lookup Table configuration.",
    "Until fixed, do not rely on the current Bank Name/Branch/Account Number/Bank Code fields as evidence of correct per-country configuration — they appear to be a fallback, not the configured architecture.",
  ],
  evidence: [
    "Figure 2A — evidence/BASELINE_bank_details_SriLanka.png: Bank Details step for Sri Lanka showing the static field set despite the 404.",
    "Figure 2B — Console warning text and network request/response pairs captured for all 4 countries (LK, PK, BD, NP), each showing status 404 with an empty response body.",
  ],
});

const bugAddress001 = bugBlock({
  id: "BUG_ADDRESS_001R",
  title: "Address Line 1 and Postal/ZIP Code accept script-like and symbol-only input with no validation, client or server",
  module: "Personal and Business Recipient Details",
  page: "Add Personal Recipient Details",
  url: "https://portal.sandbox.ajeer.money/recipients/add/details",
  reqId: "Not specified in supplied requirement — data quality / input validation",
  country: "Sri Lanka (LKR) — reproduced end-to-end including successful creation and persistence",
  bugType: "Functional / Input Validation / Data Quality",
  priority: "P2",
  severity: "Medium",
  confidence: "High",
  repro: "Reproducible — reproduced once through full creation and persisted-record verification; same class of finding as an existing, independently confirmed onboarding-flow defect (BUG_ADDRESS_001), reinforcing confidence",
  precondition: ["Customer is logged in.", "Customer is on Add Personal Recipient Details, Sri Lanka selected."],
  testData: [
    "Address Line 1: <script>alert(1)</script>",
    "Postal/ZIP Code: #######",
    "All other fields valid (Nickname 'QA Personal XSS 001', First Name Jose, Last Name O'Connor, Contact 712345678, Bank of Ceylon, Account 0099887766, Bank Code 7010).",
  ],
  steps: [
    "Enter <script>alert(1)</script> into Address Line 1.",
    "Enter ####### into Postal/ZIP Code.",
    "Complete all other mandatory fields with valid data.",
    "Click Save & Continue — observe no validation message on either field.",
    "Complete the Bank Details step and submit.",
    "Open the created recipient's detail view and inspect the Address Line 1 / Postal Code values.",
  ],
  actual: "Neither field shows any validation error, client-side or after the API round-trip. The POST /api/v1/beneficiaries/bank request body contains \"address\":{\"line1\":\"<script>alert(1)</script>\",...,\"postalCode\":\"#######\"} verbatim, the API returns 200, and the recipient detail page (/recipients/view/{id}) displays both values back as plain text exactly as entered.",
  proves: "The full round trip — client acceptance, API acceptance (200, no rejection), and persisted display in the detail view — is directly observed and proves this data reaches and is stored by the backend with no format validation applied at any layer.",
  doesNotProve: "It does not prove an XSS vulnerability: the detail view renders the script string as inert text (no alert dialog fired, confirmed via console message inspection), consistent with safe escaping. It also does not prove how this value would render elsewhere in the product (emails, generated documents, admin views) — that was not tested this session.",
  expected: "Address Line 1 should accept legitimate address characters (letters, numbers, spaces, commas, hyphens, apostrophes, slashes) and reject symbol-only or script-like values. Postal/ZIP Code should be validated against a real format and reject a value made only of symbols. Neither is specified with an exact rule in the supplied PROD_V04 excerpt, so the expected behaviour here is a general data-quality expectation, not a cited requirement violation.",
  traceability: "Not specified in supplied requirement — reported per the brief's CLASS B criteria (clear software/data-quality failure) rather than a named requirement clause.",
  validationTable: [
    ["<script>alert(1)</script> (Address Line 1)", "Reject, or store safely encoded", "Accepted, stored and displayed verbatim as text"],
    ["####### (Postal/ZIP Code)", "Reject", "Accepted, stored and displayed verbatim"],
  ],
  impact: "The Recipient Address is a KYC-adjacent field used to identify who money is being sent to. Unusable, malformed address/postal data can pass all the way into a created beneficiary record with no warning to the customer, which risks downstream payment failures or compliance friction that surface only after the customer believes the recipient was set up correctly.",
  recommendation: [
    "Validate Address Line 1 against a real address character set (client and API).",
    "Validate Postal/ZIP Code against the format expected for the recipient's destination country.",
    "Reject symbol-only and script-like values with a clear, field-specific message rather than silent acceptance.",
  ],
  vmi: {
    current: "No message is shown on either field; both values are silently accepted.",
    problem: "The customer gets no feedback that the address they entered is unusable.",
    recommended: "\"Please enter a valid address.\" / \"Please enter a valid postal code for the selected country.\"",
  },
  evidence: [
    "Figure 3A — evidence/PERSONAL_negative_data_before_submit.png: form filled with the script/symbol strings.",
    "Figure 3B — evidence/BUG_PERSONAL_001_xss_postal_no_validation.png: no validation shown, Save & Continue enabled and proceeds.",
    "Figure 3C — evidence/BUG_PERSONAL_001_detail_view_xss_postal_stored.png: the created recipient's detail view showing both values persisted and displayed as plain text (confirming no execution).",
  ],
});

const clarCountry = clarBlock({
  id: "REQ_CLAR_COUNTRY_001",
  title: "Sandbox only configures 4 corridors; 11159-PF's Country Coverage Matrix names 12+ others",
  module: "Bank Account Holder — Bank Details (all countries)",
  field: "Destination country selector (currency picker) across the whole Recipient module",
  current: "The Recipient module's currency/country picker (Bank Account Holder and Cash Pickup) offers exactly 4 destinations: Sri Lanka (LKR), Pakistan (PKR), Bangladesh (BDT), Nepal (NPR). Wallet offers Pakistan only. Searching for any other country (tested: India) returns 'No currencies found.'",
  requirement: "11159-PF's Country Coverage Matrix explicitly lists India (IFSC), Australia (Bank Code+BSB), UK (IBAN+Sort Code), Japan (Bank Code+Branch Code), Hong Kong, Jamaica, Canada, Bangladesh, Egypt, USA, Russia, SEPA, South Korea, and Pakistan as countries with defined (or explicitly 'no secondary field configured') requirements.",
  external: "External validation rule not independently verified for any of these — out of scope given none are reachable in this sandbox to test against.",
  conflict: "The requirement document describes a much broader country rollout than what is actually present in this sandbox build. It is unclear whether this is expected (sandbox intentionally scoped down) or a deployment/configuration gap against the intended PD Lookup Table state.",
  whyNotBug: "QA has no way to distinguish 'not yet configured in this environment' from 'a defect' without PD Lookup/admin visibility, which was not available this session.",
  question: "Is the 4-country scope (LK/PK/BD/NP) intentional for this sandbox build, or should the full 11159-PF country list be configured here? If intentional, 11159-PF's country-specific test cases for India/Australia/UK/etc. should be explicitly marked out-of-scope for this environment rather than tested against.",
  risk: "If unintentional, most of 11159-PF's stated purpose (country-varying secondary bank fields) is currently unverifiable in this sandbox, which limits QA's ability to sign off on the requirement at all.",
  recommendedDecision: "PD/Config team confirms intended sandbox scope; QA re-baselines the country matrix once confirmed.",
  evidence: "Live currency-picker search for 'India' returning 'No currencies found', captured during Pass 1 inventory (evidence/BASELINE_add_bank_currency_select.png shows the full available list).",
});

const clarBusiness = clarBlock({
  id: "REQ_CLAR_BUSINESS_001",
  title: "Is 'Business Registration Type' the field 11290-PF calls 'Business Type', and is it actually mandatory?",
  module: "Bank Account Holder — Business Recipient Details",
  field: "Business Registration Type dropdown",
  current: "The Business recipient form shows a 'Business Registration Type' dropdown (options: Sole Proprietorship, Partnership, LLC, Corporation) with no mandatory (*) indicator. Submitting the form with it left blank is not blocked client-side and proceeds to the Bank Details step. Server-side enforcement could not be confirmed because Business beneficiary creation fails with a 400 regardless of whether this field is filled (see BUG_BUSINESS_001).",
  requirement: "11290-PF: 'Business Type – Mandatory' as one of the required Business Beneficiary fields, distinct from Business Registration Number.",
  external: "External validation rule not independently verified.",
  conflict: "The dropdown's options (Sole Proprietorship/Partnership/LLC/Corporation) are consistent with what '11290-PF' calls Business Type, but the field is literally labelled 'Business Registration Type' in the UI, and it is not enforced as mandatory the way 11290-PF specifies. It is also unclear whether this is the same field as 'Business Registration Number', which 11290-PF treats as separately mandatory 'where applicable'.",
  whyNotBug: "Two things are entangled and neither can be confirmed independently right now: (1) whether the UI's 'Business Registration Type' is meant to satisfy 11290-PF's 'Business Type' requirement, and (2) whether server-side mandatory enforcement exists at all — both are blocked by BUG_BUSINESS_001 making it impossible to complete a Business beneficiary with or without this field to compare outcomes.",
  question: "Confirm whether 'Business Registration Type' is intended to be 11290-PF's 'Business Type' field, and whether it (and Business Registration Number) should carry a mandatory indicator and block submission when empty — for which countries, per 'where applicable'.",
  risk: "If left unresolved, 11290-PF's core mandatory-field requirement may be entirely unenforced once BUG_BUSINESS_001 is fixed.",
  recommendedDecision: "BA confirms field mapping and mandatory rule; QA re-tests BB-018 through BB-036 once BUG_BUSINESS_001 is resolved.",
  evidence: "evidence/BASELINE_add_business_recipient_details.png (no asterisk on the field) and evidence/BUSINESS_empty_submit_validation_PK.png (empty-submit validation does not flag Business Registration Type).",
});

const clarName = clarBlock({
  id: "REQ_CLAR_NAME_001",
  title: "First/Last Name fields reject accented Latin letters — same open question as an existing onboarding finding",
  module: "Personal and Business Recipient Details",
  field: "First Name / Last Name",
  current: "Entering 'José' in First Name is rejected with: 'Only letters, spaces, hyphens and apostrophes allowed.' The message is also inaccurate — é is a letter, so the message contradicts the rule it enforces.",
  requirement: "Not specified in supplied requirement for the Recipient module specifically.",
  external: "Not researched this session — out of scope for a UI-validation clarification.",
  conflict: "This mirrors a previously reported and still-unresolved finding in the onboarding flow (SUG_NAME_001 in the referenced signup-flow report), raising the same open KYC/MRZ-matching question, now also observed in the Recipient module.",
  whyNotBug: "Whether accented Latin characters should be accepted is a business/KYC decision, not a QA call — consistent with how the equivalent onboarding finding was classified.",
  question: "Should Recipient First/Last Name accept accented Latin letters (é, ñ, ç, etc.)? If not, the validation message should say so accurately rather than claiming 'letters' are allowed.",
  risk: "Legitimate recipient names may be un-enterable, and the current message misleads the customer about why.",
  recommendedDecision: "Apply whatever decision is reached for the onboarding Name field (see the referenced onboarding report) consistently to the Recipient Name fields.",
  evidence: "Recipient details form, First Name = 'José', validation message captured live during Pass 2 negative testing.",
});

const clarPhone = clarBlock({
  id: "REQ_CLAR_PHONE_001",
  title: "Recipient Contact Number accepts a duplicated country-code prefix with no rejection",
  module: "Personal Recipient Details — Contact Number",
  field: "Contact number (Sri Lanka, +94 selected)",
  current: "With +94 selected, typing +94712345678 into the Contact Number field auto-strips the '+' (the field only accepts digits) leaving 94712345678 — a value that duplicates the country code — with no validation message and no block on proceeding.",
  requirement: "11294-PF, but that requirement's own text scopes it explicitly to 'the Customer Onboarding process.'",
  external: "External validation rule not independently verified.",
  conflict: "11294-PF's country-code-duplication rule ('the system should reject the input... Please enter your phone number without the country code') is not observed being enforced on the Recipient Contact Number field. Per the mission brief's explicit caution, this is not automatically the same requirement's scope.",
  whyNotBug: "11294-PF's own requirement text is onboarding-scoped; nothing in the supplied 11285-PF/11290-PF/11159-PF excerpts states the Recipient Contact Number must follow the same rule.",
  question: "Should the Recipient Contact Number field reuse the same country-code-duplication validation as onboarding? If yes, this becomes a confirmed defect against that extended scope.",
  risk: "Low-to-medium — a malformed recipient phone number could affect delivery-related recipient communications, though this is less critical than the onboarding OTP-delivery case.",
  recommendedDecision: "BA confirms whether 11294-PF (or an equivalent Recipient-specific rule) should govern this field.",
  evidence: "evidence/REQCLAR_recipient_phone_duplicate_countrycode.png — Contact Number field showing '94712345678' with no validation message, Save & Continue enabled.",
});

const sugBusiness = sugBlock({
  id: "SUG_BUSINESS_001",
  title: "Business beneficiary creation errors give no field-level detail",
  module: "Business Recipient — API",
  field: "POST /api/v1/beneficiaries/bank error response",
  type: "Improvement / API Error Contract",
  priority: "P2",
  severity: "Low",
  current: "On validation failure the API returns {\"title\":\"Validation Failed\",\"status\":400,\"errors\":null}. The errors field, presumably intended to carry field-level detail, is always null in every observed failure.",
  suggested: "Populate errors with the specific field(s) and reason(s) that failed, so the client can show an actionable message instead of a generic toast.",
  why: "This is a diagnosability/UX improvement to the error contract, not itself the root cause of BUG_BUSINESS_001 — it compounds that bug's impact but is a separate, generally applicable improvement.",
  benefit: "Faster root-cause diagnosis for BUG_BUSINESS_001 and clearer customer-facing errors for any future validation failure.",
  evidence: "Response bodies captured for all 4 BUG_BUSINESS_001 reproduction attempts, each showing errors: null.",
});

const sugAddress = sugBlock({
  id: "SUG_ADDRESS_001",
  title: "Strengthen Address/Postal validation before submission",
  module: "Recipient Address",
  field: "Address Line 1, Postal/ZIP Code",
  type: "Improvement / Validation",
  priority: "P2",
  severity: "Low",
  current: "Address Line 1 and Postal/ZIP Code accept any string, including symbol-only and script-like input, with no client or server validation.",
  suggested: "Validate both fields against a real address/postal character set, with country-specific postal format where applicable, on both the client and the API.",
  why: "Current implementation does not violate a specifically cited requirement (none was supplied for these fields), so this is filed as an improvement rather than BUG_ADDRESS_001R being reclassified — the two entries are related but BUG_ADDRESS_001R stands on the 'indisputable functional failure' criterion (a KYC-adjacent field accepting unusable data end-to-end) independent of this suggestion.",
  benefit: "Prevents unusable address data from entering created recipient records.",
  evidence: "Same as BUG_ADDRESS_001R — evidence/BUG_PERSONAL_001_detail_view_xss_postal_stored.png",
});

const notTestedList = [
  "Business Customer → Personal/Business Beneficiary (11285-PF's other two combinations) — no Business customer account provided; Personal-account login only.",
  "Admin/PD Lookup Table verification (11159-PF AC-01) and Admin-vs-Customer-Portal field parity — no admin credentials.",
  "Full end-to-end Business Beneficiary flow (creation success, edit, delete, use-in-transfer, duplicate handling) — blocked by BUG_BUSINESS_001; tester will complete this manually per their own instruction.",
  "Country-specific secondary bank fields (IFSC, BSB, IBAN, SWIFT+Routing, Sort Code, etc.) — none of the countries 11159-PF names for these exist in this sandbox.",
  "Wallet for Sri Lanka/Bangladesh/Nepal — not configured (Pakistan only).",
  "JazzCash wallet creation — inventoried but not creation-tested (Easypaisa was).",
  "API-level request tampering (e.g. tampering beneficiary type directly in the request).",
  "Compliance/regulatory validation checks — no visibility from customer-portal access.",
  "Full UI/UX pass at 125/150/200% zoom and mobile viewport across all 4 add-recipient forms.",
  "End-to-end completed money transfer using a created recipient (confirm-dialog opened successfully; transfer not completed).",
  "Duplicate account number / duplicate registration number specific negative cases — blocked by BUG_BUSINESS_001.",
  "Systematic browser refresh / back-navigation persistence testing mid-flow.",
];

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Recipients Module QA Bug Report")] }),
      p("Ajeer Money — Sandbox Portal", { bold: true, size: 26 }),
      coverMeta,

      h("1. Executive Summary", HeadingLevel.HEADING_1),
      execSummaryTable,

      h("2. Confirmed Bug Summary", HeadingLevel.HEADING_1),
      confirmedBugSummary,

      h("3. Requirement Clarification Summary", HeadingLevel.HEADING_1),
      reqClarSummary,

      h("4. Improvement / Suggestion Summary", HeadingLevel.HEADING_1),
      sugSummary,

      h("5. Country Validation Matrix", HeadingLevel.HEADING_1),
      countryMatrix,

      h("6. Test Execution Matrix (Representative Selection)", HeadingLevel.HEADING_1),
      p("This is a representative selection of the ~52 executed test cases; the full inventory maps to PROD_V04's own BB-/TC- numbering scheme referenced throughout Section 7.", { italics: true }),
      testExecMatrix,

      h("7. Confirmed Bug Details", HeadingLevel.HEADING_1),
      ...bugBusiness001,
      ...bugBank001,
      ...bugAddress001,

      h("8. Requirement Clarifications — Full Detail", HeadingLevel.HEADING_1),
      ...clarCountry,
      ...clarBusiness,
      ...clarName,
      ...clarPhone,

      h("9. Improvement Suggestions — Full Detail", HeadingLevel.HEADING_1),
      ...sugBusiness,
      ...sugAddress,

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("10. Not Tested / Blocked Items")] }),
      p("The following could not be tested this session and are listed individually so they can be picked up manually, per instruction:"),
      ...notTestedList.map(t => p("• " + t)),

      new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun("11. Final QA Assessment")] }),
      p("The Recipient module's Personal, Cash Pickup, and Wallet creation paths are functionally solid — mandatory-field validation, duplicate-nickname detection, and recipient-type-switch data hygiene all work correctly and cleanly, with no stale data leaking into API payloads. The Business Beneficiary path, however, is completely non-functional at final submission regardless of what data is entered (BUG_BUSINESS_001), which is a direct, reproducible blocker against 11285-PF's core requirement and prevents almost all downstream Business-beneficiary testing. Separately, the 11159-PF secondary-field architecture — the PD Lookup-driven per-country bank fields — appears entirely disconnected from the backend in this sandbox, with every configured country 404ing on the field-schema endpoint (BUG_BANK_001). Given this sandbox only has four corridors configured at all (Sri Lanka, Pakistan, Bangladesh, Nepal), most of 11159-PF's country-specific format requirements (IFSC, BSB, IBAN, etc.) remain untestable here regardless of that defect. A data-quality gap in Address/Postal validation (BUG_ADDRESS_001R) was also confirmed end-to-end, though it was not demonstrated to be a security vulnerability."),
      p("Prepared by: M. Kowshikan (QA Trainee) — 10Qbit  |  Submitted to: Nixsala  |  Report date: 15.09.2026", { italics: true }),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  require('fs').writeFileSync('Bug_Report_AjeerMoney_RecipientsModule_Kowshikan_v1_0.docx', buf);
  console.log('done');
});
