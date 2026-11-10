import assert from "node:assert/strict";
import test from "node:test";
import { loadMeta, loadSummary } from "../src/lib/catalog.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  componentGroupsFor,
  countCell,
  formatYearList,
  modelDemandScore,
  mpgCell,
  NOT_LISTED,
  PRE_2011_STARS,
  qaModels,
  rankModels,
  resolveDemandExamples,
  starsCell,
  TOP_MODEL_COUNT,
  YEARS_BANNED,
  YEARS_CAPTION,
  YEARS_FAQ_RATE,
  yearsAnswer,
  yearsCaveat,
  yearsFacts,
  yearsFaqs,
  yearsH1,
  yearsPageText,
  yearsStarNote,
  yearsTitle,
} from "../src/lib/years.js";

const dates = { recalls: "2026-11-09", complaints: "2026-11-09", investigations: "2026-11-09", epa: "2026-11-04" };

function recompute(years, complaintDate, minReportingYears = 3) {
  const fileYear = Number(String(complaintDate).slice(0, 4));
  const matched = years.filter((year) => year.hasNhtsa);
  const mostCount = Math.max(...matched.map((year) => year.complaints));
  const mostYears = matched
    .filter((year) => year.complaints === mostCount)
    .map((year) => year.y)
    .sort((a, b) => a - b);
  const seasoned = matched.filter((year) => fileYear - year.y >= minReportingYears);
  const fewest = seasoned.length
    ? {
        count: Math.min(...seasoned.map((year) => year.complaints)),
        years: seasoned
          .filter((year) => year.complaints === Math.min(...seasoned.map((item) => item.complaints)))
          .map((year) => year.y)
          .sort((a, b) => a - b),
      }
    : null;
  const recallValues = matched.map((year) => year.recalls);
  return {
    mostCount,
    mostYears,
    fewest,
    total: recallValues.reduce((sum, value) => sum + value, 0),
    minRecall: Math.min(...recallValues),
    maxRecall: Math.max(...recallValues),
    dnd: matched.filter((year) => year.dnd > 0).map((year) => year.y).sort((a, b) => a - b),
    park: matched.filter((year) => year.park > 0).map((year) => year.y).sort((a, b) => a - b),
  };
}

test("year lists collapse runs and keep gaps", () => {
  assert.equal(formatYearList([2016]), "2016");
  assert.equal(formatYearList([2015, 2016]), "2015–2016");
  assert.equal(formatYearList([2000, 2001, 2004, 2006]), "2000–2001, 2004, and 2006");
});

test("blank cells say not listed and a matched zero stays zero", () => {
  const blank = countCell({ hasNhtsa: false, match: "none", complaints: 0, recalls: 0, crash: 0, fire: 0, investigations: 0 }, "complaints");
  assert.equal(blank.text, NOT_LISTED);
  assert.equal(blank.text.includes("0"), false);
  assert.equal(countCell({ hasNhtsa: true, complaints: 0 }, "complaints").text, "0");
  assert.equal(countCell({ hasNhtsa: true, crash: null }, "crash").text, NOT_LISTED);
  const oldStars = starsCell({ y: 2008, starMin: 5, starMax: 5 });
  assert.equal(oldStars.text, PRE_2011_STARS);
  assert.equal(oldStars.text.includes("5"), false);
  assert.equal(starsCell({ y: 2016, starMin: null, starMax: null }).text, NOT_LISTED);
  assert.equal(starsCell({ y: 2016, starMin: 4, starMax: 5 }).text, "4–5");
  assert.equal(mpgCell({ mpgMin: 0, mpgMax: 0, mpgeMin: null, mpgeMax: null }).text, NOT_LISTED);
  assert.equal(mpgCell({ mpgMin: null, mpgMax: null, mpgeMin: 110, mpgeMax: 120 }).text, "110–120 MPGe");
  assert.equal(mpgCell({ mpgMin: 26, mpgMax: 33, mpgeMin: null, mpgeMax: null }).text, "26–33");
});

test("years answer uses counts for the high year, the seasoned low years, and recall flags", () => {
  const years = [
    { y: 2015, complaints: 40, recalls: 2, hasNhtsa: true, dnd: 0, park: 1 },
    { y: 2016, complaints: 40, recalls: 9, hasNhtsa: true, dnd: 2, park: 0 },
    { y: 2026, complaints: 1, recalls: 0, hasNhtsa: true, dnd: 0, park: 0 },
    { y: 2001, complaints: 0, recalls: 0, hasNhtsa: false, match: "none", dnd: 0, park: 0 },
  ];
  const facts = yearsFacts(years, dates);
  const text = yearsAnswer("Honda", "CR-V", years, dates);
  assert.deepEqual(facts.most, { count: 40, years: [2015, 2016] });
  assert.deepEqual(facts.fewest, { count: 40, years: [2015, 2016] });
  assert.equal(facts.recalls.total, 11);
  assert.deepEqual(facts.dndYears, [2016]);
  assert.deepEqual(facts.parkYears, [2015]);
  assert.match(text, /the 2015–2016 model years \(40 so far on each\)/);
  assert.match(text, /add up to 11/);
  assert.match(text, /do not drive for model year 2016/);
  assert.match(text, /park outside for model year 2015/);
  assert.match(text, /model years 2001, 2015–2016, and 2026/);
  assert.doesNotMatch(text, /fewest complaints received so far are 0/);
  assert.equal(sentenceCount(text), 3);
  assert.doesNotMatch(text, YEARS_BANNED);
});

test("a new model year is left out of the low count", () => {
  const years = [
    { y: 2025, complaints: 10, recalls: 1, hasNhtsa: true, dnd: 0, park: 0 },
    { y: 2026, complaints: 2, recalls: 0, hasNhtsa: true, dnd: 0, park: 0 },
    { y: 2027, complaints: 0, recalls: 0, hasNhtsa: true, dnd: 0, park: 0 },
  ];
  const text = yearsAnswer("Honda", "Prologue", years, dates);
  assert.match(text, /most complaints for the 2025 model year \(10 so far\)/);
  assert.match(text, /No matched model year has at least 3 years of reporting history/);
  assert.match(text, /model year 2023 and earlier/);
  assert.equal(sentenceCount(text), 3);
  assert.doesNotMatch(text, YEARS_BANNED);
});

test("caveat, caption, title, and FAQ stay visible and factual", () => {
  const years = [{ y: 2018, complaints: 12, recalls: 1, hasNhtsa: true, dnd: 0, park: 0 }];
  const caveat = yearsCaveat(dates);
  assert.match(caveat, /raw counts, not rates/);
  assert.match(caveat, /More cars sold can mean more complaints/);
  assert.match(caveat, /reporting lag/);
  assert.match(caveat, /look cleaner/);
  assert.match(caveat, /format change in 2021/);
  assert.match(caveat, /Nov 9, 2026/);
  assert.match(caveat, /Nov 4, 2026/);
  assert.match(YEARS_CAPTION, /One row per model year/);
  assert.match(YEARS_CAPTION, /not listed/);
  assert.match(yearsStarNote(years), /2011 and newer/);
  assert.match(yearsStarNote([{ y: 2004 }]), /Pre-2011 rating, not comparable/);
  assert.equal(yearsTitle("Honda", "CR-V"), "Honda CR-V complaints by year: recalls, complaints, ratings");
  assert.equal(yearsH1("Honda", "CR-V"), "Honda CR-V by model year: recalls, complaints, ratings");
  const faqs = yearsFaqs({ make: "Honda", model: "CR-V", years, dates });
  assert.equal(faqs[0].q, "Which Honda CR-V year has the most NHTSA complaints?");
  assert.match(faqs[0].a, /2018 model year \(12 so far\)/);
  assert.equal(faqs[1].q, "Does a high complaint count mean a Honda CR-V year is bad?");
  assert.equal(faqs[1].a, YEARS_FAQ_RATE);
  assert.match(faqs[1].a, /not a rate/);
  assert.doesNotMatch(faqs[1].a, YEARS_BANNED);
  assert.doesNotMatch(yearsPageText({ make: "Honda", model: "CR-V", years, dates }), YEARS_BANNED);
});

test("top models are ranked from committed complaint and recall sums", () => {
  const summary = loadSummary();
  const ranked = rankModels(summary);
  assert.equal(ranked.length > TOP_MODEL_COUNT, true);
  for (let index = 1; index < ranked.length; index += 1) {
    const prev = ranked[index - 1];
    const row = ranked[index];
    assert.equal(prev.score >= row.score, true);
    if (prev.score === row.score) assert.equal(prev.complaints >= row.complaints, true);
  }
  for (const row of ranked.slice(0, TOP_MODEL_COUNT)) {
    assert.equal(row.model.yearsPage, true);
    assert.equal(row.score, modelDemandScore(row.model).score);
  }
  const examples = resolveDemandExamples(ranked);
  const civic = examples.find((example) => example.model === "Civic");
  const f150 = examples.find((example) => example.model === "F-150");
  const silverado = examples.find((example) => example.model === "Silverado 1500");
  assert.equal(civic.via, "exact");
  assert.equal(f150.via, "published-name");
  assert.equal(f150.row.model.name, "F150");
  assert.equal(silverado.via, "published-name");
  assert.equal(silverado.row.model.name, "Silverado");
  const qa = qaModels(summary);
  assert.deepEqual(
    qa.slice(0, TOP_MODEL_COUNT).map((row) => `${row.make.slug}/${row.model.slug}`),
    ranked.slice(0, TOP_MODEL_COUNT).map((row) => `${row.make.slug}/${row.model.slug}`),
  );
  for (const example of examples) {
    assert.ok(example.row, `${example.make} ${example.model} was not resolved`);
    assert.ok(
      qa.some((row) => row.make.slug === example.row.make.slug && row.model.slug === example.row.model.slug),
      `${example.make} ${example.model} is missing from the QA set`,
    );
  }
});

test("QA model answer boxes match a fresh recompute and avoid verdict words", () => {
  const summary = loadSummary();
  const metaDates = loadMeta().dates;
  const complaintDate = formatDate(metaDates.complaints);
  const recallDate = formatDate(metaDates.recalls);
  for (const row of qaModels(summary)) {
    const facts = yearsFacts(row.model.years, metaDates);
    const text = yearsAnswer(row.make.name, row.model.name, row.model.years, metaDates);
    const again = recompute(row.model.years, metaDates.complaints);
    assert.equal(facts.most.count, again.mostCount);
    assert.deepEqual(facts.most.years, again.mostYears);
    if (again.fewest) {
      assert.equal(facts.fewest.count, again.fewest.count);
      assert.deepEqual(facts.fewest.years, again.fewest.years);
      assert.match(text, new RegExp(`fewest complaints received so far are ${formatNumber(again.fewest.count).replaceAll(",", "\\,")}`));
    } else {
      assert.equal(facts.fewest, null);
      assert.match(text, /No matched model year has at least 3 years of reporting history/);
    }
    assert.equal(facts.recalls.total, again.total);
    assert.deepEqual(facts.dndYears, again.dnd);
    assert.deepEqual(facts.parkYears, again.park);
    const mostLabel = formatNumber(again.mostCount).replaceAll(",", "\\,");
    assert.match(text, new RegExp(`${mostLabel} so far`));
    assert.match(text, new RegExp(`add up to ${formatNumber(again.total).replaceAll(",", "\\,")}`));
    assert.match(text, new RegExp(complaintDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, new RegExp(recallDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(sentenceCount(text) <= 3, true, text);
    const page = yearsPageText({
      make: row.make.name,
      model: row.model.name,
      years: row.model.years,
      dates: metaDates,
    });
    assert.equal(YEARS_BANNED.test(page), false, `${row.make.name} ${row.model.name}`);
  }
});

test("every years page copy stays inside three sentences and the banned-word list", () => {
  const summary = loadSummary();
  const metaDates = loadMeta().dates;
  let pages = 0;
  for (const make of summary.makes) {
    for (const model of make.models) {
      if (!model.yearsPage) continue;
      pages += 1;
      const text = yearsAnswer(make.name, model.name, model.years, metaDates);
      assert.equal(sentenceCount(text) <= 3, true, `${make.name} ${model.name}: ${text}`);
      const page = yearsPageText({ make: make.name, model: model.name, years: model.years, dates: metaDates });
      assert.equal(YEARS_BANNED.test(page), false, `${make.name} ${model.name}`);
      assert.match(page, /raw counts, not rates/);
      assert.match(page, /format change in 2021/);
      assert.match(page, /One row per model year/);
    }
  }
  assert.equal(pages > 0, true);
});

test("component links on QA models are count pages without complaint narratives", () => {
  const summary = loadSummary();
  let links = 0;
  for (const row of qaModels(summary)) {
    for (const group of componentGroupsFor(row.make.slug, row.model.slug)) {
      for (const link of group.links) {
        assert.equal(link.path, `/${row.make.slug}/${row.model.slug}/${group.year}/${link.path.split("/").filter(Boolean).at(-1)}/`);
        assert.deepEqual(Object.keys(link).sort(), ["component", "n", "path"]);
        assert.equal(typeof link.component, "string");
        links += 1;
      }
    }
  }
  assert.equal(links > 0, true);
});
