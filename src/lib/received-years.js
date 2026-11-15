import { formatDate, formatNumber } from "./format.js";

/**
 * Complaints by the calendar year NHTSA received them.
 *
 * The complaint flat file's field 17, LDATE, is "DATE COMPLAINT RECEIVED BY
 * NHTSA". The pipeline keeps the calendar year of that field on each model
 * year as complaints.byYear (distinct ODINO values). Field 16, DATEA, is the
 * date the row was added to the file and is not used.
 *
 * A model hub sums the headline counts across its model years. When the EPA
 * name is an exact NHTSA name, only that name is included. When the headline
 * is a sum of matched names, those names are the ones in `also`. The same
 * rule produces the complaint column on the model page.
 */

export const RECEIVED_YEAR_MIN = 10;
export const RECEIVED_YEAR_CAPTION = "Complaints received by NHTSA per calendar year";
export const RECEIVED_YEAR_BANNED = /\b(avoid|best|worst|reliable)\b/i;
export const RECEIVED_YEAR_PHRASES = [
  RECEIVED_YEAR_CAPTION,
  "raw counts, not rates",
  "More complaints can mean more cars on the road",
  "reporting lag",
  "unverified owner reports",
];

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const CHART_PAD_L = 56;
const CHART_PAD_R = 12;
const CHART_PAD_T = 16;
const CHART_PAD_B = 52;

function guard(text) {
  if (RECEIVED_YEAR_BANNED.test(text)) throw new Error("Received-year copy uses a banned word");
  return text;
}

function fileYearOf(complaintDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(complaintDate || ""));
  if (!match) return null;
  return { year: Number(match[1]), complete: match[2] === "12" && match[3] === "31" };
}

function headlineGroups(yearRow) {
  if (!yearRow || typeof yearRow !== "object") return [];
  if (yearRow.splitNames) return Array.isArray(yearRow.also) ? yearRow.also : [];
  return [yearRow];
}

export function receivedYearSeries(modelDoc, complaintDate) {
  const counts = new Map();
  let total = 0;
  for (const yearRow of Object.values(modelDoc?.years || {})) {
    for (const group of headlineGroups(yearRow)) {
      const complaints = group?.complaints || {};
      total += Number(complaints.n) || 0;
      for (const item of complaints.byYear || []) {
        const year = Number(item?.year);
        const n = Number(item?.n) || 0;
        if (!Number.isInteger(year) || n <= 0) continue;
        counts.set(year, (counts.get(year) || 0) + n);
      }
    }
  }
  const dated = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total < RECEIVED_YEAR_MIN || dated <= 0) return null;
  const file = fileYearOf(complaintDate);
  const start = Math.min(...counts.keys());
  let end = Math.max(...counts.keys());
  if (file && file.year > end) end = file.year;
  const partialYear = file && !file.complete && file.year >= start && file.year <= end ? file.year : null;
  const rows = [];
  for (let year = start; year <= end; year += 1) {
    rows.push({
      year,
      n: counts.get(year) || 0,
      partial: year === partialYear,
    });
  }
  return {
    rows,
    total,
    dated,
    undated: total - dated,
    partialYear,
    cutoff: String(complaintDate || ""),
  };
}

export function receivedYearLabel(row) {
  return row?.partial ? `${row.year} (partial)` : String(row?.year ?? "");
}

export function receivedYearIntro(make, model, series) {
  const date = formatDate(series.cutoff) || "an unknown file date";
  const partial = series.partialYear ? ` ${series.partialYear} is a partial year.` : "";
  const sum = series.rows.reduce((total, row) => total + row.n, 0);
  const match = series.undated
    ? `The year rows add to ${formatNumber(sum)}. ${formatNumber(series.undated)} ${series.undated === 1 ? "complaint has" : "complaints have"} no received date in the file, so the model-year total is ${formatNumber(series.total)}.`
    : `The year rows add to ${formatNumber(sum)}, the same distinct complaint total as the model-year rows on this page.`;
  return guard(
    `For the ${make} ${model}, these counts are distinct complaints by the calendar year NHTSA received them. The year is the calendar year of LDATE, the date NHTSA received the complaint, not the model year. The complaint file is dated ${date}.${partial} ${match}`,
  );
}

export function receivedYearCaption(series) {
  const date = formatDate(series.cutoff) || "an unknown file date";
  const partial = series.partialYear ? ` ${series.partialYear} is a partial year.` : "";
  return guard(`${RECEIVED_YEAR_CAPTION}. The complaint file is dated ${date}.${partial}`);
}

export function receivedYearLegend(series) {
  if (series?.partialYear) {
    return guard(
      `Bar height is the distinct complaint count for that received year. The lighter bar is ${series.partialYear}, a partial year.`,
    );
  }
  return guard("Bar height is the distinct complaint count for that received year.");
}

export function receivedYearCaveat() {
  return guard(
    "These figures are raw counts, not rates. More complaints can mean more cars on the road. Complaints have a reporting lag. Complaints are unverified owner reports.",
  );
}

export function receivedYearChart(series) {
  const rows = series?.rows || [];
  const max = Math.max(...rows.map((row) => row.n), 1);
  const plotW = CHART_WIDTH - CHART_PAD_L - CHART_PAD_R;
  const plotH = CHART_HEIGHT - CHART_PAD_T - CHART_PAD_B;
  const slot = rows.length ? plotW / rows.length : plotW;
  const barWidth = Math.min(22, slot * 0.62);
  const baseline = CHART_PAD_T + plotH;
  const bars = rows.map((row, index) => {
    const scaled = Math.round((row.n / max) * plotH);
    const height = row.n > 0 ? Math.max(2, scaled) : 0;
    const x = Math.round(CHART_PAD_L + index * slot + (slot - barWidth) / 2);
    return {
      year: row.year,
      n: row.n,
      partial: row.partial,
      x,
      y: baseline - height,
      width: Math.round(barWidth),
      height,
      labelX: Math.round(x + barWidth / 2),
      label: String(row.year),
    };
  });
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    padL: CHART_PAD_L,
    padR: CHART_PAD_R,
    baseline,
    maxY: CHART_PAD_T,
    max,
    plotH,
    bars,
  };
}

export function receivedYearCopy(make, model, series) {
  return [
    receivedYearIntro(make, model, series),
    receivedYearCaption(series),
    receivedYearLegend(series),
    receivedYearCaveat(),
    ...series.rows.map((row) => receivedYearLabel(row)),
  ].join("\n");
}
