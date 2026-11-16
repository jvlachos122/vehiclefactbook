import { findMake, loadMeta, loadModel, loadSummary } from "./catalog.js";
import { formatDate, formatNumber } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";
import { complaintHeadlineGroups, receivedYearSeriesFromCounts } from "./received-years.js";

/**
 * Make complaint pages.
 *
 * The total for a make is the sum of the complaint counts already published
 * on its model pages. Each model year count is distinct complaints for the
 * headline NHTSA name, or the sum of the matched names when the EPA name is
 * not itself an NHTSA name. The committed files do not keep the complaint
 * identifier, so a complaint counted on more than one model stays in each
 * count. These are raw counts, not rates.
 *
 * Component categories stay off the make page. Each model year stores at most
 * ten components, and a component outside that list has no count in the
 * committed file. The complaint flat file is not part of the site build, and
 * a later download would be a different file than the committed window.
 */

export const MAKE_COMPLAINT_MIN = 50;
export const COMPLAINTS_INDEX = "/complaints/";

export const MAKE_COMPLAINT_BANNED = /\b(avoid|reliable|unreliable|best|worst)\b|most problematic/i;

export const MAKE_COMPLAINT_PHRASES = [
  "raw counts, not rates",
  "Makes with more vehicles on the road get more complaints",
  "reporting lag",
  "unverified owner reports",
];

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
  "cdescr",
  "odino",
  "firstname",
  "lastname",
  "address",
  "complaint",
  "complaints",
  "owner",
]);

let recordCache;

function guard(text) {
  const value = String(text || "");
  if (MAKE_COMPLAINT_BANNED.test(value)) throw new Error(`Make complaint copy uses a banned word: ${value}`);
  return value;
}

export function summaryComplaintTotal(make) {
  let total = 0;
  for (const model of make?.models || []) {
    for (const year of model.years || []) total += Number(year.complaints) || 0;
  }
  return total;
}

export function makeComplaintPath(slug) {
  const make = findMake(slug);
  if (!make || summaryComplaintTotal(make) < MAKE_COMPLAINT_MIN) return "";
  return `/${make.slug}/complaints/`;
}

export function makeComplaintAnswer(name, total, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  const text = `NHTSA's complaint file dated ${date} lists ${formatNumber(total)} complaints on the ${name} model pages. That figure adds the complaint counts published for those model years. These are raw counts, not rates, and makes with more vehicles on the road get more complaints.`;
  if (sentenceCount(text) > 3) throw new Error(`Make complaint answer has ${sentenceCount(text)} sentences`);
  return guard(text);
}

export function complaintIndexAnswer(count, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  const text = `NHTSA's complaint file dated ${date} has a complaints page for ${formatNumber(count)} makes with at least ${formatNumber(MAKE_COMPLAINT_MIN)} complaints in the committed model-year counts. Each count adds the complaint counts on that make's model pages. These are raw counts, not rates, and makes with more vehicles on the road get more complaints.`;
  if (sentenceCount(text) > 3) throw new Error(`Complaint index answer has ${sentenceCount(text)} sentences`);
  return guard(text);
}

export function makeComplaintOverlap(name) {
  return guard(
    `The ${name} total adds the complaint counts on the ${name} model pages. Each model year count is the headline count: the NHTSA name that matches the EPA model, or the sum of the matched names when the EPA name is not in the NHTSA file. A complaint counted under more than one of those names, or on more than one model, stays in each count. The committed file does not keep the complaint identifier, so this page does not remove that overlap.`,
  );
}

export function makeComplaintComponentNote() {
  return guard(
    "Component categories are not listed. Each model year stores at most ten components, and a component outside that list has no count in the committed file.",
  );
}

export function makeComplaintCaveat() {
  return guard(
    "These figures are raw counts, not rates. Makes with more vehicles on the road get more complaints. Complaints have a reporting lag. Complaints are unverified owner reports.",
  );
}

export function complaintSource(complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return guard(`Source: NHTSA complaint flat file dated ${date}. The pages publish complaint counts only.`);
}

export function modelComplaintCaption(name, total, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return guard(
    `${name} complaint counts by model, sorted by count. The rows add to ${formatNumber(total)}. Complaint file dated ${date}.`,
  );
}

export function modelYearComplaintCaption(name, total, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return guard(
    `${name} complaints by model year, newest model year first. Each row adds the model pages for that model year. The rows add to ${formatNumber(total)}. Complaint file dated ${date}.`,
  );
}

export function complaintIndexCaption(count, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return guard(
    `${formatNumber(count)} makes with at least ${formatNumber(MAKE_COMPLAINT_MIN)} complaints, sorted by complaint count. Complaint file dated ${date}. These are raw counts, not rates.`,
  );
}

export function makeComplaintFaqs(name, total, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return [
    {
      q: `How many ${name} complaints are counted here?`,
      a: `The complaint file dated ${date} lists ${formatNumber(total)} complaints on the ${name} model pages. That figure adds the complaint counts published for those model years.`,
    },
    {
      q: `Are ${name} complaint counts rates?`,
      a: "No. These are raw counts, not rates. Makes with more vehicles on the road get more complaints. Complaints have a reporting lag, and complaints are unverified owner reports.",
    },
    {
      q: `Are ${name} complaint narratives published here?`,
      a: "No. This page publishes complaint counts only. Names, VINs, cities, dealers, and narrative text are not stored.",
    },
  ].map((faq) => ({ q: guard(faq.q), a: guard(faq.a) }));
}

export function complaintIndexFaqs(count, complaintDate) {
  const date = formatDate(complaintDate) || "an unknown file date";
  return [
    {
      q: "Which makes have a complaints page?",
      a: `A make has a page when the committed model-year counts add to at least ${formatNumber(MAKE_COMPLAINT_MIN)} complaints. The complaint file dated ${date} has ${formatNumber(count)} such makes.`,
    },
    {
      q: "Are these complaint counts rates?",
      a: "No. These are raw counts, not rates. Makes with more vehicles on the road get more complaints. Complaints have a reporting lag, and complaints are unverified owner reports.",
    },
    {
      q: "Are complaint narratives published here?",
      a: "No. These pages publish complaint counts only. Names, VINs, cities, dealers, and narrative text are not stored.",
    },
  ].map((faq) => ({ q: guard(faq.q), a: guard(faq.a) }));
}

export function makeReceivedIntro(name, series) {
  const date = formatDate(series.cutoff) || "an unknown file date";
  const partial = series.partialYear ? ` ${series.partialYear} is a partial year.` : "";
  const sum = series.rows.reduce((total, row) => total + row.n, 0);
  const match = series.undated
    ? `The year rows add to ${formatNumber(sum)}. ${formatNumber(series.undated)} ${series.undated === 1 ? "complaint has" : "complaints have"} no received date in the file, so the model-page total is ${formatNumber(series.total)}.`
    : `The year rows add to ${formatNumber(sum)}, the same complaint total as the model pages.`;
  return guard(
    `For ${name}, these counts add the model pages by the calendar year NHTSA received each complaint. The year is the calendar year of LDATE, the date NHTSA received the complaint, not the model year. The complaint file is dated ${date}.${partial} ${match}`,
  );
}

export function belowMinimumNote() {
  return guard(
    `Makes whose model-page counts add to fewer than ${formatNumber(MAKE_COMPLAINT_MIN)} complaints do not have a page.`,
  );
}

function assertNoPii(value, path = "complaints") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPii(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PII_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} is a complaint detail field`);
    assertNoPii(child, `${path}.${key}`);
  }
}

export function buildMakeComplaints(make, complaintDate) {
  const models = [];
  const byModelYear = new Map();
  const received = new Map();
  let total = 0;
  const ordered = [...(make?.models || [])].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );
  for (const model of ordered) {
    const doc = loadModel(make.slug, model.slug);
    let modelN = 0;
    for (const [yearKey, row] of Object.entries(doc?.years || {})) {
      const year = Number(yearKey);
      let yearN = 0;
      for (const group of complaintHeadlineGroups(row)) {
        const complaints = group?.complaints || {};
        yearN += Number(complaints.n) || 0;
        for (const item of complaints.byYear || []) {
          const receivedYear = Number(item?.year);
          const count = Number(item?.n) || 0;
          if (!Number.isInteger(receivedYear) || count <= 0) continue;
          received.set(receivedYear, (received.get(receivedYear) || 0) + count);
        }
      }
      modelN += yearN;
      if (Number.isInteger(year)) byModelYear.set(year, (byModelYear.get(year) || 0) + yearN);
    }
    total += modelN;
    models.push({
      slug: model.slug,
      name: model.name,
      n: modelN,
      path: `/${make.slug}/${model.slug}/`,
    });
  }
  models.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  const modelYears = [...byModelYear.entries()]
    .map(([year, n]) => ({ year, n }))
    .sort((a, b) => b.year - a.year || b.n - a.n);
  const series = receivedYearSeriesFromCounts(total, received, complaintDate);
  const years = modelYears.map((row) => row.year);
  const record = {
    slug: make.slug,
    name: make.name,
    path: total >= MAKE_COMPLAINT_MIN ? `/${make.slug}/complaints/` : "",
    total,
    models,
    modelYears,
    series,
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null,
  };
  assertNoPii(record);
  return record;
}

function sortRecords(records) {
  return [...records].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export function loadMakeComplaintRecords() {
  if (!recordCache) {
    const complaintDate = loadMeta().dates.complaints;
    recordCache = sortRecords(loadSummary().makes.map((make) => buildMakeComplaints(make, complaintDate)));
  }
  return recordCache;
}

export function loadComplaintPages() {
  return loadMakeComplaintRecords().filter((record) => record.total >= MAKE_COMPLAINT_MIN);
}

export function findMakeComplaints(slug) {
  return loadComplaintPages().find((record) => record.slug === slug) || null;
}

export function complaintSitemapPaths() {
  return [COMPLAINTS_INDEX, ...loadComplaintPages().map((record) => record.path)];
}

export function makeComplaintCopy(record, complaintDate) {
  const parts = [
    makeComplaintAnswer(record.name, record.total, complaintDate),
    makeComplaintOverlap(record.name),
    makeComplaintComponentNote(),
    makeComplaintCaveat(),
    complaintSource(complaintDate),
    modelComplaintCaption(record.name, record.total, complaintDate),
    modelYearComplaintCaption(record.name, record.total, complaintDate),
    ...makeComplaintFaqs(record.name, record.total, complaintDate).flatMap((faq) => [faq.q, faq.a]),
  ];
  if (record.series) parts.push(makeReceivedIntro(record.name, record.series));
  return parts.join("\n");
}

export function complaintIndexCopy(complaintDate) {
  const pages = loadComplaintPages();
  return [
    complaintIndexAnswer(pages.length, complaintDate),
    complaintIndexCaption(pages.length, complaintDate),
    makeComplaintCaveat(),
    makeComplaintComponentNote(),
    complaintSource(complaintDate),
    belowMinimumNote(),
    ...complaintIndexFaqs(pages.length, complaintDate).flatMap((faq) => [faq.q, faq.a]),
  ].join("\n");
}
