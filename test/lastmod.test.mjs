import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadExamplePairs } from "../src/lib/compare-pairs.js";
import { loadHybridPairs } from "../src/lib/hybrid-pairs.js";
import {
  alignSitemapIndex,
  applyLedger,
  contentHashes,
  diskEnv,
  inspectSitemaps,
  isIsoDate,
  lastmodForPath,
  overlayEnv,
  readLedger,
  sourceFingerprints,
} from "../src/lib/lastmod.js";

const disk = diskEnv();
const baseline = contentHashes(disk);

function changedUrls(next) {
  const changed = [];
  for (const [url, hash] of baseline) {
    if (next.get(url) !== hash) changed.push(url);
  }
  for (const url of next.keys()) {
    if (!baseline.has(url)) changed.push(url);
  }
  return changed.sort();
}

function sampleYear() {
  const summary = JSON.parse(disk.read("data/site/summary.json"));
  for (const make of summary.makes) {
    const makeTotal = make.models.reduce(
      (sum, model) => sum + model.years.reduce((inner, row) => inner + (Number(row.complaints) || 0), 0),
      0,
    );
    if (makeTotal < 50 || make.models.length < 2) continue;
    for (const model of make.models) {
      if (!model.yearsPage || model.years.length < 2) continue;
      const doc = JSON.parse(disk.read(`data/site/models/${make.slug}/${model.slug}.json`));
      for (const row of model.years) {
        const detail = doc.years?.[String(row.y)];
        if (!detail || detail.splitNames) continue;
        if ((Number(detail.complaints?.n) || 0) < 1) continue;
        if (row.complaints !== detail.complaints.n) continue;
        const other = model.years.find((item) => item.y !== row.y);
        const otherModel = make.models.find((item) => item.slug !== model.slug && item.years.length);
        return {
          make: make.slug,
          model: model.slug,
          year: row.y,
          otherYear: other.y,
          otherModel: otherModel.slug,
          otherModelYear: otherModel.years[0].y,
        };
      }
    }
  }
  throw new Error("no model year with its own complaint count");
}

function bumpSample(sample) {
  const modelRel = `data/site/models/${sample.make}/${sample.model}.json`;
  const summaryRel = "data/site/summary.json";
  const doc = JSON.parse(disk.read(modelRel));
  doc.years[String(sample.year)].complaints.n += 1;
  const summary = JSON.parse(disk.read(summaryRel));
  const make = summary.makes.find((item) => item.slug === sample.make);
  const model = make.models.find((item) => item.slug === sample.model);
  const row = model.years.find((item) => item.y === sample.year);
  row.complaints += 1;
  return overlayEnv(disk, {
    [modelRel]: JSON.stringify(doc),
    [summaryRel]: JSON.stringify(summary),
  });
}

function pairUsesSample(pair, sample) {
  const sides = pair.left ? [pair.left, pair.right] : [pair.gas, pair.hybrid];
  return sides.some((side) => side.makeSlug === sample.make && side.modelSlug === sample.model && pair.year === sample.year);
}

test("an unchanged content hash keeps its date and a new hash takes today", () => {
  const today = "2026-11-18";
  const previous = {
    "/a/": { hash: "same", date: "2026-01-02" },
    "/b/": { hash: "old", date: "2026-01-02" },
    "/gone/": { hash: "x", date: "2026-01-02" },
  };
  const next = applyLedger(
    previous,
    new Map([
      ["/a/", "same"],
      ["/b/", "new"],
      ["/c/", "fresh"],
      ["/d/", ""],
    ]),
    today,
  );
  assert.equal(next["/a/"].date, "2026-01-02");
  assert.equal(next["/b/"].date, today);
  assert.equal(next["/c/"].date, today);
  assert.equal(Object.hasOwn(next, "/d/"), false);
  assert.equal(Object.hasOwn(next, "/gone/"), false);
  assert.equal(lastmodForPath("/missing/", { urls: next }), "");
});

test("a future ledger date is not kept", () => {
  const next = applyLedger({ "/a/": { hash: "same", date: "2999-01-01" } }, new Map([["/a/", "same"]]), "2026-11-18");
  assert.equal(next["/a/"].date, "2026-11-18");
});

test("committed lastmod ledger matches the current content hashes", () => {
  const ledger = readLedger();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(Object.keys(ledger.urls).length, baseline.size);
  for (const [url, hash] of baseline) {
    const entry = ledger.urls[url];
    assert.ok(entry, `ledger missing ${url}`);
    assert.equal(entry.hash, hash, url);
    assert.equal(isIsoDate(entry.date), true, url);
    assert.ok(entry.date <= today, `${url} lastmod ${entry.date} is after ${today}`);
  }
});

test("footer, header, layout, and css edits do not move any lastmod", () => {
  const overlay = overlayEnv(disk, {
    "src/components/Footer.astro": `${disk.read("src/components/Footer.astro")}\n<p>Footer only.</p>\n`,
    "src/components/Header.astro": `${disk.read("src/components/Header.astro")}\n<p>Header only.</p>\n`,
    "src/layouts/Base.astro": `${disk.read("src/layouts/Base.astro")}\n<!-- layout only -->\n`,
    "src/styles/global.css": `${disk.read("src/styles/global.css")}\nbody { outline: 1px solid transparent; }\n`,
  });
  const next = contentHashes(overlay);
  assert.deepEqual(changedUrls(next), []);
});

test("a page source edit is limited to that template", () => {
  const before = sourceFingerprints(disk);
  const rel = "src/pages/contact.astro";
  const after = sourceFingerprints(
    overlayEnv(disk, {
      [rel]: `${disk.read(rel)}\n<p>The contact page lists the office address.</p>\n`,
    }),
  );
  const changed = [...after.keys()].filter((key) => after.get(key) !== before.get(key));
  assert.deepEqual(changed, [rel]);
});

test("one model year's complaint count moves that page and the hubs that render it", () => {
  const sample = sampleYear();
  const next = contentHashes(bumpSample(sample));
  const changed = new Set(changedUrls(next));
  const yearPath = `/${sample.make}/${sample.model}/${sample.year}/`;
  const modelPath = `/${sample.make}/${sample.model}/`;
  const yearsPath = `/${sample.make}/${sample.model}/years/`;
  const makePath = `/${sample.make}/`;
  const makeComplaints = `/${sample.make}/complaints/`;
  for (const path of [yearPath, modelPath, makePath, "/complaints/"]) {
    assert.ok(changed.has(path), `expected ${path} to move; sample ${sample.make}/${sample.model}/${sample.year}`);
  }
  assert.equal(next.has(yearsPath), false, `${yearsPath} is noindex and has no sitemap lastmod`);
  assert.equal(next.has(makeComplaints), false, `${makeComplaints} is noindex and has no sitemap lastmod`);
  const hybridSlugs = new Set(
    loadHybridPairs()
      .filter((pair) => pairUsesSample(pair, sample))
      .map((pair) => `/compare/hybrid/${pair.slug}/`),
  );
  const compareSlugs = new Set(
    loadExamplePairs()
      .filter((pair) => pairUsesSample(pair, sample))
      .map((pair) => `/compare/${pair.slug}/`),
  );
  for (const url of changed) {
    const allowed =
      url === yearPath ||
      url.startsWith(`${yearPath}`) ||
      url === modelPath ||
      url === yearsPath ||
      url === makePath ||
      url === makeComplaints ||
      url === "/complaints/" ||
      hybridSlugs.has(url) ||
      compareSlugs.has(url);
    assert.ok(allowed, `unexpected lastmod move ${url}`);
  }
  assert.equal(changed.has(`/${sample.make}/${sample.model}/${sample.otherYear}/`), false);
  assert.equal(changed.has(`/${sample.make}/${sample.otherModel}/${sample.otherModelYear}/`), false);
  assert.equal(changed.has(`/${sample.make}/${sample.otherModel}/`), false);
  assert.equal(changed.has("/"), false);
  assert.equal(changed.has("/about/"), false);
  assert.equal(changed.has("/contact/"), false);
  assert.equal(changed.has("/compare/"), false);
  assert.equal(changed.has("/compare/hybrid/"), false);
  assert.ok(changed.size < 40, `moved ${changed.size} URLs for one model year`);
});

test("sitemap index lastmod is the newest lastmod in that child", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-sitemap-"));
  writeFileSync(
    join(dir, "sitemap-0.xml"),
    `<urlset><url><loc>https://vehiclefactbook.com/a/</loc><lastmod>2026-11-01T00:00:00.000Z</lastmod></url><url><loc>https://vehiclefactbook.com/b/</loc><lastmod>2026-11-17T00:00:00.000Z</lastmod></url></urlset>`,
  );
  writeFileSync(
    join(dir, "sitemap-1.xml"),
    `<urlset><url><loc>https://vehiclefactbook.com/c/</loc></url></urlset>`,
  );
  writeFileSync(
    join(dir, "sitemap-index.xml"),
    `<sitemapindex><sitemap><loc>https://vehiclefactbook.com/sitemap-0.xml</loc><lastmod>2020-01-01T00:00:00.000Z</lastmod></sitemap><sitemap><loc>https://vehiclefactbook.com/sitemap-1.xml</loc><lastmod>2020-01-01T00:00:00.000Z</lastmod></sitemap></sitemapindex>`,
  );
  alignSitemapIndex(dir);
  const inspected = inspectSitemaps(dir);
  assert.equal(inspected.index.find((entry) => entry.name === "sitemap-0.xml").lastmod, "2026-11-17T00:00:00.000Z");
  assert.equal(inspected.index.find((entry) => entry.name === "sitemap-1.xml").lastmod, "");
  assert.equal(readFileSync(join(dir, "sitemap-1.xml"), "utf8").includes("<lastmod>"), false);
});
