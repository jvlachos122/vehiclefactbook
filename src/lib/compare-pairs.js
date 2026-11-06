import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSummary } from "./catalog.js";
import { formatDate, formatNumber, kwhSpan, money, nhtsaVehicleUrl, span } from "./format.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Example comparisons (not a sales ranking; this site has no sales figures).
 *
 * 1. An EPA class family is `vclass` with a trailing "2WD" or "4WD" label removed
 *    (" - 2WD", " - 4WD", " 2WD", or " 4WD"). Two- and four-wheel-drive rows of the
 *    same body class can share a page.
 * 2. A model year's class is the family with the most configuration rows that year.
 *    A tie uses the alphabetically first family.
 * 3. A model's anchor is its newest model year that has an EPA configuration and an
 *    NHTSA name match (`match` other than "none") in data/site/summary.json.
 * 4. A candidate is two models from different makes whose anchors are the same year
 *    and the same class family. The page compares that year.
 *    The makes also have to share a tier (volume, luxury, or specialty) and the
 *    anchor year has to share a fuel type (gasoline, diesel, electric, hydrogen,
 *    or natural gas). Regular, midgrade, premium, and flex-fuel rows are one
 *    gasoline type. A volume make is not paired with a luxury or specialty make,
 *    and a gasoline model is not paired with an electric model.
 *    Same EPA class alone is not enough: both the tier and the fuel type have to match.
 * 5. Candidates are ordered by the sum of EPA configuration rows on the two models
 *    (every model year in data/site/models), then by the sum of published model years
 *    on the two make hubs, then by year, class, and slug.
 * 6. A model is used once. A class family keeps at most EXAMPLE_PAIRS_PER_CLASS pairs.
 *    The first EXAMPLE_PAIR_LIMIT pairs are published.
 *
 * `rule: "class"` repeats the older class-only selection. It exists so a dropped
 * example URL can stay up as a noindex refresh to the replacement page. Those
 * refresh URLs are not part of the published set and are left out of the sitemap.
 *
 * Unlisted makes are volume, so a new mainstream brand still pairs inside volume.
 * Luxury and specialty makes are listed so they stay out of volume pairs.
 */
export const EXAMPLE_PAIR_LIMIT = 30;
export const EXAMPLE_PAIRS_PER_CLASS = 4;
export const EXAMPLE_PAIRS_PER_MODEL = 1;

const LUXURY_MAKES = [
  "acura",
  "alfa-romeo",
  "audi",
  "bmw",
  "bmw-alpina",
  "cadillac",
  "genesis",
  "infiniti",
  "jaguar",
  "land-rover",
  "lexus",
  "lincoln",
  "lucid",
  "maserati",
  "mercedes-benz",
  "mini",
  "polestar",
  "porsche",
  "rivian",
  "tesla",
  "volvo",
];

const SPECIALTY_MAKES = [
  "aston-martin",
  "bentley",
  "bugatti",
  "bugatti-rimac",
  "ferrari",
  "fisker",
  "karma",
  "koenigsegg",
  "lamborghini",
  "lotus",
  "maybach",
  "mclaren-automotive",
  "pagani",
  "rolls-royce",
  "spyker",
];

const TIER_BY_MAKE = new Map([
  ...LUXURY_MAKES.map((slug) => [slug, "luxury"]),
  ...SPECIALTY_MAKES.map((slug) => [slug, "specialty"]),
]);

export function makeTier(makeSlug) {
  return TIER_BY_MAKE.get(makeSlug) || "volume";
}

export function fuelTypeFromConfigs(configs) {
  const rows = configs || [];
  if (!rows.length) return "";
  const electric = (config) => config.atv === "EV" || config.fuel === "Electricity";
  if (rows.every(electric)) return "electric";
  const rest = rows.filter((config) => !electric(config));
  const diesel = (config) => config.atv === "Diesel" || config.fuel === "Diesel";
  if (rest.length && rest.every(diesel)) return "diesel";
  const hydrogen = (config) => config.fuel === "Hydrogen" || config.atv === "FCV" || config.atv === "eFCV";
  if (rest.length && rest.every(hydrogen)) return "hydrogen";
  const gasoline = (config) => String(config.fuel || "").includes("Gasoline") || config.atv === "FFV";
  if (rest.some(gasoline)) return "gasoline";
  const gaseous = (config) =>
    config.fuel === "Natural Gas" || config.atv === "CNG" || config.atv === "Bifuel (CNG)" || config.atv === "Bifuel (LPG)";
  if (rest.length && rest.every(gaseous)) return "natural-gas";
  return "other";
}

export const BANNED_PAIR_WORDS = /\b(avoid|best|worst|reliable|unreliable|winner|safer|better|popular)\b/i;

const PUBLIC_SIDE_KEYS = [
  "makeSlug",
  "makeName",
  "modelSlug",
  "modelName",
  "configCount",
  "makeHub",
  "y",
  "classFamily",
  "match",
  "splitNames",
  "headlineExact",
  "recalls",
  "complaints",
  "alsoRecalls",
  "alsoComplaints",
  "mpgMin",
  "mpgMax",
  "cityMin",
  "cityMax",
  "hwyMin",
  "hwyMax",
  "mpgeMin",
  "mpgeMax",
  "kwhMin",
  "kwhMax",
  "rangeMin",
  "rangeMax",
  "costMin",
  "costMax",
  "evOnly",
  "fuelType",
  "ncapVariants",
  "starMin",
  "starMax",
  "ncapUnrated",
];

let recordCache;
let pairCache;
let redirectCache;

export function classFamily(vclass) {
  return String(vclass || "")
    .replace(/\s+-\s+(2WD|4WD)$/i, "")
    .replace(/\s+(2WD|4WD)$/i, "")
    .trim();
}

export function modalClass(configs) {
  const counts = new Map();
  for (const config of configs || []) {
    const family = classFamily(config.vclass);
    if (!family) continue;
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  if (!counts.size) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { family: ranked[0][0], count: ranked[0][1] };
}

function finiteNumbers(values) {
  const numbers = [];
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) continue;
    numbers.push(number);
  }
  return numbers;
}

function ends(values) {
  const numbers = finiteNumbers(values);
  if (!numbers.length) return [null, null];
  return [Math.min(...numbers), Math.max(...numbers)];
}

export function fuelAndStars(configs, ncap) {
  const rows = configs || [];
  const [mpgMin, mpgMax] = ends(rows.filter((config) => config.atv !== "EV").map((config) => config.comb));
  const [cityMin, cityMax] = ends(rows.filter((config) => config.atv !== "EV").map((config) => config.cityMpg));
  const [hwyMin, hwyMax] = ends(rows.filter((config) => config.atv !== "EV").map((config) => config.hwy));
  const [mpgeMin, mpgeMax] = ends(rows.filter((config) => config.atv === "EV").map((config) => config.comb));
  const [kwhMin, kwhMax] = ends(rows.map((config) => config.kwh));
  const [rangeMin, rangeMax] = ends(rows.map((config) => config.range));
  const [costMin, costMax] = ends(rows.map((config) => config.cost));
  const variants = ncap || [];
  const rated = [];
  let ncapUnrated = 0;
  for (const variant of variants) {
    const overall = String(variant?.overall ?? "");
    if (/^\d$/.test(overall)) rated.push(Number(overall));
    else ncapUnrated += 1;
  }
  return {
    mpgMin,
    mpgMax,
    cityMin,
    cityMax,
    hwyMin,
    hwyMax,
    mpgeMin,
    mpgeMax,
    kwhMin,
    kwhMax,
    rangeMin,
    rangeMax,
    costMin,
    costMax,
    evOnly: rows.length > 0 && rows.every((config) => config.atv === "EV"),
    ncapVariants: variants.length,
    starMin: rated.length ? Math.min(...rated) : null,
    starMax: rated.length ? Math.max(...rated) : null,
    ncapUnrated,
  };
}

function makeHubSizes(summary) {
  const sizes = new Map();
  for (const make of summary.makes) {
    let count = 0;
    for (const model of make.models) count += model.years.length;
    sizes.set(make.slug, count);
  }
  return sizes;
}

export function recordFromModel(make, model, doc, makeHub) {
  let configCount = 0;
  let anchor = null;
  const years = [...model.years].sort((a, b) => b.y - a.y);
  for (const row of years) {
    const detail = doc?.years?.[String(row.y)];
    const configs = detail?.configs || [];
    configCount += configs.length;
    if (anchor || row.match === "none") continue;
    const modal = modalClass(configs);
    if (!modal) continue;
    anchor = {
      y: row.y,
      classFamily: modal.family,
      match: row.match,
      splitNames: Boolean(detail.splitNames),
      headlineExact: Boolean(row.headlineExact),
      recalls: row.recalls,
      complaints: row.complaints,
      alsoRecalls: row.alsoRecalls || 0,
      alsoComplaints: row.alsoComplaints || 0,
      ...fuelAndStars(configs, detail.ncap),
      fuelType: fuelTypeFromConfigs(configs),
    };
  }
  return {
    makeSlug: make.slug,
    makeName: make.name,
    modelSlug: model.slug,
    modelName: model.name,
    configCount,
    makeHub,
    anchor,
  };
}

function byIdentity(a, b) {
  return a.makeSlug.localeCompare(b.makeSlug) || a.modelSlug.localeCompare(b.modelSlug);
}

function identityKey(pair) {
  return `${pair.left.makeSlug}/${pair.left.modelSlug}/${pair.right.makeSlug}/${pair.right.modelSlug}`;
}

function scoreConfigs(pair) {
  return pair.left.configCount + pair.right.configCount;
}

function scoreHub(pair) {
  return pair.left.makeHub + pair.right.makeHub;
}

function publicSide(record) {
  const anchor = record.anchor;
  const side = {
    makeSlug: record.makeSlug,
    makeName: record.makeName,
    modelSlug: record.modelSlug,
    modelName: record.modelName,
    configCount: record.configCount,
    makeHub: record.makeHub,
  };
  for (const key of PUBLIC_SIDE_KEYS) {
    if (key in side) continue;
    side[key] = anchor[key];
  }
  return side;
}

export function pairSlug(left, right) {
  return `${left.makeSlug}-${left.modelSlug}-vs-${right.makeSlug}-${right.modelSlug}`;
}

function anchorFuel(record) {
  if (record.anchor.fuelType) return record.anchor.fuelType;
  if (record.anchor.evOnly) return "electric";
  return "gasoline";
}

function withPairKeys(record) {
  const fuelType = anchorFuel(record);
  const tier = record.tier || makeTier(record.makeSlug);
  if (record.tier === tier && record.anchor.fuelType === fuelType) return record;
  return {
    ...record,
    tier,
    anchor: { ...record.anchor, fuelType },
  };
}

export function selectExamplePairs(records, options = {}) {
  const limit = options.limit ?? EXAMPLE_PAIR_LIMIT;
  const perClass = options.perClass ?? EXAMPLE_PAIRS_PER_CLASS;
  const perModel = options.perModel ?? EXAMPLE_PAIRS_PER_MODEL;
  const classOnly = options.rule === "class";
  const eligible = records.filter((record) => record.anchor && record.anchor.match !== "none" && record.anchor.classFamily);
  const candidates = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const first = withPairKeys(eligible[i]);
      const second = withPairKeys(eligible[j]);
      if (first.makeSlug === second.makeSlug) continue;
      if (first.anchor.y !== second.anchor.y) continue;
      if (first.anchor.classFamily !== second.anchor.classFamily) continue;
      if (!classOnly && (first.tier !== second.tier || first.anchor.fuelType !== second.anchor.fuelType)) continue;
      const [left, right] = [first, second].sort(byIdentity);
      candidates.push({
        left,
        right,
        year: left.anchor.y,
        classFamily: left.anchor.classFamily,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      scoreConfigs(b) - scoreConfigs(a) ||
      scoreHub(b) - scoreHub(a) ||
      b.year - a.year ||
      a.classFamily.localeCompare(b.classFamily) ||
      identityKey(a).localeCompare(identityKey(b)),
  );
  const modelUse = new Map();
  const classUse = new Map();
  const kept = [];
  const seenSlugs = new Set();
  for (const candidate of candidates) {
    const leftKey = `${candidate.left.makeSlug}/${candidate.left.modelSlug}`;
    const rightKey = `${candidate.right.makeSlug}/${candidate.right.modelSlug}`;
    if ((modelUse.get(leftKey) || 0) >= perModel) continue;
    if ((modelUse.get(rightKey) || 0) >= perModel) continue;
    if ((classUse.get(candidate.classFamily) || 0) >= perClass) continue;
    const left = publicSide(candidate.left);
    const right = publicSide(candidate.right);
    const slug = pairSlug(left, right);
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate comparison slug ${slug}`);
    }
    seenSlugs.add(slug);
    kept.push({
      slug,
      year: candidate.year,
      classFamily: candidate.classFamily,
      tier: candidate.left.tier,
      fuelType: candidate.left.anchor.fuelType,
      configCount: candidate.left.configCount + candidate.right.configCount,
      makeHub: candidate.left.makeHub + candidate.right.makeHub,
      left,
      right,
    });
    modelUse.set(leftKey, (modelUse.get(leftKey) || 0) + 1);
    modelUse.set(rightKey, (modelUse.get(rightKey) || 0) + 1);
    classUse.set(candidate.classFamily, (classUse.get(candidate.classFamily) || 0) + 1);
    if (kept.length === limit) break;
  }
  return kept;
}

export function mmyPath(side, year) {
  return `/${side.makeSlug}/${side.modelSlug}/${year}/`;
}

function dash(value) {
  return value ? value : "—";
}

export function costSpan(min, max) {
  if (min == null || max == null) return "";
  if (min === max) return money(min);
  return `${money(min)}–${money(max)}`;
}

export function starLabel(side) {
  if (side.y < 2011) return "Pre-2011 rating, not comparable";
  if (!side.ncapVariants) return "No matched overall rating";
  if (side.starMin == null) return "Not rated";
  if (side.starMin === side.starMax) return String(side.starMin);
  return `${side.starMin}–${side.starMax}`;
}

export function fuelPhrase(side) {
  const parts = [];
  const mpg = span(side.mpgMin, side.mpgMax, "mpg combined");
  if (mpg) {
    const city = span(side.cityMin, side.cityMax, "mpg city");
    const hwy = span(side.hwyMin, side.hwyMax, "mpg highway");
    parts.push(city && hwy ? `${mpg} (${city}, ${hwy})` : mpg);
  }
  const kwh = kwhSpan(side.kwhMin, side.kwhMax);
  if (kwh) parts.push(kwh);
  if (side.rangeMin != null && side.rangeMax != null) {
    parts.push(`a range of ${span(side.rangeMin, side.rangeMax, "miles")}`);
  }
  if (!parts.length) {
    const mpge = span(side.mpgeMin, side.mpgeMax, "MPGe combined");
    if (mpge) parts.push(mpge);
  }
  return parts.join(" and ") || "no combined fuel figure in the EPA rows for this model year";
}

function starBit(side) {
  const label = starLabel(side);
  if (label === "Not rated") return `Not rated for the ${side.makeName} ${side.modelName}`;
  if (label === "No matched overall rating") return `no matched overall rating for the ${side.makeName} ${side.modelName}`;
  if (label === "Pre-2011 rating, not comparable") {
    return `a pre-2011 rating, not comparable, for the ${side.makeName} ${side.modelName}`;
  }
  return `an overall rating of ${label} for the ${side.makeName} ${side.modelName}`;
}

export function pairAnswer(pair, dates, ncapFetched) {
  const epaDate = formatDate(dates.epa);
  const fetched = ncapFetched ? formatDate(String(ncapFetched).slice(0, 10)) : "";
  const fuel = `EPA rates the ${pair.year} ${pair.left.makeName} ${pair.left.modelName} ${fuelPhrase(pair.left)} and the ${pair.year} ${pair.right.makeName} ${pair.right.modelName} ${fuelPhrase(pair.right)} (fuel economy file dated ${epaDate}).`;
  let stars;
  if (pair.year < 2011) {
    stars = "NHTSA's pre-2011 rating, not comparable to later stars, is not shown for this model year.";
  } else {
    const when = fetched ? `, fetched ${fetched},` : "";
    stars = `NHTSA's Safety Ratings API${when} lists ${starBit(pair.left)} and ${starBit(pair.right)}.`;
  }
  return `${fuel} ${stars}`;
}

function sideNotes(pair, side) {
  const notes = [];
  if (side.splitNames) {
    notes.push(
      `NHTSA does not list the EPA model name ${side.modelName} for ${pair.year}. The counts for ${side.makeName} are the sum of the matched names on the model year page.`,
    );
  } else if (side.alsoRecalls || side.alsoComplaints) {
    notes.push(
      `Other NHTSA names matched to the ${pair.year} ${side.makeName} ${side.modelName} are listed on the model year page and are not added to these counts.`,
    );
  }
  return notes;
}

export function pairDocument(pair, { dates, ncapFetched }) {
  const epaDate = formatDate(dates.epa);
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const fetched = ncapFetched ? formatDate(String(ncapFetched).slice(0, 10)) : "";
  const columns = [pair.left, pair.right].map((side) => ({
    heading: `${pair.year} ${side.makeName} ${side.modelName}`,
    href: mmyPath(side, pair.year),
    nhtsaHref: nhtsaVehicleUrl(pair.year, side.makeName, side.modelName),
  }));
  const cell = (side, value) => dash(value);
  const rows = [
    { label: "EPA class", numeric: false, left: pair.left.classFamily, right: pair.right.classFamily },
    { label: "Combined mpg", numeric: true, left: cell(pair.left, span(pair.left.mpgMin, pair.left.mpgMax)), right: cell(pair.right, span(pair.right.mpgMin, pair.right.mpgMax)) },
    { label: "City mpg", numeric: true, left: cell(pair.left, span(pair.left.cityMin, pair.left.cityMax)), right: cell(pair.right, span(pair.right.cityMin, pair.right.cityMax)) },
    { label: "Highway mpg", numeric: true, left: cell(pair.left, span(pair.left.hwyMin, pair.left.hwyMax)), right: cell(pair.right, span(pair.right.hwyMin, pair.right.hwyMax)) },
    { label: "kWh/100 mi", numeric: true, left: cell(pair.left, kwhSpan(pair.left.kwhMin, pair.left.kwhMax).replace(/ kWh\/100 mi$/, "")), right: cell(pair.right, kwhSpan(pair.right.kwhMin, pair.right.kwhMax).replace(/ kWh\/100 mi$/, "")) },
    { label: "Range (miles)", numeric: true, left: cell(pair.left, span(pair.left.rangeMin, pair.left.rangeMax)), right: cell(pair.right, span(pair.right.rangeMin, pair.right.rangeMax)) },
    { label: "Annual fuel cost", numeric: true, left: cell(pair.left, costSpan(pair.left.costMin, pair.left.costMax)), right: cell(pair.right, costSpan(pair.right.costMin, pair.right.costMax)) },
    { label: "Combined MPGe", numeric: true, left: cell(pair.left, span(pair.left.mpgeMin, pair.left.mpgeMax)), right: cell(pair.right, span(pair.right.mpgeMin, pair.right.mpgeMax)) },
    { label: "Overall stars", numeric: false, left: starLabel(pair.left), right: starLabel(pair.right) },
    { label: "Recall campaigns", numeric: true, left: formatNumber(pair.left.recalls), right: formatNumber(pair.right.recalls) },
    { label: "Complaints received so far", numeric: true, left: formatNumber(pair.left.complaints), right: formatNumber(pair.right.complaints) },
  ];
  const ncapSource = fetched
    ? `NHTSA Safety Ratings API fetched ${fetched}.`
    : "NHTSA Safety Ratings API.";
  return {
    title: `${pair.year} ${pair.left.makeName} ${pair.left.modelName} vs ${pair.year} ${pair.right.makeName} ${pair.right.modelName}`,
    eyebrow: "Example comparison",
    classLine: `${pair.year} model year, EPA class ${pair.classFamily}.`,
    answer: pairAnswer(pair, dates, ncapFetched),
    caveat: `Complaint counts are distinct complaints received so far in the NHTSA file dated ${complaintDate}. More complaints can mean more cars sold, and a newer model year has had less time for complaints to be reported. Recall counts are campaigns in the NHTSA recall file dated ${recallDate}, and they are not rates.`,
    tableHeading: "Fuel economy and NHTSA counts",
    tableCaption: `Side-by-side EPA fuel economy and NHTSA counts for these two ${pair.year} model years in the ${pair.classFamily} class. The EPA file is dated ${epaDate}. Complaint counts are those received so far in the file dated ${complaintDate}.`,
    columns,
    rows,
    notes: [...sideNotes(pair, pair.left), ...sideNotes(pair, pair.right)],
    linksHeading: "Model year pages",
    narrativeNote: "Complaint narratives stay on NHTSA's site and are not copied here.",
    sourcesHeading: "Sources",
    sources: [
      `EPA fuel economy file dated ${epaDate}. City, highway, and combined mpg omit electric-only rows. Electric rows contribute kWh/100 mi and range. Annual fuel cost is EPA's published fuelCost08 figure for 15,000 miles and 55 percent city driving.`,
      `NHTSA recall file dated ${recallDate}. The recall figure is the number of campaigns on the model year page.`,
      `NHTSA complaint file dated ${complaintDate}. The complaint figure is distinct complaints received so far. More complaints can mean more cars sold.`,
      `${ncapSource} Overall stars are shown for model year 2011 and newer. A pre-2011 rating is not comparable and is not shown. Where NHTSA marks the overall rating Not rated, the cell says Not rated.`,
    ],
  };
}

export function exampleIndexIntro(count) {
  return `These example comparisons pair two models from different makes. Both models use the newest model year that has an NHTSA name match. That year has to share an EPA vehicle class, the makes have to share a tier (volume, luxury, or specialty), and the model year has to share a fuel type (gasoline, diesel, electric, hydrogen, or natural gas). Drive-type labels (2WD and 4WD) are removed before the class is compared. Pairs are ordered by how many EPA configuration rows the two models have in the committed files, then by how many model years the two makes publish. Each model appears once, and each class keeps at most ${EXAMPLE_PAIRS_PER_CLASS} pairs. This page lists ${count} pairs. This list is not a sales ranking.`;
}

export function exampleIndexCaption() {
  return "Example comparisons from the committed EPA and NHTSA files. A pair shares an EPA class, a make tier, and a fuel type. The order follows EPA configuration rows, then make size.";
}

function loadRecords() {
  if (recordCache) return recordCache;
  const summary = loadSummary();
  const hubs = makeHubSizes(summary);
  const records = [];
  for (const make of summary.makes) {
    for (const model of make.models) {
      const doc = JSON.parse(readFileSync(join(root, "data/site/models", make.slug, `${model.slug}.json`), "utf8"));
      records.push(recordFromModel(make, model, doc, hubs.get(make.slug)));
    }
  }
  recordCache = records;
  return recordCache;
}

export function loadExamplePairs() {
  if (pairCache) return pairCache;
  pairCache = selectExamplePairs(loadRecords());
  return pairCache;
}

export function buildPairRedirects(legacy, current) {
  const live = new Set(current.map((pair) => pair.slug));
  const redirects = [];
  for (const old of legacy) {
    if (live.has(old.slug)) continue;
    const shares = (side) => (pair) =>
      (pair.left.makeSlug === side.makeSlug && pair.left.modelSlug === side.modelSlug) ||
      (pair.right.makeSlug === side.makeSlug && pair.right.modelSlug === side.modelSlug);
    const primary = old.left.configCount >= old.right.configCount ? old.left : old.right;
    const secondary = primary === old.left ? old.right : old.left;
    const replacement =
      current.find(shares(primary)) ||
      current.find(shares(secondary)) ||
      current.find((pair) => pair.classFamily === old.classFamily) ||
      null;
    const title = `${old.year} ${old.left.makeName} ${old.left.modelName} vs ${old.year} ${old.right.makeName} ${old.right.modelName}`;
    redirects.push({
      slug: old.slug,
      year: old.year,
      classFamily: old.classFamily,
      title,
      leftName: `${old.left.makeName} ${old.left.modelName}`,
      rightName: `${old.right.makeName} ${old.right.modelName}`,
      replacementSlug: replacement?.slug || "",
      replacementPath: replacement ? `/compare/${replacement.slug}/` : "/compare/",
      replacementTitle: replacement
        ? `${replacement.year} ${replacement.left.makeName} ${replacement.left.modelName} vs ${replacement.year} ${replacement.right.makeName} ${replacement.right.modelName}`
        : "Example comparisons",
    });
  }
  return redirects;
}

export function redirectAnswer(redirect) {
  const moved = `The example comparison of the ${redirect.year} ${redirect.leftName} and the ${redirect.year} ${redirect.rightName} is not in the current example set.`;
  const why = "Example pages now keep two models only when they share an EPA class, a similar make tier, and a fuel type.";
  const next = redirect.replacementSlug
    ? `The replacement example is ${redirect.replacementTitle}.`
    : "The current example comparisons are listed on the compare page.";
  return `${moved} ${why} ${next}`;
}

export function loadRemovedPairRedirects() {
  if (redirectCache) return redirectCache;
  const records = loadRecords();
  const current = loadExamplePairs();
  const legacy = selectExamplePairs(records, { rule: "class" });
  redirectCache = buildPairRedirects(legacy, current);
  return redirectCache;
}

export function removedComparePaths() {
  return new Set(loadRemovedPairRedirects().map((item) => `/compare/${item.slug}/`));
}

export function ncapFetchedAt(meta, year) {
  return meta?.ncap?.[String(year)]?.fetchedAt || "";
}
