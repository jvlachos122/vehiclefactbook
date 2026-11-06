import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BANNED_PAIR_WORDS } from "../src/lib/compare-pairs.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { loadMeta } from "../src/lib/catalog.js";
import { formatDate } from "../src/lib/format.js";
import { formatDollars } from "../src/lib/fuel-cost.js";
import {
  HYBRID_MIN_YEAR,
  HYBRID_PAIR_LIMIT,
  eiaAnnualCost,
  eiaForPair,
  familyStem,
  figuresFrom,
  hybridAnswer,
  hybridDocument,
  hybridIndexAnswer,
  hybridIndexCaption,
  hybridIndexIntro,
  hybridIndexTeaser,
  isConventionalGas,
  loadEiaRetail,
  loadHybridPairs,
  powertrainKind,
  readEiaRetail,
  selectHybridPairs,
} from "../src/lib/hybrid-pairs.js";

const root = join(import.meta.dirname, "..");

function entry(meta, config) {
  return { meta, config };
}

function meta(modelSlug, extra = {}) {
  return {
    makeSlug: "toyota",
    makeName: "Toyota",
    modelSlug,
    modelName: modelSlug,
    match: "exact",
    complaints: 3,
    recalls: 1,
    alsoComplaints: 0,
    ...extra,
  };
}

test("family stem keeps a hybrid suffix with its base model", () => {
  const norms = new Set(["RAV4", "PRIUS", "CAMRY"]);
  assert.equal(familyStem("RAV4PRIME", norms), "RAV4");
  assert.equal(familyStem("PRIUSPRIME", norms), "PRIUS");
  assert.equal(familyStem("CAMRYHYBRID", norms), "CAMRY");
  assert.equal(familyStem("RAV4", norms), "RAV4");
  assert.equal(familyStem("ACTIVEHYBRIDX6", norms), "ACTIVEHYBRIDX6");
  assert.equal(isConventionalGas({ atv: "", fuel: "Regular Gasoline" }), true);
  assert.equal(isConventionalGas({ atv: "FFV", fuel: "Regular Gasoline" }), false);
  assert.equal(isConventionalGas({ atv: "Hybrid", fuel: "Regular Gasoline" }), false);
  assert.equal(powertrainKind({ atv: "Plug-in Hybrid" }), "plug-in-hybrid");
});

test("hybrid selection uses the newest overlap and the configuration-row order", () => {
  const families = [
    {
      makeSlug: "toyota",
      makeName: "Toyota",
      modelSlug: "rav4",
      modelName: "RAV4",
      configCount: 20,
      years: [
        {
          y: 2019,
          gas: [entry(meta("rav4"), { fuel: "Regular Gasoline", atv: "", comb: 25, cityMpg: 22, hwy: 29, cost: 2000 })],
          hybrid: [entry(meta("rav4"), { fuel: "Regular Gasoline", atv: "Hybrid", comb: 40, cityMpg: 41, hwy: 38, cost: 1500 })],
          phev: [],
        },
        {
          y: 2025,
          gas: [entry(meta("rav4"), { fuel: "Regular Gasoline", atv: "", comb: 30, cityMpg: 27, hwy: 35, cost: 2250, vclass: "Small Sport Utility Vehicle 4WD" })],
          hybrid: [entry(meta("rav4"), { fuel: "Regular Gasoline", atv: "Hybrid", comb: 39, cityMpg: 41, hwy: 38, cost: 1700, vclass: "Small Sport Utility Vehicle 4WD" })],
          phev: [entry(meta("rav4-prime", { modelName: "RAV4 Prime" }), { fuel: "Regular Gasoline", atv: "Plug-in Hybrid", comb: 38, cityMpg: 40, hwy: 36, cost: 1750, kwh: 36, vclass: "Small Sport Utility Vehicle 4WD" })],
        },
      ],
    },
    {
      makeSlug: "honda",
      makeName: "Honda",
      modelSlug: "cr-v",
      modelName: "CR-V",
      configCount: 50,
      years: [
        {
          y: 2026,
          gas: [entry(meta("cr-v", { makeSlug: "honda", makeName: "Honda" }), { fuel: "Regular Gasoline", atv: "", comb: 30, cityMpg: 28, hwy: 33, cost: 2250 })],
          hybrid: [entry(meta("cr-v", { makeSlug: "honda", makeName: "Honda" }), { fuel: "Regular Gasoline", atv: "Hybrid", comb: 40, cityMpg: 43, hwy: 36, cost: 1700 })],
          phev: [],
        },
      ],
    },
  ];
  const pairs = selectHybridPairs(families, { limit: 10, minYear: HYBRID_MIN_YEAR });
  assert.deepEqual(
    pairs.map((pair) => pair.slug),
    ["honda-cr-v-hybrid-vs-gasoline", "toyota-rav4-hybrid-vs-gasoline", "toyota-rav4-plug-in-hybrid-vs-gasoline"],
  );
  assert.equal(pairs[1].year, 2025);
  assert.equal(pairs[1].gas.mpgMin, 30);
  assert.equal(pairs[1].hybrid.costMin, 1700);
  assert.equal(pairs[2].hybrid.kwhMin, 36);
  assert.equal(pairs[2].hybrid.modelSlug, "rav4-prime");
  const oldOnly = selectHybridPairs(
    [
      {
        makeSlug: "chevrolet",
        makeName: "Chevrolet",
        modelSlug: "malibu",
        modelName: "Malibu",
        configCount: 100,
        years: [
          {
            y: 2019,
            gas: [entry(meta("malibu"), { fuel: "Regular Gasoline", atv: "", comb: 25, cost: 2000, cityMpg: 22, hwy: 30 })],
            hybrid: [entry(meta("malibu"), { fuel: "Regular Gasoline", atv: "Hybrid", comb: 45, cost: 1200, cityMpg: 40, hwy: 42 })],
            phev: [],
          },
        ],
      },
    ],
    { limit: 5, minYear: HYBRID_MIN_YEAR },
  );
  assert.equal(oldOnly.length, 0);
  const mild = selectHybridPairs(
    [
      {
        makeSlug: "bmw",
        makeName: "BMW",
        modelSlug: "3-series",
        modelName: "3 Series",
        configCount: 400,
        years: [
          {
            y: 2024,
            gas: [entry(meta("3-series"), { fuel: "Premium Gasoline", atv: "", comb: 29, cityMpg: 25, hwy: 34, cost: 2850 })],
            hybrid: [entry(meta("3-series"), { fuel: "Premium Gasoline", atv: "Hybrid", comb: 26, cityMpg: 23, hwy: 31, cost: 3150 })],
            phev: [],
          },
        ],
      },
    ],
    { limit: 5, minYear: HYBRID_MIN_YEAR },
  );
  assert.equal(mild.length, 0);
});

test("published hybrid pairs match EPA rows and avoid ranking words", () => {
  const pairs = loadHybridPairs();
  const metaFile = loadMeta();
  const retail = loadEiaRetail();
  assert.equal(pairs.length, HYBRID_PAIR_LIMIT);
  assert.ok(pairs.length >= 20 && pairs.length <= 40);
  const slugs = new Set();
  for (const pair of pairs) {
    assert.equal(slugs.has(pair.slug), false);
    slugs.add(pair.slug);
    assert.ok(pair.year >= HYBRID_MIN_YEAR);
    assert.equal(pair.gas.makeSlug, pair.makeSlug);
    assert.notEqual(pair.gas.mpgMin, null);
    assert.notEqual(pair.hybrid.costMin, null);
    assert.ok(pair.kind === "hybrid" || pair.kind === "plug-in-hybrid");
    const doc = hybridDocument(pair, { dates: metaFile.dates, eia: eiaForPair(pair, retail) });
    assert.ok(sentenceCount(doc.answer) >= 1 && sentenceCount(doc.answer) <= 3, doc.answer);
    assert.match(doc.answer, /EPA rates/);
    assert.match(doc.answer, /annual fuel cost/);
    assert.match(doc.answer, new RegExp(formatDate(metaFile.dates.epa).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const copy = JSON.stringify(doc);
    assert.doesNotMatch(copy, BANNED_PAIR_WORDS, pair.slug);
    assert.doesNotMatch(copy, /\bVIN\b/i);
    assert.equal(copy.includes("odino"), false);
    if (pair.gas.mpgMin != null) assert.match(doc.answer, new RegExp(String(pair.gas.mpgMin)));
    if (pair.hybrid.mpgMin != null) assert.match(doc.answer, new RegExp(String(pair.hybrid.mpgMin)));
  }
  assert.doesNotMatch(hybridIndexAnswer(pairs.length, formatDate(metaFile.dates.epa)), BANNED_PAIR_WORDS);
  assert.doesNotMatch(hybridIndexIntro(pairs.length), BANNED_PAIR_WORDS);
  assert.doesNotMatch(hybridIndexCaption(formatDate(metaFile.dates.epa)), BANNED_PAIR_WORDS);
  assert.doesNotMatch(hybridIndexTeaser(), BANNED_PAIR_WORDS);
  assert.ok(sentenceCount(hybridIndexAnswer(pairs.length, formatDate(metaFile.dates.epa))) <= 3);

  for (const slug of ["toyota-rav4-hybrid-vs-gasoline", "toyota-camry-hybrid-vs-gasoline"]) {
    const pair = pairs.find((item) => item.slug === slug);
    assert.ok(pair, slug);
    for (const side of [pair.gas, pair.hybrid]) {
      const configs = [];
      for (const source of side.sources) {
        const detail = JSON.parse(readFileSync(join(root, "data/site/models", source.makeSlug, `${source.modelSlug}.json`), "utf8")).years[String(pair.year)];
        for (const config of detail.configs) {
          const kind = powertrainKind(config);
          if (side === pair.gas && isConventionalGas(config)) configs.push(config);
          if (side === pair.hybrid && kind === pair.kind) configs.push(config);
        }
      }
      const figures = figuresFrom(configs);
      assert.equal(side.mpgMin, figures.mpgMin, slug);
      assert.equal(side.mpgMax, figures.mpgMax, slug);
      assert.equal(side.cityMin, figures.cityMin, slug);
      assert.equal(side.cityMax, figures.cityMax, slug);
      assert.equal(side.hwyMin, figures.hwyMin, slug);
      assert.equal(side.hwyMax, figures.hwyMax, slug);
      assert.equal(side.costMin, figures.costMin, slug);
      assert.equal(side.costMax, figures.costMax, slug);
      assert.equal(side.kwhMin, figures.kwhMin, slug);
      assert.equal(side.rows, figures.rows, slug);
      const summary = JSON.parse(readFileSync(join(root, "data/site/summary.json"), "utf8"));
      const make = summary.makes.find((item) => item.slug === side.makeSlug);
      const model = make.models.find((item) => item.slug === side.modelSlug);
      const row = model.years.find((item) => item.y === pair.year);
      assert.equal(side.complaints, row.complaints);
      assert.equal(side.recalls, row.recalls);
    }
    const doc = hybridDocument(pair, { dates: metaFile.dates, eia: eiaForPair(pair, retail) });
    assert.equal(doc.answer, hybridAnswer(pair, formatDate(metaFile.dates.epa)));
    if (pair.gas.fuel === "Regular Gasoline" && pair.hybrid.fuel === "Regular Gasoline") {
      const retailGas = readEiaRetail(readFileSync(join(root, "data/eia-fuel-prices.csv"), "utf8")).gasoline;
      assert.equal(retail.gasoline.usd, retailGas.usd);
      const expected = eiaAnnualCost(pair.gas.mpgMax, retailGas.usd, "Regular Gasoline");
      const shown = doc.rows.find((row) => row.label === "Calculated annual cost");
      assert.ok(shown, slug);
      assert.equal(shown.gas.includes(formatDollars(expected)), true, shown.gas);
    }
  }
});
