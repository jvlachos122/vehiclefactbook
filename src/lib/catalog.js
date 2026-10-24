import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

let summaryCache;
let metaCache;
let advisoryCache;
let recentCache;
const modelCache = new Map();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSummary() {
  if (!summaryCache) summaryCache = readJson(join(root, "data/site/summary.json"));
  return summaryCache;
}

export function loadMeta() {
  if (!metaCache) metaCache = readJson(join(root, "data/site/meta.json"));
  return metaCache;
}

export function loadAdvisories() {
  if (!advisoryCache) advisoryCache = readJson(join(root, "data/site/advisories.json"));
  return advisoryCache;
}

export function loadRecent() {
  if (!recentCache) recentCache = readJson(join(root, "data/recent.json"));
  return recentCache;
}

export function loadModel(make, model) {
  const key = `${make}/${model}`;
  if (!modelCache.has(key)) {
    modelCache.set(key, readJson(join(root, "data/site/models", make, `${model}.json`)));
  }
  return modelCache.get(key);
}

export function makePaths() {
  return loadSummary().makes.map((make) => ({
    params: { make: make.slug },
    props: { makeSlug: make.slug },
  }));
}

export function modelPaths() {
  const paths = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      paths.push({
        params: { make: make.slug, model: model.slug },
        props: { makeSlug: make.slug, modelSlug: model.slug },
      });
    }
  }
  return paths;
}

export function yearsPaths() {
  return modelPaths().filter((path) => {
    const make = loadSummary().makes.find((item) => item.slug === path.props.makeSlug);
    const model = make.models.find((item) => item.slug === path.props.modelSlug);
    return model.yearsPage;
  });
}

export function mmyPaths() {
  const paths = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      for (const year of model.years) {
        paths.push({
          params: { make: make.slug, model: model.slug, year: String(year.y) },
          props: { makeSlug: make.slug, modelSlug: model.slug, year: year.y },
        });
      }
    }
  }
  return paths;
}

export function findMake(slug) {
  return loadSummary().makes.find((make) => make.slug === slug);
}

export function findModel(makeSlug, modelSlug) {
  const make = findMake(makeSlug);
  const model = make?.models.find((item) => item.slug === modelSlug);
  return { make, model };
}

export function findYear(makeSlug, modelSlug, year) {
  const found = findModel(makeSlug, modelSlug);
  const row = found.model?.years.find((item) => item.y === Number(year));
  return { ...found, row };
}
