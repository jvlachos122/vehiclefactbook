import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeAnswer } from "../src/lib/answer.js";
import { loadMeta, loadSummary } from "../src/lib/catalog.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  FLAG_CAVEAT,
  MAKE_RECALL_CAP,
  buildCampaigns,
  campaignFacts,
  formatYearList,
  loadMakeCampaigns,
  sortCampaigns,
} from "../src/lib/make-recalls.js";

const FORBIDDEN_KEYS = new Set([
  "vin",
  "vins",
  "city",
  "cities",
  "dealer",
  "phone",
  "operator",
  "narrative",
  "odino",
  "complaint",
  "complaints",
  "owner",
  "firstname",
  "lastname",
  "address",
]);

function assertNoPii(value, path = "campaign") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPii(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN_KEYS.has(key.toLowerCase()), false, `${path}.${key}`);
    assertNoPii(child, `${path}.${key}`);
  }
}

function recallsOnYear(row) {
  const list = [...(row?.recalls || [])];
  for (const group of row?.also || []) list.push(...(group?.recalls || []));
  return list;
}

function offlineCampaigns(make) {
  const byCamp = new Map();
  for (const model of make.models) {
    const doc = JSON.parse(readFileSync(join("data/site/models", make.slug, `${model.slug}.json`), "utf8"));
    for (const [year, row] of Object.entries(doc.years || {})) {
      for (const recall of recallsOnYear(row)) {
        const camp = String(recall?.camp || "").trim();
        if (!camp) continue;
        let item = byCamp.get(camp);
        if (!item) {
          item = {
            camp,
            date: "",
            dnd: false,
            park: false,
            summaries: new Set(),
            components: new Set(),
            models: new Map(),
          };
          byCamp.set(camp, item);
        }
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(recall.date || "")) ? recall.date : "";
        if (date && (!item.date || date < item.date)) item.date = date;
        if (recall.dnd === true) item.dnd = true;
        if (recall.park === true) item.park = true;
        if (recall.summary) item.summaries.add(String(recall.summary).trim());
        if (recall.component) item.components.add(String(recall.component).trim());
        if (!item.models.has(model.slug)) item.models.set(model.slug, new Set());
        item.models.get(model.slug).add(Number(year));
      }
    }
  }
  return byCamp;
}

test("year lists collapse consecutive model years", () => {
  assert.equal(formatYearList([2011, 2010, 2013, 2014, 2015, 2011]), "2010–2011, 2013–2015");
  assert.equal(formatYearList([2001, 2003]), "2001, 2003");
  assert.equal(formatYearList([]), "");
});

test("campaign sort is newest report date first", () => {
  const sorted = sortCampaigns([
    { camp: "10V000001", date: "2010-01-01" },
    { camp: "24V000002", date: "2024-05-01" },
    { camp: "24V000009", date: "2024-05-01" },
    { camp: "99V000001", date: "" },
  ]);
  assert.deepEqual(
    sorted.map((campaign) => campaign.camp),
    ["24V000009", "24V000002", "10V000001", "99V000001"],
  );
});

test("campaign records keep recall fields and drop complaint and VIN fields", () => {
  const campaigns = buildCampaigns([
    {
      year: 2019,
      model: { slug: "civic", name: "Civic" },
      recall: {
        camp: "19V100000",
        date: "2019-06-01",
        component: "AIR BAGS",
        summary: "Short.",
        dnd: false,
        park: true,
        vin: "1HGCM82633A004352",
        city: "Toledo",
        dealer: "Main Street Motors",
        phone: "555-0100",
        operator: "A. Driver",
        narrative: "The owner said the car stalled.",
        odino: "998877",
        complaint: "stalled",
      },
    },
    {
      year: 2018,
      model: { slug: "accord", name: "Accord" },
      recall: {
        camp: "19V100000",
        date: "2019-04-02",
        component: "SEAT BELTS: FRONT",
        summary: "A longer summary from the same campaign.",
        dnd: true,
        park: false,
      },
    },
    {
      year: 2020,
      model: { slug: "civic", name: "Civic" },
      recall: { camp: "20V200000", date: "2020-01-08", component: "BRAKES", summary: "Brakes.", dnd: false, park: false },
    },
  ]);
  assert.deepEqual(
    campaigns.map((campaign) => campaign.camp),
    ["20V200000", "19V100000"],
  );
  const merged = campaigns[1];
  assert.equal(merged.date, "2019-04-02");
  assert.equal(merged.dnd, true);
  assert.equal(merged.park, true);
  assert.equal(merged.summary, "A longer summary from the same campaign.");
  assert.equal(merged.component, "SEAT BELTS: FRONT");
  assert.deepEqual(merged.models, [
    { slug: "accord", name: "Accord", years: [2018] },
    { slug: "civic", name: "Civic", years: [2019] },
  ]);
  assert.deepEqual(Object.keys(merged).sort(), ["camp", "component", "date", "dnd", "models", "park", "summary"]);
  const packed = JSON.stringify(campaigns);
  for (const secret of ["1HGCM82633A004352", "Toledo", "Main Street Motors", "555-0100", "998877", "stalled"]) {
    assert.equal(packed.includes(secret), false, secret);
  }
  assertNoPii(campaigns);
});

test("flag caveat names the May 2025 file change", () => {
  assert.match(FLAG_CAVEAT, /May 2025/);
  assert.match(FLAG_CAVEAT, /flag not present in older NHTSA records/);
  assert.equal(MAKE_RECALL_CAP, 25);
});

for (const slug of ["ford", "honda", "toyota"]) {
  test(`${slug} campaigns match an offline count and stay newest first`, () => {
    const make = loadSummary().makes.find((item) => item.slug === slug);
    const campaigns = loadMakeCampaigns(make);
    const offline = offlineCampaigns(make);
    assert.equal(campaigns.length, offline.size);
    const ordered = [...offline.values()].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.camp !== b.camp) return a.camp < b.camp ? 1 : -1;
      return 0;
    });
    assert.deepEqual(
      campaigns.map((campaign) => campaign.camp),
      ordered.map((campaign) => campaign.camp),
    );
    for (let index = 1; index < campaigns.length; index += 1) {
      const prev = campaigns[index - 1];
      const curr = campaigns[index];
      if (prev.date === curr.date) assert.ok(prev.camp >= curr.camp);
      else assert.ok(prev.date > curr.date);
    }
    for (const campaign of campaigns) {
      const source = offline.get(campaign.camp);
      assert.equal(campaign.date, source.date);
      assert.equal(campaign.dnd, source.dnd);
      assert.equal(campaign.park, source.park);
      assert.ok(source.summaries.has(campaign.summary) || campaign.summary === "");
      assert.equal(source.components.has(campaign.component) || campaign.component === "", true);
      assert.equal(campaign.models.length, source.models.size);
      for (const model of campaign.models) {
        assert.deepEqual(model.years, [...source.models.get(model.slug)].sort((a, b) => a - b));
      }
      assert.deepEqual(Object.keys(campaign).sort(), ["camp", "component", "date", "dnd", "models", "park", "summary"]);
      assertNoPii(campaign);
    }
    const facts = campaignFacts(campaigns);
    assert.equal(facts.total, campaigns.length);
    assert.equal(facts.dnd, campaigns.filter((campaign) => campaign.dnd).length);
    assert.equal(facts.park, campaigns.filter((campaign) => campaign.park).length);
    assert.equal(facts.dnd, [...offline.values()].filter((campaign) => campaign.dnd).length);
    assert.equal(facts.park, [...offline.values()].filter((campaign) => campaign.park).length);
    if (facts.minDate) assert.equal(facts.minDate, campaigns[campaigns.length - 1].date);
    if (facts.maxDate) assert.equal(facts.maxDate, campaigns[0].date);
    const totals = {
      models: make.models.length,
      recalls: 0,
      complaints: 0,
    };
    for (const model of make.models) {
      for (const year of model.years) {
        totals.recalls += year.recalls || 0;
        totals.complaints += year.complaints || 0;
      }
    }
    const text = makeAnswer(make.name, make.models, loadMeta().dates, facts);
    const counted = (value, singular) => `${value.toLocaleString("en-US")} ${value === 1 ? singular : `${singular}s`}`;
    assert.ok(text.includes(`${counted(facts.total, "vehicle campaign")} matched to ${make.name}`));
    assert.ok(text.includes(`${counted(facts.dnd, "campaign")} marked do not drive`));
    assert.ok(text.includes(`${counted(facts.park, "campaign")} marked park outside`));
    assert.ok(text.includes("recall file dated"));
    assert.ok(sentenceCount(text) <= 3);
    assert.doesNotMatch(text, /\b(avoid|reliable|unreliable|best|worst)\b/i);
    assert.ok(totals.recalls >= 0);
  });
}
