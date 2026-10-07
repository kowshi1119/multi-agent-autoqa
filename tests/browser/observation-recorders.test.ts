import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { attachPageRecorders, createPageRecords } from "../../src/browser/observation.js";

/**
 * Regression (found by verification VER-20261007-081729342Z-7335): a request
 * that finished while Stop was closing the browser context made
 * request.response() reject with "Target page, context or browser has been
 * closed", and the recorder left that rejection unhandled.
 */
describe("page recorders", () => {
  it("records a finished request whose response can no longer be read, without an unhandled rejection", async () => {
    const page = new EventEmitter();
    const records = createPageRecords();
    attachPageRecorders(page as unknown as Page, records);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      page.emit("requestfinished", {
        method: () => "GET",
        url: () => "http://localhost:1/api/x",
        resourceType: () => "fetch",
        response: () => Promise.reject(new Error("request.response: Target page, context or browser has been closed")),
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(records.networkRequests).toEqual([expect.objectContaining({ method: "GET", url: "http://localhost:1/api/x", resourceType: "fetch", status: undefined })]);
  });
});
