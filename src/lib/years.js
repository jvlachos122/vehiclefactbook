import { loadComponentPages } from "./components.js";
import { yearList } from "./ev-range.js";
import { formatDate, formatNumber, plural, span } from "./format.js";

/**
 * Model-year pages.
 *
 * Demand rank is a proxy because the repo has no search volumes. A model's
 * score is the sum of NHTSA complaint counts and recall counts on its year
 * rows in data/site/summary.json. Ties break on the complaint sum, then the
 * make slug, then the model slug.
 *
 * The low complaint count uses MIN_REPORTING_YEARS of reporting history:
 * complaint-file year minus the model year. Newer years stay in the table and
 * in the high-count sentence. Counts are raw complaint and recall totals.
 */

export const MIN_REPORTING_YEARS = 3;
export const TOP_MODEL_COUNT = 50;
export const NOT_LISTED = "not listed";
export const PRE_2011_STARS = "Pre-2011 rating, not comparable";
export const YEARS_CAPTION =
  "One row per model year: recalls, complaints, complaints with a crash or fire flag, investigations, NCAP overall stars, and EPA combined mpg. A blank cell says not listed.";
export const YEARS_FAQ_RATE =
  "No. A high complaint count is a raw count, not a rate, and more cars sold can mean more complaints. Complaints have a reporting lag, so a newer model year can show a lower count because less time has passed. The complaint file's own documentation describes a format change in 2021.";
export const YEARS_BANNED = /\b(avoid|best|worst|reliable)\b|problem years|years to avoid/i;

export const DEMAND_EXAMPLES = [
  { make: "Honda", model: "Civic" },
  { make: "Honda", model: "Accord" },
  { make: "Honda", model: "CR-V" },
  { make: "Nissan", model: "Rogue" },
  { make: "Jeep", model: "Grand Cherokee" },
  { make: "Ford", model: "Escape" },
  { make: "Ford", model: "F-150" },
  { make: "Toyota", model: "Camry" },
  { make: "Toyota", model: "RAV4" },
  { make: "Chevrolet", model: "Silverado 1500" },
];

/**
 * Published names when the demand phrase is not itself a model page.
 * Ford F-150 is published as F150. There is no Silverado 1500 page;
 * Chevrolet Silverado is the published model. F-150 Lightning is a
 * different model and is not used as a stand-in.
 */
export const DEMAND_PUBLISHED_NAMES = [
  { make: "Ford", model: "F-150", publishedMake: "Ford", publishedModel: "F150" },
  { make: "Chevrolet", model: "Silverado 1500", publishedMake: "Chevrolet", publishedModel: "Silverado" },
];

export function isMatchedYear(row) {
  if (!row || row.hasNhtsa === false || row.match === "none") return false;
  if (row.hasNhtsa === true) return true;
  return Number.isFinite(row.complaints);
}

function numeric(row, field) {
  const value = row?.[field];
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function listedSpan(min, max) {
  const low = Number(min);
  const high = Number(max);
  if (min == null || max == null || !(low > 0) || !(high > 0)) return "";
  return span(low, high);
}

export function countCell(row, field) {
  if (!isMatchedYear(row)) return { text: NOT_LISTED, sort: NOT_LISTED };
  const number = numeric(row, field);
  if (number == null) return { text: NOT_LISTED, sort: NOT_LISTED };
  return { text: formatNumber(number), sort: String(number) };
}

export function starsCell(row) {
  const year = Number(row?.y);
  if (!Number.isInteger(year) || year < 2011) return { text: PRE_2011_STARS, sort: "pre-2011" };
  if (row.starMin == null || row.starMax == null) return { text: NOT_LISTED, sort: NOT_LISTED };
  const text = row.starMin === row.starMax ? String(row.starMin) : `${row.starMin}–${row.starMax}`;
  return { text, sort: String(row.starMax) };
}

export function mpgCell(row) {
  const mpg = listedSpan(row?.mpgMin, row?.mpgMax);
  if (mpg) return { text: mpg, sort: String(row.mpgMax) };
  const mpge = listedSpan(row?.mpgeMin, row?.mpgeMax);
  if (mpge) return { text: `${mpge} MPGe`, sort: String(row.mpgeMax) };
  return { text: NOT_LISTED, sort: NOT_LISTED };
}

export function formatYearList(years) {
  const label = yearList(years);
  if (!label) return "";
  const parts = label.split(", ");
  if (parts.length < 2) return label;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function modelYearPhrase(years) {
  const list = formatYearList(years);
  if (!list) return "no model years";
  if (/^\d{4}$/.test(list)) return `model year ${list}`;
  return `model years ${list}`;
}

export function complaintFileYear(dates) {
  const match = /^(\d{4})/.exec(String(dates?.complaints || ""));
  return match ? Number(match[1]) : null;
}

function extreme(rows, direction) {
  let target = numeric(rows[0], "complaints");
  for (const row of rows) {
    const count = numeric(row, "complaints");
    if (direction === "max" ? count > target : count < target) target = count;
  }
  const years = [...new Set(rows.filter((row) => numeric(row, "complaints") === target).map((row) => row.y))].sort(
    (a, b) => a - b,
  );
  return { count: target, years };
}

function recallFacts(matched) {
  const listed = [];
  for (const row of matched) {
    const value = numeric(row, "recalls");
    if (value == null) continue;
    listed.push({ y: row.y, value });
  }
  if (!listed.length) {
    return { total: null, min: null, max: null, minYears: [], maxYears: [], matchedCount: matched.length };
  }
  const total = listed.reduce((sum, item) => sum + item.value, 0);
  const min = Math.min(...listed.map((item) => item.value));
  const max = Math.max(...listed.map((item) => item.value));
  return {
    total,
    min,
    max,
    minYears: listed.filter((item) => item.value === min).map((item) => item.y),
    maxYears: listed.filter((item) => item.value === max).map((item) => item.y),
    matchedCount: matched.length,
  };
}

function flagYears(matched, field) {
  return matched
    .filter((row) => (numeric(row, field) || 0) > 0)
    .map((row) => row.y)
    .sort((a, b) => a - b);
}

export function yearsFacts(years, dates, options = {}) {
  const minReportingYears = options.minReportingYears ?? MIN_REPORTING_YEARS;
  const rows = [...(years || [])]
    .filter((row) => Number.isInteger(Number(row?.y)))
    .sort((a, b) => a.y - b.y);
  const matched = rows.filter((row) => isMatchedYear(row));
  const counted = matched.filter((row) => numeric(row, "complaints") != null);
  const fileYear = complaintFileYear(dates);
  const cutoff = fileYear == null ? null : fileYear - minReportingYears;
  const seasoned =
    cutoff == null ? [] : counted.filter((row) => row.y <= cutoff);
  return {
    minReportingYears,
    fileYear,
    cutoff,
    coveredYears: rows.map((row) => row.y),
    matchedYears: matched.map((row) => row.y),
    most: counted.length ? extreme(counted, "max") : null,
    fewest: seasoned.length ? extreme(seasoned, "min") : null,
    recalls: recallFacts(matched),
    dndYears: flagYears(matched, "dnd"),
    parkYears: flagYears(matched, "park"),
  };
}

function historyPhrase(facts) {
  if (facts.fileYear == null) return `at least ${facts.minReportingYears} years of reporting history`;
  return `at least ${facts.minReportingYears} years of reporting history (model year ${facts.cutoff} and earlier, using complaint file year ${facts.fileYear})`;
}

function yearLead(years) {
  const list = formatYearList(years);
  if (/^\d{4}$/.test(list)) return `${list} model year`;
  return `${list} model years`;
}

function mostClause(facts) {
  const each = facts.most.years.length > 1 ? " on each" : "";
  return `NHTSA has received the most complaints for the ${yearLead(facts.most.years)} (${formatNumber(facts.most.count)} so far${each})`;
}

function fewestClause(facts) {
  const history = historyPhrase(facts);
  if (!facts.fewest) return `No matched model year has ${history}`;
  const each = facts.fewest.years.length > 1 ? " on each" : "";
  return `Among matched model years with ${history}, the fewest complaints received so far are ${formatNumber(facts.fewest.count)}${each}, in ${formatYearList(facts.fewest.years)}`;
}

function recallClause(facts) {
  const recalls = facts.recalls;
  const overlap = "a campaign that covers more than one model year is counted in each year";
  if (recalls.total == null) return "recall counts are not listed on the matched model years";
  if (recalls.min === recalls.max) {
    return `matched recall counts on these model years add up to ${formatNumber(recalls.total)}, and each matched model year lists ${plural(recalls.min, "recall")} (${overlap})`;
  }
  return `matched recall counts on these model years add up to ${formatNumber(recalls.total)}, from ${formatNumber(recalls.min)} in ${formatYearList(recalls.minYears)} to ${formatNumber(recalls.max)} in ${formatYearList(recalls.maxYears)} (${overlap})`;
}

function advisorySentence(facts, recallDate) {
  const dated = `The recall file dated ${recallDate}`;
  const dndYears = facts.dndYears;
  const parkYears = facts.parkYears;
  if (!dndYears.length && !parkYears.length) {
    return `${dated} does not list a campaign marked do not drive or park outside for these model years.`;
  }
  if (dndYears.length && parkYears.length) {
    return `${dated} lists a campaign marked do not drive for ${modelYearPhrase(dndYears)} and a campaign marked park outside for ${modelYearPhrase(parkYears)}.`;
  }
  if (dndYears.length) {
    return `${dated} lists a campaign marked do not drive for ${modelYearPhrase(dndYears)} and does not list a campaign marked park outside for these model years.`;
  }
  return `${dated} does not list a campaign marked do not drive for these model years and lists a campaign marked park outside for ${modelYearPhrase(parkYears)}.`;
}

export function yearsAnswer(make, model, years, dates) {
  const facts = yearsFacts(years, dates);
  const complaintDate = formatDate(dates?.complaints);
  const recallDate = formatDate(dates?.recalls);
  if (!facts.coveredYears.length) {
    return `NHTSA's complaint file dated ${complaintDate} does not have matched complaint counts for the ${make} ${model} model years in this table.`;
  }
  if (!facts.most) {
    return [
      `This table covers ${modelYearPhrase(facts.coveredYears)} for the ${make} ${model}, and NHTSA's complaint file dated ${complaintDate} does not have matched complaint counts for these model years.`,
      `No matched model year has ${historyPhrase(facts)}.`,
      advisorySentence(facts, recallDate),
    ].join(" ");
  }
  return [
    `For the ${make} ${model}, this table covers ${modelYearPhrase(facts.coveredYears)}, and ${mostClause(facts)} in the complaint file dated ${complaintDate}.`,
    `${fewestClause(facts)}, and ${recallClause(facts)}.`,
    advisorySentence(facts, recallDate),
  ].join(" ");
}

export function yearsCaveat(dates) {
  const complaintDate = formatDate(dates?.complaints) || "not listed";
  const recallDate = formatDate(dates?.recalls) || "not listed";
  const epaDate = formatDate(dates?.epa) || "not listed";
  return `These figures are raw counts, not rates. More cars sold can mean more complaints, and complaints have a reporting lag, so the newest model years can look cleaner than older ones. The complaint file's own documentation describes a format change in 2021. The complaint file is dated ${complaintDate}, the recall file is dated ${recallDate}, and the EPA fuel economy file is dated ${epaDate}.`;
}

export function yearsFaqs({ make, model, years, dates }) {
  const facts = yearsFacts(years, dates);
  const complaintDate = formatDate(dates?.complaints);
  const vehicle = `${make} ${model}`;
  const most = facts.most
    ? `${mostClause(facts)} in the complaint file dated ${complaintDate}.`
    : `NHTSA's complaint file dated ${complaintDate} does not have a matched complaint count for these ${vehicle} model years.`;
  return [
    { q: `Which ${vehicle} year has the most NHTSA complaints?`, a: most },
    { q: `Does a high complaint count mean a ${vehicle} year is bad?`, a: YEARS_FAQ_RATE },
  ];
}

export function yearsTitle(make, model) {
  return `${make} ${model} complaints by year: recalls, complaints, ratings`;
}

export function yearsH1(make, model) {
  return `${make} ${model} by model year: recalls, complaints, ratings`;
}

export function yearsStarNote(years) {
  const hasOld = (years || []).some((year) => Number(year?.y) < 2011);
  const stars = hasOld
    ? `Star cells say "${PRE_2011_STARS}" for model years before 2011, because those ratings use a different NHTSA method.`
    : "Overall stars in this table are matched NHTSA ratings for model years 2011 and newer.";
  return `${stars} For 2011 and newer, a star cell says not listed when no overall star was matched. A recall, complaint, crash, fire, or investigation cell says not listed when no NHTSA name was matched, and a matched zero stays zero. Combined mpg says not listed when the EPA file has no positive combined mpg. An electric configuration with no mpg can show MPGe.`;
}

export function yearsPageText({ make, model, years, dates }) {
  const faqs = yearsFaqs({ make, model, years, dates });
  return [
    yearsTitle(make, model),
    yearsH1(make, model),
    yearsAnswer(make, model, years, dates),
    yearsCaveat(dates),
    YEARS_CAPTION,
    yearsStarNote(years),
    ...faqs.flatMap((faq) => [faq.q, faq.a]),
  ].join("\n");
}

export function modelDemandScore(model) {
  let complaints = 0;
  let recalls = 0;
  for (const year of model?.years || []) {
    complaints += Number(year?.complaints) || 0;
    recalls += Number(year?.recalls) || 0;
  }
  return { complaints, recalls, score: complaints + recalls };
}

export function rankModels(summary) {
  const rows = [];
  for (const make of summary?.makes || []) {
    for (const model of make.models || []) {
      rows.push({ make, model, ...modelDemandScore(model) });
    }
  }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.complaints - a.complaints ||
      a.make.slug.localeCompare(b.make.slug) ||
      a.model.slug.localeCompare(b.model.slug),
  );
  return rows;
}

function findRanked(ranked, make, model) {
  return ranked.find((row) => row.make.name === make && row.model.name === model) || null;
}

export function resolveDemandExamples(summaryOrRanked) {
  const ranked = Array.isArray(summaryOrRanked) ? summaryOrRanked : rankModels(summaryOrRanked);
  return DEMAND_EXAMPLES.map((example) => {
    const exact = findRanked(ranked, example.make, example.model);
    if (exact) {
      return { ...example, row: exact, via: "exact", publishedName: `${example.make} ${example.model}` };
    }
    const alias = DEMAND_PUBLISHED_NAMES.find((item) => item.make === example.make && item.model === example.model);
    if (!alias) return { ...example, row: null, via: "missing", publishedName: "" };
    const row = findRanked(ranked, alias.publishedMake, alias.publishedModel);
    return {
      ...example,
      row,
      via: row ? "published-name" : "missing",
      publishedName: row ? `${alias.publishedMake} ${alias.publishedModel}` : "",
    };
  });
}

export function qaModels(summary) {
  const ranked = rankModels(summary);
  const selected = ranked.slice(0, TOP_MODEL_COUNT).filter((row) => row.model.yearsPage);
  const seen = new Set(selected.map((row) => `${row.make.slug}/${row.model.slug}`));
  for (const example of resolveDemandExamples(ranked)) {
    if (!example.row?.model?.yearsPage) continue;
    const key = `${example.row.make.slug}/${example.row.model.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(example.row);
  }
  return selected;
}

export function componentGroupsFor(makeSlug, modelSlug) {
  const groups = new Map();
  for (const page of loadComponentPages()) {
    if (page.makeSlug !== makeSlug || page.modelSlug !== modelSlug) continue;
    let group = groups.get(page.year);
    if (!group) {
      group = { year: page.year, links: [] };
      groups.set(page.year, group);
    }
    group.links.push({ component: page.component, path: page.path, n: page.n });
  }
  return [...groups.values()]
    .sort((a, b) => a.year - b.year)
    .map((group) => ({
      year: group.year,
      links: group.links.sort((a, b) => b.n - a.n || a.component.localeCompare(b.component)),
    }));
}
