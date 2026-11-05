import { loadModel, loadSummary } from "./catalog.js";
import { campaignUrl, formatDate, plain, plural } from "./format.js";

export const CAMPAIGN_PAGE_MIN_YEAR = 2015;
export const RECALL_CARD_CAP = 10;

const CAMP_ID = /^[0-9A-Z]+$/;

let cache;

function normKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cleanDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

export function campaignNumberYear(camp) {
  const match = /^(\d{2})[A-Z]/.exec(String(camp || "").trim());
  if (!match) return null;
  const yy = Number(match[1]);
  // NHTSA numbers start in 1966. Prefixes 66–99 are 1966–1999; 00–65 are 2000–2065.
  return yy >= 66 ? 1900 + yy : 2000 + yy;
}

export function campaignPageYear(camp) {
  const year = campaignNumberYear(camp);
  return year != null && year >= CAMPAIGN_PAGE_MIN_YEAR;
}

export function isIndexableCampaign(camp, referenced) {
  const id = String(camp || "").trim();
  return Boolean(referenced) && CAMP_ID.test(id) && campaignPageYear(id);
}

function headlineNhtsaName(doc, row) {
  const want = doc.modelNorm || normKey(doc.model);
  const found = (row.nhtsaModels || []).find((name) => normKey(name) === want);
  return found || String(doc.model || "");
}

function ensure(byCamp, camp) {
  let item = byCamp.get(camp);
  if (!item) {
    item = {
      camp,
      dates: new Set(),
      components: new Set(),
      summary: "",
      dnd: false,
      park: false,
      mmy: new Map(),
      makes: new Map(),
    };
    byCamp.set(camp, item);
  }
  return item;
}

function addRecall(item, recall, place) {
  const date = cleanDate(recall?.date);
  if (date) item.dates.add(date);
  const component = String(recall?.component || "").trim();
  if (component) item.components.add(component);
  const summary = String(recall?.summary || "").trim();
  if (summary.length > item.summary.length || (summary.length === item.summary.length && summary > item.summary)) {
    item.summary = summary;
  }
  if (recall?.dnd === true) item.dnd = true;
  if (recall?.park === true) item.park = true;
  const href = `/${place.makeSlug}/${place.modelSlug}/${place.year}/`;
  let row = item.mmy.get(href);
  if (!row) {
    row = {
      make: place.make,
      makeSlug: place.makeSlug,
      model: place.model,
      modelSlug: place.modelSlug,
      year: place.year,
      href,
      nhtsaNames: new Set(),
      components: new Set(),
    };
    item.mmy.set(href, row);
  }
  if (place.nhtsaName) row.nhtsaNames.add(place.nhtsaName);
  if (component) row.components.add(component);
  if (!item.makes.has(place.makeSlug)) {
    item.makes.set(place.makeSlug, { name: place.make, slug: place.makeSlug });
  }
}

function consider(byCamp, recall, place) {
  const camp = String(recall?.camp || "").trim();
  if (!isIndexableCampaign(camp, true)) return;
  addRecall(ensure(byCamp, camp), recall, place);
}

function sortedText(values) {
  return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function publish(item) {
  const dates = [...item.dates].sort();
  const components = sortedText(item.components);
  const mmy = [...item.mmy.values()]
    .map((row) => ({
      make: row.make,
      makeSlug: row.makeSlug,
      model: row.model,
      modelSlug: row.modelSlug,
      year: row.year,
      href: row.href,
      nhtsaNames: sortedText(row.nhtsaNames),
      components: sortedText(row.components),
    }))
    .sort(
      (a, b) =>
        a.make.localeCompare(b.make) ||
        a.model.localeCompare(b.model) ||
        a.year - b.year ||
        a.href.localeCompare(b.href),
    );
  const makes = [...item.makes.values()].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return {
    camp: item.camp,
    date: dates[0] || "",
    dates,
    component: components.join("; "),
    components,
    summary: plain(item.summary, 400),
    dnd: item.dnd,
    park: item.park,
    mmy,
    makes,
  };
}

function buildIndex() {
  const byCamp = new Map();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const [yearKey, row] of Object.entries(doc.years || {})) {
        const year = Number(yearKey);
        if (!Number.isInteger(year)) continue;
        const place = {
          make: doc.make,
          makeSlug: doc.makeSlug || make.slug,
          model: doc.model,
          modelSlug: doc.modelSlug || model.slug,
          year,
        };
        const headlineName = headlineNhtsaName(doc, row);
        for (const recall of row.recalls || []) consider(byCamp, recall, { ...place, nhtsaName: headlineName });
        for (const group of row.also || []) {
          const nhtsaName = String(group?.name || "").trim();
          for (const recall of group?.recalls || []) consider(byCamp, recall, { ...place, nhtsaName });
        }
      }
    }
  }
  const list = [...byCamp.values()]
    .map(publish)
    .filter((campaign) => campaign.mmy.length > 0)
    .sort((a, b) => (a.camp < b.camp ? -1 : a.camp > b.camp ? 1 : 0));
  const published = new Map(list.map((campaign) => [campaign.camp, campaign]));
  return { byCamp: published, list };
}

export function loadCampaignIndex() {
  if (!cache) cache = buildIndex();
  return cache;
}

export function loadIndexableCampaigns() {
  return loadCampaignIndex().list;
}

export function findCampaign(camp) {
  return loadCampaignIndex().byCamp.get(String(camp || "").trim()) || null;
}

export function campaignPath(camp) {
  const record = findCampaign(camp);
  return record ? `/recalls/${record.camp}/` : "";
}

export function campaignHref(camp) {
  return campaignPath(camp) || campaignUrl(camp);
}

export function campaignPaths() {
  return loadIndexableCampaigns().map((campaign) => ({
    params: { campno: campaign.camp },
  }));
}

function makePhrase(makes) {
  const names = (makes || []).map((make) => make.name).filter(Boolean);
  if (names.length === 0) return "the matched model years";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names.length} makes`;
}

export function campaignAnswer(campaign, recallDate) {
  const fileDate = formatDate(recallDate);
  const coverage = `NHTSA lists campaign ${campaign.camp} on ${plural(campaign.mmy.length, "model year page")} for ${makePhrase(campaign.makes)}`;
  const sentences = [
    fileDate ? `${coverage} in the recall file dated ${fileDate}.` : `${coverage}.`,
  ];
  const dates = (campaign.dates || []).filter(Boolean);
  if (dates.length === 1) sentences.push(`The report date on the matched rows is ${formatDate(dates[0])}.`);
  else if (dates.length > 1) {
    sentences.push(
      `Report dates on the matched rows run from ${formatDate(dates[0])} to ${formatDate(dates[dates.length - 1])}.`,
    );
  }
  if (campaign.dnd && campaign.park) sentences.push("NHTSA marks the matched rows do not drive and park outside.");
  else if (campaign.dnd) sentences.push("NHTSA marks the matched rows do not drive.");
  else if (campaign.park) sentences.push("NHTSA marks the matched rows park outside.");
  return sentences.slice(0, 3).join(" ");
}

export function recallsOnYear(yearDetail) {
  const list = [];
  for (const recall of yearDetail?.recalls || []) list.push(recall);
  for (const group of yearDetail?.also || []) {
    for (const recall of group?.recalls || []) list.push(recall);
  }
  return list;
}

export function primaryNameGroup(yearDetail) {
  const groups = [...(yearDetail?.also || [])];
  groups.sort((a, b) => (b.complaints?.n || 0) - (a.complaints?.n || 0));
  return groups[0] || null;
}

export function cardRecalls(yearDetail) {
  const source = yearDetail?.splitNames ? primaryNameGroup(yearDetail)?.recalls || [] : yearDetail?.recalls || [];
  return source.slice(0, RECALL_CARD_CAP);
}

export function mmyCampaignLinkPlan(yearDetail) {
  const cardCamps = new Set(
    cardRecalls(yearDetail)
      .map((recall) => String(recall?.camp || "").trim())
      .filter((camp) => campaignPath(camp)),
  );
  const seen = new Set();
  const all = [];
  for (const recall of recallsOnYear(yearDetail)) {
    const camp = String(recall?.camp || "").trim();
    const path = campaignPath(camp);
    if (!path || seen.has(camp)) continue;
    seen.add(camp);
    all.push({ camp, path });
  }
  all.sort((a, b) => (a.camp < b.camp ? -1 : a.camp > b.camp ? 1 : 0));
  return {
    all,
    cards: all.filter((item) => cardCamps.has(item.camp)),
    extra: all.filter((item) => !cardCamps.has(item.camp)),
  };
}
