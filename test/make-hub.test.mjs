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
});
