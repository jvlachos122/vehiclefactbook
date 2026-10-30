import assert from "node:assert/strict";
import test from "node:test";
import { homeAnswer, mmyAnswer, pre2011RatingSentence, variantLabel, yearsAnswer } from "../src/lib/answer.js";

function sentenceCount(text) {
  return text.split(/(?<=[.?!])\s+/).filter((sentence) => sentence.trim()).length;
}

const dates = { recalls: "2026-10-23", complaints: "2026-10-23", epa: "2026-09-29", investigations: "2026-10-23" };

test("variant label drops year make and model", () => {
  assert.equal(variantLabel("2018 Honda Accord 4 DR FWD", 2018, "Honda", "Accord"), "4 DR FWD");
});

test("exact model year answer uses the headline counts", () => {
  const text = mmyAnswer({
    make: "Honda",
    model: "Accord",
    year: 2018,
    dates,
    row: {
      match: "exact",
      recalls: 6,
      complaints: 1893,
      dnd: 0,
      park: 0,
      investigations: 2,
      invOpen: 0,
      alsoRecalls: 1,
      alsoComplaints: 116,
      mpgMin: 26,
      mpgMax: 47,
      mpgeMin: null,
      mpgeMax: null,
      kwhMin: null,
      kwhMax: null,
      costMin: 1450,
      costMax: 2600,
    },
    detail: {
      splitNames: false,
      also: [{ name: "Accord Hybrid" }],
      complaints: { top: [{ component: "ELECTRICAL SYSTEM", n: 400 }] },
      ncap: [{ description: "2018 Honda Accord 4 DR FWD", overall: "5" }],
    },
  });
  assert.match(text, /6 recalls and 1,893 complaints for the 2018 Honda Accord/);
  assert.match(text, /116 complaints under Accord Hybrid/);
  assert.match(text, /4 DR FWD 5 stars overall/);
  assert.match(text, /26–47 mpg combined/);
  assert.match(text, /Sep 29, 2026/);
  assert.ok(sentenceCount(text) <= 3);
  assert.doesNotMatch(text, /\b(avoid|reliable|unreliable|best|worst)\b/i);
});

test("unmatched model year says the name did not match", () => {
  const text = mmyAnswer({
    make: "Porsche",
    model: "Carrera 2 Coupe",
    year: 2003,
    dates,
    row: {
      match: "none",
      recalls: 0,
      complaints: 0,
      dnd: 0,
      park: 0,
      investigations: 0,
      invOpen: 0,
      mpgMin: 15,
      mpgMax: 15,
      costMin: 3200,
      costMax: 3200,
    },
    detail: { ncap: [], complaints: { top: [] } },
  });
  assert.match(text, /do not have a make and model name matched/);
  assert.match(text, /15 mpg combined/);
  assert.ok(sentenceCount(text) <= 3);
  assert.doesNotMatch(text, /\bavoid\b/i);
});

test("home answer uses the file counts", () => {
  const text = homeAnswer(
    {
      epaRowsMy2000: 32430,
      rawMakes: 87,
      rawModels: 1025,
      mmySpine: 8158,
      publishedMakes: 86,
      publishedModels: 1016,
      vehicleCampaignsPost2010: 13712,
      vehicleCampaignsPre2010: 12721,
      complaintVehicleOdino: 1608391,
    },
    dates,
  );
  assert.match(text, /13,712 vehicle campaigns/);
  assert.match(text, /8,158 model years/);
  assert.match(text, /1,608,391 distinct vehicle complaints/);
  assert.match(text, /Mini and MINI/);
  assert.equal(sentenceCount(text), 3);
  assert.doesNotMatch(text, /\b(avoid|reliable|best|worst)\b/i);
});

test("pre-2011 answer says the rating is not comparable", () => {
  const text = mmyAnswer({
    make: "Honda",
    model: "Civic",
    year: 2008,
    dates,
    row: {
      match: "exact",
      recalls: 2,
      complaints: 40,
      dnd: 0,
      park: 0,
      investigations: 0,
      invOpen: 0,
      mpgMin: 25,
      mpgMax: 36,
      costMin: 1800,
      costMax: 2500,
    },
    detail: { ncap: [{ description: "2008 Honda Civic", overall: "5" }], complaints: { top: [] } },
  });
  assert.equal(text.includes(pre2011RatingSentence()), true);
  assert.match(text, /pre-2011 rating, not comparable/);
  assert.doesNotMatch(text, /5 stars overall/);
});

test("years answer names the high and low counts as facts", () => {
  const text = yearsAnswer(
    "Honda",
    "Civic",
    [
      { y: 2016, complaints: 1000, hasNhtsa: true },
      { y: 2026, complaints: 4, hasNhtsa: true },
    ],
    dates,
  );
  assert.match(text, /4 \(2026\) to 1,000 \(2016\)/);
  assert.match(text, /not rates/);
  assert.equal(sentenceCount(text), 3);
  assert.doesNotMatch(text, /\b(avoid|best|worst|reliable)\b/i);
});
