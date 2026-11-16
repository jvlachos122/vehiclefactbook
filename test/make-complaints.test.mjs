import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMeta, loadSummary } from "../src/lib/catalog.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  COMPLAINTS_INDEX,
  MAKE_COMPLAINT_BANNED,
  MAKE_COMPLAINT_MIN,
  MAKE_COMPLAINT_PHRASES,
  complaintIndexCopy,
  complaintSitemapPaths,
  loadComplaintPages,
  loadMakeComplaintRecords,
  makeComplaintCopy,
  makeComplaintPath,
  summaryComplaintTotal,
} from "../src/lib/make-complaints.js";
import { RECEIVED_YEAR_MIN } from "../src/lib/received-years.js";

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
  "owner",
]);

function keysOf(value, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) keysOf(child, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    found.push(key);
    keysOf(child, found);
  }
  return found;
}

function offline(make) {
  const models = new Map();
  const modelYears = new Map();
  const received = new Map();
  let total = 0;
  for (const model of make.models) {
    const doc = JSON.parse(readFileSync(join("data/site/models", make.slug, `${model.slug}.json`), "utf8"));
    let modelN = 0;
    for (const [yearKey, row] of Object.entries(doc.years || {})) {
      const groups = row?.splitNames ? row.also || [] : [row];
      let yearN = 0;
      for (const group of groups) {
        const complaints = group?.complaints || {};
        yearN += Number(complaints.n) || 0;
        for (const item of complaints.byYear || []) {
          const year = Number(item?.year);
          const n = Number(item?.n) || 0;
          if (!Number.isInteger(year) || n <= 0) continue;
          received.set(year, (received.get(year) || 0) + n);
        }
      }
      modelN += yearN;
      const year = Number(yearKey);
      if (Number.isInteger(year)) modelYears.set(year, (modelYears.get(year) || 0) + yearN);
    }
    total += modelN;
    models.set(model.slug, modelN);
  }
  return { total, models, modelYears, received };
}

test("make complaint totals match the model pages and an offline recompute", () => {
  const summary = loadSummary();
  const complaintDate = loadMeta().dates.complaints;
  const records = loadMakeComplaintRecords();
  assert.equal(records.length, summary.makes.length);
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  let published = 0;
  let unpublished = 0;
  for (const make of summary.makes) {
    const record = bySlug.get(make.slug);
    const again = offline(make);
    const summaryTotal = summaryComplaintTotal(make);
    assert.equal(record.total, summaryTotal, make.slug);
    assert.equal(record.total, again.total, make.slug);
    assert.equal(record.models.length, make.models.length, make.slug);
    assert.equal(
      record.models.reduce((sum, model) => sum + model.n, 0),
      record.total,
      make.slug,
    );
    assert.equal(
      record.modelYears.reduce((sum, row) => sum + row.n, 0),
      record.total,
      make.slug,
    );
    for (let index = 1; index < record.models.length; index += 1) {
      const prev = record.models[index - 1];
      const curr = record.models[index];
      assert.ok(prev.n > curr.n || (prev.n === curr.n && prev.name.localeCompare(curr.name) <= 0), make.slug);
    }
    for (let index = 1; index < record.modelYears.length; index += 1) {
      assert.ok(record.modelYears[index - 1].year >= record.modelYears[index].year, make.slug);
    }
    const modelSlugs = new Set(make.models.map((model) => model.slug));
    for (const model of record.models) {
      assert.equal(modelSlugs.has(model.slug), true, `${make.slug}/${model.slug}`);
      assert.equal(model.n, again.models.get(model.slug), `${make.slug}/${model.slug}`);
      assert.equal(model.path, `/${make.slug}/${model.slug}/`);
    }
    for (const [year, n] of again.modelYears) {
      assert.equal(record.modelYears.find((row) => row.year === year).n, n, `${make.slug} ${year}`);
    }
    if (record.series) {
      assert.equal(record.series.total, record.total, make.slug);
      assert.equal(record.series.rows.reduce((sum, row) => sum + row.n, 0) + record.series.undated, record.total, make.slug);
      assert.ok(record.series.undated >= 0, make.slug);
      for (const [year, n] of again.received) {
        assert.equal(record.series.rows.find((row) => row.year === year).n, n, `${make.slug} ${year}`);
      }
    } else {
      assert.ok(
        record.total < RECEIVED_YEAR_MIN || [...again.received.values()].reduce((sum, n) => sum + n, 0) === 0,
        make.slug,
      );
    }
    for (const key of keysOf(record)) assert.equal(PII_KEYS.has(key.toLowerCase()), false, `${make.slug} ${key}`);
    assert.equal(Object.hasOwn(record, "components"), false, make.slug);
    assert.equal(Object.hasOwn(record, "top"), false, make.slug);
    assert.doesNotMatch(JSON.stringify(record), /\b[A-HJ-NPR-Z0-9]{17}\b/);
    const copy = makeComplaintCopy(record, complaintDate);
    assert.equal(MAKE_COMPLAINT_BANNED.test(copy), false, make.slug);
    if (record.total >= MAKE_COMPLAINT_MIN) {
      published += 1;
      assert.equal(record.path, `/${make.slug}/complaints/`);
      assert.equal(makeComplaintPath(make.slug), record.path);
      for (const phrase of MAKE_COMPLAINT_PHRASES) assert.ok(copy.includes(phrase), `${make.slug} missing ${phrase}`);
      assert.ok(copy.includes(formatDate(complaintDate)), make.slug);
      assert.ok(copy.includes(formatNumber(record.total)), make.slug);
      assert.equal(sentenceCount(copy.split("\n")[0]) <= 3, true, make.slug);
      if (record.series) assert.ok(copy.includes("LDATE"), make.slug);
    } else {
      unpublished += 1;
      assert.equal(record.path, "");
      assert.equal(makeComplaintPath(make.slug), "");
    }
  }
  assert.ok(published >= 1);
  assert.ok(unpublished >= 1);
  const pages = loadComplaintPages();
  assert.equal(pages.length, published);
  for (let index = 1; index < pages.length; index += 1) {
    assert.ok(pages[index - 1].total >= pages[index].total);
  }
  const paths = complaintSitemapPaths();
  assert.equal(paths.length, published + 1);
  assert.equal(paths[0], COMPLAINTS_INDEX);
  assert.deepEqual(new Set(paths), new Set([COMPLAINTS_INDEX, ...pages.map((page) => page.path)]));
  const indexCopy = complaintIndexCopy(complaintDate);
  assert.equal(MAKE_COMPLAINT_BANNED.test(indexCopy), false);
  for (const phrase of MAKE_COMPLAINT_PHRASES) assert.ok(indexCopy.includes(phrase), phrase);
  assert.equal(sentenceCount(indexCopy.split("\n")[0]) <= 3, true);
  assert.ok(indexCopy.includes(formatNumber(MAKE_COMPLAINT_MIN)));
  assert.ok(indexCopy.includes("at most ten components"));
});

test("Honda complaints add the model pages, and a make under the minimum has no page", () => {
  const complaintDate = loadMeta().dates.complaints;
  const honda = loadMakeComplaintRecords().find((record) => record.slug === "honda");
  const make = loadSummary().makes.find((item) => item.slug === "honda");
  const again = offline(make);
  assert.ok(honda);
  assert.ok(honda.total >= MAKE_COMPLAINT_MIN);
  assert.equal(honda.total, again.total);
  assert.equal(honda.path, "/honda/complaints/");
  assert.ok(honda.series);
  const fileYear = Number(complaintDate.slice(0, 4));
  const partialExpected = complaintDate.endsWith("-12-31") ? null : fileYear;
  const years = honda.series.rows.map((row) => row.year);
  assert.equal(
    honda.series.partialYear,
    partialExpected >= years[0] && partialExpected <= years.at(-1) ? partialExpected : null,
  );
  const civic = honda.models.find((model) => model.slug === "civic");
  assert.ok(civic);
  assert.equal(civic.n, again.models.get("civic"));
  assert.equal(civic.path, "/honda/civic/");
  assert.equal(honda.models.some((model) => !make.models.some((item) => item.slug === model.slug)), false);
  const below = loadMakeComplaintRecords().filter((record) => record.total < MAKE_COMPLAINT_MIN);
  assert.ok(below.length >= 1);
  assert.equal(below.every((record) => record.path === "" && makeComplaintPath(record.slug) === ""), true);
  const copy = makeComplaintCopy(honda, complaintDate);
  assert.equal(MAKE_COMPLAINT_BANNED.test(copy), false);
  assert.doesNotMatch(copy, /most problematic/i);
  assert.match(copy, /does not remove that overlap/);
  assert.match(copy, /Component categories are not listed/);
});
