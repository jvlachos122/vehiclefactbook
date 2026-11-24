import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import { loadPriceSnapshot } from "../src/lib/eia-prices.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import {
  EXAMPLE_MILES,
  FUEL_CALCULATOR_BANNED,
  FUEL_CALCULATOR_CRUMBS,
  FUEL_CALCULATOR_PATH,
  fuelCalculatorAnswer,
  loadFuelCalculatorView,
  selectFuelExamples,
  wordCount,
} from "../src/lib/fuel-calculator-examples.js";
import { loadFuelCostPages, loadFuelCostYears } from "../src/lib/fuel-classes.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { enumerateSitemapUrls, readLedger } from "../src/lib/lastmod.js";
import { webApp } from "../src/lib/schema.js";
import { site } from "../src/lib/site.js";

const pageSource = readFileSync(new URL("../src/pages/tools/fuel-cost-calculator.astro", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("../src/lib/fuel-calculator-examples.js", import.meta.url), "utf8");
const snapshotText = readFileSync(new URL("../data/eia-fuel-prices.csv", import.meta.url), "utf8");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function familyOf(vclass) {
  return String(vclass || "")
    .replace(/\s+-\s+(2WD|4WD)$/i, "")
    .replace(/\s+(2WD|4WD)$/i, "")
    .trim();
}

function configTotal(doc) {
  let total = 0;
  for (const year of Object.values(doc?.years || {})) total += (year?.configs || []).length;
  return total;
}

function pick(configs, atv) {
  const rows = (configs || []).filter(
    (config) => clean(config.fuel) === "Regular Gasoline" && clean(config.atv) === atv && Number(config.comb) > 0,
  );
  if (!rows.length) return null;
  const max = Math.max(...rows.map((config) => Number(config.comb)));
  const tied = rows.filter((config) => Number(config.comb) === max);
  tied.sort(
    (a, b) =>
      clean(a.model).localeCompare(clean(b.model), "en") ||
      (Number(a.displ) || 0) - (Number(b.displ) || 0) ||
      (Number(a.cylinders) || 0) - (Number(b.cylinders) || 0) ||
      clean(a.trany).localeCompare(clean(b.trany), "en") ||
      clean(a.drive).localeCompare(clean(b.drive), "en"),
  );
  return tied[0];
}

function offlineExamples() {
  const windowYears = new Set(loadFuelCostYears());
  const pages = loadFuelCostPages();
  const candidates = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      const years = Object.keys(doc.years || {})
        .map(Number)
        .filter((year) => windowYears.has(year))
        .sort((a, b) => b - a);
      let found = null;
      for (const year of years) {
        const configs = doc.years[String(year)]?.configs || [];
        const gas = pick(configs, "");
        const hybrid = pick(configs, "Hybrid");
        if (!gas || !hybrid || Number(hybrid.comb) <= Number(gas.comb)) continue;
        found = { year, gas, hybrid };
        break;
      }
      if (!found) continue;
      const family = familyOf(found.gas.vclass);
      if (!pages.some((page) => page.family === family)) continue;
      candidates.push({
        makeName: doc.make,
        makeSlug: doc.makeSlug,
        modelName: doc.model,
        modelSlug: doc.modelSlug,
        configCount: configTotal(doc),
        year: found.year,
        family,
        gas: found.gas,
        hybrid: found.hybrid,
      });
    }
  }
  const byFamily = new Map();
  for (const candidate of candidates) {
    const list = byFamily.get(candidate.family) || [];
    list.push(candidate);
    byFamily.set(candidate.family, list);
  }
  const winners = [];
  for (const list of byFamily.values()) {
    list.sort(
      (a, b) =>
        b.configCount - a.configCount ||
        b.year - a.year ||
        a.makeName.localeCompare(b.makeName, "en") ||
        a.modelName.localeCompare(b.modelName, "en"),
    );
    winners.push(list[0]);
  }
  winners.sort((a, b) => b.configCount - a.configCount || a.family.localeCompare(b.family, "en"));
  return winners.slice(0, 3);
}

function dollars(value) {
  const cents = Math.round(Math.abs(Number(value)) * 100);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}

function wordsOf(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words, size = 8) {
  const out = new Set();
  for (let index = 0; index + size <= words.length; index += 1) out.add(words.slice(index, index + size).join(" "));
  return out;
}

function templateBody(source) {
  const parts = source.split(/^---$/m);
  assert.equal(parts.length >= 3, true);
  return parts.slice(2).join("---");
}

test("worked examples recompute from committed EPA rows and the EIA snapshot", () => {
  const view = loadFuelCalculatorView();
  const examples = selectFuelExamples();
  const offline = offlineExamples();
  const gasLine = snapshotText.split(/\r?\n/).find((line) => line.startsWith("gasoline,US,"));
  assert.ok(gasLine);
  const gasPrice = gasLine.split(",")[3];
  assert.equal(view.priceUsd, gasPrice);
  assert.equal(Number(gasPrice) > 0, true);
  assert.equal(examples.length, 3);
  assert.equal(offline.length, 3);
  const classes = new Set();
  const models = new Set();
  const windowYears = new Set(loadFuelCostYears());
  for (let index = 0; index < examples.length; index += 1) {
    const example = examples[index];
    const expected = offline[index];
    assert.equal(example.makeSlug, expected.makeSlug);
    assert.equal(example.modelSlug, expected.modelSlug);
    assert.equal(example.year, expected.year);
    assert.equal(windowYears.has(example.year), true);
    assert.equal(example.gas.comb, Number(expected.gas.comb));
    assert.equal(example.hybrid.comb, Number(expected.hybrid.comb));
    assert.equal(example.gas.configName, clean(expected.gas.model));
    assert.equal(example.hybrid.configName, clean(expected.hybrid.model));
    assert.ok(example.hybrid.comb > example.gas.comb);
    classes.add(example.classHref);
    models.add(`${example.makeSlug}/${example.modelSlug}`);
    const doc = loadModel(example.makeSlug, example.modelSlug);
    const configs = doc.years[String(example.year)].configs;
    for (const side of [example.gas, example.hybrid]) {
      const row = configs.find(
        (config) =>
          clean(config.model) === side.configName &&
          clean(config.trany) === side.trany &&
          clean(config.drive) === side.drive &&
          Number(config.comb) === side.comb &&
          clean(config.fuel) === "Regular Gasoline" &&
          clean(config.atv) === side.atv,
      );
      assert.ok(row, `${example.makeName} ${example.modelName} ${side.powertrain}`);
      const again = (EXAMPLE_MILES / Number(row.comb)) * Number(gasPrice);
      assert.ok(Math.abs(side.calculated - again) < 1e-9);
      assert.equal(side.calculatedLabel, dollars(again));
      const published = Number(row.cost);
      if (Number.isFinite(published) && published > 0) assert.equal(side.fuelCost08, published);
    }
    assert.equal(example.yearHref, `/${example.makeSlug}/${example.modelSlug}/${example.year}/`);
    assert.equal(example.modelHref, `/${example.makeSlug}/${example.modelSlug}/`);
    assert.equal(loadFuelCostPages().some((page) => page.path === example.classHref), true);
    const summaryModel = loadSummary()
      .makes.find((make) => make.slug === example.makeSlug)
      .models.find((model) => model.slug === example.modelSlug);
    assert.equal(summaryModel.years.some((row) => row.y === example.year), true);
  }
  assert.equal(classes.size, 3);
  assert.equal(models.size, 3);
  assert.equal(FUEL_CALCULATOR_BANNED.test(view.methodText), false);
  assert.equal(FUEL_CALCULATOR_BANNED.test(view.caption), false);
  assert.equal(/\b[A-HJ-NPR-Z0-9]{17}\b/.test(view.methodText), false);
});

test("the calculator answer names the files and stays inside three sentences", () => {
  const view = loadFuelCalculatorView();
  const meta = loadMeta();
  const text = fuelCalculatorAnswer({
    epaDate: formatDate(meta.dates.epa),
    epaRows: formatNumber(meta.counts.epaRowsMy2000),
    gasPeriod: formatDate(view.gas.period),
    electricPeriod: view.electricPeriodLabel,
    retrieved: formatDate(view.gas.retrieved),
  });
  assert.equal(sentenceCount(text) >= 1 && sentenceCount(text) <= 3, true);
  assert.match(text, /data\/eia-fuel-prices\.csv/);
  assert.match(text, new RegExp(formatDate(meta.dates.epa)));
  assert.match(text, new RegExp(formatDate(view.gas.period)));
  assert.match(text, new RegExp(formatDate(view.gas.retrieved)));
  assert.equal(FUEL_CALCULATOR_BANNED.test(text), false);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: FUEL_CALCULATOR_CRUMBS.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.label,
          item: new URL(item.href, site.url).href,
        })),
      },
      webApp({
        name: "Fuel cost calculator",
        description: text,
        url: new URL(FUEL_CALCULATOR_PATH, site.url).href,
      }),
    ],
  };
  const parsed = JSON.parse(JSON.stringify(graph));
  const types = parsed["@graph"].map((node) => node["@type"]);
  assert.deepEqual(types.sort(), ["BreadcrumbList", "WebApplication"]);
  assert.equal(JSON.stringify(parsed).includes("Product"), false);
  assert.equal(JSON.stringify(parsed).includes("Review"), false);
  assert.equal(JSON.stringify(parsed).includes("AggregateRating"), false);
});

test("method copy is long enough and is not reused from other pages", () => {
  const view = loadFuelCalculatorView();
  assert.ok(wordCount(view.methodText) >= 300, `method is ${wordCount(view.methodText)} words`);
  assert.match(view.caption, /data\/eia-fuel-prices\.csv/);
  assert.match(view.methodText, /data\/eia-fuel-prices\.csv/);
  const mine = shingles(wordsOf(`${view.methodText} ${view.caption}`));
  const files = [
    "src/pages/methodology.astro",
    "src/pages/tools/trip-fuel-cost.astro",
    "src/pages/tools/mpg-calculator.astro",
    "src/pages/fuel-cost/index.astro",
    "src/pages/fuel-cost/[slug].astro",
    "src/pages/compare/hybrid/index.astro",
    "src/pages/compare/hybrid/[pair].astro",
    "src/lib/fuel-classes.js",
    "src/lib/fuel-cost.js",
    "src/lib/hybrid-pairs.js",
    "src/pages/index.astro",
    "README.md",
  ];
  for (const file of files) {
    const theirs = shingles(wordsOf(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/<[^>]+>/g, " ")));
    const hits = [...mine].filter((item) => theirs.has(item));
    assert.deepEqual(hits, [], file);
  }
  for (const example of selectFuelExamples()) {
    assert.equal(moduleSource.includes(example.modelSlug), false, example.modelSlug);
    assert.equal(moduleSource.includes(example.makeSlug), false, example.makeSlug);
  }
  assert.equal(/\$\d/.test(moduleSource), false);
  assert.equal(moduleSource.includes("4.269"), false);
});

test("the tool is in the template before the method, with no new sitemap URL", () => {
  const body = templateBody(pageSource);
  const formAt = body.indexOf("<form");
  const methodAt = body.indexOf('id="calculator-method"');
  assert.ok(formAt > 0 && methodAt > formAt);
  assert.equal(/<p\b/i.test(body.slice(0, formAt)), false);
  assert.match(body, /id="trip"/);
  assert.match(body, new RegExp(`value="${EXAMPLE_MILES}"`));
  assert.match(pageSource, /breadcrumbs=\{FUEL_CALCULATOR_CRUMBS\}/);
  assert.match(pageSource, /webApp\(/);
  assert.match(pageSource, /href="\/fuel-cost\/"/);
  assert.match(pageSource, /href="\/tools\/trip-fuel-cost\/"/);
  assert.doesNotMatch(pageSource, /"@type":\s*"Product"|AggregateRating|"@type":\s*"Review"/);
  const urls = enumerateSitemapUrls();
  assert.deepEqual(
    urls.filter((url) => url.startsWith("/tools/")),
    ["/tools/fuel-cost-calculator/", "/tools/mpg-calculator/", "/tools/trip-fuel-cost/"],
  );
  assert.deepEqual(Object.keys(readLedger().urls).sort(), urls);
});
