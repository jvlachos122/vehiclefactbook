import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMeta, loadSummary, mmyPaths } from "../src/lib/catalog.js";
import { componentPaths } from "../src/lib/components.js";
import {
  EV_RANGE_INDEX,
  NOT_LISTED,
  RANGE_CAVEAT,
  RANGE_SEGMENT,
  answerConfig,
  evRangeAnswer,
  evRangeIndexAnswer,
  evRangePath,
  evRangeRowCount,
  evRangeSource,
  findEvRangePage,
  formatListed,
  loadEvRangePages,
  pageFromDoc,
  phevOmitNote,
  yearList,
} from "../src/lib/ev-range.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";

const BANNED = /\b(avoid|reliable|unreliable|best|worst)\b/i;
const PERCENT = /%|\bpercent\b/i;

function listed(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function clean(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return name || "configuration";
}

function walkModels() {
  const files = [];
  const root = "data/site/models";
  for (const make of readdirSync(root)) {
    const dir = join(root, make);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) files.push(join(dir, file));
    }
  }
  return files;
}

function rowKey(row) {
  return JSON.stringify([row.year, row.config, row.range, row.kwh, row.mpge, row.cost, row.href]);
}

test("blanks are not published as zero", () => {
  for (const value of [0, "0", null, "", -1, Number.NaN]) {
    assert.equal(formatListed(value), NOT_LISTED);
    assert.equal(formatListed(value, "money"), NOT_LISTED);
    assert.equal(formatListed(value, "kwh"), NOT_LISTED);
    assert.notEqual(formatListed(value), "0");
    assert.notEqual(formatListed(value, "money"), "$0");
  }
  assert.equal(formatListed(363), "363");
  assert.equal(formatListed(25.8779), "25.8779");
  assert.equal(formatListed(1050, "money"), "$1,050");

  const page = pageFromDoc({
    make: "Example",
    makeSlug: "example",
    model: "Blank",
    modelSlug: "blank",
    years: {
      2020: {
        configs: [
          { model: "Blank EV", atv: "EV", fuel: "Electricity", range: 0, kwh: null, comb: 0, cost: "" },
          { model: "Blank PHEV", atv: "Plug-in Hybrid", fuel: "Premium Gasoline", range: 40, kwh: 30, comb: 40, cost: 1500 },
        ],
      },
    },
  });
  assert.equal(page.rows.length, 1);
  assert.equal(page.phevCount, 1);
  assert.equal(page.rows[0].range, null);
  assert.equal(page.rows[0].kwh, null);
  assert.equal(page.rows[0].mpge, null);
  assert.equal(page.rows[0].cost, null);
  assert.equal(page.high, null);
  assert.equal(formatListed(page.rows[0].range), NOT_LISTED);
  const text = evRangeAnswer(page, "2026-09-29");
  assert.equal(sentenceCount(text) <= 3, true, text);
  assert.doesNotMatch(text, /\b0\b/);
  assert.match(phevOmitNote(page.phevCount), /plug-in hybrid/i);
  assert.doesNotMatch(phevOmitNote(page.phevCount), /\b40\b/);
});

test("answer citations keep EPA names without splitting the sentence", () => {
  assert.equal(answerConfig("ARIYA PLATINUM+ e-4ORCE 87kWh 19in. Wheels"), "ARIYA PLATINUM+ e-4ORCE 87kWh 19in Wheels");
  assert.equal(answerConfig("ID.4 Pro"), "ID.4 Pro");
  assert.equal(answerConfig("ID. Buzz"), "ID. Buzz");
  const page = {
    make: "Nissan",
    model: "ARIYA",
    years: [2024],
    yearLabel: "2024",
    rows: [
      { year: 2024, config: "ARIYA PLATINUM+ e-4ORCE 87kWh 19in. Wheels", range: 272 },
      { year: 2024, config: "ARIYA Venture+", range: 216 },
    ],
    high: { value: 272, rows: [{ year: 2024, config: "ARIYA PLATINUM+ e-4ORCE 87kWh 19in. Wheels" }] },
    low: { value: 216, rows: [{ year: 2024, config: "ARIYA Venture+" }] },
  };
  const text = evRangeAnswer(page, "2026-09-29");
  assert.equal(sentenceCount(text) <= 3, true, text);
  assert.match(text, /19in Wheels/);
  assert.doesNotMatch(text, /19in\. Wheels/);
});

test("year lists collapse consecutive model years", () => {
  assert.equal(yearList([2014, 2000, 2002, 2001, 2003, 2012, 2013]), "2000–2003, 2012–2014");
  assert.equal(yearList([2022]), "2022");
});

test("range slug does not collide with a year, component, or make path", () => {
  const pages = loadEvRangePages();
  const paths = new Set(pages.map((page) => page.path));
  assert.equal(paths.size, pages.length);
  assert.equal(RANGE_SEGMENT === "range", true);
  assert.equal(/^\d{4}$/.test(RANGE_SEGMENT), false);
  assert.equal(loadSummary().makes.some((make) => make.slug === "ev-range"), false);
  for (const page of pages) {
    assert.equal(page.path, evRangePath(page.makeSlug, page.modelSlug));
    assert.match(page.path, /^\/[^/]+\/[^/]+\/range\/$/);
  }
  for (const item of mmyPaths()) {
    assert.notEqual(String(item.params.year), RANGE_SEGMENT);
    assert.equal(/^\d{4}$/.test(String(item.params.year)), true);
    assert.equal(paths.has(`/${item.params.make}/${item.params.model}/${item.params.year}/`), false);
  }
  for (const item of componentPaths()) {
    const path = `/${item.params.make}/${item.params.model}/${item.params.year}/${item.params.component}/`;
    assert.equal(paths.has(path), false);
    assert.notEqual(path, evRangePath(item.params.make, item.params.model));
  }
  assert.equal(paths.has(EV_RANGE_INDEX), false);
});

test("published EV pages match a recompute and leave plug-in hybrids out", () => {
  const pages = loadEvRangePages();
  const byPath = new Map(pages.map((page) => [page.path, page]));
  let models = 0;
  let rows = 0;
  const samples = [
    ["tesla", "model-3"],
    ["nissan", "leaf"],
  ];
  for (const [makeSlug, modelSlug] of samples) {
    assert.ok(findEvRangePage(makeSlug, modelSlug), `${makeSlug}/${modelSlug}`);
  }

  for (const file of walkModels()) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const expected = [];
    let phev = 0;
    let phevMax = null;
    const years = new Set();
    for (const [yearKey, yearRow] of Object.entries(doc.years || {})) {
      const year = Number(yearKey);
      for (const config of yearRow.configs || []) {
        if (config.atv === "Plug-in Hybrid") {
          phev += 1;
          const range = listed(config.range);
          if (range != null) phevMax = phevMax == null ? range : Math.max(phevMax, range);
        }
        if (config.atv !== "EV") continue;
        years.add(year);
        expected.push({
          year,
          config: clean(config.model),
          range: listed(config.range),
          kwh: listed(config.kwh),
          mpge: listed(config.comb),
          cost: listed(config.cost),
          href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
        });
      }
    }
    const path = `/${doc.makeSlug}/${doc.modelSlug}/range/`;
    if (!expected.length) {
      assert.equal(byPath.has(path), false, path);
      continue;
    }
    models += 1;
    rows += expected.length;
    const page = byPath.get(path);
    assert.ok(page, path);
    assert.equal(page.make, doc.make);
    assert.equal(page.model, doc.model);
    assert.equal(page.phevCount, phev);
    assert.deepEqual(page.years, [...years].sort((a, b) => a - b));
    assert.deepEqual(page.rows.map(rowKey).sort(), expected.map(rowKey).sort());
    const cmpNull = (left, right) => {
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      return left < right ? -1 : left > right ? 1 : 0;
    };
    const ordered = [...page.rows].sort(
      (a, b) =>
        a.year - b.year ||
        a.config.localeCompare(b.config, "en") ||
        cmpNull(a.range, b.range) ||
        cmpNull(a.kwh, b.kwh) ||
        cmpNull(a.mpge, b.mpge) ||
        cmpNull(a.cost, b.cost),
    );
    assert.deepEqual(page.rows.map(rowKey), ordered.map(rowKey));
    const bevRanges = expected.map((row) => row.range).filter((range) => range != null);
    if (bevRanges.length) {
      const bevMax = Math.max(...bevRanges);
      assert.equal(page.high.value, bevMax);
      if (phevMax != null && phevMax !== bevMax) assert.notEqual(page.high.value, phevMax);
    } else {
      assert.equal(page.high, null);
    }
  }

  assert.equal(pages.length, models);
  assert.equal(evRangeRowCount(pages), rows);
  assert.equal(byPath.size, models);

  const labels = pages.map((page) => `${page.make}\0${page.model}`);
  const sorted = [...labels].sort((a, b) => {
    const [aMake, aModel] = a.split("\0");
    const [bMake, bModel] = b.split("\0");
    return aMake.localeCompare(bMake, "en") || aModel.localeCompare(bModel, "en");
  });
  assert.deepEqual(labels, sorted);

  const voltPath = "data/site/models/chevrolet/volt.json";
  const volt = JSON.parse(readFileSync(voltPath, "utf8"));
  const voltEv = Object.values(volt.years).some((row) => (row.configs || []).some((config) => config.atv === "EV"));
  if (!voltEv) assert.equal(findEvRangePage("chevrolet", "volt"), null);
});

test("answers use the recomputed counts and avoid ranking language", () => {
  const meta = loadMeta();
  const pages = loadEvRangePages();
  const date = formatDate(meta.dates.epa);
  assert.ok(date);
  for (const page of pages) {
    const text = evRangeAnswer(page, meta.dates.epa);
    assert.equal(sentenceCount(text) <= 3, true, `${page.path} ${text}`);
    assert.equal(sentenceCount(text) >= 1, true, text);
    assert.ok(text.includes(page.make), text);
    assert.ok(text.includes(page.model), text);
    assert.ok(text.includes(date), text);
    assert.ok(text.includes(formatNumber(page.rows.length)), text);
    if (page.high) assert.ok(text.includes(formatNumber(page.high.value)), text);
    assert.doesNotMatch(text, BANNED);
    assert.doesNotMatch(text, PERCENT);
    if (page.phevCount) {
      const note = phevOmitNote(page.phevCount);
      assert.match(note, /plug-in hybrid/i);
      assert.doesNotMatch(note, BANNED);
      assert.equal(page.rows.every((row) => row.href.includes(`/${page.modelSlug}/`)), true);
    }
  }
  const index = evRangeIndexAnswer(pages, meta.dates.epa);
  assert.equal(sentenceCount(index) <= 3, true, index);
  assert.ok(index.includes(formatNumber(pages.length)), index);
  assert.ok(index.includes(formatNumber(evRangeRowCount(pages))), index);
  assert.ok(index.includes(date), index);
  assert.doesNotMatch(index, BANNED);
  assert.equal(sentenceCount(RANGE_CAVEAT), 1);
  assert.match(RANGE_CAVEAT, /test-cycle estimate/);
  assert.match(RANGE_CAVEAT, /varies/);
  assert.doesNotMatch(RANGE_CAVEAT, PERCENT);
  assert.doesNotMatch(RANGE_CAVEAT, BANNED);
  const source = evRangeSource(meta.dates.epa);
  assert.match(source, /atvType is EV/);
  assert.match(source, new RegExp(NOT_LISTED));
  assert.doesNotMatch(source, BANNED);
  assert.equal(phevOmitNote(0), "");
});

test("page templates do not hard-code a row total", () => {
  const files = [
    "src/lib/ev-range.js",
    "src/pages/ev-range.astro",
    "src/pages/[make]/[model]/range.astro",
    "src/pages/index.astro",
    "src/pages/methodology.astro",
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b1,?598\b/);
    assert.doesNotMatch(text, /\b1,?608\b/);
  }
  const modelPage = readFileSync("src/pages/[make]/[model]/range.astro", "utf8");
  assert.match(modelPage, /formatListed\(value, kind\)/);
  assert.match(modelPage, /cell\(row\.range\)/);
  assert.match(modelPage, /cell\(row\.kwh\)/);
  assert.match(modelPage, /cell\(row\.mpge\)/);
  assert.match(modelPage, /cell\(row\.cost, "money"\)/);
  assert.match(modelPage, /NOT_LISTED/);
  assert.match(modelPage, /RANGE_CAVEAT/);
  assert.match(readFileSync("src/pages/ev-range.astro", "utf8"), /evRangeIndexAnswer/);
  assert.match(readFileSync("src/pages/[make]/[model]/index.astro", "utf8"), /evRange\.path/);
  assert.match(readFileSync("src/pages/[make]/[model]/[year]/index.astro", "utf8"), /hasAllElectric/);
});
