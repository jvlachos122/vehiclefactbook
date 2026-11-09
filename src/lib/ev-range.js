import { loadModel, loadSummary } from "./catalog.js";
import { formatDate, formatNumber, plural } from "./format.js";

/**
 * EPA range by model year.
 *
 * A page exists for a model with at least one all-electric configuration.
 * All-electric means atvType EV. Plug-in hybrid rows are not a page by
 * themselves, and their stored range is not mixed into these figures. The
 * committed field is EPA's range column. For a plug-in hybrid that column is
 * not the all-electric range.
 *
 * The page lives at /make/model/range/. Model years are four-digit numbers, so
 * "range" does not collide with a year path. Component pages are one segment
 * deeper (/make/model/year/component/). The index is /ev-range/.
 *
 * Missing and non-positive figures are "not listed by EPA". A zero in the
 * file is not published as zero. Counts are read from the committed model
 * files on each build.
 */

export const RANGE_SEGMENT = "range";
export const EV_RANGE_INDEX = "/ev-range/";
export const NOT_LISTED = "not listed by EPA";
export const RANGE_CAVEAT = "EPA range is a test-cycle estimate, and real-world range varies.";

const BANNED = /\b(avoid|reliable|unreliable|best|worst)\b/i;

let cache;

export function listedNumber(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

export function formatListed(value, kind = "number") {
  const number = listedNumber(value);
  if (number == null) return NOT_LISTED;
  if (kind === "money") return `$${Math.round(number).toLocaleString("en-US")}`;
  return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function isAllElectric(config) {
  return config?.atv === "EV";
}

export function isPlugInHybrid(config) {
  return config?.atv === "Plug-in Hybrid";
}

export function hasAllElectric(configs) {
  return (configs || []).some(isAllElectric);
}

export function evRangePath(makeSlug, modelSlug) {
  return `/${makeSlug}/${modelSlug}/${RANGE_SEGMENT}/`;
}

export function yearList(years) {
  const nums = [...new Set((years || []).map(Number))].filter((year) => Number.isInteger(year)).sort((a, b) => a - b);
  if (!nums.length) return "";
  const groups = [];
  let start = nums[0];
  let prev = nums[0];
  for (const year of nums.slice(1)) {
    if (year === prev + 1) {
      prev = year;
      continue;
    }
    groups.push(start === prev ? String(start) : `${start}–${prev}`);
    start = prev = year;
  }
  groups.push(start === prev ? String(start) : `${start}–${prev}`);
  return groups.join(", ");
}

export function temporalCoverageFromYears(years) {
  const nums = [...new Set((years || []).map(Number))].filter((year) => Number.isInteger(year)).sort((a, b) => a - b);
  if (!nums.length) return "";
  if (nums.length === 1) return String(nums[0]);
  return `${nums[0]}/${nums[nums.length - 1]}`;
}

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return name || "configuration";
}

/**
 * Periods that would end an answer-box sentence are removed from a citation.
 * "19in. Wheels" would split the sentence. "ID.4" and "ID. Buzz" stay, because
 * the sentence counter already ignores those periods. The table keeps the EPA spelling.
 */
export function answerConfig(name) {
  return cleanName(name)
    .replace(/\.+(?=\s)/g, (period, offset, text) => {
      let cursor = offset - 1;
      while (cursor >= 0 && /[A-Z]/.test(text[cursor])) cursor -= 1;
      const abbreviation = offset - 1 - cursor;
      if (abbreviation > 0 && abbreviation <= 2) return period;
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function cite(rows) {
  const labels = [];
  const seen = new Set();
  for (const row of rows) {
    const label = `${row.year} ${answerConfig(row.config)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (labels.length <= 1) return labels[0] || "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function cmpNum(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRows(left, right) {
  return (
    left.year - right.year ||
    left.config.localeCompare(right.config, "en") ||
    cmpNum(left.range, right.range) ||
    cmpNum(left.kwh, right.kwh) ||
    cmpNum(left.mpge, right.mpge) ||
    cmpNum(left.cost, right.cost)
  );
}

function extreme(rows, value) {
  const matched = rows.filter((row) => row.range === value).sort(compareRows);
  return {
    value,
    rows: matched,
    years: [...new Set(matched.map((row) => row.year))].sort((a, b) => a - b),
  };
}

function extremes(rows) {
  const listed = rows.filter((row) => row.range != null);
  if (!listed.length) return { high: null, low: null };
  let highValue = listed[0].range;
  let lowValue = listed[0].range;
  for (const row of listed) {
    if (row.range > highValue) highValue = row.range;
    if (row.range < lowValue) lowValue = row.range;
  }
  return { high: extreme(rows, highValue), low: extreme(rows, lowValue) };
}

export function pageFromDoc(doc) {
  const rows = [];
  let phevCount = 0;
  const years = [];
  for (const [yearKey, yearRow] of Object.entries(doc?.years || {})) {
    const year = Number(yearKey);
    if (!Number.isInteger(year)) continue;
    let yearHasEv = false;
    for (const config of yearRow?.configs || []) {
      if (isPlugInHybrid(config)) phevCount += 1;
      if (!isAllElectric(config)) continue;
      yearHasEv = true;
      rows.push({
        year,
        config: cleanName(config.model),
        range: listedNumber(config.range),
        kwh: listedNumber(config.kwh),
        mpge: listedNumber(config.comb),
        cost: listedNumber(config.cost),
        href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
      });
    }
    if (yearHasEv) years.push(year);
  }
  if (!rows.length) return null;
  years.sort((a, b) => a - b);
  rows.sort(compareRows);
  const { high, low } = extremes(rows);
  const makeSlug = doc.makeSlug;
  const modelSlug = doc.modelSlug;
  return {
    make: doc.make,
    makeSlug,
    model: doc.model,
    modelSlug,
    path: evRangePath(makeSlug, modelSlug),
    modelPath: `/${makeSlug}/${modelSlug}/`,
    years,
    yearLabel: yearList(years),
    rows,
    phevCount,
    high,
    low,
  };
}

function assertNoSlugCollision() {
  for (const make of loadSummary().makes) {
    if (make.slug === "ev-range") {
      throw new Error(`Make slug ${make.slug} collides with ${EV_RANGE_INDEX}`);
    }
    for (const model of make.models) {
      for (const year of model.years) {
        if (String(year.y) === RANGE_SEGMENT) {
          throw new Error(`Model year ${year.y} collides with ${evRangePath(make.slug, model.slug)}`);
        }
      }
    }
  }
}

function buildPages() {
  assertNoSlugCollision();
  const pages = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const page = pageFromDoc(loadModel(make.slug, model.slug));
      if (page) pages.push(page);
    }
  }
  pages.sort((a, b) => a.make.localeCompare(b.make, "en") || a.model.localeCompare(b.model, "en") || a.path.localeCompare(b.path));
  return pages;
}

function index() {
  if (!cache) cache = buildPages();
  return cache;
}

export function loadEvRangePages() {
  return index();
}

export function findEvRangePage(makeSlug, modelSlug) {
  return loadEvRangePages().find((page) => page.makeSlug === makeSlug && page.modelSlug === modelSlug) || null;
}

export function evRangePaths() {
  return loadEvRangePages().map((page) => ({
    params: { make: page.makeSlug, model: page.modelSlug },
    props: { makeSlug: page.makeSlug, modelSlug: page.modelSlug },
  }));
}

export function evRangeRowCount(pages = loadEvRangePages()) {
  return pages.reduce((sum, page) => sum + page.rows.length, 0);
}

function guard(text) {
  assertEvRangeCopy(text);
  return text;
}

export function evRangeAnswer(page, epaDate) {
  const dated = formatDate(epaDate);
  const file = dated ? ` dated ${dated}` : "";
  const name = `${page.make} ${page.model}`;
  const yearPhrase = page.years.length === 1 ? `model year ${page.yearLabel}` : `model years ${page.yearLabel}`;
  const first = `The EPA fuel economy file${file} lists ${plural(page.rows.length, "all-electric configuration")} of the ${name} for ${yearPhrase}.`;
  const missing = page.rows.filter((row) => row.range == null).length;
  if (page.rows.length === 1) {
    const row = page.rows[0];
    const second = row.range == null
      ? "EPA does not list a range for that configuration."
      : `The EPA-rated range is ${formatNumber(row.range)} miles (${row.year} ${answerConfig(row.config)}).`;
    return guard(`${first} ${second}`);
  }
  if (!page.high) {
    return guard(`${first} EPA does not list a range for these configurations.`);
  }
  if (page.high.value === page.low.value) {
    const extra = missing ? `, and EPA does not list a range for ${plural(missing, "other configuration")}` : "";
    const second = missing
      ? `The configurations that list a range show ${formatNumber(page.high.value)} miles, including the ${cite(page.high.rows)}${extra}.`
      : `Each of those configurations has an EPA-rated range of ${formatNumber(page.high.value)} miles, including the ${cite(page.high.rows)}.`;
    return guard(`${first} ${second}`);
  }
  const second = `The highest EPA-rated range is ${formatNumber(page.high.value)} miles (${cite(page.high.rows)}).`;
  const low = `The lowest EPA-rated range is ${formatNumber(page.low.value)} miles (${cite(page.low.rows)})`;
  const third = missing ? `${low}, and EPA does not list a range for ${plural(missing, "configuration")}.` : `${low}.`;
  return guard(`${first} ${second} ${third}`);
}

export function evRangeIndexAnswer(pages, epaDate) {
  const dated = formatDate(epaDate);
  const file = dated ? ` dated ${dated}` : "";
  const years = pages.flatMap((page) => page.years);
  const min = years.length ? Math.min(...years) : null;
  const max = years.length ? Math.max(...years) : null;
  const yearPhrase = min == null ? "no model year" : min === max ? `model year ${min}` : `model years ${min} through ${max}`;
  const first = `The EPA fuel economy file${file} lists ${plural(evRangeRowCount(pages), "all-electric configuration")} across ${plural(pages.length, "model")} for ${yearPhrase}.`;
  const second = "The table shows each model's highest EPA-rated range and the model year of that figure.";
  return guard(`${first} ${second}`);
}

export function phevOmitNote(count) {
  const n = Number(count) || 0;
  if (!n) return "";
  return guard(`The EPA file also lists ${plural(n, "plug-in hybrid configuration")} of this model. Those rows are not in the table. The range stored on a plug-in hybrid row is not the all-electric range, so it is not mixed into these figures.`);
}

export function evRangeSource(epaDate) {
  const dated = formatDate(epaDate);
  const file = dated ? ` dated ${dated}` : "";
  return guard(`Source: EPA fueleconomy.gov vehicles file${file}. Range, kWh/100 mi, combined MPGe, and annual fuel cost are the figures on all-electric configurations, where atvType is EV. A figure the file leaves blank is shown as ${NOT_LISTED}, not as zero.`);
}

export function assertEvRangeCopy(text) {
  if (BANNED.test(String(text || ""))) {
    throw new Error("EV range copy uses a ranking word");
  }
}
