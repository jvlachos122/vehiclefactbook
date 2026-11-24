// Per-URL sitemap lastmod.
//
// data/lastmod.json maps each sitemap path to a hash of that page's main
// content and the date the hash last changed. A path new to the ledger gets
// the UTC date it first appears. The same hash keeps the previous date, so a
// refresh that rewrites files without changing the rendered numbers does not
// move lastmod.
//
// The hash is the page template and the modules that render its article,
// plus the data rows that article shows. It does not include the shared
// layout, header, footer, the answer/data-note wrappers, global CSS, JSON-LD
// builders, or the file-vintage dates (meta.dates, fetchedAt, retrieved).
// Those can change without a change to the numbers on the page.
//
// A value that cannot be hashed is left out of the ledger. The sitemap then
// omits <lastmod> for that URL instead of inventing a date.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndexableCampaigns } from "./campaigns.js";
import { displayedComplaints, modelHasComponentPage, qualifyingComponents } from "./components.js";
import { loadExamplePairs } from "./compare-pairs.js";
import { loadPriceSnapshot } from "./eia-prices.js";
import { loadEvRangePages } from "./ev-range.js";
import { fuelExampleFingerprint } from "./fuel-calculator-examples.js";
import { loadFuelCostCatalog } from "./fuel-classes.js";
import { loadHybridPairs } from "./hybrid-pairs.js";
import { loadInvestigationPages, makeInvestigationCount, modelInvestigationCount } from "./investigations.js";
import { complaintSitemapPaths, MAKE_COMPLAINT_MIN } from "./make-complaints.js";
import { complaintHeadlineGroups } from "./received-years.js";
import { loadSafetyPages } from "./safety-ratings.js";
import { loadScorePages } from "./scores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const LEDGER_PATH = "data/lastmod.json";

const IGNORE_EXACT = new Set([
  "src/components/Header.astro",
  "src/components/Footer.astro",
  "src/components/Answer.astro",
  "src/components/DataNote.astro",
  "src/lib/schema.js",
  "src/lib/jsonld-audit.js",
  "src/lib/catalog.js",
]);
const IGNORE_PREFIX = ["src/layouts/", "src/styles/"];
const STRIP_KEY = /^(fetched|fetchedAt|fetchedByYear|generatedAt|retrieved)$/i;
const EIA_TEMPLATES = new Set([
  "src/pages/compare/hybrid/[pair].astro",
  "src/pages/tools/fuel-cost-calculator.astro",
  "src/pages/tools/trip-fuel-cost.astro",
  "src/pages/methodology.astro",
]);

const TEMPLATES = {
  make: "src/pages/[make]/index.astro",
  model: "src/pages/[make]/[model]/index.astro",
  years: "src/pages/[make]/[model]/years.astro",
  mmy: "src/pages/[make]/[model]/[year]/index.astro",
  component: "src/pages/[make]/[model]/[year]/[component].astro",
  range: "src/pages/[make]/[model]/range.astro",
  makeComplaints: "src/pages/[make]/complaints/index.astro",
  compare: "src/pages/compare/[pair].astro",
  hybrid: "src/pages/compare/hybrid/[pair].astro",
  fuel: "src/pages/fuel-cost/[slug].astro",
  safety: "src/pages/safety-ratings/[slug].astro",
  safetyYear: "src/pages/safety-ratings/[slug]/[year].astro",
  score: "src/pages/smog-and-ghg-scores/[slug].astro",
  scoreYear: "src/pages/smog-and-ghg-scores/[slug]/[year].astro",
  investigation: "src/pages/investigations/[action].astro",
  campaign: "src/pages/recalls/[campno].astro",
};

export function diskEnv() {
  return {
    read(rel) {
      return readFileSync(join(ROOT, rel), "utf8");
    },
  };
}

export function overlayEnv(base, files) {
  return {
    read(rel) {
      if (Object.prototype.hasOwnProperty.call(files, rel)) return files[rel];
      return base.read(rel);
    },
  };
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function lastmodInstant(value) {
  if (isIsoDate(value)) return Date.parse(`${value}T00:00:00.000Z`);
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`invalid lastmod ${value}`);
  return time;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (STRIP_KEY.test(key)) continue;
    if (value[key] === undefined) continue;
    out[key] = stable(value[key]);
  }
  return out;
}

function canon(value) {
  return JSON.stringify(stable(value));
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const next = [];
    for (const child of value) {
      const item = numeric(child);
      if (item !== undefined) next.push(item);
    }
    return next.length ? next : undefined;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (STRIP_KEY.test(key)) continue;
    const item = numeric(child);
    if (item === undefined) continue;
    out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function ignored(rel) {
  if (!rel || rel.endsWith(".css")) return true;
  if (IGNORE_EXACT.has(rel)) return true;
  return IGNORE_PREFIX.some((prefix) => rel.startsWith(prefix));
}

function importedSpecs(source) {
  const specs = new Set();
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specs.add(match[1]);
  for (const match of source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) specs.add(match[1]);
  return specs;
}

function resolveSpec(fromRel, spec) {
  const base = normalize(join(dirname(fromRel), spec)).replaceAll("\\", "/");
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.astro`, `${base}.json`];
  for (const candidate of candidates) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  return "";
}

function contentFiles(entryRel, env) {
  const files = new Set();
  const seen = new Set();
  const stack = [entryRel];
  while (stack.length) {
    const rel = stack.pop();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    if (ignored(rel)) continue;
    files.add(rel);
    if (/\.(json|svg|png|woff2?)$/.test(rel)) continue;
    const source = env.read(rel);
    for (const spec of importedSpecs(source)) {
      const resolved = resolveSpec(rel, spec);
      if (resolved) stack.push(resolved);
    }
  }
  return files;
}

function fingerprint(files, env) {
  const hash = createHash("sha256");
  for (const rel of [...files].sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(env.read(rel));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkPages(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkPages(full, out);
    else if (entry.name.endsWith(".astro")) out.push(relative(ROOT, full).replaceAll("\\", "/"));
  }
  return out;
}

function pageTemplates() {
  return walkPages(join(ROOT, "src/pages")).filter((rel) => rel !== "src/pages/404.astro");
}

function staticPath(rel) {
  if (rel.includes("[")) return "";
  let path = rel.slice("src/pages/".length).replace(/\.astro$/, "");
  if (path.endsWith("/index")) path = path.slice(0, -"/index".length);
  else if (path === "index") path = "";
  return path ? `/${path}/` : "/";
}

export function sourceFingerprints(env = diskEnv()) {
  const map = new Map();
  for (const rel of pageTemplates()) map.set(rel, fingerprint(contentFiles(rel, env), env));
  return map;
}

function complaintCount(detail) {
  if (!detail) return 0;
  if (detail.splitNames) {
    return (detail.also || []).reduce((sum, group) => sum + (Number(group?.complaints?.n) || 0), 0);
  }
  return Number(detail.complaints?.n) || 0;
}

function receivedFingerprint(doc) {
  const counts = new Map();
  let total = 0;
  for (const yearRow of Object.values(doc?.years || {})) {
    for (const group of complaintHeadlineGroups(yearRow)) {
      const complaints = group?.complaints || {};
      total += Number(complaints.n) || 0;
      for (const item of complaints.byYear || []) {
        const year = Number(item?.year);
        const count = Number(item?.n) || 0;
        if (!Number.isInteger(year) || count <= 0) continue;
        counts.set(year, (counts.get(year) || 0) + count);
      }
    }
  }
  const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }));
  if (total < 10 || !rows.length) return { shown: false };
  return { shown: true, total, rows };
}

function evSpan(detail) {
  let min = null;
  let max = null;
  for (const config of detail?.configs || []) {
    if (config?.atv !== "EV") continue;
    const range = Number(config.range);
    if (!Number.isFinite(range) || range <= 0) continue;
    min = min == null ? range : Math.min(min, range);
    max = max == null ? range : Math.max(max, range);
  }
  return [min, max];
}

function recallsOf(detail) {
  const list = [];
  for (const recall of detail?.recalls || []) list.push(recall);
  for (const group of detail?.also || []) {
    for (const recall of group?.recalls || []) list.push(recall);
  }
  return list;
}

function sameSet(left, right, label) {
  if (left.size !== right.size || [...left].some((item) => !right.has(item))) {
    const missing = [...left].filter((item) => !right.has(item)).slice(0, 5);
    const extra = [...right].filter((item) => !left.has(item)).slice(0, 5);
    throw new Error(`${label} paths diverged; missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
  }
}

function sideMpg(side) {
  return {
    makeSlug: side.makeSlug,
    modelSlug: side.modelSlug,
    classFamily: side.classFamily,
    fuel: side.fuel,
    rows: side.rows,
    mpgMin: side.mpgMin,
    mpgMax: side.mpgMax,
    cityMin: side.cityMin,
    cityMax: side.cityMax,
    hwyMin: side.hwyMin,
    hwyMax: side.hwyMax,
    costMin: side.costMin,
    costMax: side.costMax,
    kwhMin: side.kwhMin,
    kwhMax: side.kwhMax,
    rangeMin: side.rangeMin,
    rangeMax: side.rangeMax,
  };
}

function pairBody(pair) {
  const side = (item) => ({
    makeSlug: item.makeSlug,
    modelSlug: item.modelSlug,
    makeName: item.makeName,
    modelName: item.modelName,
    classFamily: item.classFamily,
    fuelType: item.fuelType,
    evOnly: item.evOnly,
    match: item.match,
    splitNames: item.splitNames,
    headlineExact: item.headlineExact,
    mpgMin: item.mpgMin,
    mpgMax: item.mpgMax,
    cityMin: item.cityMin,
    cityMax: item.cityMax,
    hwyMin: item.hwyMin,
    hwyMax: item.hwyMax,
    mpgeMin: item.mpgeMin,
    mpgeMax: item.mpgeMax,
    kwhMin: item.kwhMin,
    kwhMax: item.kwhMax,
    rangeMin: item.rangeMin,
    rangeMax: item.rangeMax,
    costMin: item.costMin,
    costMax: item.costMax,
    starMin: item.starMin,
    starMax: item.starMax,
    ncapVariants: item.ncapVariants,
    ncapUnrated: item.ncapUnrated,
  });
  return {
    slug: pair.slug,
    year: pair.year,
    classFamily: pair.classFamily,
    configCount: pair.configCount,
    left: side(pair.left),
    right: side(pair.right),
  };
}

function buildContent(env) {
  const summary = JSON.parse(env.read("data/site/summary.json"));
  const meta = JSON.parse(env.read("data/site/meta.json"));
  const partHashes = new Map();
  const urls = new Map();

  function assign(url, template, parts) {
    if (!url || !url.startsWith("/")) throw new Error(`bad sitemap path ${url}`);
    if (urls.has(url)) throw new Error(`duplicate sitemap path ${url}`);
    urls.set(url, { template, parts: [...new Set(parts)] });
  }

  function addParts(url, parts) {
    const info = urls.get(url);
    if (!info) throw new Error(`no sitemap path ${url} for extra content`);
    info.parts.push(...parts);
  }

  partHashes.set("meta-counts", sha(canon(numeric(meta.counts) || {})));
  partHashes.set("meta-ncap", sha(canon(meta.ncap || {})));
  const prices = loadPriceSnapshot(env.read("data/eia-fuel-prices.csv")).map((row) => {
    const { retrieved, ...rest } = row;
    return rest;
  });
  partHashes.set("eia", sha(canon(prices)));
  const sources = JSON.parse(env.read("data/sources.json"));
  const sourceNames = Object.values(sources)
    .map((item) => item?.textFile || "")
    .filter(Boolean)
    .sort();
  partHashes.set("sources-names", sha(canon(sourceNames)));
  partHashes.set("recent", sha(canon(JSON.parse(env.read("data/recent.json")))));
  const advisories = JSON.parse(env.read("data/site/advisories.json"));
  partHashes.set("advisory:doNotDrive", sha(canon(advisories.doNotDrive || [])));
  partHashes.set("advisory:parkOutside", sha(canon(advisories.parkOutside || [])));
  partHashes.set("advisory:takata", sha(canon(advisories.takata || [])));

  const rowIds = new Map();
  for (const make of summary.makes || []) {
    for (const model of make.models || []) {
      for (const row of model.years || []) {
        const id = `row:${make.slug}/${model.slug}/${row.y}`;
        rowIds.set(`${make.slug}/${model.slug}/${row.y}`, id);
        partHashes.set(id, sha(canon(row)));
      }
    }
  }

  const makeRollups = new Map();
  const complaintRollups = [];
  const componentPaths = new Set();

  for (const make of summary.makes || []) {
    let makeComplaints = 0;
    const modelRows = [];
    const campaigns = new Map();
    for (const model of make.models || []) {
      const doc = JSON.parse(env.read(`data/site/models/${make.slug}/${model.slug}.json`));
      const receivedId = `received:${make.slug}/${model.slug}`;
      partHashes.set(receivedId, sha(canon(receivedFingerprint(doc))));
      const componentItems = [];
      let complaints = 0;
      let rangeMin = null;
      let rangeMax = null;
      let minY = null;
      let maxY = null;
      let starMin = null;
      let starMax = null;
      let latestRated = null;
      for (const row of model.years || []) {
        const detail = doc.years?.[String(row.y)] || null;
        const detailId = `detail:${make.slug}/${model.slug}/${row.y}`;
        partHashes.set(detailId, sha(canon(detail)));
        complaints += complaintCount(detail);
        const [low, high] = evSpan(detail);
        if (low != null) rangeMin = rangeMin == null ? low : Math.min(rangeMin, low);
        if (high != null) rangeMax = rangeMax == null ? high : Math.max(rangeMax, high);
        if (minY == null || row.y < minY) minY = row.y;
        if (maxY == null || row.y > maxY) maxY = row.y;
        if (row.y >= 2011 && row.starMin != null && row.starMax != null) {
          starMin = starMin == null ? row.starMin : Math.min(starMin, row.starMin);
          starMax = starMax == null ? row.starMax : Math.max(starMax, row.starMax);
          if (latestRated == null || row.y > latestRated) latestRated = row.y;
        }
        for (const recall of recallsOf(detail)) {
          const camp = String(recall?.camp || "");
          if (!camp) continue;
          const item = campaigns.get(camp) || {
            camp,
            date: "",
            component: String(recall.component || ""),
            dnd: false,
            park: false,
            models: new Map(),
          };
          if (recall.date && (!item.date || recall.date < item.date)) item.date = recall.date;
          item.dnd = item.dnd || Boolean(recall.dnd);
          item.park = item.park || Boolean(recall.park);
          const years = item.models.get(model.slug) || { slug: model.slug, name: model.name, years: [] };
          years.years.push(row.y);
          item.models.set(model.slug, years);
          campaigns.set(camp, item);
        }
        const displayed = displayedComplaints(detail);
        if (!displayed) continue;
        const listN = Number(displayed.complaints?.n) || 0;
        for (const item of qualifyingComponents(displayed.complaints)) {
          componentItems.push({
            year: row.y,
            component: item.component,
            slug: item.slug,
            n: item.n,
            listN,
            split: displayed.split,
            mmyN: Number(row.complaints) || 0,
            path: `/${make.slug}/${model.slug}/${row.y}/${item.slug}/`,
          });
        }
      }
      const grouped = new Map();
      for (const item of componentItems) {
        const list = grouped.get(item.year) || [];
        list.push(item);
        grouped.set(item.year, list);
      }
      for (const item of componentItems) {
        const siblings = (grouped.get(item.year) || [])
          .filter((other) => other.slug !== item.slug)
          .map((other) => ({ slug: other.slug, n: other.n }))
          .sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug));
        const payload = { n: item.n, listN: item.listN, siblings };
        if (item.split && item.mmyN !== item.listN) payload.mmyN = item.mmyN;
        partHashes.set(`component:${item.path}`, sha(canon(payload)));
        componentPaths.add(item.path);
      }
      partHashes.set(
        `components:${make.slug}/${model.slug}`,
        sha(canon(componentItems.map((item) => ({ year: item.year, slug: item.slug, n: item.n })))),
      );
      const linkId = `model-links:${make.slug}/${model.slug}`;
      const rowPart = (model.years || []).map((row) => rowIds.get(`${make.slug}/${model.slug}/${row.y}`));
      assign(`/${make.slug}/${model.slug}/`, TEMPLATES.model, [...rowPart, receivedId, linkId]);
      if (model.yearsPage) {
        assign(`/${make.slug}/${model.slug}/years/`, TEMPLATES.years, [
          ...rowPart,
          `components:${make.slug}/${model.slug}`,
          linkId,
        ]);
      }
      for (const row of model.years || []) {
        assign(`/${make.slug}/${model.slug}/${row.y}/`, TEMPLATES.mmy, [
          `detail:${make.slug}/${model.slug}/${row.y}`,
          rowIds.get(`${make.slug}/${model.slug}/${row.y}`),
        ]);
      }
      for (const item of componentItems) {
        assign(item.path, TEMPLATES.component, [`component:${item.path}`]);
      }
      makeComplaints += complaints;
      modelRows.push({
        slug: model.slug,
        name: model.name,
        minY,
        maxY,
        complaints,
        starMin,
        starMax,
        latestRated,
        rangeMin,
        rangeMax,
      });
    }
    const campaignList = [...campaigns.values()]
      .map((item) => ({
        camp: item.camp,
        date: item.date,
        component: item.component,
        dnd: item.dnd,
        park: item.park,
        models: [...item.models.values()]
          .map((model) => ({ ...model, years: [...new Set(model.years)].sort((a, b) => a - b) }))
          .sort((a, b) => a.slug.localeCompare(b.slug)),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.camp < b.camp ? 1 : -1));
    partHashes.set(
      `make:${make.slug}`,
      sha(
        canon({
          models: modelRows.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)),
          campaigns: campaignList,
          investigations: makeInvestigationCount(make.slug),
        }),
      ),
    );
    assign(`/${make.slug}/`, TEMPLATES.make, [`make:${make.slug}`]);
    complaintRollups.push({ slug: make.slug, name: make.name, total: makeComplaints, models: modelRows.length });
    if (makeComplaints >= MAKE_COMPLAINT_MIN) {
      partHashes.set(`complaints:${make.slug}`, sha(canon({ total: makeComplaints, models: modelRows.map((row) => ({ slug: row.slug, n: row.complaints })) })));
      assign(`/${make.slug}/complaints/`, TEMPLATES.makeComplaints, [`complaints:${make.slug}`]);
    }
  }
  partHashes.set("complaints-index", sha(canon(complaintRollups)));

  const officialComplaints = new Set(complaintSitemapPaths());
  const builtComplaints = new Set(["/complaints/"]);
  for (const url of urls.keys()) {
    if (url.endsWith("/complaints/")) builtComplaints.add(url);
  }
  sameSet(officialComplaints, builtComplaints, "complaints");
  sameSet(componentPaths, new Set([...urls.keys()].filter((url) => url.split("/").length === 6)), "component");

  for (const rel of pageTemplates()) {
    const path = staticPath(rel);
    if (path) assign(path, rel, []);
  }

  partHashes.set("fuel-examples", sha(canon(fuelExampleFingerprint())));
  addParts("/tools/fuel-cost-calculator/", ["fuel-examples"]);

  addParts("/", ["home-makes", "section-sizes"]);
  partHashes.set(
    "home-makes",
    sha(canon((summary.makes || []).map((make) => ({ slug: make.slug, name: make.name, models: make.models.length })))),
  );
  partHashes.set(
    "section-sizes",
    sha(
      canon({
        ev: loadEvRangePages().length,
        fuel: loadFuelCostCatalog().pages.length,
        safety: loadSafetyPages().length,
        scores: loadScorePages().length,
        investigations: loadInvestigationPages().length,
        complaints: complaintRollups.filter((make) => make.total >= MAKE_COMPLAINT_MIN).length,
      }),
    ),
  );
  addParts("/complaints/", ["complaints-index"]);
  addParts("/methodology/", ["sources-names"]);
  addParts("/recalls/this-week/", ["recent"]);
  addParts("/recalls/do-not-drive/", ["advisory:doNotDrive"]);
  addParts("/recalls/park-outside/", ["advisory:parkOutside"]);
  addParts("/recalls/takata-airbag/", ["advisory:takata"]);

  const fuel = loadFuelCostCatalog();
  const fuelIndex = [];
  for (const page of fuel.pages) {
    partHashes.set(`fuel:${page.path}`, sha(canon(page)));
    assign(page.path, TEMPLATES.fuel, [`fuel:${page.path}`]);
    fuelIndex.push({ slug: page.slug, low: page.low, high: page.high, modelCount: page.modelCount, configCount: page.configCount });
  }
  partHashes.set("fuel-index", sha(canon({ years: fuel.years, omitted: fuel.omitted, blankClass: fuel.blankClass, pages: fuelIndex })));
  addParts("/fuel-cost/", ["fuel-index"]);

  const safetyIndex = [];
  for (const page of loadSafetyPages()) {
    partHashes.set(`safety:${page.path}`, sha(canon(page)));
    assign(page.path, TEMPLATES.safety, [`safety:${page.path}`]);
    safetyIndex.push({ slug: page.slug, ratedCount: page.ratedCount, fiveCount: page.fiveCount, notRatedCount: page.notRatedCount });
    for (const yearRow of page.byYear || []) {
      if (!yearRow.path) continue;
      partHashes.set(`safety-year:${yearRow.path}`, sha(canon(yearRow)));
      assign(yearRow.path, TEMPLATES.safetyYear, [`safety-year:${yearRow.path}`]);
    }
  }
  partHashes.set("safety-index", sha(canon(safetyIndex)));
  addParts("/safety-ratings/", ["safety-index"]);

  const scoreIndex = [];
  for (const page of loadScorePages()) {
    partHashes.set(`score:${page.path}`, sha(canon(page)));
    assign(page.path, TEMPLATES.score, [`score:${page.path}`]);
    scoreIndex.push({ slug: page.slug, score10: page.score10, score9: page.score9, notAvailable: page.notAvailable });
    for (const yearRow of page.byYear || []) {
      if (!yearRow.path) continue;
      partHashes.set(`score-year:${yearRow.path}`, sha(canon(yearRow)));
      assign(yearRow.path, TEMPLATES.scoreYear, [`score-year:${yearRow.path}`]);
    }
  }
  partHashes.set("score-index", sha(canon(scoreIndex)));
  addParts("/smog-and-ghg-scores/", ["score-index"]);

  const evIndex = [];
  for (const page of loadEvRangePages()) {
    partHashes.set(`ev:${page.path}`, sha(canon(page)));
    assign(page.path, TEMPLATES.range, [`ev:${page.path}`]);
    evIndex.push({ path: page.path, rows: page.rows?.length || 0, high: page.high, low: page.low });
  }
  partHashes.set("ev-index", sha(canon(evIndex)));
  addParts("/ev-range/", ["ev-index"]);

  const investigationIndex = [];
  for (const record of loadInvestigationPages()) {
    partHashes.set(`investigation:${record.path}`, sha(canon(record)));
    assign(record.path, TEMPLATES.investigation, [`investigation:${record.path}`]);
    investigationIndex.push({
      action: record.action,
      subject: record.subject,
      component: record.component,
      opened: record.opened,
      mmy: record.mmy,
    });
  }
  partHashes.set("investigation-index", sha(canon(investigationIndex)));
  addParts("/investigations/", ["investigation-index"]);

  for (const campaign of loadIndexableCampaigns()) {
    const path = `/recalls/${campaign.camp}/`;
    partHashes.set(`campaign:${path}`, sha(canon(campaign)));
    assign(path, TEMPLATES.campaign, [`campaign:${path}`]);
  }

  const hybridMpg = [];
  for (const pair of loadHybridPairs()) {
    const path = `/compare/hybrid/${pair.slug}/`;
    const mpgId = `hybrid-mpg:${pair.slug}`;
    partHashes.set(mpgId, sha(canon({ year: pair.year, kind: pair.kind, gas: sideMpg(pair.gas), hybrid: sideMpg(pair.hybrid) })));
    hybridMpg.push(mpgId);
    const parts = [mpgId];
    for (const side of [pair.gas, pair.hybrid]) {
      const rowId = rowIds.get(`${side.makeSlug}/${side.modelSlug}/${pair.year}`);
      if (!rowId) throw new Error(`hybrid pair ${pair.slug} has no summary row for ${side.makeSlug}/${side.modelSlug}/${pair.year}`);
      parts.push(rowId);
    }
    assign(path, TEMPLATES.hybrid, parts);
  }
  addParts("/compare/hybrid/", hybridMpg);

  const compareBodies = [];
  for (const pair of loadExamplePairs()) {
    const path = `/compare/${pair.slug}/`;
    const bodyId = `pair:${pair.slug}`;
    partHashes.set(bodyId, sha(canon(pairBody(pair))));
    compareBodies.push(bodyId);
    const parts = [bodyId];
    for (const side of [pair.left, pair.right]) {
      const rowId = rowIds.get(`${side.makeSlug}/${side.modelSlug}/${pair.year}`);
      if (!rowId) throw new Error(`compare pair ${pair.slug} has no summary row for ${side.makeSlug}/${side.modelSlug}/${pair.year}`);
      parts.push(rowId);
    }
    assign(path, TEMPLATES.compare, parts);
  }
  addParts("/compare/", compareBodies);

  for (const [url, info] of urls) {
    const text = env.read(info.template);
    if (text.includes("meta.counts")) info.parts.push("meta-counts");
    if (text.includes("meta.ncap")) info.parts.push("meta-ncap");
    if (EIA_TEMPLATES.has(info.template)) info.parts.push("eia");
    info.parts = [...new Set(info.parts)];
  }

  // The model page links to the fuel-class pages that list it. That is the
  // class path, not the class table, so a different model's mpg does not move it.
  const fuelByModel = new Map();
  for (const page of fuel.pages) {
    for (const key of page.modelKeys || []) {
      const list = fuelByModel.get(key) || [];
      list.push(page.path);
      fuelByModel.set(key, list);
    }
  }
  const evByModel = new Map(loadEvRangePages().map((page) => [`${page.makeSlug}/${page.modelSlug}`, page.path]));
  for (const make of summary.makes || []) {
    for (const model of make.models || []) {
      partHashes.set(
        `model-links:${make.slug}/${model.slug}`,
        sha(
          canon({
            yearsPage: Boolean(model.yearsPage),
            ev: evByModel.get(`${make.slug}/${model.slug}`) || "",
            fuel: (fuelByModel.get(`${make.slug}/${model.slug}`) || []).sort(),
            investigations: modelInvestigationCount(make.slug, model.slug),
            components: modelHasComponentPage(make.slug, model.slug),
          }),
        ),
      );
    }
  }

  const sourceCache = new Map();
  function sourceFor(template) {
    if (!sourceCache.has(template)) sourceCache.set(template, fingerprint(contentFiles(template, env), env));
    return sourceCache.get(template);
  }

  const hashes = new Map();
  for (const [url, info] of urls) {
    const source = sourceFor(info.template);
    const lines = [`source:${source}`];
    for (const id of [...info.parts].sort()) {
      const part = partHashes.get(id);
      if (!part) throw new Error(`missing content part ${id} for ${url}`);
      lines.push(`${id}=${part}`);
    }
    hashes.set(url, sha(lines.join("\n")));
  }
  return hashes;
}

export function contentHashes(env = diskEnv()) {
  return buildContent(env);
}

export function enumerateSitemapUrls(env = diskEnv()) {
  return [...contentHashes(env).keys()].sort();
}

export function applyLedger(previous, hashes, today) {
  if (!isIsoDate(today)) throw new Error(`ledger date is not YYYY-MM-DD: ${today}`);
  const urls = {};
  const entries = hashes instanceof Map ? [...hashes.entries()] : Object.entries(hashes || {});
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [url, hash] of entries) {
    if (!hash) continue;
    const prev = previous?.[url];
    const keep = prev && prev.hash === hash && isIsoDate(prev.date) && prev.date <= today;
    urls[url] = { hash, date: keep ? prev.date : today };
  }
  return urls;
}

export function readLedger() {
  const path = join(ROOT, LEDGER_PATH);
  if (!existsSync(path)) return { urls: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed.urls !== "object" || !parsed.urls || Array.isArray(parsed.urls)) {
    throw new Error(`${LEDGER_PATH} is missing an urls object`);
  }
  return parsed;
}

export function lastmodForPath(pathname, ledger = readLedger()) {
  const entry = ledger.urls?.[pathname];
  if (!entry || !entry.hash || !isIsoDate(entry.date)) return "";
  return entry.date;
}

function serializeLedger(urls) {
  return `${JSON.stringify({ urls }, null, 2)}\n`;
}

export function lastmodDistribution(ledger = readLedger()) {
  const counts = new Map();
  for (const entry of Object.values(ledger.urls || {})) {
    counts.set(entry.date, (counts.get(entry.date) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function updateLedgerFile(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const hashes = contentHashes(options.env || diskEnv());
  const previous = readLedger().urls || {};
  const urls = applyLedger(previous, hashes, today);
  let changed = 0;
  let added = 0;
  for (const [url, entry] of Object.entries(urls)) {
    const prev = previous[url];
    if (!prev) added += 1;
    else if (prev.date !== entry.date) changed += 1;
  }
  const path = join(ROOT, LEDGER_PATH);
  const text = serializeLedger(urls);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current !== text) writeFileSync(path, text);
  return { urls: Object.keys(urls).length, added, changed, wrote: current !== text, distribution: lastmodDistribution({ urls }) };
}

function locEntries(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)];
}

export function alignSitemapIndex(distDir) {
  const indexPath = join(distDir, "sitemap-index.xml");
  if (!existsSync(indexPath)) throw new Error("sitemap-index.xml was not written");
  const childNames = readdirSync(distDir).filter((name) => /^sitemap-\d+\.xml$/.test(name));
  if (!childNames.length) throw new Error("no child sitemaps were written");
  const childMax = new Map();
  for (const name of childNames) {
    let max = "";
    for (const match of locEntries(readFileSync(join(distDir, name), "utf8"))) {
      const lastmod = match[2] || "";
      if (!lastmod) continue;
      if (!max || lastmodInstant(lastmod) > lastmodInstant(max)) max = lastmod;
    }
    childMax.set(name, max);
  }
  const indexXml = readFileSync(indexPath, "utf8").replace(/<loc>([^<]+)<\/loc>(?:\s*<lastmod>(?:[^<]*)<\/lastmod>)?/g, (full, loc) => {
    let name = "";
    try {
      name = decodeURIComponent(new URL(loc).pathname).split("/").pop();
    } catch {
      return full;
    }
    if (!childMax.has(name)) return full;
    const max = childMax.get(name);
    if (!max) return `<loc>${loc}</loc>`;
    return `<loc>${loc}</loc><lastmod>${max}</lastmod>`;
  });
  writeFileSync(indexPath, indexXml);
  return childMax;
}

export function inspectSitemaps(distDir) {
  const index = [];
  for (const match of locEntries(readFileSync(join(distDir, "sitemap-index.xml"), "utf8"))) {
    const name = decodeURIComponent(new URL(match[1]).pathname).split("/").pop();
    index.push({ name, loc: match[1], lastmod: match[2] || "" });
  }
  const pages = [];
  const childMax = new Map();
  for (const name of readdirSync(distDir).filter((item) => /^sitemap-\d+\.xml$/.test(item))) {
    let max = "";
    for (const match of locEntries(readFileSync(join(distDir, name), "utf8"))) {
      const path = new URL(match[1]).pathname;
      const lastmod = match[2] || "";
      pages.push({ path, lastmod, file: name });
      if (lastmod && (!max || lastmodInstant(lastmod) > lastmodInstant(max))) max = lastmod;
    }
    childMax.set(name, max);
  }
  return { index, pages, childMax };
}
