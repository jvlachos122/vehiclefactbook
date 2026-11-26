import assert from "node:assert/strict";
import test from "node:test";
import { loadSummary } from "../src/lib/catalog.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { MODEL_FACTS_BANNED } from "../src/lib/model-facts.js";
import { modelComparisonText } from "../src/lib/model-comparisons.js";

const PII = /\b(vins?|dealers?|narrative|cdescr|odino)\b/i;

test("comparisons use the stored highs and skip an unmatched count", () => {
  const accord = [
    { y: 2019, hasNhtsa: true, match: "exact", mpgMin: 28, mpgMax: 30, complaints: 4, recalls: 1 },
    { y: 2020, hasNhtsa: true, match: "exact", mpgMin: 30, mpgMax: 32, complaints: 9, recalls: 2 },
  ];
  const peers = [
    { slug: "accord", years: accord },
    { slug: "civic", years: [{ y: 2020, mpgMin: 30, mpgMax: 35 }] },
    { slug: "fit", years: [{ y: 2020, mpgMin: 32, mpgMax: 32 }] },
    { slug: "old", years: [{ y: 2018, hasNhtsa: false, match: "none", mpgMin: 10, mpgMax: 10, complaints: 99, recalls: 99 }] },
  ];
  const text = modelComparisonText("Honda", { name: "Accord", slug: "accord" }, accord, peers);
  assert.equal(sentenceCount(text), 3);
  assert.match(text, /The 2020 combined mpg high is 32 and the 2019 combined mpg high is 30/);
  assert.match(text, /The 2020 matched complaint count is 9 and the 2019 matched complaint count is 4/);
  assert.match(text, /Among other Honda models with a 2020 combined mpg, 1 lists a higher combined mpg high than 32, none list a lower high, and 1 lists the same high/);
  assert.doesNotMatch(text, /99|2018/);
  assert.doesNotMatch(text, MODEL_FACTS_BANNED);

  const equal = modelComparisonText(
    "Honda",
    { name: "Accord", slug: "accord" },
    [
      { y: 2019, hasNhtsa: true, match: "exact", mpgMin: 30, mpgMax: 30, complaints: 4, recalls: 1 },
      { y: 2020, hasNhtsa: true, match: "exact", mpgMin: 30, mpgMax: 30, complaints: 4, recalls: 1 },
    ],
    [],
  );
  assert.match(equal, /The 2019 and 2020 combined mpg highs are both 30/);
  assert.match(equal, /matched complaint counts are both 4/);
  assert.match(equal, /No other Honda model lists a combined mpg for 2020/);

  const unmatched = modelComparisonText(
    "Honda",
    { name: "Accord", slug: "accord" },
    [
      { y: 2018, hasNhtsa: false, match: "none", complaints: 0, recalls: 0, mpgMin: 20, mpgMax: 22 },
      { y: 2019, hasNhtsa: true, match: "exact", complaints: 3, recalls: 1, mpgMin: 21, mpgMax: 24 },
    ],
    [],
  );
  assert.match(unmatched, /2019 combined mpg high is 24/);
  assert.match(unmatched, /2018 combined mpg high is 22/);
  assert.doesNotMatch(unmatched, /complaint/);

  const none = modelComparisonText("Honda", { name: "Pilot", slug: "pilot" }, [{ y: 2020, hasNhtsa: false, match: "none" }], []);
  assert.match(none, /no year-to-year comparison/);
  assert.equal(sentenceCount(none), 1);
});

test("every model comparison stays inside three sentences and names only its own years", () => {
  const summary = loadSummary();
  for (const make of summary.makes) {
    const peers = make.models.map((model) => ({ slug: model.slug, years: model.years }));
    for (const model of make.models) {
      const text = modelComparisonText(make.name, { name: model.name, slug: model.slug }, model.years, peers);
      const count = sentenceCount(text);
      assert.ok(count >= 1 && count <= 3, `${make.slug}/${model.slug}: ${text}`);
      assert.doesNotMatch(text, MODEL_FACTS_BANNED, text);
      assert.doesNotMatch(text, PII, text);
      const years = new Set(model.years.map((year) => year.y));
      for (const match of text.matchAll(/\b(?:19|20)\d{2}\b/g)) {
        assert.equal(years.has(Number(match[0])), true, `${make.slug}/${model.slug} names ${match[0]}`);
      }
    }
  }
});
