import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import { yearList } from "../src/lib/ev-range.js";
import { formatNumber, span } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  MODEL_FACTS_BANNED,
  MODEL_FACTS_CAVEAT,
  MODEL_FACTS_METHOD,
  NOT_LISTED,
  countFactCell,
  economyCell,
  modelFacts,
  modelFactsAnswer,
  modelFactsCaption,
  overallCell,
} from "../src/lib/model-facts.js";

const root = join(import.meta.dirname, "..");
const PII = /\b(vins?|dealers?|narrative|cdescr|odino|firstname|lastname|operator)\b/i;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

function recallsOf(detail) {
  const list = detail?.splitNames ? (detail.also || []).flatMap((group) => group.recalls || []) : detail?.recalls || [];
  return new Set(list.map((recall) => String(recall?.camp || "").trim()).filter(Boolean));
}

function complaintCount(detail) {
  if (!detail) return 0;
  if (detail.splitNames) return (detail.also || []).reduce((sum, group) => sum + (Number(group?.complaints?.n) || 0), 0);
  return Number(detail.complaints?.n) || 0;
}

function investigationCount(detail) {
  if (!detail) return 0;
  if (detail.splitNames) return (detail.also || []).reduce((sum, group) => sum + (group.investigations || []).length, 0);
  return (detail.investigations || []).length;
}

function communicationCount(detail) {
  if (!detail) return 0;
  if (Number.isFinite(Number(detail.communicationCount))) return Number(detail.communicationCount);
  return Array.isArray(detail.communications) ? detail.communications.length : 0;
}

function matched(detail) {
  if (!detail || detail.match === "none") return false;
  return recallsOf(detail).size > 0 || complaintCount(detail) > 0 || investigationCount(detail) > 0 || communicationCount(detail) > 0;
}

function economyFrom(configs) {
  const mpg = [];
  const mpge = [];
  for (const config of configs || []) {
    const comb = Number(config?.comb);
    if (!(comb > 0)) continue;
    if (config.atv === "EV") mpge.push(comb);
    else mpg.push(comb);
  }
  if (mpg.length) return span(Math.min(...mpg), Math.max(...mpg), "mpg");
  if (mpge.length) return span(Math.min(...mpge), Math.max(...mpge), "MPGe");
  return NOT_LISTED;
}

function overallFrom(detail, year) {
  if (year < 2011) return NOT_LISTED;
  const stars = [];
  for (const variant of detail?.ncap || []) {
    if (/^\d$/.test(String(variant?.overall ?? ""))) stars.push(Number(variant.overall));
  }
  if (!stars.length) return NOT_LISTED;
  const low = Math.min(...stars);
  const high = Math.max(...stars);
  return low === high ? String(low) : `${low}–${high}`;
}

function countFrom(detail, field) {
  if (!matched(detail)) return NOT_LISTED;
  const number = field === "recalls" ? recallsOf(detail).size : complaintCount(detail);
  return formatNumber(number);
}

function joinedYears(years) {
  const label = yearList(years);
  if (!label) return "";
  const parts = label.split(", ");
  if (parts.length < 2) return label;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

test("blank cells say not listed and a matched zero stays zero", () => {
  assert.equal(economyCell({ mpgMin: null, mpgMax: null, mpgeMin: null, mpgeMax: null }), NOT_LISTED);
  assert.equal(economyCell({ mpgMin: 0, mpgMax: 0, mpgeMin: 110, mpgeMax: 120 }), "110–120 MPGe");
  assert.equal(economyCell({ mpgMin: 30, mpgMax: 30, mpgeMin: 110, mpgeMax: 110 }), "30 mpg");
  assert.equal(economyCell({ mpgMin: 26, mpgMax: 33 }), "26–33 mpg");
  const unmatched = { hasNhtsa: false, match: "none", recalls: 0, complaints: 0 };
  assert.equal(countFactCell(unmatched, "recalls"), NOT_LISTED);
  assert.equal(countFactCell(unmatched, "complaints"), NOT_LISTED);
  assert.equal(countFactCell({ hasNhtsa: true, match: "exact", recalls: 0, complaints: 0 }, "recalls"), "0");
  assert.equal(countFactCell({ hasNhtsa: true, match: "exact", complaints: 0 }, "complaints"), "0");
  assert.equal(overallCell({ y: 2008, starMin: 5, starMax: 5 }), NOT_LISTED);
  assert.equal(overallCell({ y: 2018, starMin: null, starMax: null }), NOT_LISTED);
  assert.equal(overallCell({ y: 2018, starMin: 4, starMax: 5 }), "4–5");
  assert.equal(overallCell({ y: 2018, starMin: 5, starMax: 5 }), "5");
});

test("a facts answer stays inside three sentences and does not invent a fuel figure", () => {
  const dates = { epa: "2026-11-04", recalls: "2026-11-17", complaints: "2026-11-17" };
  const years = [
    { y: 2008, hasNhtsa: false, match: "none", recalls: 0, complaints: 0, starMin: 5, starMax: 5, mpgMin: null, mpgMax: null },
    { y: 2019, hasNhtsa: true, match: "exact", recalls: 2, complaints: 4, starMin: 5, starMax: 5, mpgMin: 28, mpgMax: 32 },
    { y: 2020, hasNhtsa: true, match: "exact", recalls: 2, complaints: 9, starMin: 4, starMax: 5, mpgMin: 32, mpgMax: 32 },
    { y: 2024, hasNhtsa: true, match: "exact", recalls: 0, complaints: 1, starMin: null, starMax: null, mpgeMin: 110, mpgeMax: 118 },
  ];
  const facts = modelFacts("Honda", "Example", years, dates, { makeSlug: "honda", modelSlug: "example" });
  assert.equal(sentenceCount(facts.answer), 3);
  assert.match(facts.answer, /highest EPA combined mpg listed for a Honda Example configuration is 32, in model years 2019–2020/);
  const vowel = modelFactsAnswer("Acura", "Example", years, dates);
  assert.match(vowel, /for an Acura Example configuration/);
  assert.match(facts.answer, /run from 1 in 2024 to 9 in 2020/);
  assert.match(facts.answer, /add up to 4/);
  assert.match(facts.answer, /newest model year with an NHTSA overall rating is 2020 at 4–5 overall/);
  assert.doesNotMatch(facts.answer, /118/);
  assert.equal(facts.rows[0].overall, NOT_LISTED);
  assert.equal(facts.rows[0].recalls, NOT_LISTED);
  assert.equal(facts.rows[3].economy, "110–118 MPGe");
  assert.equal(facts.rows[3].recalls, "0");
  assert.equal(facts.rows.every((row) => row.href.startsWith("/honda/example/")), true);
  const blank = modelFactsAnswer("Example", "None", [{ y: 2021, hasNhtsa: false, match: "none", recalls: 0, complaints: 0 }], dates);
  assert.match(blank, /does not list a combined mpg or MPGe/);
  assert.match(blank, /does not list recall campaign counts/);
  assert.equal(sentenceCount(blank), 3);
  assert.doesNotMatch(blank, MODEL_FACTS_BANNED);
  assert.equal(MODEL_FACTS_BANNED.test("a problem year to avoid"), true);
  assert.equal(MODEL_FACTS_BANNED.test("the highest combined mpg"), false);
});

test("table values match an offline recompute from the committed model files", () => {
  const summary = loadSummary();
  const dates = loadMeta().dates;
  const answers = new Set();
  let mpgModels = 0;
  let mpgeModels = 0;
  let unmatchedModels = 0;
  let ratedModels = 0;
  for (const make of summary.makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      const facts = modelFacts(make.name, model.name, model.years, dates, {
        makeSlug: make.slug,
        modelSlug: model.slug,
      });
      assert.equal(sentenceCount(facts.answer), 3, `${make.slug}/${model.slug}`);
      assert.equal(answers.has(facts.answer), false, facts.answer);
      answers.add(facts.answer);
      assert.doesNotMatch(facts.answer, MODEL_FACTS_BANNED);
      assert.doesNotMatch(facts.caption, MODEL_FACTS_BANNED);
      assert.doesNotMatch(`${facts.answer} ${facts.caption} ${facts.caveat}`, PII);
      assert.doesNotMatch(`${facts.answer} ${facts.caption} ${facts.caveat}`, VIN);
      assert.equal(facts.caveat, MODEL_FACTS_CAVEAT);
      assert.match(facts.caption, /not listed/);
      assert.match(facts.answer, new RegExp(make.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(facts.rows.length, model.years.length);
      const rowByYear = new Map(facts.rows.map((row) => [row.y, row]));
      let mpgMax = null;
      let mpgYears = [];
      let mpgeMax = null;
      let mpgeYears = [];
      let matchedYears = [];
      let recallTotal = 0;
      let ratingYear = null;
      for (const year of model.years) {
        const detail = doc.years[String(year.y)];
        const row = rowByYear.get(year.y);
        assert.equal(row.y, year.y);
        assert.equal(row.href, `/${make.slug}/${model.slug}/${year.y}/`);
        assert.equal(row.economy, economyFrom(detail?.configs), `${make.slug}/${model.slug}/${year.y} economy`);
        assert.equal(row.recalls, countFrom(detail, "recalls"), `${make.slug}/${model.slug}/${year.y} recalls`);
        assert.equal(row.complaints, countFrom(detail, "complaints"), `${make.slug}/${model.slug}/${year.y} complaints`);
        assert.equal(row.overall, overallFrom(detail, year.y), `${make.slug}/${model.slug}/${year.y} overall`);
        for (const cell of [row.economy, row.recalls, row.complaints, row.overall]) {
          assert.doesNotMatch(cell, PII);
          assert.doesNotMatch(cell, VIN);
        }
        const economy = economyFrom(detail?.configs);
        const mpg = /^([\d,]+)(?:–([\d,]+))? mpg$/.exec(economy);
        if (mpg) {
          const high = Number((mpg[2] || mpg[1]).replaceAll(",", ""));
          if (mpgMax == null || high > mpgMax) {
            mpgMax = high;
            mpgYears = [year.y];
          } else if (high === mpgMax) mpgYears.push(year.y);
        }
        const mpge = /^([\d,]+)(?:–([\d,]+))? MPGe$/.exec(economy);
        if (mpge) {
          const high = Number((mpge[2] || mpge[1]).replaceAll(",", ""));
          if (mpgeMax == null || high > mpgeMax) {
            mpgeMax = high;
            mpgeYears = [year.y];
          } else if (high === mpgeMax) mpgeYears.push(year.y);
        }
        if (matched(detail)) {
          matchedYears.push({ y: year.y, complaints: complaintCount(detail), recalls: recallsOf(detail).size });
          recallTotal += recallsOf(detail).size;
        }
        const overall = overallFrom(detail, year.y);
        if (overall !== NOT_LISTED && (ratingYear == null || year.y > ratingYear.y)) ratingYear = { y: year.y, overall };
      }
      if (mpgMax != null) {
        mpgModels += 1;
        assert.match(facts.answer, new RegExp(`highest EPA combined mpg listed for an? .* configuration is ${formatNumber(mpgMax)}`));
        assert.match(facts.answer, new RegExp(joinedYears(mpgYears).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      } else if (mpgeMax != null) {
        mpgeModels += 1;
        assert.match(facts.answer, new RegExp(`highest EPA combined MPGe listed for an? .* configuration is ${formatNumber(mpgeMax)}`));
        assert.match(facts.answer, new RegExp(joinedYears(mpgeYears).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      } else {
        assert.match(facts.answer, /does not list a combined mpg or MPGe/);
      }
      if (matchedYears.length) {
        const counts = matchedYears.map((year) => year.complaints);
        const low = Math.min(...counts);
        const high = Math.max(...counts);
        assert.match(facts.answer, new RegExp(formatNumber(low).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(facts.answer, new RegExp(formatNumber(high).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(facts.answer, new RegExp(`add up to ${formatNumber(recallTotal).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      } else {
        unmatchedModels += 1;
        assert.match(facts.answer, /does not list recall campaign counts/);
        assert.match(facts.answer, /no model year in this table has a matched complaint count/i);
      }
      if (ratingYear) {
        ratedModels += 1;
        assert.match(facts.answer, new RegExp(`newest model year with an NHTSA overall rating is ${ratingYear.y} at ${ratingYear.overall} overall`));
      } else {
        assert.match(facts.answer, /no model year in this table has an NHTSA overall rating/);
      }
    }
  }
  assert.ok(mpgModels > 0);
  assert.ok(mpgeModels > 0);
  assert.ok(unmatchedModels > 0);
  assert.ok(ratedModels > 0);
  assert.equal(answers.size, summary.makes.reduce((sum, make) => sum + make.models.length, 0));
});

test("the model hub template adds no URL and points the caveat at the methodology", () => {
  const page = readFileSync(join(root, "src/pages/[make]/[model]/index.astro"), "utf8");
  const component = readFileSync(join(root, "src/components/ModelFacts.astro"), "utf8");
  assert.match(page, /<ModelFacts /);
  assert.match(page, /return modelPaths\(\)/);
  assert.equal(page.includes("/facts/"), false);
  assert.match(component, /id="year-by-year"/);
  assert.match(component, /<caption>\{caption\}<\/caption>/);
  assert.match(component, new RegExp(`href=\\{MODEL_FACTS_METHOD\\}`));
  assert.match(component, /href=\{row\.href\}/);
  assert.equal(MODEL_FACTS_METHOD, "/methodology/");
  assert.match(modelFactsCaption("Honda", "Civic", loadMeta().dates), /A blank cell says not listed/);
  const templates = readFileSync(join(root, "src/pages/[make]/[model]/index.astro"), "utf8");
  assert.equal(templates.includes("/facts/"), false);
});
