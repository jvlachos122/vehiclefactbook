import { loadModel, loadSummary } from "./catalog.js";
import { formatDate, plain, plural } from "./format.js";

/**
 * Investigation pages.
 *
 * A page exists for an action that is attached to at least one published model
 * year and has no close date on any stored row. The investigations file also
 * contains actions that were not attached to a published model year. Those
 * actions are counted in meta.counts.investigationActionsNoCloseDate and do not
 * get a page, because their make, model, and year rows are not in the committed
 * site data.
 *
 * The close-date line is "no close date in the NHTSA file." It is not a
 * statement that the investigation is active. The long summary is not stored
 * on the model year and is not copied here. Complaint counts are not stored on
 * these rows, so these pages do not invent one.
 */

export const INVESTIGATIONS_INDEX = "/investigations/";
export const NO_CLOSE_DATE = "No close date in the NHTSA file";
export const SUBJECT_LIMIT = 180;

const ACTION_ID = /^[A-Z0-9]+$/;

let cache;

function normKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function headlineNhtsaName(doc, row) {
  const want = doc.modelNorm || normKey(doc.model);
  const found = (row.nhtsaModels || []).find((name) => normKey(name) === want);
  return found || String(doc.model || "");
}

function cleanDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function componentParts(value) {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sortedText(values) {
  return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function chooseSubject(values) {
  const cleaned = [...values].map((value) => plain(value, SUBJECT_LIMIT)).filter(Boolean);
  cleaned.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return cleaned[0] || "";
}

function ensure(byAction, action) {
  let item = byAction.get(action);
  if (!item) {
    item = {
      action,
      closeDateInFile: false,
      subjects: new Set(),
      components: new Set(),
      opened: new Set(),
      mmy: new Map(),
    };
    byAction.set(action, item);
  }
  return item;
}

function addInvestigation(item, investigation, place) {
  if (investigation?.closeDateInFile) item.closeDateInFile = true;
  const subject = String(investigation?.subject || "").trim();
  if (subject) item.subjects.add(subject);
  for (const part of componentParts(investigation?.component)) item.components.add(part);
  const opened = cleanDate(investigation?.opened);
  if (opened) item.opened.add(opened);
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
    };
    item.mmy.set(href, row);
  }
  if (place.nhtsaName) row.nhtsaNames.add(place.nhtsaName);
}

function consider(byAction, investigation, place) {
  const action = String(investigation?.action || "").trim();
  if (!action) return;
  addInvestigation(ensure(byAction, action), investigation, place);
}

function publish(item) {
  if (!ACTION_ID.test(item.action)) {
    throw new Error(`Investigation action ${item.action} is not a URL slug`);
  }
  const openedDates = [...item.opened].sort();
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
    }))
    .sort(
      (a, b) =>
        a.make.localeCompare(b.make) ||
        a.model.localeCompare(b.model) ||
        a.year - b.year ||
        a.href.localeCompare(b.href),
    );
  return {
    action: item.action,
    subject: chooseSubject(item.subjects),
    component: components.join("; "),
    components,
    opened: openedDates[0] || "",
    openedDates,
    mmy,
    path: `${INVESTIGATIONS_INDEX}${item.action}/`,
  };
}

function buildIndex() {
  const byAction = new Map();
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
        if (!row.splitNames) {
          const nhtsaName = headlineNhtsaName(doc, row);
          for (const investigation of row.investigations || []) {
            consider(byAction, investigation, { ...place, nhtsaName });
          }
        }
        for (const group of row.also || []) {
          const nhtsaName = String(group?.name || "").trim();
          for (const investigation of group?.investigations || []) {
            consider(byAction, investigation, { ...place, nhtsaName });
          }
        }
      }
    }
  }
  const list = [...byAction.values()]
    .filter((item) => !item.closeDateInFile && item.mmy.size > 0)
    .map(publish)
    .sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
  const published = new Map(list.map((item) => [item.action, item]));
  const modelCounts = new Map();
  const makeCounts = new Map();
  for (const item of list) {
    const seenModels = new Set();
    const seenMakes = new Set();
    for (const row of item.mmy) {
      const modelKey = `${row.makeSlug}/${row.modelSlug}`;
      if (!seenModels.has(modelKey)) {
        seenModels.add(modelKey);
        modelCounts.set(modelKey, (modelCounts.get(modelKey) || 0) + 1);
      }
      if (!seenMakes.has(row.makeSlug)) {
        seenMakes.add(row.makeSlug);
        makeCounts.set(row.makeSlug, (makeCounts.get(row.makeSlug) || 0) + 1);
      }
    }
  }
  return { byAction: published, list, modelCounts, makeCounts };
}

function index() {
  if (!cache) cache = buildIndex();
  return cache;
}

export function loadInvestigationPages() {
  return index().list;
}

export function findInvestigation(action) {
  return index().byAction.get(String(action || "").trim()) || null;
}

export function investigationPath(action) {
  const record = findInvestigation(action);
  return record ? record.path : "";
}

export function investigationPaths() {
  return loadInvestigationPages().map((record) => ({
    params: { action: record.action },
  }));
}

export function modelInvestigationCount(makeSlug, modelSlug) {
  return index().modelCounts.get(`${makeSlug}/${modelSlug}`) || 0;
}

export function makeInvestigationCount(makeSlug) {
  return index().makeCounts.get(makeSlug) || 0;
}

export function investigationAnswer(record, fileDate) {
  const dated = formatDate(fileDate);
  const subject = record.subject ? ` (${record.subject})` : "";
  const rows = plural(record.mmy.length, "model year row");
  const first = `NHTSA action ${record.action}${subject} has no close date in the NHTSA file.`;
  const second = dated
    ? `The investigations file dated ${dated} attaches it to ${rows}.`
    : `The investigations file attaches it to ${rows}.`;
  return `${first} ${second}`;
}

export function investigationIndexAnswer(pageCount, fileCount, fileDate) {
  const dated = formatDate(fileDate);
  const fileSentence = dated
    ? `The investigations file dated ${dated} has ${plural(fileCount, "action")} with no close date on any row.`
    : `The investigations file has ${plural(fileCount, "action")} with no close date on any row.`;
  const listed = `This index lists the ${plural(pageCount, "action")} attached to a published model year.`;
  const status = "The date status is no close date in the NHTSA file.";
  return `${fileSentence} ${listed} ${status}`;
}
