import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mmyAnswer, modelAnswer } from "../src/lib/answer.js";
import { loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";

const BANNED = /\b(avoid|best|worst|reliable|unreliable)\b/i;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
const ROW_KEYS = ["component", "date", "id", "summary"];
const index = JSON.parse(readFileSync(new URL("../data/site/communication-ids.json", import.meta.url), "utf8"));

function idSort(value) {
  const text = String(value || "");
  if (/^\d+$/.test(text)) return [0, Number(text), text];
  return [1, 0, text];
}

function rowSort(row) {
  const date = String(row?.date || "");
  return [date ? 1 : 0, date, ...idSort(row?.id)];
}

function compareKeys(left, right) {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function headlineIds(doc, detail, yearEntry) {
  const ids = new Set();
  if (detail.splitNames) {
    for (const group of detail.also || []) {
      for (const id of yearEntry?.[group.norm] || []) ids.add(String(id));
    }
  } else {
    for (const id of yearEntry?.[doc.modelNorm] || []) ids.add(String(id));
  }
  return ids;
}

function assertRows(rows, ids, label) {
  assert.ok(rows.length <= 8, label);
  const seen = new Set();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, label);
    assert.equal(seen.has(row.id), false, label);
    seen.add(row.id);
    assert.equal(ids.has(String(row.id)), true, `${label} ${row.id}`);
    assert.equal(VIN.test(`${row.summary} ${row.component}`), false, label);
    assert.equal(BANNED.test(`${row.component}`), false, label);
  }
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(compareKeys(rowSort(rows[index - 1]), rowSort(rows[index])) >= 0, label);
  }
}

test("manufacturer communication counts match the imported ID lists", () => {
  const summary = loadSummary();
  const dates = loadMeta().dates;
  let pages = 0;
  let withRows = 0;
  const samples = [];
  for (const make of summary.makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      const modelTotal = model.years.reduce((sum, year) => sum + (year.communications || 0), 0);
      if (modelTotal > 0 && samples.length < 5) samples.push({ make, model });
      for (const row of model.years) {
        pages += 1;
        const detail = doc.years[String(row.y)];
        const yearEntry = index[`${make.slug}/${model.slug}`]?.[String(row.y)] || {};
        const expected = headlineIds(doc, detail, yearEntry);
        assert.equal(row.communications, expected.size, `${make.slug}/${model.slug}/${row.y}`);
        assert.equal(detail.communicationCount || 0, expected.size, `${make.slug}/${model.slug}/${row.y}`);
        const storedNorms = Object.keys(yearEntry).sort();
        const expectedNorms = new Set();
        if (!detail.splitNames && expected.size) expectedNorms.add(doc.modelNorm);
        for (const group of detail.also || []) {
          const groupIds = yearEntry[group.norm] || [];
          assert.equal(new Set(groupIds).size, groupIds.length, `${make.slug}/${model.slug}/${row.y} ${group.norm}`);
          assert.equal(group.communicationCount || 0, groupIds.length, `${make.slug}/${model.slug}/${row.y} ${group.norm}`);
          if (group.communicationCount) expectedNorms.add(group.norm);
          assertRows(group.communications || [], new Set(groupIds.map(String)), `${make.slug}/${model.slug}/${row.y} ${group.norm}`);
        }
        assert.deepEqual(storedNorms, [...expectedNorms].sort(), `${make.slug}/${model.slug}/${row.y}`);
        const shown = detail.communications || [];
        assertRows(shown, expected, `${make.slug}/${model.slug}/${row.y}`);
        if (shown.length) withRows += 1;
        if (row.communications > 0) {
          const answer = mmyAnswer({
            make: make.name,
            model: model.name,
            year: row.y,
            row,
            detail,
            dates,
          });
          assert.match(answer, /manufacturer communication/);
          assert.match(answer, /not a recall/);
          assert.equal(BANNED.test(answer), false, answer);
          assert.ok(sentenceCount(answer) <= 3, answer);
        }
      }
      if (modelTotal > 0) {
        const answer = modelAnswer(make.name, model.name, model.years, dates);
        assert.match(answer, /manufacturer communication/);
        assert.match(answer, /not a recall/);
        assert.equal(BANNED.test(answer), false, answer);
        assert.ok(sentenceCount(answer) <= 3, answer);
      }
    }
  }
  assert.ok(pages > 8000);
  assert.ok(withRows > 0);
  assert.ok(samples.length >= 5);
});
