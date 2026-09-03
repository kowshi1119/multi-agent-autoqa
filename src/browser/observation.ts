import type { Page } from "playwright";
import { redactSecrets } from "../redact.js";
import type {
  ConsoleRecord,
  InteractiveElement,
  NetworkRecord,
  Observation,
  PageErrorRecord,
} from "../types.js";

export const MAX_VISIBLE_TEXT = 8000;

/** Console/network/error listeners attached once per page, mutated in place. */
export type PageRecords = {
  consoleMessages: ConsoleRecord[];
  pageErrors: PageErrorRecord[];
  networkRequests: NetworkRecord[];
};

export function createPageRecords(): PageRecords {
  return { consoleMessages: [], pageErrors: [], networkRequests: [] };
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
}

/**
 * Reads interactive elements directly from the DOM. This runs our own
 * fixed observation script (never model-supplied code) purely to describe
 * the page; it never executes anything the AI Explorer provides.
 */
async function collectInteractiveElements(
  page: Page
): Promise<InteractiveElement[]> {
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

    return nodes.slice(0, 200).map((el) => {
      const isFormElement =
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLButtonElement;

      return {
        role: roleOf(el),
        name: accessibleName(el),
        label: accessibleName(el),
        type: isFormElement ? (el as HTMLInputElement).type ?? undefined : undefined,
        visible: isVisible(el),
        enabled: isFormElement ? !(el as HTMLInputElement).disabled : undefined,
      };
    });
  });
}

export async function observe(
  page: Page,
  records: PageRecords,
  options: { screenshotPath?: string } = {}
): Promise<Observation> {
  const url = page.url();
  const title = await page.title();
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };

  const rawText = await page.evaluate(
    () => document.body?.innerText ?? ""
  );
  const visibleText = redactSecrets(rawText).slice(0, MAX_VISIBLE_TEXT);

  const interactiveElements = await collectInteractiveElements(page);

  if (options.screenshotPath) {
    await page.screenshot({ path: options.screenshotPath, fullPage: false });
  }

  return {
    timestamp: new Date().toISOString(),
    url,
    title,
    viewport,
    visibleText,
    interactiveElements,
    consoleMessages: [...records.consoleMessages],
    pageErrors: [...records.pageErrors],
    networkRequests: [...records.networkRequests],
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
  };
}
