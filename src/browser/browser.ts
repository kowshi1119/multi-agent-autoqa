import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { attachPageRecorders, createPageRecords, type PageRecords } from "./observation.js";

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

export type PageSession = {
  context: BrowserContext;
  page: Page;
  records: PageRecords;
};

export class BrowserManager {
  private browser: Browser | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly headless: boolean
  ) {}

  async launch(): Promise<void> {
    try {
      this.browser = await chromium.launch({ headless: this.headless });
      this.logger.info(
        { headless: this.headless },
        "Chromium launched"
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new BrowserLaunchError(
        `AutoQA could not start Chromium.\n\nTry:\nnpx playwright install chromium\n\nUnderlying error: ${cause}`
      );
    }
  }

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new BrowserLaunchError(
        "Browser has not been launched. Call launch() first."
      );
    }
    return this.browser;
  }

  async newPageSession(): Promise<PageSession> {
    const browser = this.requireBrowser();
    const context = await browser.newContext({
      viewport: {
        width: this.config.browser.viewport.width,
        height: this.config.browser.viewport.height,
      },
    });

    const page = await context.newPage();
    const records = createPageRecords();
    attachPageRecorders(page, records);

    return { context, page, records };
  }

  async startTracing(context: BrowserContext): Promise<void> {
    if (!this.config.evidence.trace) return;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  async stopTracing(context: BrowserContext, outputPath: string): Promise<void> {
    if (!this.config.evidence.trace) return;
    try {
      await context.tracing.stop({ path: outputPath });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: cause }, "Failed to write Playwright trace");
    }
  }

  async closeSession(session: PageSession): Promise<void> {
    await session.context.close();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
