import type { InteractiveElement, LinkSummary } from "../types.js";

export type PageNode = {
  id: string;
  url: string;
  pathname: string;
  title: string;
  firstSeenAt: string;
  controls: InteractiveElement[];
  links: LinkSummary[];
  testedHeuristics: string[];
};

export type PageEdge = {
  fromPageId: string;
  toPageId: string;
  action: { type: string; label?: string };
};

export type ApplicationMap = {
  pages: PageNode[];
  edges: PageEdge[];
};
