import { describe, expect, it } from "vitest";
import { PageMapper } from "../../src/mapping/mapper.js";
import type { Observation } from "../../src/types.js";

function observation(partial: {
  url: string;
  pathname: string;
  title?: string;
  interactiveElements?: Observation["interactiveElements"];
  links?: Observation["links"];
}): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: partial.url, title: partial.title ?? "Untitled", pathname: partial.pathname },
    viewport: { width: 1440, height: 900 },
    visibleText: "",
    interactiveElements: partial.interactiveElements ?? [],
    forms: [],
    links: partial.links ?? [],
    consoleMessages: [],
    pageErrors: [],
    networkRequests: [],
    dialogs: [],
    stateSignature: "irrelevant-for-mapper",
  };
}

describe("PageMapper", () => {
  it("creates one PageNode for repeated observations of the same pathname", () => {
    const mapper = new PageMapper();
    const now = new Date().toISOString();

    const first = mapper.upsertPage(observation({ url: "http://localhost:4173/form", pathname: "/form" }), now);
    const second = mapper.upsertPage(observation({ url: "http://localhost:4173/form", pathname: "/form" }), now);

    expect(first.id).toBe(second.id);
    expect(mapper.toJSON().pages).toHaveLength(1);
  });

  it("creates a new PageNode for a new pathname", () => {
    const mapper = new PageMapper();
    const now = new Date().toISOString();

    mapper.upsertPage(observation({ url: "http://localhost:4173/", pathname: "/" }), now);
    mapper.upsertPage(observation({ url: "http://localhost:4173/form", pathname: "/form" }), now);

    expect(mapper.toJSON().pages).toHaveLength(2);
  });

  it("merges newly seen controls into an existing page rather than duplicating it", () => {
    const mapper = new PageMapper();
    const now = new Date().toISOString();

    mapper.upsertPage(
      observation({
        url: "http://localhost:4173/form",
        pathname: "/form",
        interactiveElements: [{ role: "textbox", name: "Username", widgetType: "text_field", visible: true }],
      }),
      now
    );
    const updated = mapper.upsertPage(
      observation({
        url: "http://localhost:4173/form",
        pathname: "/form",
        interactiveElements: [{ role: "button", name: "Submit", widgetType: "submit_button", visible: true }],
      }),
      now
    );

    expect(mapper.toJSON().pages).toHaveLength(1);
    expect(updated.controls.map((c) => c.name).sort()).toEqual(["Submit", "Username"]);
  });

  it("deduplicates identical edges", () => {
    const mapper = new PageMapper();
    mapper.recordEdge("PAGE-001", "PAGE-002", { type: "click", label: "Form" });
    mapper.recordEdge("PAGE-001", "PAGE-002", { type: "click", label: "Form" });

    expect(mapper.toJSON().edges).toHaveLength(1);
  });

  it("keeps distinct edges with different actions between the same pages", () => {
    const mapper = new PageMapper();
    mapper.recordEdge("PAGE-001", "PAGE-002", { type: "click", label: "Form" });
    mapper.recordEdge("PAGE-001", "PAGE-002", { type: "navigate", label: "Form (direct)" });

    expect(mapper.toJSON().edges).toHaveLength(2);
  });
});
