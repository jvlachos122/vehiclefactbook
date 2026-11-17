import { loadModel } from "./catalog.js";
import { span, formatDate, plural } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";
import { campaignFacts, loadMakeCampaigns } from "./make-recalls.js";

/**
 * Facts for a make hub.
 *
 * Complaint counts are the headline counts already used on the model year
 * pages: the matched NHTSA name, or the sum of the matched names when the EPA
 * name is not an NHTSA name. Recall campaigns are distinct campaign numbers
 * on those model years. A campaign on more than one model is counted on each
 * model, and once in the make total. NCAP overall stars are model year 2011
 * and newer. EPA range is all-electric configurations only (atv EV). A
 * plug-in hybrid range is not included. A blank is an em dash, not zero.
 */

export const MAKE_HUB_BANNED = /\b(avoid|reliable|unreliable|best|worst)\b|most problematic/i;

const PII_KEYS = new Set([
  "vin",
  "vins",
  "city",
  "cities",
  "dealer",
  "dealers",
  "phone",
  "operator",
  "narrative",
  "odino",
  "summary",
  "cdescr",
]);

function recallsOnYear(row) {
  const list = [...(row?.recalls || [])];
  for (const group of row?.also || []) list.push(...(group?.recalls || []));
  return list;
}

function complaintCount(row) {
  if (!row) return 0;
  if (row.splitNames) return (row.also || []).reduce((sum, group) => sum + (Number(group?.complaints?.n) || 0), 0);
  return Number(row.complaints?.n) || 0;
}

function evRange(row) {
  let min = null;
  let max = null;
  for (const config of row?.configs || []) {
    if (config?.atv !== "EV") continue;
    const range = Number(config.range);
    if (!Number.isFinite(range) || range <= 0) continue;
    min = min == null ? range : Math.min(min, range);
    max = max == null ? range : Math.max(max, range);
  }
  return [min, max];
}

function guard(text) {
  if (MAKE_HUB_BANNED.test(text)) throw new Error(`make hub copy matches a banned word: ${text}`);
  return text;
}

export function campaignCountsByModel(campaigns) {
  const counts = new Map();
  for (const campaign of campaigns || []) {
    const seen = new Set();
    for (const model of campaign.models || []) {
      if (!model?.slug || seen.has(model.slug)) continue;
      seen.add(model.slug);
      counts.set(model.slug, (counts.get(model.slug) || 0) + 1);
    }
  }
  return counts;
}

export function makeHubRows(make, campaigns = loadMakeCampaigns(make)) {
  const counts = campaignCountsByModel(campaigns);
  const rows = [];
  const models = [...(make?.models || [])].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );
  for (const model of models) {
    const doc = loadModel(make.slug, model.slug);
    let complaints = 0;
    let rangeMin = null;
    let rangeMax = null;
    for (const row of Object.values(doc?.years || {})) {
      complaints += complaintCount(row);
      const [low, high] = evRange(row);
      if (low != null) rangeMin = rangeMin == null ? low : Math.min(rangeMin, low);
      if (high != null) rangeMax = rangeMax == null ? high : Math.max(rangeMax, high);
    }
    let minY = null;
    let maxY = null;
    let starMin = null;
    let starMax = null;
    let latestRated = null;
    for (const year of model.years || []) {
      if (minY == null || year.y < minY) minY = year.y;
      if (maxY == null || year.y > maxY) maxY = year.y;
      if (year.y < 2011 || year.starMin == null || year.starMax == null) continue;
      starMin = starMin == null ? year.starMin : Math.min(starMin, year.starMin);
      starMax = starMax == null ? year.starMax : Math.max(starMax, year.starMax);
      if (latestRated == null || year.y > latestRated) latestRated = year.y;
    }
    const record = {
      slug: model.slug,
      name: model.name,
      path: `/${make.slug}/${model.slug}/`,
      minY,
      maxY,
      campaigns: counts.get(model.slug) || 0,
      complaints,
      starMin,
      starMax,
      latestRated,
      rangeMin,
      rangeMax,
    };
    for (const key of Object.keys(record)) {
      if (PII_KEYS.has(key)) throw new Error(`make hub row has ${key}`);
    }
    rows.push(record);
  }
  return rows;
}

export function yearSpan(row) {
  if (row?.minY == null || row?.maxY == null) return "—";
  return row.minY === row.maxY ? String(row.minY) : `${row.minY}–${row.maxY}`;
}

export function starCell(row) {
  if (row?.starMin == null || row?.starMax == null) return "—";
  if (row.starMin === row.starMax) return String(row.starMin);
  return `${row.starMin}–${row.starMax}`;
}

export function rangeCell(row) {
  if (row?.rangeMin == null || row?.rangeMax == null) return "—";
  return span(row.rangeMin, row.rangeMax);
}

export function makeHubAnswer(name, rows, facts, dates) {
  const models = rows.length;
  const years = rows.filter((row) => row.minY != null);
  const minY = years.length ? Math.min(...years.map((row) => row.minY)) : null;
  const maxY = years.length ? Math.max(...years.map((row) => row.maxY)) : null;
  const complaints = rows.reduce((sum, row) => sum + row.complaints, 0);
  const latest = rows.reduce((year, row) => (row.latestRated != null && (year == null || row.latestRated > year) ? row.latestRated : year), null);
  const range = minY == null ? "no model years" : `model years ${minY}–${maxY}`;
  const first = `${name} covers ${plural(models, "model")} and ${range} in the EPA file dated ${formatDate(dates.epa)}.`;
  const second = `NHTSA's recall file dated ${formatDate(dates.recalls)} lists ${plural(Number(facts?.total) || 0, "vehicle campaign")} matched to those model years, and the complaint file dated ${formatDate(dates.complaints)} lists ${plural(complaints, "distinct complaint")} on the model year pages.`;
  const third = latest == null
    ? "No model year from 2011 on has an NHTSA overall star in the committed ratings."
    : `The newest model year with an NHTSA overall star is ${latest}.`;
  const text = `${first} ${second} ${third}`;
  const count = sentenceCount(text);
  if (count < 1 || count > 3) throw new Error(`${name} make hub answer has ${count} sentences`);
  return guard(text);
}

export function makeHubCaption(name, dates) {
  return guard(
    `${name} models: model-year coverage, distinct recall campaigns, distinct complaints on the model year pages, NHTSA overall stars for model year 2011 and newer where rated, and EPA all-electric range where a configuration lists one. A campaign on more than one model is counted on each of those models. EPA file dated ${formatDate(dates.epa)}. Recall file dated ${formatDate(dates.recalls)}. Complaint file dated ${formatDate(dates.complaints)}.`,
  );
}

export function makeHubFacts(make) {
  const campaigns = loadMakeCampaigns(make);
  return { campaigns, facts: campaignFacts(campaigns), rows: makeHubRows(make, campaigns) };
}
