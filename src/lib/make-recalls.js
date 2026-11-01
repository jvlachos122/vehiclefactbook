import { loadModel } from "./catalog.js";

export const MAKE_RECALL_CAP = 25;

export const FLAG_CAVEAT =
  "Do-not-drive and park-outside flags were added to NHTSA's file in May 2025, so older campaigns may lack them (flag not present in older NHTSA records).";

const cache = new Map();

export function formatYearList(years) {
  const sorted = [...new Set(years)].filter((year) => Number.isInteger(year)).sort((a, b) => a - b);
  if (!sorted.length) return "";
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const year of sorted.slice(1)) {
    if (year === prev + 1) {
      prev = year;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = year;
    prev = year;
  }
  parts.push(start === prev ? String(start) : `${start}–${prev}`);
  return parts.join(", ");
}

export function sortCampaigns(campaigns) {
  return [...campaigns].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.camp !== b.camp) return a.camp < b.camp ? 1 : -1;
    return 0;
  });
}

function absorb(item, recall, model, year) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(recall?.date || "")) ? recall.date : "";
  if (date && (!item.date || date < item.date)) item.date = date;
  const component = String(recall?.component || "").trim();
  if (component.length > item.component.length) item.component = component;
  const summary = String(recall?.summary || "").trim();
  if (summary.length > item.summary.length) item.summary = summary;
  if (recall?.dnd === true) item.dnd = true;
  if (recall?.park === true) item.park = true;
  const slug = String(model?.slug || "").trim();
  if (!slug) return;
  let entry = item.modelMap.get(slug);
  if (!entry) {
    entry = { slug, name: String(model.name || slug), years: new Set() };
    item.modelMap.set(slug, entry);
  }
  const yearNum = Number(year);
  if (Number.isInteger(yearNum)) entry.years.add(yearNum);
}

function publish(item) {
  const models = [...item.modelMap.values()]
    .map((model) => ({
      slug: model.slug,
      name: model.name,
      years: [...model.years].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return {
    camp: item.camp,
    date: item.date,
    component: item.component,
    summary: item.summary,
    dnd: item.dnd,
    park: item.park,
    models,
  };
}

export function buildCampaigns(hits) {
  const byCamp = new Map();
  for (const hit of hits) {
    const camp = String(hit?.recall?.camp || "").trim();
    if (!camp) continue;
    let item = byCamp.get(camp);
    if (!item) {
      item = {
        camp,
        date: "",
        component: "",
        summary: "",
        dnd: false,
        park: false,
        modelMap: new Map(),
      };
      byCamp.set(camp, item);
    }
    absorb(item, hit.recall, hit.model, hit.year);
  }
  return sortCampaigns([...byCamp.values()].map(publish));
}

export function campaignFacts(campaigns) {
  let minDate = "";
  let maxDate = "";
  let dnd = 0;
  let park = 0;
  for (const campaign of campaigns) {
    if (campaign.dnd) dnd += 1;
    if (campaign.park) park += 1;
    if (!campaign.date) continue;
    if (!minDate || campaign.date < minDate) minDate = campaign.date;
    if (!maxDate || campaign.date > maxDate) maxDate = campaign.date;
  }
  return { total: campaigns.length, minDate, maxDate, dnd, park };
}

export function modelsInCampaigns(campaigns) {
  const models = new Map();
  for (const campaign of campaigns) {
    for (const model of campaign.models || []) {
      if (!models.has(model.slug)) models.set(model.slug, model.name);
    }
  }
  return [...models.entries()]
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

function recallsOnYear(row) {
  const list = [];
  for (const recall of row?.recalls || []) list.push(recall);
  for (const group of row?.also || []) {
    for (const recall of group?.recalls || []) list.push(recall);
  }
  return list;
}

export function loadMakeCampaigns(make) {
  const slug = make?.slug;
  if (!slug) return [];
  if (cache.has(slug)) return cache.get(slug);
  const hits = [];
  const models = [...(make.models || [])].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );
  for (const model of models) {
    const doc = loadModel(slug, model.slug);
    const years = Object.entries(doc.years || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [year, row] of years) {
      for (const recall of recallsOnYear(row)) {
        hits.push({
          recall,
          model: { slug: model.slug, name: model.name },
          year: Number(year),
        });
      }
    }
  }
  const campaigns = buildCampaigns(hits);
  cache.set(slug, campaigns);
  return campaigns;
}
