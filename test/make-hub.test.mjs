import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMeta, loadSummary } from "../src/lib/catalog.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { makeComplaintPath } from "../src/lib/make-complaints.js";
import {
  MAKE_HUB_BANNED,
  makeHubAnswer,
  makeHubCaption,
  makeHubFacts,
  makeYearCaption,
  makeYearComparisonText,
  makeYearCount,
  makeYearEconomy,
  makeYearRows,
  makeYearStars,
  rangeCell,
  starCell,
  yearSpan,
} from "../src/lib/make-hub.js";

const root = join(import.meta.dirname, "..");
const PII = ["vin", "city", "dealer", "phone", "operator", "narrative", "odino", "summary"];

function recallsOnYear(row) {
  const list = [...(row?.recalls || [])];
  for (const group of row?.also || []) list.push(...(group?.recalls || []));
  return list;
}

function offlineRow(make, model) {
  const doc = JSON.parse(readFileSync(join(root, "data/site/models", make.slug, `${model.slug}.json`), "utf8"));
  const camps = new Set();
  let complaints = 0;
  let rangeMin = null;
  let rangeMax = null;
  for (const row of Object.values(doc.years || {})) {
    for (const recall of recallsOnYear(row)) {
      const camp = String(recall?.camp || "").trim();
      if (camp) camps.add(camp);
    }
    if (row.splitNames) {
      for (const group of row.also || []) complaints += Number(group?.complaints?.n) || 0;
    } else {
      complaints += Number(row.complaints?.n) || 0;
    }
    for (const config of row.configs || []) {
      if (config?.atv !== "EV") continue;
      const range = Number(config.range);
      if (!Number.isFinite(range) || range <= 0) continue;
      rangeMin = rangeMin == null ? range : Math.min(rangeMin, range);
      rangeMax = rangeMax == null ? range : Math.max(rangeMax, range);
    }
  }
  let starMin = null;
  let starMax = null;
  let latestRated = null;
  let minY = null;
  let maxY = null;
  for (const year of model.years || []) {
    if (minY == null || year.y < minY) minY = year.y;
    if (maxY == null || year.y > maxY) maxY = year.y;
    if (year.y < 2011 || year.starMin == null || year.starMax == null) continue;
    starMin = starMin == null ? year.starMin : Math.min(starMin, year.starMin);
    starMax = starMax == null ? year.starMax : Math.max(starMax, year.starMax);
    if (latestRated == null || year.y > latestRated) latestRated = year.y;
  }
  return { camps: camps.size, complaints, rangeMin, rangeMax, starMin, starMax, latestRated, minY, maxY };
}

function offlineCampaigns(make) {
  const camps = new Set();
  for (const model of make.models) {
    const doc = JSON.parse(readFileSync(join(root, "data/site/models", make.slug, `${model.slug}.json`), "utf8"));
    for (const row of Object.values(doc.years || {})) {
      for (const recall of recallsOnYear(row)) {
        const camp = String(recall?.camp || "").trim();
        if (camp) camps.add(camp);
      }
    }
  }
  return camps.size;
}

test("make hub counts match an offline recompute", () => {
  const summary = loadSummary();
  const dates = loadMeta().dates;
  const samples = ["honda", "audi", "alfa-romeo"];
  const answers = new Set();
  let withoutComplaints = 0;
  for (const make of summary.makes) {
    const hub = makeHubFacts(make);
    const text = makeHubAnswer(make.name, hub.rows, hub.facts, dates);
    const caption = makeHubCaption(make.name, dates);
    assert.ok(sentenceCount(text) >= 1 && sentenceCount(text) <= 3, text);
    assert.doesNotMatch(text, MAKE_HUB_BANNED);
    assert.doesNotMatch(caption, MAKE_HUB_BANNED);
    assert.equal(answers.has(text), false, make.slug);
    answers.add(text);
    assert.match(text, new RegExp(`covers ${hub.rows.length.toLocaleString("en-US")} model`));
    assert.match(text, /EPA file dated/);
    assert.match(text, /recall file dated/);
    assert.match(text, /complaint file dated/);
    if (hub.rows.some((row) => row.latestRated != null)) assert.match(text, /newest model year with an NHTSA overall star is/);
    else assert.match(text, /No model year from 2011 on has an NHTSA overall star/);
    const complaintPath = makeComplaintPath(make.slug);
    if (!complaintPath) withoutComplaints += 1;
    for (const row of hub.rows) {
      for (const key of Object.keys(row)) assert.equal(PII.includes(key), false, key);
    }
    if (!samples.includes(make.slug)) continue;
    assert.equal(hub.facts.total, offlineCampaigns(make), make.slug);
    assert.equal(hub.rows.length, make.models.length, make.slug);
    let complaints = 0;
    for (const model of make.models) {
      const again = offlineRow(make, model);
      const row = hub.rows.find((item) => item.slug === model.slug);
      assert.ok(row, model.slug);
      assert.equal(row.campaigns, again.camps, `${make.slug}/${model.slug} campaigns`);
      assert.equal(row.complaints, again.complaints, `${make.slug}/${model.slug} complaints`);
      assert.equal(row.minY, again.minY);
      assert.equal(row.maxY, again.maxY);
      assert.equal(row.starMin, again.starMin);
      assert.equal(row.starMax, again.starMax);
      assert.equal(row.latestRated, again.latestRated);
      assert.equal(row.rangeMin, again.rangeMin);
      assert.equal(row.rangeMax, again.rangeMax);
      assert.equal(yearSpan(row), again.minY === again.maxY ? String(again.minY) : `${again.minY}–${again.maxY}`);
      assert.equal(starCell(row), again.starMin == null ? "—" : again.starMin === again.starMax ? String(again.starMin) : `${again.starMin}–${again.starMax}`);
      complaints += again.complaints;
    }
    assert.match(text, new RegExp(`${complaints.toLocaleString("en-US")} distinct complaint`));
    if (make.slug === "honda" || make.slug === "audi") assert.ok(complaintPath, make.slug);
  }
  assert.ok(withoutComplaints > 0);
  const page = readFileSync(join(root, "src/pages/[make]/index.astro"), "utf8");
  assert.match(page, /href="#recalls"/);
  assert.match(page, /href=\{complaintPath\}/);
  assert.match(page, /<caption>\{caption\}<\/caption>/);
  assert.doesNotMatch(page, /Product|AggregateRating|Review/);
  const calculator = readFileSync(join(root, "src/pages/tools/fuel-cost-calculator.astro"), "utf8");
  assert.match(calculator, /href="\/tools\/trip-fuel-cost\/"/);
  assert.match(page, /id="make-years"/);
});

test("a make year table adds matched counts and does not treat an unmatched year as zero", () => {
  const make = {
    name: "Example",
    models: [
      {
        years: [
          { y: 2019, hasNhtsa: true, match: "exact", mpgMin: 20, mpgMax: 25, complaints: 2, recalls: 1, starMin: 4, starMax: 5 },
          { y: 2020, hasNhtsa: true, match: "exact", mpgMin: 22, mpgMax: 28, complaints: 4, recalls: 0, starMin: null, starMax: null },
        ],
      },
      {
        years: [
          { y: 2020, hasNhtsa: true, match: "exact", mpgMin: 30, mpgMax: 31, complaints: 1, recalls: 3, starMin: 5, starMax: 5 },
          { y: 2008, hasNhtsa: false, match: "none", mpgMin: null, mpgMax: null, complaints: 0, recalls: 0, starMin: 5, starMax: 5 },
        ],
      },
    ],
  };
  const rows = makeYearRows(make);
  const byYear = new Map(rows.map((row) => [row.y, row]));
  assert.equal(makeYearEconomy(byYear.get(2020)), "22–31 mpg");
  assert.equal(makeYearCount(byYear.get(2020), "recalls"), "3");
  assert.equal(makeYearCount(byYear.get(2020), "complaints"), "5");
  assert.equal(makeYearStars(byYear.get(2020)), "5");
  assert.equal(makeYearStars(byYear.get(2019)), "4–5");
  assert.equal(makeYearEconomy(byYear.get(2008)), "not listed");
  assert.equal(makeYearCount(byYear.get(2008), "recalls"), "not listed");
  assert.equal(makeYearCount(byYear.get(2008), "complaints"), "not listed");
  assert.equal(makeYearStars(byYear.get(2008)), "not listed");
  const text = makeYearComparisonText(make.name, rows);
  assert.match(text, /The 2020 combined mpg high is 31 and the 2019 combined mpg high is 25/);
  assert.match(text, /The 2020 summed complaint count is 5 and the 2019 summed complaint count is 2/);
  assert.match(text, /The 2020 summed recall count is 3 and the 2019 summed recall count is 1/);
  assert.doesNotMatch(text, /2008|best|worst/);
  const caption = makeYearCaption("Example", { epa: "2026-09-29", recalls: "2026-11-23", complaints: "2026-11-23" });
  assert.match(caption, /not listed/);
  assert.match(caption, /Sep 29, 2026/);
});

test("make year rows match the summary counts", () => {
  const dates = loadMeta().dates;
  for (const make of loadSummary().makes) {
    const rows = makeYearRows(make);
    const text = makeYearComparisonText(make.name, rows);
    assert.doesNotMatch(text, MAKE_HUB_BANNED, text);
    assert.match(makeYearCaption(make.name, dates), /not listed/);
    const expected = new Map();
    for (const model of make.models) {
      for (const year of model.years) {
        let bucket = expected.get(year.y) || { models: 0, recalls: 0, complaints: 0, matched: false, mpgMin: null, mpgMax: null };
        bucket.models += 1;
        const matched = year.hasNhtsa === true || (year.hasNhtsa !== false && year.match !== "none" && Number.isFinite(Number(year.complaints)));
        if (year.hasNhtsa === false || year.match === "none") {
          // unmatched
        } else if (matched) {
          bucket.matched = true;
          bucket.recalls += Number(year.recalls) || 0;
          bucket.complaints += Number(year.complaints) || 0;
        }
        if (year.mpgMin > 0 && year.mpgMax > 0) {
          bucket.mpgMin = bucket.mpgMin == null ? year.mpgMin : Math.min(bucket.mpgMin, year.mpgMin);
          bucket.mpgMax = bucket.mpgMax == null ? year.mpgMax : Math.max(bucket.mpgMax, year.mpgMax);
        }
        expected.set(year.y, bucket);
      }
    }
    assert.equal(rows.length, expected.size, make.slug);
    for (const row of rows) {
      const again = expected.get(row.y);
      assert.equal(row.models, again.models, `${make.slug} ${row.y}`);
      assert.equal(row.matched, again.matched, `${make.slug} ${row.y}`);
      if (again.matched) {
        assert.equal(makeYearCount(row, "recalls"), again.recalls.toLocaleString("en-US"));
        assert.equal(makeYearCount(row, "complaints"), again.complaints.toLocaleString("en-US"));
      } else {
        assert.equal(makeYearCount(row, "recalls"), "not listed");
      }
      if (again.mpgMax != null) assert.equal(row.mpg.max, again.mpgMax);
      assert.doesNotMatch(makeYearEconomy(row), /—/);
      assert.doesNotMatch(makeYearStars(row), /—/);
    }
  }
});
