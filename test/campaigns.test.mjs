import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CAMPAIGN_PAGE_MIN_YEAR,
  campaignAnswer,
  campaignNumberYear,
  campaignPageYear,
  campaignPath,
  campaignPaths,
  cardRecalls,
  isIndexableCampaign,
  loadIndexableCampaigns,
  mmyCampaignLinkPlan,
  primaryNameGroup,
  RECALL_CARD_CAP,
} from "../src/lib/campaigns.js";
import { loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import { formatDate, plain } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";

const BANNED = /\b(avoid|lemon|reliable|unreliable|best|worst|stay away)\b/i;
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

function normKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function headlineName(doc, row) {
  const want = doc.modelNorm || normKey(doc.model);
  const found = (row.nhtsaModels || []).find((name) => normKey(name) === want);
  return found || String(doc.model || "");
}

function walkModels() {
  const files = [];
  const root = "data/site/models";
  for (const make of readdirSync(root)) {
    const dir = join(root, make);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) files.push(join(dir, file));
    }
  }
  return files;
}

function collectFromDisk() {
  const byCamp = new Map();
  for (const file of walkModels()) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const [yearKey, row] of Object.entries(doc.years || {})) {
      const year = Number(yearKey);
      const href = `/${doc.makeSlug}/${doc.modelSlug}/${year}/`;
      const hits = [];
      for (const recall of row.recalls || []) hits.push({ recall, nhtsaName: headlineName(doc, row) });
      for (const group of row.also || []) {
        for (const recall of group.recalls || []) hits.push({ recall, nhtsaName: String(group.name || "").trim() });
      }
      for (const hit of hits) {
        const camp = String(hit.recall?.camp || "").trim();
        if (!/^[0-9A-Z]+$/.test(camp)) continue;
        let item = byCamp.get(camp);
        if (!item) {
          item = {
            camp,
            dates: new Set(),
            components: new Set(),
            summary: "",
            dnd: false,
            park: false,
            rows: new Map(),
          };
          byCamp.set(camp, item);
        }
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(hit.recall.date || "")) ? hit.recall.date : "";
        if (date) item.dates.add(date);
        const component = String(hit.recall.component || "").trim();
        if (component) item.components.add(component);
        const summary = String(hit.recall.summary || "").trim();
        if (summary.length > item.summary.length || (summary.length === item.summary.length && summary > item.summary)) {
          item.summary = summary;
        }
        if (hit.recall.dnd === true) item.dnd = true;
        if (hit.recall.park === true) item.park = true;
        let place = item.rows.get(href);
        if (!place) {
          place = { href, names: new Set(), components: new Set() };
          item.rows.set(href, place);
        }
        if (hit.nhtsaName) place.names.add(hit.nhtsaName);
        if (component) place.components.add(component);
      }
    }
  }
  return byCamp;
}

const disk = collectFromDisk();
const indexable = loadIndexableCampaigns();
const recallDate = loadMeta().dates.recalls;

function assertMatchesDisk(campaign) {
  const source = disk.get(campaign.camp);
  assert.ok(source, campaign.camp);
  assert.equal(campaign.dnd, source.dnd);
  assert.equal(campaign.park, source.park);
  assert.deepEqual(campaign.dates, [...source.dates].sort());
  assert.equal(campaign.date, campaign.dates[0] || "");
  assert.deepEqual(campaign.components, [...source.components].sort((a, b) => a.localeCompare(b)));
  assert.equal(campaign.component, campaign.components.join("; "));
  assert.equal(campaign.summary, plain(source.summary, 400));
  assert.deepEqual(
    campaign.mmy.map((row) => row.href).sort(),
    [...source.rows.keys()].sort(),
  );
  for (let index = 1; index < campaign.mmy.length; index += 1) {
    const prev = campaign.mmy[index - 1];
    const curr = campaign.mmy[index];
    const order =
      prev.make.localeCompare(curr.make) ||
      prev.model.localeCompare(curr.model) ||
      prev.year - curr.year ||
      prev.href.localeCompare(curr.href);
    assert.ok(order <= 0, `${prev.href} before ${curr.href}`);
  }
  for (const row of campaign.mmy) {
    const place = source.rows.get(row.href);
    assert.deepEqual(row.nhtsaNames, [...place.names].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(row.components, [...place.components].sort((a, b) => a.localeCompare(b)));
    assert.match(row.href, /^\/[a-z0-9-]+\/[a-z0-9-]+\/\d{4}\/$/);
  }
  assert.equal(campaign.mmy.length >= 1, true);
  assertNoPii(campaign);
  const text = campaignAnswer(campaign, recallDate);
  const sentences = sentenceCount(text);
  assert.ok(sentences >= 1 && sentences <= 3, text);
  assert.match(text, new RegExp(`NHTSA lists campaign ${campaign.camp}`));
  assert.match(text, new RegExp(formatDate(recallDate)));
  assert.doesNotMatch(text, BANNED);
  assert.equal(campaignPath(campaign.camp), `/recalls/${campaign.camp}/`);
}

test("campaign number years use the 1966 prefix pivot", () => {
  assert.equal(campaignNumberYear("66V002001"), 1966);
  assert.equal(campaignNumberYear("79V001000"), 1979);
  assert.equal(campaignNumberYear("00V001000"), 2000);
  assert.equal(campaignNumberYear("14V000000"), 2014);
  assert.equal(campaignNumberYear("15V000000"), 2015);
  assert.equal(campaignNumberYear("26V332000"), 2026);
  assert.equal(campaignPageYear("14V000000"), false);
  assert.equal(campaignPageYear("15V000000"), true);
  assert.equal(CAMPAIGN_PAGE_MIN_YEAR, 2015);
  assert.equal(isIndexableCampaign("19V000001", false), false);
  assert.equal(isIndexableCampaign("19V000001", true), true);
  assert.equal(isIndexableCampaign("14V000001", true), false);
  assert.equal(isIndexableCampaign("not-a-campaign", true), false);
});

test("campaign answer states file facts and does not give advice", () => {
  const both = campaignAnswer(
    {
      camp: "19V000001",
      dates: ["2019-04-02", "2019-06-01"],
      dnd: true,
      park: true,
      mmy: [{}, {}],
      makes: [
        { name: "Acura", slug: "acura" },
        { name: "Honda", slug: "honda" },
      ],
    },
    "2026-11-03",
  );
  assert.equal(sentenceCount(both), 3);
  assert.match(both, /NHTSA lists campaign 19V000001 on 2 model year pages for Acura and Honda/);
  assert.match(both, /recall file dated Nov 3, 2026/);
  assert.match(both, /Report dates on the matched rows run from Apr 2, 2019 to Jun 1, 2019/);
  assert.match(both, /do not drive and park outside/);
  assert.doesNotMatch(both, BANNED);

  const plainFacts = campaignAnswer(
    {
      camp: "21V058000",
      dates: ["2021-02-05"],
      dnd: false,
      park: false,
      mmy: [{}],
      makes: [{ name: "Honda", slug: "honda" }],
    },
    "2026-11-03",
  );
  assert.equal(sentenceCount(plainFacts), 2);
  assert.match(plainFacts, /1 model year page for Honda/);
  assert.match(plainFacts, /report date on the matched rows is Feb 5, 2021/);
  assert.doesNotMatch(plainFacts, /do not drive|park outside|avoid/i);
});

test("indexable campaigns are the 2015+ campaigns a model year lists", () => {
  const expected = [...disk.keys()].filter((camp) => campaignPageYear(camp)).sort();
  assert.deepEqual(
    indexable.map((campaign) => campaign.camp),
    expected,
  );
  assert.ok(expected.length > 0);
  assert.ok(expected.length < disk.size, "pre-2015 campaigns stay off the page list");
  const paths = campaignPaths().map((item) => item.params.campno);
  assert.deepEqual(paths, expected);
  const index = JSON.parse(readFileSync("data/campaign-index.json", "utf8"));
  const unlinked = Object.keys(index).find((camp) => campaignPageYear(camp) && !disk.has(camp));
  assert.ok(unlinked, "the recall index still contains a 2015+ campaign with no model year");
  assert.equal(campaignPath(unlinked), "");
  assert.equal(paths.includes(unlinked), false);
  const older = [...disk.keys()].find((camp) => !campaignPageYear(camp));
  assert.ok(older);
  assert.equal(campaignPath(older), "");
  assert.equal(paths.includes(older), false);
  for (const campaign of indexable) assertNoPii(campaign);
});

test("two sample campaigns match the stored model-year rows", () => {
  const multi = [...indexable].sort((a, b) => b.mmy.length - a.mmy.length || (a.camp < b.camp ? -1 : 1))[0];
  const flagged = indexable.find((campaign) => campaign.camp !== multi.camp && (campaign.dnd || campaign.park));
  assert.ok(multi?.mmy.length > 1, "a campaign listed on more than one model year");
  assert.ok(flagged, "a second campaign carries a do-not-drive or park-outside flag");
  assertMatchesDisk(multi);
  assertMatchesDisk(flagged);
  if (flagged.dnd) assert.match(campaignAnswer(flagged, recallDate), /do not drive/);
  if (flagged.park) assert.match(campaignAnswer(flagged, recallDate), /park outside/);
  assert.equal(multi.summary.length > 0, true);
  assert.equal(flagged.summary.length > 0, true);
});

test("every indexable campaign is linked from a model year recall section", () => {
  const covered = new Set();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const row of Object.values(doc.years || {})) {
        const plan = mmyCampaignLinkPlan(row);
        const linked = new Set([...plan.cards, ...plan.extra].map((item) => item.camp));
        assert.deepEqual(
          [...linked].sort(),
          plan.all.map((item) => item.camp),
        );
        const onYear = new Set();
        for (const recall of [...(row.recalls || []), ...(row.also || []).flatMap((group) => group.recalls || [])]) {
          const camp = String(recall?.camp || "").trim();
          if (campaignPath(camp)) onYear.add(camp);
        }
        assert.deepEqual([...linked].sort(), [...onYear].sort());
        const cards = new Set(cardRecalls(row).map((recall) => String(recall?.camp || "").trim()));
        for (const item of plan.cards) assert.equal(cards.has(item.camp), true, item.camp);
        for (const item of plan.extra) assert.equal(cards.has(item.camp), false, item.camp);
        for (const item of plan.all) {
          assert.equal(item.path, `/recalls/${item.camp}/`);
          covered.add(item.camp);
        }
      }
    }
  }
  assert.deepEqual([...covered].sort(), indexable.map((campaign) => campaign.camp));
});

test("model year pages render the campaign link plan", () => {
  const year = readFileSync("src/pages/[make]/[model]/[year]/index.astro", "utf8");
  const list = readFileSync("src/components/RecallList.astro", "utf8");
  assert.match(year, /mmyCampaignLinkPlan/);
  assert.match(year, /CampaignLinks/);
  assert.match(year, /plan\.extra/);
  assert.match(year, /RecallList/);
  assert.match(list, /campaignPath/);
  assert.match(list, /campaignUrl/);
  assert.equal(RECALL_CARD_CAP, 10);
  const sample = loadSummary().makes.find((make) => make.slug === "chevrolet");
  const doc = loadModel(sample.slug, "ss");
  const row = doc.years["2014"];
  assert.equal(row.splitNames, true);
  assert.equal(primaryNameGroup(row)?.name, [...row.also].sort((a, b) => (b.complaints?.n || 0) - (a.complaints?.n || 0))[0].name);
});
