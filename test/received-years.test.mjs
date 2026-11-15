import assert from "node:assert/strict";
import test from "node:test";
import { loadMeta, loadModel, loadSummary, modelPaths } from "../src/lib/catalog.js";
import { formatDate, formatNumber } from "../src/lib/format.js";
import {
  RECEIVED_YEAR_BANNED,
  RECEIVED_YEAR_MIN,
  RECEIVED_YEAR_PHRASES,
  receivedYearCaption,
  receivedYearCaveat,
  receivedYearChart,
  receivedYearCopy,
  receivedYearIntro,
  receivedYearLabel,
  receivedYearSeries,
} from "../src/lib/received-years.js";

const PII_KEYS = new Set([
  "vin",
  "vins",
  "city",
  "dealer",
  "narrative",
  "cdescr",
  "odino",
  "operator",
  "phone",
  "vehicle_operator",
]);

function offline(doc) {
  const counts = new Map();
  let total = 0;
  for (const yearRow of Object.values(doc?.years || {})) {
    const groups = yearRow?.splitNames ? yearRow.also || [] : [yearRow];
    for (const group of groups) {
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
  let dated = 0;
  for (const n of counts.values()) dated += n;
  return { counts, total, dated, undated: total - dated };
}

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

test("received-year counts match an offline recompute and add up to the model total", () => {
  const summary = loadSummary();
  const complaintDate = loadMeta().dates.complaints;
  const fileYear = Number(String(complaintDate).slice(0, 4));
  const partialExpected = complaintDate.endsWith("-12-31") ? null : fileYear;
  let shown = 0;
  let hidden = 0;
  for (const make of summary.makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      const again = offline(doc);
      const summaryTotal = model.years.reduce((sum, year) => sum + (Number(year.complaints) || 0), 0);
      const label = `${make.slug}/${model.slug}`;
      assert.equal(again.total, summaryTotal, label);
      const series = receivedYearSeries(doc, complaintDate);
      if (summaryTotal < RECEIVED_YEAR_MIN || again.dated <= 0) {
        assert.equal(series, null, label);
        hidden += 1;
        continue;
      }
      shown += 1;
      assert.equal(series.total, summaryTotal, label);
      assert.equal(series.dated, again.dated, label);
      assert.equal(series.undated, again.undated, label);
      assert.equal(
        series.rows.reduce((sum, row) => sum + row.n, 0) + series.undated,
        series.total,
        label,
      );
      for (const row of series.rows) assert.equal(row.n, again.counts.get(row.year) || 0, `${label} ${row.year}`);
      for (const [year, n] of again.counts) {
        const row = series.rows.find((item) => item.year === year);
        assert.ok(row, `${label} missing ${year}`);
        assert.equal(row.n, n, `${label} ${year}`);
      }
      const years = series.rows.map((row) => row.year);
      assert.deepEqual(
        years,
        Array.from({ length: years.at(-1) - years[0] + 1 }, (_, index) => years[0] + index),
        label,
      );
      assert.equal(series.partialYear, partialExpected >= years[0] && partialExpected <= years.at(-1) ? partialExpected : null);
      assert.equal(series.rows.filter((row) => row.partial).length, series.partialYear ? 1 : 0);
      const copy = receivedYearCopy(make.name, model.name, series);
      assert.equal(RECEIVED_YEAR_BANNED.test(copy), false, label);
      for (const phrase of RECEIVED_YEAR_PHRASES) assert.ok(copy.includes(phrase), `${label} missing ${phrase}`);
      assert.ok(copy.includes(formatDate(complaintDate)), label);
      assert.equal(copy.includes(formatNumber(series.dated)), true, label);
      for (const key of keysOf(series)) assert.equal(PII_KEYS.has(key.toLowerCase()), false, `${label} ${key}`);
      assert.equal(Object.hasOwn(series, "path"), false, label);
      assert.doesNotMatch(copy, /\b[A-HJ-NPR-Z0-9]{17}\b/);
    }
  }
  assert.ok(shown >= 1);
  assert.ok(hidden >= 1);
});

test("Honda Civic received years are the offline LDATE sums, with the file year partial", () => {
  const complaintDate = loadMeta().dates.complaints;
  const doc = loadModel("honda", "civic");
  const again = offline(doc);
  const series = receivedYearSeries(doc, complaintDate);
  assert.ok(series);
  assert.equal(series.total, again.total);
  assert.equal(series.undated, 0);
  const fileYear = Number(complaintDate.slice(0, 4));
  const partialExpected = complaintDate.endsWith("-12-31") ? null : fileYear;
  assert.equal(series.partialYear, partialExpected);
  for (const [year, n] of again.counts) {
    assert.equal(series.rows.find((row) => row.year === year).n, n);
  }
  if (series.partialYear) {
    assert.equal(receivedYearLabel(series.rows.find((row) => row.partial)), `${series.partialYear} (partial)`);
  }
  const chart = receivedYearChart(series);
  assert.equal(chart.bars.length, series.rows.length);
  const max = Math.max(...series.rows.map((row) => row.n));
  for (const bar of chart.bars) {
    const scaled = Math.round((bar.n / max) * chart.plotH);
    assert.equal(bar.height, bar.n > 0 ? Math.max(2, scaled) : 0);
    assert.equal(bar.partial, bar.year === series.partialYear);
  }
  assert.ok(chart.bars.filter((bar) => bar.n > 0).every((bar) => bar.height >= 2));
  const tallest = chart.bars.reduce((current, bar) => (bar.height > current.height ? bar : current));
  assert.equal(tallest.n, max);
});

test("exact headlines ignore other names, and split headlines sum the matched names", () => {
  const exact = {
    years: {
      2010: {
        splitNames: false,
        complaints: { n: 10, byYear: [{ year: 2011, n: 10 }] },
        also: [{ complaints: { n: 50, byYear: [{ year: 2011, n: 50 }] } }],
      },
    },
  };
  const exactSeries = receivedYearSeries(exact, "2011-06-01");
  assert.equal(exactSeries.total, 10);
  assert.equal(exactSeries.rows.find((row) => row.year === 2011).n, 10);
  assert.equal(exactSeries.partialYear, 2011);

  const split = {
    years: {
      2010: {
        splitNames: true,
        complaints: { n: 99, byYear: [{ year: 2014, n: 99 }] },
        also: [
          { complaints: { n: 6, byYear: [{ year: 2011, n: 6 }] } },
          { complaints: { n: 5, byYear: [{ year: 2011, n: 4 }, { year: 2012, n: 1 }] } },
        ],
      },
    },
  };
  const splitSeries = receivedYearSeries(split, "2012-12-31");
  assert.equal(splitSeries.total, 11);
  assert.equal(splitSeries.partialYear, null);
  assert.equal(splitSeries.rows.find((row) => row.year === 2011).n, 10);
  assert.equal(splitSeries.rows.find((row) => row.year === 2012).n, 1);
  assert.equal(splitSeries.rows.some((row) => row.year === 2014), false);
});

test("missing received dates explain the gap, and small totals omit the section", () => {
  const missing = {
    years: {
      2018: { complaints: { n: 12, byYear: [{ year: 2019, n: 10 }] } },
    },
  };
  const series = receivedYearSeries(missing, "2026-11-09");
  assert.equal(series.total, 12);
  assert.equal(series.dated, 10);
  assert.equal(series.undated, 2);
  assert.equal(series.rows.reduce((sum, row) => sum + row.n, 0), 10);
  assert.match(receivedYearIntro("Example", "Car", series), /2 complaints have no received date/);
  assert.match(receivedYearCaption(series), /2026 is a partial year/);
  assert.equal(receivedYearCaveat().includes("raw counts, not rates"), true);

  const small = {
    years: {
      2018: { complaints: { n: RECEIVED_YEAR_MIN - 1, byYear: [{ year: 2019, n: RECEIVED_YEAR_MIN - 1 }] } },
    },
  };
  assert.equal(receivedYearSeries(small, "2026-11-09"), null);

  const undated = {
    years: {
      2018: { complaints: { n: 15, byYear: [] } },
    },
  };
  assert.equal(receivedYearSeries(undated, "2026-11-09"), null);
});

test("the received-year section adds no model route", () => {
  const paths = modelPaths();
  assert.equal(paths.length, loadSummary().makes.reduce((sum, make) => sum + make.models.length, 0));
  assert.equal(paths.some((path) => String(path.params.model).includes("received")), false);
  assert.equal(paths.some((path) => Object.keys(path.params).length !== 2), false);
});
