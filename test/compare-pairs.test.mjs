import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { loadMeta } from "../src/lib/catalog.js";
import { formatDate } from "../src/lib/format.js";
import {
  BANNED_PAIR_WORDS,
  EXAMPLE_PAIR_LIMIT,
  EXAMPLE_PAIRS_PER_CLASS,
  classFamily,
  exampleIndexCaption,
  exampleIndexIntro,
  fuelAndStars,
  loadExamplePairs,
  modalClass,
  pairDocument,
  pairSlug,
  selectExamplePairs,
} from "../src/lib/compare-pairs.js";

const root = join(import.meta.dirname, "..");

function rec(makeSlug, modelSlug, configCount, makeHub, anchor) {
  return {
    makeSlug,
    makeName: makeSlug,
    modelSlug,
    modelName: modelSlug,
    configCount,
    makeHub,
    anchor: anchor ? { match: "exact", splitNames: false, headlineExact: true, recalls: 0, complaints: 0, alsoRecalls: 0, alsoComplaints: 0, ...anchor } : null,
  };
}

test("class family drops a trailing drive label", () => {
  assert.equal(classFamily("Compact Cars"), "Compact Cars");
  assert.equal(classFamily("Sport Utility Vehicle - 2WD"), "Sport Utility Vehicle");
  assert.equal(classFamily("Sport Utility Vehicle - 4WD"), "Sport Utility Vehicle");
  assert.equal(classFamily("Standard Pickup Trucks 4WD"), "Standard Pickup Trucks");
  assert.equal(classFamily("Small Sport Utility Vehicle 2WD"), "Small Sport Utility Vehicle");
});

test("modal class uses the most common family and breaks ties alphabetically", () => {
  assert.equal(
    modalClass([
      { vclass: "Small Sport Utility Vehicle 4WD" },
      { vclass: "Small Sport Utility Vehicle 2WD" },
      { vclass: "Standard Sport Utility Vehicle 4WD" },
    ]).family,
    "Small Sport Utility Vehicle",
  );
  assert.equal(
    modalClass([
      { vclass: "Midsize Cars" },
      { vclass: "Compact Cars" },
    ]).family,
    "Compact Cars",
  );
  assert.equal(modalClass([]), null);
});

test("selection keeps the highest configuration sums inside the caps", () => {
  const records = [
    rec("chevy", "silverado", 50, 10, { y: 2026, classFamily: "Pickup" }),
    rec("gmc", "sierra", 40, 8, { y: 2026, classFamily: "Pickup" }),
    rec("ford", "f150", 30, 9, { y: 2026, classFamily: "Pickup" }),
    rec("ram", "1500", 20, 4, { y: 2026, classFamily: "Pickup" }),
    rec("honda", "civic", 15, 7, { y: 2026, classFamily: "Car" }),
    rec("toyota", "camry", 14, 12, { y: 2026, classFamily: "Car" }),
    rec("honda", "accord", 13, 7, { y: 2026, classFamily: "Car" }),
    rec("mazda", "3", 12, 3, { y: 2026, classFamily: "Car" }),
    rec("old", "left", 100, 100, { y: 2008, classFamily: "Car" }),
    rec("older", "right", 100, 100, { y: 2009, classFamily: "Car" }),
    rec("blank", "car", 100, 100, { y: 2026, classFamily: "Car", match: "none" }),
  ];
  const capped = selectExamplePairs(records, { limit: 10, perClass: 1, perModel: 1 });
  assert.deepEqual(
    capped.map((pair) => pair.slug),
    selectExamplePairs(records, { limit: 10, perClass: 1, perModel: 1 }).map((pair) => pair.slug),
  );
  assert.deepEqual(capped.map((pair) => pair.slug), ["chevy-silverado-vs-gmc-sierra", "honda-civic-vs-toyota-camry"]);
  const wider = selectExamplePairs(records, { limit: 10, perClass: 2, perModel: 1 });
  assert.deepEqual(wider.map((pair) => pair.slug), [
    "chevy-silverado-vs-gmc-sierra",
    "ford-f150-vs-ram-1500",
    "honda-civic-vs-toyota-camry",
    "honda-accord-vs-mazda-3",
  ]);
  for (const pair of wider) {
    assert.notEqual(pair.left.makeSlug, pair.right.makeSlug);
    assert.equal(pair.left.classFamily, pair.right.classFamily);
    assert.equal(pair.year, pair.left.y);
    assert.equal(pair.slug, pairSlug(pair.left, pair.right));
    assert.notEqual(pair.left.match, "none");
  }
  const tied = selectExamplePairs(
    [
      rec("a", "one", 10, 1, { y: 2024, classFamily: "Large Cars" }),
      rec("b", "two", 10, 5, { y: 2024, classFamily: "Large Cars" }),
      rec("c", "three", 10, 4, { y: 2024, classFamily: "Large Cars" }),
    ],
    { limit: 1, perClass: 4, perModel: 1 },
  );
  assert.equal(tied[0].slug, "b-two-vs-c-three");
});

test("published pairs follow the rule and two samples match the source files", () => {
  const pairs = loadExamplePairs();
  const meta = loadMeta();
  const summary = JSON.parse(readFileSync(join(root, "data/site/summary.json"), "utf8"));
  assert.equal(pairs.length, EXAMPLE_PAIR_LIMIT);
  const modelUse = new Map();
  const classUse = new Map();
  const slugs = new Set();
  for (const pair of pairs) {
    assert.equal(pair.left.classFamily, pair.classFamily);
    assert.equal(pair.right.classFamily, pair.classFamily);
    assert.equal(pair.left.y, pair.year);
    assert.equal(pair.right.y, pair.year);
    assert.notEqual(pair.left.makeSlug, pair.right.makeSlug);
    assert.notEqual(pair.left.match, "none");
    assert.notEqual(pair.right.match, "none");
    assert.equal(pair.slug, pairSlug(pair.left, pair.right));
    assert.equal(slugs.has(pair.slug), false);
    slugs.add(pair.slug);
    for (const side of [pair.left, pair.right]) {
      const key = `${side.makeSlug}/${side.modelSlug}`;
      assert.equal(modelUse.has(key), false);
      modelUse.set(key, true);
    }
    classUse.set(pair.classFamily, (classUse.get(pair.classFamily) || 0) + 1);
    const fetched = meta.ncap?.[String(pair.year)]?.fetchedAt || "";
    const doc = pairDocument(pair, { dates: meta.dates, ncapFetched: fetched });
    assert.ok(sentenceCount(doc.answer) >= 1 && sentenceCount(doc.answer) <= 3, doc.answer);
    assert.match(doc.answer, /fuel economy file dated/);
    assert.match(doc.answer, /Safety Ratings API|pre-2011 rating/);
    const copy = JSON.stringify(doc);
    assert.doesNotMatch(copy, BANNED_PAIR_WORDS, pair.slug);
    assert.doesNotMatch(copy, /\bVIN\b/);
    assert.equal(copy.includes('"camp"'), false);
    assert.equal(copy.includes("odino"), false);
    for (const side of [pair.left, pair.right]) {
      for (const key of Object.keys(side)) {
        assert.notEqual(["vin", "city", "dealer", "phone", "operator", "narrative", "odino", "summary", "top", "complaintsText"].includes(key), true);
      }
    }
  }
  for (const count of classUse.values()) assert.ok(count <= EXAMPLE_PAIRS_PER_CLASS);
  assert.doesNotMatch(exampleIndexIntro(pairs.length), BANNED_PAIR_WORDS);
  assert.doesNotMatch(exampleIndexCaption(), BANNED_PAIR_WORDS);
  assert.match(exampleIndexIntro(pairs.length), new RegExp(`lists ${pairs.length} pairs`));

  for (const slug of ["chevrolet-silverado-vs-gmc-sierra", "honda-civic-vs-toyota-camry"]) {
    const pair = pairs.find((item) => item.slug === slug);
    assert.ok(pair, slug);
    const doc = pairDocument(pair, {
      dates: meta.dates,
      ncapFetched: meta.ncap[String(pair.year)].fetchedAt,
    });
    assert.match(doc.answer, new RegExp(formatDate(meta.dates.epa).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(doc.caveat, /received so far/);
    assert.match(doc.caveat, /More complaints can mean more cars sold/);
    assert.match(doc.tableCaption, /received so far/);
    for (const side of [pair.left, pair.right]) {
      const make = summary.makes.find((item) => item.slug === side.makeSlug);
      const model = make.models.find((item) => item.slug === side.modelSlug);
      const row = model.years.find((item) => item.y === pair.year);
      const detail = JSON.parse(readFileSync(join(root, "data/site/models", side.makeSlug, `${side.modelSlug}.json`), "utf8")).years[String(pair.year)];
      assert.equal(side.recalls, row.recalls);
      assert.equal(side.complaints, row.complaints);
      assert.equal(side.complaints, complaintCount(detail));
      assert.equal(side.recalls, recallCount(detail));
      assert.equal(side.mpgMin, row.mpgMin);
      assert.equal(side.mpgMax, row.mpgMax);
      assert.equal(side.kwhMin, row.kwhMin);
      assert.equal(side.kwhMax, row.kwhMax);
      assert.equal(side.costMin, row.costMin);
      assert.equal(side.costMax, row.costMax);
      assert.equal(side.rangeMax, row.rangeMax);
      assert.equal(side.starMin, row.starMin);
      assert.equal(side.starMax, row.starMax);
      assert.equal(side.evOnly, row.evOnly);
      const figures = directFigures(detail.configs);
      assert.equal(side.cityMin, figures.cityMin);
      assert.equal(side.cityMax, figures.cityMax);
      assert.equal(side.hwyMin, figures.hwyMin);
      assert.equal(side.hwyMax, figures.hwyMax);
      assert.equal(side.rangeMin, figures.rangeMin);
      const again = fuelAndStars(detail.configs, detail.ncap);
      assert.equal(side.mpgMin, again.mpgMin);
      assert.equal(side.cityMin, again.cityMin);
      assert.equal(side.starMin, again.starMin);
      if (side.mpgMin != null) assert.match(doc.answer, new RegExp(String(side.mpgMin)));
      if (side.kwhMin != null) assert.match(doc.answer, /kWh\/100 mi/);
      const rowText = doc.rows.find((item) => item.label === "Complaints received so far");
      const shown = side === pair.left ? rowText.left : rowText.right;
      assert.equal(shown, side.complaints.toLocaleString("en-US"));
    }
  }
});

function complaintCount(detail) {
  if (detail.splitNames) {
    return (detail.also || []).reduce((sum, item) => sum + (item.complaints?.n || 0), 0);
  }
  return detail.complaints?.n || 0;
}

function recallCount(detail) {
  const camps = new Set();
  const groups = detail.splitNames ? detail.also || [] : [{ recalls: detail.recalls || [] }];
  for (const group of groups) {
    for (const recall of group.recalls || []) {
      if (recall.camp) camps.add(recall.camp);
    }
  }
  return camps.size;
}

function directFigures(configs) {
  const city = [];
  const hwy = [];
  const range = [];
  for (const config of configs || []) {
    if (config.atv !== "EV" && config.cityMpg) city.push(Number(config.cityMpg));
    if (config.atv !== "EV" && config.hwy) hwy.push(Number(config.hwy));
    if (config.range) range.push(Number(config.range));
  }
  const end = (values) => (values.length ? [Math.min(...values), Math.max(...values)] : [null, null]);
  const [cityMin, cityMax] = end(city);
  const [hwyMin, hwyMax] = end(hwy);
  const [rangeMin] = end(range);
  return { cityMin, cityMax, hwyMin, hwyMax, rangeMin };
}
