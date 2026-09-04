import type { Page } from "playwright";
import { computeStateSignature, normalizePathname } from "../mapping/state-signature.js";
import { redactSecrets } from "../redact.js";
import type {
  ConsoleRecord,
  DialogRecord,
  FormSummary,
  InteractiveElement,
  LinkSummary,
  NetworkRecord,
  Observation,
  PageErrorRecord,
  WidgetType,
} from "../types.js";

export const MAX_VISIBLE_TEXT = 8000;

/** Console/network/error/dialog listeners attached once per page, mutated in place. */
export type PageRecords = {
  consoleMessages: ConsoleRecord[];
  pageErrors: PageErrorRecord[];
  networkRequests: NetworkRecord[];
  dialogs: DialogRecord[];
};

export function createPageRecords(): PageRecords {
  return { consoleMessages: [], pageErrors: [], networkRequests: [], dialogs: [] };
}

export function attachPageRecorders(page: Page, records: PageRecords): void {
  page.on("console", (message) => {
    records.consoleMessages.push({
      type: message.type(),
      text: redactSecrets(message.text()),
      timestamp: new Date().toISOString(),
    });
  });

  page.on("pageerror", (error) => {
    records.pageErrors.push({
      message: redactSecrets(error.message),
      timestamp: new Date().toISOString(),
    });
  });

  page.on("requestfinished", (request) => {
    void request.response().then((response) => {
      records.networkRequests.push({
        method: request.method(),
        url: request.url(),
        status: response?.status(),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      });
    });
  });

  page.on("requestfailed", (request) => {
    records.networkRequests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Registered proactively (before any action executes) so Playwright never
   * blocks page interaction waiting on an unhandled dialog — this alone is
   * what prevents an unexpected alert/confirm/beforeunload from hanging the
   * run. No heuristic in Phase 1 targets a dialog deliberately, so every
   * dialog type is dismissed unconditionally; a dismissed dialog is recorded
   * but is never itself treated as a finding.
   */
  page.on("dialog", (dialog) => {
    records.dialogs.push({
      dialogType: dialog.type(),
      message: redactSecrets(dialog.message()),
      action: "dismissed",
      timestamp: new Date().toISOString(),
    });
    void dialog.dismiss().catch(() => {});
  });
}

type RawElement = {
  role: string;
  name?: string;
  label?: string;
  type?: string;
  widgetType: InteractiveElement["widgetType"];
  required?: boolean;
  visible: boolean;
  enabled?: boolean;
  formIndex?: number;
  isSubmit?: boolean;
};

type PageEvaluationResult = {
  elements: RawElement[];
  forms: Array<{ formIndex: number; action?: string; method?: string; fieldIndexes: number[]; submitIndex?: number }>;
  links: LinkSummary[];
};

/**
 * Reads interactive elements, forms, and links directly from the DOM in one
 * combined page.evaluate() round trip. This runs our own fixed observation
 * script (never model-supplied code) purely to describe the page; it never
 * executes anything the AI Explorer provides.
 */
async function collectPageStructure(page: Page): Promise<PageEvaluationResult> {
  return page.evaluate(() => {
    const selector =
      "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='checkbox']";
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));

    function isVisible(el: HTMLElement): boolean {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }

    function accessibleName(el: HTMLElement): string | undefined {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.trim();

      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl?.textContent) return labelEl.textContent.trim();
      }

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label?.textContent) return label.textContent.trim();
        }
        if (el.placeholder) return el.placeholder.trim();
      }

      const text = el.textContent?.trim();
      if (text) return text.slice(0, 120);

      return undefined;
    }

    function roleOf(el: HTMLElement): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;

      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        return "textbox";
      }
      return tag;
    }

    function widgetTypeOf(el: HTMLElement): WidgetType {
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "textarea") return "textarea";
      if (tag === "select") return "select";
      if (tag === "button") {
        const type = (el as HTMLButtonElement).type;
        return type === "submit" ? "submit_button" : "button";
      }
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit") return "submit_button";
        if (type === "button") return "button";
        if (type === "email") return "email_field";
        if (type === "password") return "password_field";
        if (type === "number") return "number_field";
        if (type === "search") return "search_field";
        if (type === "text" || type === "" || type === "tel" || type === "url") return "text_field";
        return "unknown";
      }
      const role = el.getAttribute("role");
      if (role === "button") return "button";
      if (role === "link") return "link";
      if (role === "textbox") return "text_field";
      if (role === "checkbox") return "checkbox";
      return "unknown";
    }

    function isFormElement(el: HTMLElement): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement {
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLButtonElement
      );
    }

    const rawElements = nodes.slice(0, 200).map((el) => {
      const name = accessibleName(el);
      const formElement = isFormElement(el);
      const widgetType = widgetTypeOf(el);
      return {
        el,
        role: roleOf(el),
        name,
        label: name,
        type: formElement ? (el as HTMLInputElement).type || undefined : undefined,
        widgetType,
        required: formElement ? Boolean((el as HTMLInputElement).required) : undefined,
        visible: isVisible(el),
        enabled: formElement ? !(el as HTMLInputElement).disabled : undefined,
        isSubmit: widgetType === "submit_button",
      };
    });

    const elements = rawElements.map(({ el: _el, isSubmit: _isSubmit, ...rest }) => rest);

    const forms = Array.from(document.forms).map((form, formIndex) => {
      const fieldIndexes: number[] = [];
      let submitIndex: number | undefined;
      rawElements.forEach((raw, index) => {
        if (form.contains(raw.el)) {
          fieldIndexes.push(index);
          if (raw.isSubmit && submitIndex === undefined) submitIndex = index;
        }
      });
      return {
        formIndex,
        action: form.getAttribute("action") || undefined,
        method: form.getAttribute("method") || undefined,
        fieldIndexes,
        submitIndex,
      };
    });

    const links: LinkSummary[] = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(a.href, document.baseURI).origin === location.origin;
      } catch {
        sameOrigin = false;
      }
      return { href: a.href, text: a.textContent?.trim().slice(0, 120) || undefined, sameOrigin };
    });

    return { elements, forms, links };
  });
}

function buildForms(structure: PageEvaluationResult): FormSummary[] {
  return structure.forms.map((form) => ({
    formIndex: form.formIndex,
    ...(form.action ? { action: form.action } : {}),
    ...(form.method ? { method: form.method } : {}),
    fields: form.fieldIndexes.map((i) => structure.elements[i]).filter((e): e is RawElement => Boolean(e)),
    ...(form.submitIndex !== undefined && structure.elements[form.submitIndex]
      ? { submitControl: structure.elements[form.submitIndex] }
      : {}),
  }));
}

export async function observe(
  page: Page,
  records: PageRecords,
  options: { screenshotPath?: string } = {}
): Promise<Observation> {
  const url = page.url();
  const title = await page.title();
  const pathname = normalizePathname(url);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };

  const rawText = await page.evaluate(() => document.body?.innerText ?? "");
  const visibleText = redactSecrets(rawText).slice(0, MAX_VISIBLE_TEXT);

  const structure = await collectPageStructure(page);
  const interactiveElements: InteractiveElement[] = structure.elements;
  const forms = buildForms(structure);
  const links = structure.links;

  if (options.screenshotPath) {
    await page.screenshot({ path: options.screenshotPath, fullPage: false });
  }

  const stateSignature = computeStateSignature(pathname, interactiveElements, visibleText);

  return {
    timestamp: new Date().toISOString(),
    page: { url, title, pathname },
    viewport,
    visibleText,
    interactiveElements,
    forms,
    links,
    consoleMessages: [...records.consoleMessages],
    pageErrors: [...records.pageErrors],
    networkRequests: [...records.networkRequests],
    dialogs: [...records.dialogs],
    stateSignature,
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
  };
}
