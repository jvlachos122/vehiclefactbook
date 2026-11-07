import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { primaryNameGroup } from "../src/lib/campaigns.js";
import { loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import {
  COMPONENT_MIN,
  COMPONENT_TITLE_LIMIT,
  componentAnswer,
  componentDocumentTitle,
  componentHrefs,
  componentMetaDescription,
  componentSlug,
  displayedComplaints,
  loadComponentPages,
  qualifyingComponents,
} from "../src/lib/components.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import { classifyPage, sentenceCount } from "../src/lib/jsonld-audit.js";

const BANNED = /\b(avoid|reliable|unreliable|best|worst|lemon|stay away)\b/i;
const PII_KEYS = new Set(["vin", "city", "operator", "dealer", "vehicle_operator", "narrative", "cdescr"]);

function walkKeys(value, path) {
  if (Array.isArray(value)) {
    for (const child of value) walkKeys(child, path);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(PII_KEYS.has(key.toLowerCase()), false, `${path} field ${key}`);
    walkKeys(child, path);
  }
}

function escapeReg(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("component slugs keep letters, digits, and collapsed separators", () => {
  assert.equal(componentSlug("ELECTRICAL SYSTEM"), "electrical-system");
  assert.equal(componentSlug("FUEL/PROPULSION SYSTEM"), "fuel-propulsion-system");
  assert.equal(componentSlug("ELECTRONIC STABILITY CONTROL (ESC)"), "electronic-stability-control-esc");
  assert.equal(
    componentSlug("FORWARD COLLISION AVOIDANCE: AUTOMATIC EMERGENCY BRAKING"),
    "forward-collision-avoidance-automatic-emergency-braking",
  );
  assert.equal(componentSlug("A & B"), "a-and-b");
  assert.equal(componentSlug(""), "");
});

test("published component pages match the stored complaint lists", () => {
  const complaintDate = loadMeta().dates.complaints;
  const pages = loadComponentPages();
  const byPath = new Map(pages.map((page) => [page.path, page]));
  assert.equal(byPath.size, pages.length);
  let expected = 0;
  let below = 0;

  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const summaryYear of model.years) {
        const detail = doc.years[String(summaryYear.y)];
        const displayed = displayedComplaints(detail);
        const items = displayed ? qualifyingComponents(displayed.complaints) : [];
        const hrefs = componentHrefs(make.slug, model.slug, summaryYear.y);
        assert.equal(Object.keys(hrefs).length, items.length, `${make.slug}/${model.slug}/${summaryYear.y}`);

        for (const item of items) {
          expected += 1;
          const path = `/${make.slug}/${model.slug}/${summaryYear.y}/${item.slug}/`;
          const page = byPath.get(path);
          assert.ok(page, path);
          assert.equal(page.component, item.component);
          assert.equal(page.n, item.n);
          assert.ok(page.n >= COMPONENT_MIN);
          assert.ok(page.listN >= page.n);
          assert.ok(page.mmyN >= page.listN);
          assert.equal(page.listN, displayed.complaints.n);
          assert.equal(page.mmyN, summaryYear.complaints);
          assert.equal(page.split, displayed.split);
          assert.equal(page.nhtsaName, displayed.split ? displayed.nhtsaName : "");
          assert.equal(page.yearsPage, Boolean(model.yearsPage));
          assert.equal(hrefs[item.component], path);
          assert.equal(classifyPage(`${path}index.html`), "component");
          if (!displayed.split) assert.equal(page.mmyN, page.listN);

          const stored = displayed.complaints.top.find((row) => row.component === item.component);
          assert.equal(page.n, stored.n);

          const answer = componentAnswer(page, complaintDate);
          assert.ok(sentenceCount(answer) >= 1 && sentenceCount(answer) <= 3, answer);
          assert.match(answer, new RegExp(escapeReg(formatNumber(page.n))));
          assert.match(answer, new RegExp(escapeReg(formatDate(complaintDate))));
          assert.match(answer, /not rates/);
          assert.doesNotMatch(answer, BANNED);
          assert.doesNotMatch(answer, /%|\brate of\b/i);

          const title = componentDocumentTitle(page);
          assert.ok(title.length > 0 && title.length <= COMPONENT_TITLE_LIMIT, title);
          assert.doesNotMatch(title, BANNED);

          const description = componentMetaDescription(page, complaintDate);
          assert.ok(description.length >= 40 && description.length <= 170, description);
          assert.doesNotMatch(description, BANNED);
          walkKeys(page, path);
        }

        for (const row of displayed?.complaints?.top || []) {
          if (Number(row.n) < COMPONENT_MIN) {
            below += 1;
            assert.equal(hrefs[row.component], undefined);
          }
        }

        const groups = detail?.splitNames ? detail.also || [] : detail?.also || [];
        const primary = detail?.splitNames ? primaryNameGroup(detail) : null;
        for (const group of groups) {
          if (primary && group === primary) continue;
          if (!detail?.splitNames && group === undefined) continue;
          for (const row of group?.complaints?.top || []) {
            if (Number(row.n) < COMPONENT_MIN) continue;
            const headlineTop = displayed?.complaints?.top || [];
            const headline = headlineTop.find((item) => item.component === row.component && Number(item.n) >= COMPONENT_MIN);
            const path = `/${make.slug}/${model.slug}/${summaryYear.y}/${componentSlug(row.component)}/`;
            if (!headline) assert.equal(byPath.has(path), false, path);
            else assert.equal(byPath.get(path).n, headline.n);
          }
        }
      }
    }
  }

  assert.equal(pages.length, expected);
  assert.ok(expected > 0);
  assert.ok(below > 0);
  for (const page of pages) {
    assert.equal(page.siblings.some((sibling) => sibling.slug === page.slug), false);
    for (const sibling of page.siblings) {
      assert.ok(sibling.n >= COMPONENT_MIN);
      assert.equal(byPath.get(sibling.path)?.n, sibling.n);
    }
  }
});

test("component templates stay indexable and do not add ranking language", () => {
  const page = readFileSync("src/pages/[make]/[model]/[year]/[component].astro", "utf8");
  const year = readFileSync("src/pages/[make]/[model]/[year]/index.astro", "utf8");
  const bars = readFileSync("src/components/ComplaintBars.astro", "utf8");
  const config = readFileSync("astro.config.mjs", "utf8");
  assert.doesNotMatch(page, /noindex|AggregateRating|AggregateOffer|Product|Review|"@type":\s*"Vehicle"|affiliate/i);
  assert.doesNotMatch(page, /\bavoid\b/i);
  assert.match(page, /BreadcrumbList|breadcrumbs/);
  assert.match(page, /creators:\s*\[nhtsaOrg\]/);
  assert.match(year, /componentHrefs/);
  assert.match(year, /hrefs=\{complaintLinks\}/);
  assert.match(year, /id="complaints"/);
  assert.match(bars, /hrefs\[item\.component\]/);
  assert.match(config, /removedCompares/);
  assert.doesNotMatch(config, /\[component\]|component page/);
});
