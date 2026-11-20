import { yearList } from "./ev-range.js";
import { formatDate, formatNumber, span } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";

/**
 * Year-by-year facts for a model hub.
 *
 * Every figure comes from the model-year row already published on the hub:
 * EPA combined mpg for non-electric configurations, MPGe when that is the
 * combined figure, recall campaign counts, complaint counts, and NHTSA
 * overall stars for model year 2011 and newer. A missing figure stays
 * "not listed". A pre-2011 star is not the current overall rating and is
 * not filled in. Counts are raw counts, not rates.
 */

export const NOT_LISTED = "not listed";
export const MODEL_FACTS_CAVEAT = "These figures are raw counts, not rates.";
export const MODEL_FACTS_METHOD = "/methodology/";
export const MODEL_FACTS_BANNED = /\b(avoid|reliable|unreliable|best|worst)\b|problem years?/i;

const PII = /\b(vins?|dealers?|narrative|cdescr|odino|firstname|lastname|operator)\b/i;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

function guard(text) {
  const value = String(text || "");
  if (MODEL_FACTS_BANNED.test(value)) throw new Error(`model facts copy matches a banned word: ${value}`);
  if (PII.test(value) || VIN.test(value)) throw new Error(`model facts copy names a complaint detail: ${value}`);
  return value;
}

function positiveSpan(min, max) {
  const low = Number(min);
  const high = Number(max);
  if (!(low > 0) || !(high > 0)) return null;
  return { min: low, max: high };
}

export function isMatchedYear(row) {
  if (!row || row.hasNhtsa === false || row.match === "none") return false;
  if (row.hasNhtsa === true) return true;
  return Number.isFinite(Number(row.complaints));
}

export function economyCell(row) {
  const mpg = positiveSpan(row?.mpgMin, row?.mpgMax);
  if (mpg) return span(mpg.min, mpg.max, "mpg");
  const mpge = positiveSpan(row?.mpgeMin, row?.mpgeMax);
  if (mpge) return span(mpge.min, mpge.max, "MPGe");
  return NOT_LISTED;
}

export function countFactCell(row, field) {
  if (!isMatchedYear(row)) return NOT_LISTED;
  const number = Number(row?.[field]);
  if (!Number.isFinite(number)) return NOT_LISTED;
  return formatNumber(number);
}

export function overallCell(row) {
  const year = Number(row?.y);
  if (!Number.isInteger(year) || year < 2011) return NOT_LISTED;
  if (row?.starMin == null || row?.starMax == null) return NOT_LISTED;
  if (row.starMin === row.starMax) return String(row.starMin);
  return `${row.starMin}–${row.starMax}`;
}

function joinedYears(years) {
  const label = yearList(years);
  if (!label) return "";
  const parts = label.split(", ");
  if (parts.length < 2) return label;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function inYears(years) {
  const list = joinedYears(years);
  if (!list) return "no model year";
  if (/^\d{4}$/.test(list)) return `model year ${list}`;
  return `model years ${list}`;
}

function extreme(rows, field, direction) {
  let target = null;
  for (const row of rows) {
    const value = Number(row[field]);
    if (!Number.isFinite(value) || !(value > 0)) continue;
    if (target == null || (direction === "max" ? value > target : value < target)) target = value;
  }
  if (target == null) return null;
  const years = rows.filter((row) => Number(row[field]) === target).map((row) => row.y);
  return { value: target, years };
}

function complaintExtreme(rows, direction) {
  let target = null;
  for (const row of rows) {
    const value = Number(row.complaints);
    if (!Number.isFinite(value)) continue;
    if (target == null || (direction === "max" ? value > target : value < target)) target = value;
  }
  const years = rows.filter((row) => Number(row.complaints) === target).map((row) => row.y);
  return { value: target, years };
}

export function modelFactsFigures(years) {
  const rows = [...(years || [])].filter((row) => Number.isInteger(Number(row?.y))).sort((a, b) => a.y - b.y);
  const matched = rows.filter((row) => isMatchedYear(row));
  const mpg = extreme(rows, "mpgMax", "max");
  const mpge = mpg ? null : extreme(rows, "mpgeMax", "max");
  let complaints = null;
  if (matched.length) {
    const high = complaintExtreme(matched, "max");
    const low = complaintExtreme(matched, "min");
    complaints = {
      min: low.value,
      minYears: low.years,
      max: high.value,
      maxYears: high.years,
      years: matched.length,
    };
  }
  const recalls = {
    matched: matched.length > 0,
    total: matched.reduce((sum, row) => sum + (Number(row.recalls) || 0), 0),
  };
  let rating = null;
  for (const row of rows) {
    if (Number(row.y) < 2011 || row.starMin == null || row.starMax == null) continue;
    if (rating == null || row.y > rating.year) {
      rating = { year: row.y, min: row.starMin, max: row.starMax };
    }
  }
  return { rows, mpg, mpge, complaints, recalls, rating };
}

function starText(rating) {
  if (rating.min === rating.max) return String(rating.min);
  return `${rating.min}–${rating.max}`;
}

function article(name) {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

function fuelSentence(make, model, figures, epaDate) {
  const vehicle = `${article(make)} ${make} ${model}`;
  const dated = formatDate(epaDate) || NOT_LISTED;
  if (figures.mpg) {
    return `The highest EPA combined mpg listed for ${vehicle} configuration is ${formatNumber(figures.mpg.value)}, in ${inYears(figures.mpg.years)} (fuel economy file dated ${dated}).`;
  }
  if (figures.mpge) {
    return `The highest EPA combined MPGe listed for ${vehicle} configuration is ${formatNumber(figures.mpge.value)}, in ${inYears(figures.mpge.years)} (fuel economy file dated ${dated}).`;
  }
  return `The fuel economy file dated ${dated} does not list a combined mpg or MPGe for the ${vehicle} model years in this table.`;
}

function complaintSentence(figures, complaintDate) {
  const dated = formatDate(complaintDate) || NOT_LISTED;
  const complaints = figures.complaints;
  if (!complaints) return `No model year in this table has a matched complaint count in the complaint file dated ${dated}.`;
  if (complaints.min === complaints.max) {
    if (complaints.years === 1) {
      return `The matched model year lists ${formatNumber(complaints.min)} complaints in the complaint file dated ${dated}.`;
    }
    return `Each matched model year lists ${formatNumber(complaints.min)} complaints in the complaint file dated ${dated}.`;
  }
  return `Matched complaint counts on the years shown run from ${formatNumber(complaints.min)} in ${joinedYears(complaints.minYears)} to ${formatNumber(complaints.max)} in ${joinedYears(complaints.maxYears)} (complaint file dated ${dated}).`;
}

function recallSentence(figures, recallDate) {
  const dated = formatDate(recallDate) || NOT_LISTED;
  const rating = figures.rating
    ? `the newest model year with an NHTSA overall rating is ${figures.rating.year} at ${starText(figures.rating)} overall`
    : "no model year in this table has an NHTSA overall rating";
  if (!figures.recalls.matched) {
    return `The recall file dated ${dated} does not list recall campaign counts for these model years, and ${rating}.`;
  }
  return `In the recall file dated ${dated}, recall campaign counts on the matched model years add up to ${formatNumber(figures.recalls.total)}, and a campaign that covers more than one model year is counted in each year, and ${rating}.`;
}

export function modelFactsAnswer(make, model, years, dates) {
  const figures = modelFactsFigures(years);
  const text = [
    fuelSentence(make, model, figures, dates?.epa),
    complaintSentence(figures, dates?.complaints),
    recallSentence(figures, dates?.recalls),
  ].join(" ");
  const count = sentenceCount(text);
  if (count < 1 || count > 3) throw new Error(`${make} ${model} facts answer has ${count} sentences`);
  return guard(text);
}

export function modelFactsCaption(make, model, dates) {
  const epa = formatDate(dates?.epa) || NOT_LISTED;
  const recalls = formatDate(dates?.recalls) || NOT_LISTED;
  const complaints = formatDate(dates?.complaints) || NOT_LISTED;
  return guard(
    `${make} ${model} by model year: EPA combined mpg across configurations, or MPGe when that is the combined figure. Recall campaigns and complaints are counts. NCAP overall is the NHTSA rating for model year 2011 and newer where a rating is listed. A blank cell says not listed. A pre-2011 rating is not shown. A campaign on more than one model year is counted in each year. EPA file dated ${epa}. Recall file dated ${recalls}. Complaint file dated ${complaints}.`,
  );
}

export function modelFacts(make, model, years, dates, slugs) {
  const figures = modelFactsFigures(years);
  const rows = figures.rows.map((row) => ({
    y: row.y,
    href: `/${slugs.makeSlug}/${slugs.modelSlug}/${row.y}/`,
    economy: economyCell(row),
    recalls: countFactCell(row, "recalls"),
    complaints: countFactCell(row, "complaints"),
    overall: overallCell(row),
  }));
  return {
    rows,
    figures,
    answer: modelFactsAnswer(make, model, years, dates),
    caption: modelFactsCaption(make, model, dates),
    caveat: MODEL_FACTS_CAVEAT,
  };
}
