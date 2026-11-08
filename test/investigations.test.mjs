import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMeta } from "../src/lib/catalog.js";
import { formatDate, formatNumber, plain } from "../src/lib/format.js";
import {
  INVESTIGATIONS_INDEX,
  NO_CLOSE_DATE,
  SUBJECT_LIMIT,
  findInvestigation,
  investigationAnswer,
  investigationIndexAnswer,
  investigationPath,
  investigationPaths,
  loadInvestigationPages,
  makeInvestigationCount,
  modelInvestigationCount,
} from "../src/lib/investigations.js";
import { classifyPage, sentenceCount } from "../src/lib/jsonld-audit.js";

const BANNED = /\bstill open\b|\bongoing\b|\bavoid\b/i;
const ALLOWED_RECORD = new Set(["action", "subject", "component", "components", "opened", "openedDates", "mmy", "path"]);
const ALLOWED_MMY = new Set(["make", "makeSlug", "model", "modelSlug", "year", "href", "nhtsaNames"]);
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
  "summary",
  "cdescr",
  "firstname",
  "lastname",
  "address",
]);

function normKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function headlineNhtsaName(doc, row) {
  const want = doc.modelNorm || normKey(doc.model);
  const found = (row.nhtsaModels || []).find((name) => normKey(name) === want);
  return found || String(doc.model || "");
}

function componentParts(value) {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function assertNoPii(value, path = "investigation") {
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
  const byAction = new Map();
  for (const file of walkModels()) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const [yearKey, row] of Object.entries(doc.years || {})) {
      const year = Number(yearKey);
      const href = `/${doc.makeSlug}/${doc.modelSlug}/${year}/`;
      const hits = [];
      if (!row.splitNames) {
        for (const investigation of row.investigations || []) {
          hits.push({ investigation, nhtsaName: headlineNhtsaName(doc, row) });
        }
      }
      for (const group of row.also || []) {
        for (const investigation of group.investigations || []) {
          hits.push({ investigation, nhtsaName: String(group.name || "").trim() });
        }
      }
      for (const hit of hits) {
        const action = String(hit.investigation?.action || "").trim();
        if (!action) continue;
        let item = byAction.get(action);
        if (!item) {
          item = { action, closeDateInFile: false, subjects: new Set(), components: new Set(), opened: new Set(), rows: new Map() };
          byAction.set(action, item);
        }
        if (hit.investigation.closeDateInFile) item.closeDateInFile = true;
        const subject = String(hit.investigation.subject || "").trim();
        if (subject) item.subjects.add(subject);
        for (const part of componentParts(hit.investigation.component)) item.components.add(part);
        const opened = /^\d{4}-\d{2}-\d{2}$/.test(String(hit.investigation.opened || "")) ? hit.investigation.opened : "";
        if (opened) item.opened.add(opened);
        let place = item.rows.get(href);
        if (!place) {
          place = { href, names: new Set() };
          item.rows.set(href, place);
        }
        if (hit.nhtsaName) place.names.add(hit.nhtsaName);
      }
    }
  }
  return byAction;
}

function chooseSubject(values) {
  const cleaned = [...values].map((value) => plain(value, SUBJECT_LIMIT)).filter(Boolean);
  cleaned.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return cleaned[0] || "";
}

const disk = collectFromDisk();
const pages = loadInvestigationPages();
const fileDate = loadMeta().dates.investigations;
const fileCount = loadMeta().counts.investigationActionsNoCloseDate;

function assertMatchesDisk(record) {
  const source = disk.get(record.action);
  assert.ok(source, record.action);
  assert.equal(source.closeDateInFile, false);
  assert.equal(record.subject, chooseSubject(source.subjects));
  assert.ok(record.subject.length <= SUBJECT_LIMIT);
  assert.deepEqual(record.components, [...source.components].sort((a, b) => a.localeCompare(b)));
  assert.equal(record.component, record.components.join("; "));
  assert.deepEqual(record.openedDates, [...source.opened].sort());
  assert.equal(record.opened, record.openedDates[0] || "");
  assert.deepEqual(
    record.mmy.map((row) => row.href).sort(),
    [...source.rows.keys()].sort(),
  );
  for (let index = 1; index < record.mmy.length; index += 1) {
    const prev = record.mmy[index - 1];
    const curr = record.mmy[index];
    const order =
      prev.make.localeCompare(curr.make) ||
      prev.model.localeCompare(curr.model) ||
      prev.year - curr.year ||
      prev.href.localeCompare(curr.href);
    assert.ok(order <= 0, `${prev.href} before ${curr.href}`);
  }
  for (const row of record.mmy) {
    const place = source.rows.get(row.href);
    assert.deepEqual(row.nhtsaNames, [...place.names].sort((a, b) => a.localeCompare(b)));
    assert.match(row.href, /^\/[a-z0-9-]+\/[a-z0-9-]+\/\d{4}\/$/);
    assert.equal(modelInvestigationCount(row.makeSlug, row.modelSlug) > 0, true);
    assert.equal(makeInvestigationCount(row.makeSlug) > 0, true);
  }
  for (const key of Object.keys(record)) assert.equal(ALLOWED_RECORD.has(key), true, key);
  for (const row of record.mmy) {
    for (const key of Object.keys(row)) assert.equal(ALLOWED_MMY.has(key), true, key);
  }
  assertNoPii(record);
  assert.doesNotMatch(record.subject, BANNED);
  assert.doesNotMatch(record.component, BANNED);
  const text = investigationAnswer(record, fileDate);
  assert.ok(sentenceCount(text) >= 1 && sentenceCount(text) <= 3, text);
  assert.match(text, new RegExp(`NHTSA action ${record.action}`));
  if (record.subject) assert.match(text, new RegExp(record.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /no close date in the NHTSA file/i);
  assert.match(text, new RegExp(formatNumber(record.mmy.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(formatDate(fileDate)));
  assert.doesNotMatch(text, BANNED);
  assert.equal(record.path, `/investigations/${record.action}/`);
  assert.equal(investigationPath(record.action), record.path);
  assert.equal(classifyPage(`${record.path}index.html`), "investigation");
}

test("investigation pages match stored model year rows", () => {
  assert.ok(pages.length > 0);
  assert.equal(typeof fileCount, "number");
  assert.ok(fileCount > 0);
  const expected = [...disk.values()].filter((item) => !item.closeDateInFile && item.rows.size > 0).map((item) => item.action).sort();
  assert.deepEqual(pages.map((record) => record.action), expected);
  for (const record of pages) assertMatchesDisk(record);
  const closed = [...disk.values()].find((item) => item.closeDateInFile);
  assert.ok(closed);
  assert.equal(findInvestigation(closed.action), null);
  assert.equal(investigationPath(closed.action), "");
  assert.equal(investigationPaths().length, pages.length);
  assert.equal(classifyPage("/investigations/index.html"), "investigation-index");
  assert.equal(INVESTIGATIONS_INDEX, "/investigations/");
  assert.equal(NO_CLOSE_DATE, "No close date in the NHTSA file");
  assert.doesNotMatch(NO_CLOSE_DATE, BANNED);
});

test("investigation index answer states the file count and the date status", () => {
  const text = investigationIndexAnswer(pages.length, fileCount, fileDate);
  assert.ok(sentenceCount(text) >= 1 && sentenceCount(text) <= 3, text);
  assert.match(text, new RegExp(formatDate(fileDate)));
  assert.match(text, new RegExp(formatNumber(fileCount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(formatNumber(pages.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /no close date on any row/);
  assert.match(text, /no close date in the NHTSA file/);
  assert.doesNotMatch(text, BANNED);
});
