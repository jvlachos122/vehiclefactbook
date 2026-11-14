import assert from "node:assert/strict";
import test from "node:test";
import { loadModel, loadSummary } from "../src/lib/catalog.js";
import { classFamily } from "../src/lib/compare-pairs.js";
import { loadFuelCostPages } from "../src/lib/fuel-classes.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  NOT_AVAILABLE,
  SCORE_BANNED,
  SCORE_INDEX,
  SCORE_TEN_TINY,
  SCORE_YEARS,
  classIndexCaption,
  distributionCaption,
  fieldMeaningText,
  ghgMeaningText,
  labelMeaningText,
  listedScore,
  loadScoreCatalog,
  outsideClassNote,
  scoreClassAnswer,
  scoreClassFaqs,
  scoreIndexAnswer,
  scoreIndexFaqs,
  scoreLabel,
  scoreListedCount,
  scorePaths,
  scoreRowHtml,
  scoreSections,
  scoreYearAnswer,
  sectionGapNote,
  smogMeaningText,
  vehiclesFileText,
  yearCountCaption,
} from "../src/lib/scores.js";

const meta = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(new URL("../data/site/meta.json", import.meta.url), "utf8")),
);

function rawScore(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(number) || number < 1 || number > 10) return null;
  return number;
}

function sectionOf(config) {
  if (config?.atv === "Plug-in Hybrid") return "plug";
  if (config?.atv === "FCV" || config?.atv === "eFCV" || config?.fuel === "Hydrogen") return "plug";
  if (config?.atv === "EV" || config?.fuel === "Electricity") return "plug";
  return "combustion";
}

function recompute() {
  const fuelFamilies = new Set(loadFuelCostPages().map((page) => page.family));
  const byYear = new Map(SCORE_YEARS.map((year) => [year, { scores: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((score) => [score, 0])), notAvailable: 0, total: 0 }]));
  const byFamily = new Map();
  const hrefs = new Set();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      for (const year of model.years) hrefs.add(`/${make.slug}/${model.slug}/${year.y}/`);
      const doc = loadModel(make.slug, model.slug);
      for (const year of SCORE_YEARS) {
        const yearRow = doc.years?.[String(year)];
        if (!yearRow) continue;
        for (const config of yearRow.configs || []) {
          const score = rawScore(config.ghg);
          const bucket = byYear.get(year);
          bucket.total += 1;
          if (score == null) bucket.notAvailable += 1;
          else bucket.scores[score] += 1;
          const family = classFamily(config.vclass);
          if (!family || !fuelFamilies.has(family)) continue;
          const list = byFamily.get(family) || [];
          list.push({
            year,
            score,
            section: sectionOf(config),
            href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
          });
          byFamily.set(family, list);
        }
      }
    }
  }
  return { byYear, byFamily, hrefs };
}

const offline = recompute();
const catalog = loadScoreCatalog();

test("a negative greenhouse gas score is not a score", () => {
  for (const value of [-1, 0, null, undefined, "", 11, 1.5, "-1", "−1"]) {
    assert.equal(listedScore(value), null, String(value));
    assert.equal(scoreLabel(value), NOT_AVAILABLE);
    assert.equal(scoreLabel(value).includes("1") && scoreLabel(value) !== NOT_AVAILABLE, false);
  }
  assert.equal(listedScore(10), 10);
  assert.equal(listedScore(1), 1);
  assert.equal(scoreLabel(10), "10");
  const html = scoreRowHtml({
    href: "/honda/cr-v/2025/",
    vehicle: "2025 Honda CR-V",
    trim: "CR-V",
    fuel: "Hydrogen",
    scoreLabel: scoreLabel(-1),
  });
  assert.equal(html.includes(">-1<") || html.includes(">−1<"), false);
  assert.match(html, />not available</);
});

test("score distributions match an offline recompute", () => {
  assert.deepEqual(catalog.years, SCORE_YEARS);
  let scored = 0;
  let missing = 0;
  for (const year of catalog.distribution) {
    const expected = offline.byYear.get(year.year);
    assert.equal(year.total, expected.total, String(year.year));
    assert.equal(year.notAvailable, expected.notAvailable, String(year.year));
    for (let score = 1; score <= 10; score += 1) {
      assert.equal(year.scores[score], expected.scores[score], `${year.year} ${score}`);
      assert.equal(catalog.totals.scores[score] >= year.scores[score], true);
    }
    scored += year.total - year.notAvailable;
    missing += year.notAvailable;
  }
  for (let score = 1; score <= 10; score += 1) {
    const sum = catalog.distribution.reduce((total, year) => total + year.scores[score], 0);
    assert.equal(catalog.totals.scores[score], sum);
  }
  assert.equal(catalog.scored, scored);
  assert.equal(catalog.notAvailable, missing);
  assert.equal(catalog.totals.notAvailable, missing);
  assert.equal(catalog.totals.total, scored + missing);
});

test("class lists match the fuel-cost classes and the offline counts", () => {
  const fuel = loadFuelCostPages();
  assert.equal(catalog.pages.length, fuel.length);
  assert.deepEqual(catalog.pages.map((page) => page.slug), fuel.map((page) => page.slug));
  const hrefs = new Set();
  for (const page of catalog.pages) {
    const records = offline.byFamily.get(page.family) || [];
    const score10 = records.filter((record) => record.score === 10).length;
    const score9 = records.filter((record) => record.score === 9).length;
    const notAvailable = records.filter((record) => record.score == null).length;
    assert.equal(page.score10, score10, page.slug);
    assert.equal(page.score9, score9, page.slug);
    assert.equal(page.notAvailable, notAvailable, page.slug);
    assert.equal(page.configs, records.length, page.slug);
    assert.equal(page.listNines, score10 < SCORE_TEN_TINY, page.slug);
    const expectedListed = records.filter((record) => record.score === 10 || (page.listNines && record.score === 9));
    assert.equal(page.listed.length, expectedListed.length, page.slug);
    for (const row of page.listed) {
      assert.equal(row.score === 10 || (page.listNines && row.score === 9), true, page.slug);
      assert.equal(row.scoreLabel, String(row.score));
      assert.equal(row.scoreLabel === "-1" || row.scoreLabel === "−1", false);
      assert.ok(offline.hrefs.has(row.href), row.href);
      hrefs.add(row.href);
      assert.equal(row.section === "plug" || row.section === "combustion", true);
    }
    const plug = page.listed.filter((row) => row.section === "plug");
    const combustion = page.listed.filter((row) => row.section === "combustion");
    assert.equal(plug.length + combustion.length, page.listed.length);
    if (!page.split) {
      const sections = scoreSections(page.listed, page.years, meta.dates.epa);
      const shown = sections.flatMap((section) => section.tables.flatMap((table) => table.rows));
      assert.equal(shown.length, page.listed.length, page.slug);
      for (const section of sections) {
        assert.equal(section.tables.every((table) => table.rows.every((row) => row.section === section.id)), true);
        for (const table of section.tables) {
          assert.equal(table.rows.every((row) => row.score === table.score), true);
        }
      }
    } else {
      assert.ok(page.byYear.every((year) => year.path === `${page.path}${year.year}/`), page.slug);
    }
    const yearListed = page.byYear.reduce((sum, year) => sum + year.listed.length, 0);
    assert.equal(yearListed, page.listed.length, page.slug);
    for (const year of page.byYear) {
      const yearRecords = records.filter((record) => record.year === year.year);
      assert.equal(year.score10, yearRecords.filter((record) => record.score === 10).length, `${page.slug} ${year.year}`);
      assert.equal(year.score9, yearRecords.filter((record) => record.score === 9).length, `${page.slug} ${year.year}`);
    }
  }
  assert.ok(hrefs.size > 0);
});

test("score copy stays factual and inside the answer limit", () => {
  const chunks = [
    scoreIndexAnswer(catalog, meta.dates.epa),
    distributionCaption(meta.dates.epa),
    classIndexCaption(meta.dates.epa),
    ghgMeaningText(),
    smogMeaningText(),
    labelMeaningText(),
    fieldMeaningText(),
    vehiclesFileText(meta.dates.epa),
    outsideClassNote(catalog.outside),
    ...scoreIndexFaqs().flatMap((faq) => [faq.q, faq.a]),
  ];
  assert.equal(sentenceCount(scoreIndexAnswer(catalog, meta.dates.epa)) <= 3, true);
  for (const page of catalog.pages) {
    const answer = scoreClassAnswer(page, meta.dates.epa);
    chunks.push(answer, yearCountCaption(page, meta.dates.epa));
    chunks.push(sectionGapNote(page.listed, "plug", page.listNines), sectionGapNote(page.listed, "combustion", page.listNines));
    assert.equal(sentenceCount(answer) <= 3, true, page.slug);
    for (const faq of scoreClassFaqs(page)) chunks.push(faq.q, faq.a);
    for (const year of page.byYear) {
      if (!year.path) continue;
      const yearAnswer = scoreYearAnswer(page, year, meta.dates.epa);
      chunks.push(yearAnswer);
      assert.equal(sentenceCount(yearAnswer) <= 3, true, `${page.slug} ${year.year}`);
    }
    for (const section of scoreSections(page.listed, page.years, meta.dates.epa)) {
      chunks.push(section.heading);
      for (const table of section.tables) chunks.push(table.caption);
    }
  }
  for (const chunk of chunks) assert.doesNotMatch(chunk, SCORE_BANNED, chunk);
  assert.match(scoreIndexAnswer(catalog, meta.dates.epa), /do not include it/);
  assert.match(fieldMeaningText(), /do not store score or smogRating/);
  assert.equal(catalog.pages.every((page) => page.listed.every((row) => row.smog == null && row.scoreLabel !== "-1")), true);
});

test("published score paths are the index, the class pages, and year pages only when a class is split", () => {
  const paths = scorePaths();
  assert.equal(paths[0], SCORE_INDEX);
  assert.equal(new Set(paths).size, paths.length);
  const classes = catalog.pages.length;
  const years = catalog.pages.filter((page) => page.split).reduce((sum, page) => sum + page.byYear.filter((year) => year.path).length, 0);
  assert.equal(paths.length, 1 + classes + years);
  assert.equal(scoreListedCount(), catalog.pages.reduce((sum, page) => sum + page.listed.length, 0));
  for (const page of catalog.pages) {
    if (page.split) assert.equal(page.byYear.every((year) => year.path), true, page.slug);
    else assert.equal(page.byYear.every((year) => year.path === ""), true, page.slug);
  }
});
