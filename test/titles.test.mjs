import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { componentDocumentTitle, loadComponentPages } from "../src/lib/components.js";
import { clip } from "../src/lib/format.js";

const root = join(import.meta.dirname, "..");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (entry.endsWith(".astro")) files.push(path.slice(join(root, "src/pages").length + 1).replaceAll("\\", "/"));
  }
  return files;
}

const PAGE_TEMPLATES = [
  "404.astro",
  "about.astro",
  "compare.astro",
  "compare/hybrid/index.astro",
  "compare/hybrid/[pair].astro",
  "compare/[pair].astro",
  "complaints/index.astro",
  "contact.astro",
  "disclosure.astro",
  "ev-range.astro",
  "fuel-cost/index.astro",
  "fuel-cost/[slug].astro",
  "guides/do-recalls-expire.astro",
  "guides/how-long-do-recalls-last.astro",
  "guides/index.astro",
  "guides/open-recall-meaning.astro",
  "guides/what-is-a-tsb.astro",
  "index.astro",
  "investigations/[action].astro",
  "investigations/index.astro",
  "[make]/complaints/index.astro",
  "[make]/index.astro",
  "[make]/[model]/index.astro",
  "[make]/[model]/range.astro",
  "[make]/[model]/[year]/[component].astro",
  "[make]/[model]/[year]/index.astro",
  "[make]/[model]/years.astro",
  "methodology.astro",
  "privacy.astro",
  "recalls/[campno].astro",
  "recalls/do-not-drive.astro",
  "recalls/lookup.astro",
  "recalls/park-outside.astro",
  "recalls/takata-airbag.astro",
  "recalls/this-week.astro",
  "safety-ratings/index.astro",
  "safety-ratings/[slug].astro",
  "safety-ratings/[slug]/[year].astro",
  "smog-and-ghg-scores/index.astro",
  "smog-and-ghg-scores/[slug].astro",
  "smog-and-ghg-scores/[slug]/[year].astro",
  "tools/fuel-cost-calculator.astro",
  "tools/mpg-calculator.astro",
  "tools/trip-fuel-cost.astro",
];

test("page templates are unchanged, so the sitemap does not gain a URL family", () => {
  assert.deepEqual(walk(join(root, "src/pages")).sort(), [...PAGE_TEMPLATES].sort());
});

test("component titles are unique and keep the component name", () => {
  const seen = new Map();
  for (const page of loadComponentPages()) {
    const title = componentDocumentTitle(page);
    const prior = seen.get(title);
    assert.equal(prior, undefined, `${title} is used by ${prior} and ${page.year} ${page.makeSlug} ${page.modelSlug} ${page.slug}`);
    seen.set(title, `${page.year} ${page.makeSlug}/${page.modelSlug}/${page.slug}`);
    const tail = page.component.split(":").map((part) => part.trim()).filter(Boolean).at(-1) || page.component;
    assert.ok(title.includes(tail) || title.includes(tail.slice(0, 8)), title);
    assert.doesNotMatch(title, / component complaints$/);
  }
  assert.ok(seen.size > 1000);
});

test("the shortened component-complaints fallback is not used", () => {
  function oldTitle(page) {
    const limit = 65;
    const full = `${page.year} ${page.makeName} ${page.modelName}: ${page.component} complaints`;
    if (full.length <= limit) return full;
    const shorter = `${page.year} ${page.makeName} ${page.modelName} component complaints`;
    if (shorter.length <= limit) return shorter;
    return clip(shorter, limit);
  }
  const groups = new Map();
  for (const page of loadComponentPages()) {
    const title = oldTitle(page);
    const list = groups.get(title) || [];
    list.push(page);
    groups.set(title, list);
  }
  const collided = [...groups.values()].filter((list) => list.length > 1).flat();
  assert.equal(collided.length, 145);
  const current = new Set();
  for (const page of collided) {
    const title = componentDocumentTitle(page);
    assert.equal(current.has(title), false, title);
    current.add(title);
    assert.doesNotMatch(title, / component complaints$/);
    const tail = page.component.split(":").map((part) => part.trim()).filter(Boolean).at(-1) || page.component;
    assert.ok(title.includes(tail) || title.includes(tail.slice(0, 8)), title);
  }
});

test("the HTML check rejects a duplicate title in the built site", () => {
  const source = readFileSync(join(root, "scripts/check-html.mjs"), "utf8");
  assert.match(source, /duplicate title/);
});
