import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { findModel, loadModel, loadSummary } from "../src/lib/catalog.js";
import { classFamily } from "../src/lib/compare-pairs.js";
import { loadFuelCostPages } from "../src/lib/fuel-classes.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  SAFETY_BANNED,
  SAFETY_HTML_LIMIT,
  SAFETY_INDEX,
  SAFETY_YEAR_COUNT,
  emptyFiveSentence,
  findSafetyPage,
  isFiveStar,
  isRatedStar,
  loadSafetyCatalog,
  nameRowHtml,
  pageFits,
  rowBytes,
  safetyClassAnswer,
  safetyFaqs,
  safetyIndexAnswer,
  safetyIndexFaqs,
  safetyIndexSourceParts,
  safetyLinkForFuel,
  safetyPaths,
  safetySourceParts,
  safetyYearAnswer,
  starLabel,
} from "../src/lib/safety-ratings.js";

const SAMPLES = ["small-suv", "standard-suv", "midsize-car", "standard-pickup", "minivan", "two-seater", "special-purpose"];

function windowYears() {
  return readdirSync("data/ncap")
    .filter((name) => /^\d{4}\.json$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .filter((year) => Number.isInteger(year))
    .sort((a, b) => b - a)
    .slice(0, SAFETY_YEAR_COUNT)
    .sort((a, b) => a - b);
}

function bucket(overall) {
  const text = String(overall ?? "").trim();
  if (text === "5") return "five";
  if (/^[1-5]$/.test(text)) return "rated";
  return "not";
}

function recompute() {
  const years = windowYears();
  const families = new Set(loadFuelCostPages().map((page) => page.family));
  const raw = new Map();
  const fileCounts = new Map(years.map((year) => [year, { variants: 0, rated: 0, five: 0, notRated: 0 }]));
  for (const year of years) {
    const doc = JSON.parse(readFileSync(`data/ncap/${year}.json`, "utf8"));
    const counts = fileCounts.get(year);
    for (const variant of doc.variants) {
      const id = Number(variant.vehicleId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const key = `${year}:${id}`;
      if (raw.has(key)) throw new Error(`duplicate ${key}`);
      raw.set(key, variant);
      counts.variants += 1;
      const kind = bucket(variant.overall);
      if (kind === "five") {
        counts.five += 1;
        counts.rated += 1;
      } else if (kind === "rated") counts.rated += 1;
      else counts.notRated += 1;
    }
  }
  const hits = new Map();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const year of years) {
        const yearRow = doc.years?.[String(year)];
        if (!yearRow?.ncap?.length) continue;
        const classNames = new Set();
        for (const config of yearRow.configs || []) {
          const family = classFamily(config.vclass);
          if (family) classNames.add(family);
        }
        for (const variant of yearRow.ncap) {
          const id = Number(variant.vehicleId);
          if (!Number.isInteger(id) || id <= 0) continue;
          hits.set(`${year}:${id}`, {
            href: `/${make.slug}/${model.slug}/${year}/`,
            families: [...classNames],
          });
        }
      }
    }
  }
  const byFamily = new Map();
  let noMatch = 0;
  let ambiguous = 0;
  let outside = 0;
  let noClass = 0;
  for (const [key, variant] of raw) {
    const hit = hits.get(key);
    if (!hit) {
      noMatch += 1;
      continue;
    }
    if (hit.families.length === 0) {
      noClass += 1;
      continue;
    }
    if (hit.families.length > 1) {
      ambiguous += 1;
      continue;
    }
    const family = hit.families[0];
    if (!families.has(family)) {
      outside += 1;
      continue;
    }
    const list = byFamily.get(family) || [];
    list.push({ key, href: hit.href, overall: variant.overall });
    byFamily.set(family, list);
  }
  return { years, fileCounts, byFamily, noMatch, ambiguous, outside, noClass, rawCount: raw.size };
}

function idsOf(rows) {
  return rows.map((row) => `${row.year}:${row.vehicleId}`).sort();
}

function assertCopy(text, label) {
  assert.equal(typeof text, "string", label);
  assert.equal(text.length > 0, true, label);
  assert.doesNotMatch(text, SAFETY_BANNED, label);
}

test("a Not rated star is never rendered as zero", () => {
  for (const value of ["Not Rated", "not rated", "", null, 0, "0", "n/a"]) {
    assert.equal(starLabel(value), "Not rated");
    assert.equal(isRatedStar(value), false);
    assert.equal(isFiveStar(value), false);
  }
  assert.equal(starLabel("5"), "5");
  assert.equal(starLabel("4"), "4");
  assert.equal(isFiveStar("5"), true);
  assert.equal(isRatedStar("2"), true);
  assert.doesNotMatch(emptyFiveSentence(), SAFETY_BANNED);
});

test("class counts match an offline recompute from data/ncap", () => {
  const expected = recompute();
  const catalog = loadSafetyCatalog();
  assert.deepEqual(catalog.years, expected.years);
  assert.equal(catalog.years.length, SAFETY_YEAR_COUNT);
  assert.equal(catalog.pages.length, loadFuelCostPages().length);
  assert.deepEqual(
    catalog.pages.map((page) => page.slug),
    loadFuelCostPages().map((page) => page.slug),
  );
  assert.equal(catalog.noMatch, expected.noMatch);
  assert.equal(catalog.noMatchByMake.reduce((sum, row) => sum + row.count, 0), catalog.noMatch);
  for (const row of catalog.ambiguousModels) {
    const found = findModel(row.makeSlug, row.modelSlug);
    assert.equal(found.model.years.some((item) => item.y === row.year), true, row.href);
  }
  assert.equal(catalog.ambiguousVariants, expected.ambiguous);
  assert.equal(catalog.outsideVariants, expected.outside);
  assert.equal(catalog.noClass, expected.noClass);
  assert.equal(catalog.placed + catalog.unplaced, catalog.totals.variants);
  assert.equal(catalog.totals.variants, expected.rawCount);
  assert.equal(catalog.totals.rated, [...expected.fileCounts.values()].reduce((sum, row) => sum + row.rated, 0));
  assert.equal(catalog.totals.five, [...expected.fileCounts.values()].reduce((sum, row) => sum + row.five, 0));
  assert.equal(catalog.totals.notRated, [...expected.fileCounts.values()].reduce((sum, row) => sum + row.notRated, 0));
  for (const year of catalog.byYear) {
    const file = expected.fileCounts.get(year.year);
    assert.equal(year.variants, file.variants, String(year.year));
    assert.equal(year.rated, file.rated, String(year.year));
    assert.equal(year.five, file.five, String(year.year));
    assert.equal(year.notRated, file.notRated, String(year.year));
    assert.equal(year.placed + year.notPlaced, year.variants, String(year.year));
  }

  const index = safetyIndexAnswer(catalog);
  assert.equal(sentenceCount(index) <= 3, true, index);
  assertCopy(index, "index answer");
  assert.match(index, /similar size and weight/);
  assert.match(index, /pre-2011/);
  assert.match(index, /variant/);
  for (const faq of safetyIndexFaqs(catalog.years)) assertCopy(`${faq.q} ${faq.a}`, faq.q);
  assert.equal(safetyIndexFaqs(catalog.years).length >= 2 && safetyIndexFaqs(catalog.years).length <= 4, true);
  const indexSource = safetyIndexSourceParts(catalog, "2026-11-04");
  assertCopy(`${indexSource.before}${indexSource.middle}${indexSource.after}`, "index source");

  for (const slug of SAMPLES) {
    const page = findSafetyPage(slug);
    assert.ok(page, slug);
    const rows = expected.byFamily.get(page.family) || [];
    const five = rows.filter((row) => bucket(row.overall) === "five");
    const rated = rows.filter((row) => bucket(row.overall) !== "not");
    const notRated = rows.filter((row) => bucket(row.overall) === "not");
    assert.equal(page.rows.length, rows.length, slug);
    assert.equal(page.fiveCount, five.length, slug);
    assert.equal(page.ratedCount, rated.length, slug);
    assert.equal(page.notRatedCount, notRated.length, slug);
    assert.deepEqual(idsOf(page.rows), rows.map((row) => row.key).sort(), slug);
    assert.equal(page.fiveRows.length + page.otherRows.length, page.ratedCount, slug);
    assert.equal(page.fiveRows.length + page.otherRows.length + page.notRatedRows.length, page.rows.length, slug);
    for (const row of page.rows) {
      assert.notEqual(row.overallLabel, "0", row.href);
      assert.notEqual(row.frontLabel, "0");
      assert.notEqual(row.sideLabel, "0");
      assert.notEqual(row.rolloverLabel, "0");
      assert.equal(row.rated, isRatedStar(row.overall));
      assert.equal(row.five, row.overallLabel === "5");
      if (!row.rated) assert.equal(row.overallLabel, "Not rated");
      const found = findModel(row.makeSlug, row.modelSlug);
      assert.equal(found.model.years.some((item) => item.y === row.year), true, row.href);
      assert.equal(row.href, `/${row.makeSlug}/${row.modelSlug}/${row.year}/`);
    }
    const answer = safetyClassAnswer(page);
    assert.equal(sentenceCount(answer) <= 3, true, answer);
    assertCopy(answer, `${slug} answer`);
    assert.match(answer, /similar size and weight/);
    assert.match(answer, /pre-2011/);
    for (const faq of safetyFaqs(page)) {
      assertCopy(`${faq.q} ${faq.a}`, `${slug} ${faq.q}`);
      assert.match(faq.a, /Not rated|2011|variant|class/);
    }
    assert.equal(safetyFaqs(page).length >= 2 && safetyFaqs(page).length <= 4, true, slug);
    const source = safetySourceParts(page, "2026-11-04");
    assertCopy(`${source.before}${source.middle}${source.after}`, `${slug} source`);
    assert.match(source.after, /Not rated/);
    assert.match(source.after, /2011/);
    const link = safetyLinkForFuel(page);
    assert.equal(link.href, page.path);
    assertCopy(`${link.label}${link.after}`, `${slug} fuel link`);
    if (page.split) {
      assert.equal(pageFits(page.fullBytes), false, slug);
      const listed = page.byYear.filter((year) => year.path);
      assert.equal(listed.length > 0, true, slug);
      const yearIds = listed.flatMap((year) => idsOf(year.rows));
      assert.deepEqual(yearIds.sort(), idsOf(page.rows), `${slug} year split`);
      for (const year of listed) {
        assert.equal(pageFits(year.fullBytes), true, `${slug} ${year.year}`);
        const yearAnswer = safetyYearAnswer(page, year);
        assert.equal(sentenceCount(yearAnswer) <= 3, true, yearAnswer);
        assertCopy(yearAnswer, `${slug} ${year.year}`);
        assert.equal(year.fiveRows.length + year.otherRows.length + year.notRatedRows.length, year.rows.length);
      }
      if (page.showFiveList) assert.equal(pageFits(rowBytes(page.fiveRows, nameRowHtml)), true, slug);
    } else {
      assert.equal(pageFits(page.fullBytes), true, slug);
      assert.equal(page.byYear.some((year) => year.path), false, slug);
    }
  }

  const seen = new Set();
  for (const page of catalog.pages) {
    for (const row of page.rows) {
      const key = `${row.year}:${row.vehicleId}`;
      assert.equal(seen.has(key), false, key);
      seen.add(key);
    }
  }
  assert.equal(seen.size, catalog.placed);
  const paths = safetyPaths();
  assert.equal(paths[0], SAFETY_INDEX);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.includes("/safety-ratings/small-suv/"), true);
  assert.equal(paths.filter((path) => path.includes("/small-suv/")).length >= 1, true);
});

test("templates keep the answer, the 5-star section, and the visible FAQ", () => {
  const index = readFileSync("src/pages/safety-ratings/index.astro", "utf8");
  const page = readFileSync("src/pages/safety-ratings/[slug].astro", "utf8");
  const year = readFileSync("src/pages/safety-ratings/[slug]/[year].astro", "utf8");
  const table = readFileSync("src/components/SafetyRatingTable.astro", "utf8");
  assert.match(index, /safetyIndexAnswer/);
  assert.match(index, /safetyIndexFaqs/);
  assert.match(index, /faqPage\(faqs\)/);
  assert.match(index, /<h3>\{faq\.q\}<\/h3>/);
  assert.match(page, /safetyClassAnswer/);
  assert.match(page, /<h1>NHTSA 5-star rated \{page\.plural\}<\/h1>/);
  assert.match(page, /<h2>5 stars overall<\/h2>/);
  assert.match(page, /faqPage\(faqs\)/);
  assert.match(page, /<h3>\{faq\.q\}<\/h3>/);
  assert.match(year, /safetyYearAnswer/);
  assert.match(year, /<h2>5 stars overall<\/h2>/);
  assert.match(year, /faqPage\(faqs\)/);
  assert.match(table, /row\.href/);
  assert.match(table, /row\.overallLabel/);
  assert.match(table, /row\.possibilityLabel/);
  assert.doesNotMatch(`${index}\n${page}\n${year}\n${table}`, SAFETY_BANNED);
  assert.match(readFileSync("src/pages/index.astro", "utf8"), /href="\/safety-ratings\/"/);
  assert.match(readFileSync("src/components/Footer.astro", "utf8"), /href="\/safety-ratings\/"/);
  assert.match(readFileSync("src/pages/fuel-cost/index.astro", "utf8"), /safetyIndexLink/);
  assert.match(readFileSync("src/pages/fuel-cost/[slug].astro", "utf8"), /safetyLinkForFuel/);
  assert.match(readFileSync("src/pages/methodology.astro", "utf8"), /href="\/safety-ratings\/"/);
  assert.equal(SAFETY_HTML_LIMIT, 60 * 1024);
});
