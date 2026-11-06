import { readFileSync } from "node:fs";
import { loadModel, loadSummary } from "./catalog.js";
import { modalClass } from "./compare-pairs.js";
import { formatDate, formatNumber, kwhSpan, money, nhtsaVehicleUrl, span } from "./format.js";
import { loadPriceSnapshot } from "./eia-prices.js";
import { calculateCost, formatDollars, formatUnitPrice } from "./fuel-cost.js";

/**
 * Same-model hybrid vs gasoline pages.
 *
 * A family is one make plus one EPA base model. A sibling whose normalized name
 * is that base model plus Hybrid, PHEV, Prime, Plug-in Hybrid, or Energi
 * (RAV4 Prime beside RAV4) joins the family. Nothing is inferred beyond those suffixes.
 *
 * A page needs one model year, from HYBRID_MIN_YEAR on, that has both:
 * - conventional gasoline: fuel contains "Gasoline" and atvType is blank
 *   (flex-fuel, diesel, and electric rows are not the gasoline side)
 * - hybrid: atvType "Hybrid", or plug-in hybrid: atvType "Plug-in Hybrid"
 * Hybrid and plug-in hybrid are separate pages. The year is the newest overlap.
 * Both sides need a combined mpg and an annual fuel cost (fuelCost08).
 * The hybrid side's highest combined mpg has to be at least the gasoline side's
 * highest combined mpg, so a performance row tagged Hybrid is not published
 * in place of an efficiency comparison.
 *
 * Order is the family's EPA configuration-row count, then year, then slug.
 * That count is not a sales figure. The first HYBRID_PAIR_LIMIT pairs are published.
 */
export const HYBRID_PAIR_LIMIT = 32;
export const HYBRID_MIN_YEAR = 2020;

const FAMILY_SUFFIXES = ["PLUGINHYBRID", "PHEV", "HYBRID", "PRIME", "ENERGI"];

const KIND_BUCKETS = [
  ["hybrid", "hybrid", "hybrid"],
  ["phev", "plug-in-hybrid", "plug-in hybrid"],
];

let familyCache;
let pairCache;

export function familyStem(modelNorm, norms) {
  const text = String(modelNorm || "");
  for (const suffix of FAMILY_SUFFIXES) {
    if (text.endsWith(suffix) && text.length > suffix.length + 1) {
      const stem = text.slice(0, -suffix.length);
      if (!norms || norms.has(stem)) return stem;
    }
  }
  return text;
}

export function isConventionalGas(config) {
  return !config?.atv && String(config?.fuel || "").includes("Gasoline");
}

export function powertrainKind(config) {
  if (config?.atv === "Hybrid") return "hybrid";
  if (config?.atv === "Plug-in Hybrid") return "plug-in-hybrid";
  return "";
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

export function figuresFrom(configs) {
  const rows = configs || [];
  const [mpgMin, mpgMax] = ends(rows.map((config) => config.comb));
  const [cityMin, cityMax] = ends(rows.map((config) => config.cityMpg));
  const [hwyMin, hwyMax] = ends(rows.map((config) => config.hwy));
  const [costMin, costMax] = ends(rows.map((config) => config.cost));
  const [kwhMin, kwhMax] = ends(rows.map((config) => config.kwh));
  const [rangeMin, rangeMax] = ends(rows.map((config) => config.range));
  return { mpgMin, mpgMax, cityMin, cityMax, hwyMin, hwyMax, costMin, costMax, kwhMin, kwhMax, rangeMin, rangeMax, rows: rows.length };
}

function uniformFuel(configs) {
  const fuels = new Set(configs.map((config) => config.fuel).filter(Boolean));
  return fuels.size === 1 ? [...fuels][0] : "";
}

function sideFrom(entries) {
  if (!entries.length) return null;
  const configs = entries.map((entry) => entry.config);
  const figures = figuresFrom(configs);
  if (figures.mpgMin == null || figures.costMin == null) return null;
  const counts = new Map();
  for (const entry of entries) counts.set(entry.meta.modelSlug, (counts.get(entry.meta.modelSlug) || 0) + 1);
  const [primarySlug] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const primary = entries.find((entry) => entry.meta.modelSlug === primarySlug).meta;
  const sources = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.meta.modelSlug)) continue;
    seen.add(entry.meta.modelSlug);
    sources.push({
      makeSlug: entry.meta.makeSlug,
      modelSlug: entry.meta.modelSlug,
      modelName: entry.meta.modelName,
    });
  }
  return {
    ...primary,
    ...figures,
    fuel: uniformFuel(configs),
    classFamily: modalClass(configs)?.family || "",
    sources,
  };
}

export function selectHybridPairs(families, options = {}) {
  const limit = options.limit ?? HYBRID_PAIR_LIMIT;
  const minYear = options.minYear ?? HYBRID_MIN_YEAR;
  const candidates = [];
  for (const family of families) {
    for (const [bucket, kind, kindLabel] of KIND_BUCKETS) {
      const years = (family.years || [])
        .filter((year) => year.y >= minYear && year.gas?.length && year[bucket]?.length)
        .sort((a, b) => b.y - a.y);
      if (!years.length) continue;
      const year = years[0];
      const gas = sideFrom(year.gas);
      const hybrid = sideFrom(year[bucket]);
      if (!gas || !hybrid) continue;
      if (hybrid.mpgMax < gas.mpgMax) continue;
      candidates.push({
        slug: `${family.makeSlug}-${family.modelSlug}-${kind}-vs-gasoline`,
        year: year.y,
        kind,
        kindLabel,
        makeSlug: family.makeSlug,
        makeName: family.makeName,
        modelSlug: family.modelSlug,
        modelName: family.modelName,
        configCount: family.configCount,
        gas,
        hybrid,
      });
    }
  }
  candidates.sort((a, b) => b.configCount - a.configCount || b.year - a.year || a.slug.localeCompare(b.slug));
  const kept = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.slug)) throw new Error(`Duplicate hybrid comparison slug ${candidate.slug}`);
    seen.add(candidate.slug);
    kept.push(candidate);
    if (kept.length === limit) break;
  }
  return kept;
}

function dollarSpan(min, max) {
  if (min == null || max == null) return "";
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (Math.round(low * 100) === Math.round(high * 100)) return formatDollars(low);
  return `${formatDollars(low)}–${formatDollars(high)}`;
}

export function eiaAnnualCost(mpg, usd, fuel = "Regular Gasoline") {
  const result = calculateCost({
    miles: 15000,
    comb: mpg,
    gallonPrice: usd,
    fuel,
    mix: "combined",
  });
  return result.status === "ok" ? result.cost : null;
}

function calculatedSpan(side, usd, fuel) {
  const highMpgCost = eiaAnnualCost(side.mpgMax, usd, fuel);
  const lowMpgCost = eiaAnnualCost(side.mpgMin, usd, fuel);
  if (highMpgCost == null || lowMpgCost == null) return "";
  return dollarSpan(highMpgCost, lowMpgCost);
}

function mpgPhrase(side) {
  const combined = span(side.mpgMin, side.mpgMax, "mpg combined");
  const city = span(side.cityMin, side.cityMax, "mpg city");
  const hwy = span(side.hwyMin, side.hwyMax, "mpg highway");
  if (combined && city && hwy) return `${combined} (${city}, ${hwy})`;
  return combined;
}

export function hybridAnswer(pair, epaDate) {
  let hybridText = mpgPhrase(pair.hybrid);
  const kwh = kwhSpan(pair.hybrid.kwhMin, pair.hybrid.kwhMax);
  if (kwh) hybridText = `${hybridText} and ${kwh}`;
  const rated = `EPA rates the ${pair.year} ${pair.makeName} ${pair.modelName} gasoline configurations at ${mpgPhrase(pair.gas)} and the ${pair.kindLabel} configurations at ${hybridText} (fuel economy file dated ${epaDate}).`;
  const cost = `EPA's annual fuel cost is ${money(pair.gas.costMin) === money(pair.gas.costMax) ? money(pair.gas.costMin) : `${money(pair.gas.costMin)}–${money(pair.gas.costMax)}`} for gasoline and ${money(pair.hybrid.costMin) === money(pair.hybrid.costMax) ? money(pair.hybrid.costMin) : `${money(pair.hybrid.costMin)}–${money(pair.hybrid.costMax)}`} for ${pair.kindLabel}.`;
  return `${rated} ${cost}`;
}

function costLabel(min, max) {
  if (min == null || max == null) return "—";
  if (min === max) return money(min);
  return `${money(min)}–${money(max)}`;
}

function sameVehicle(pair) {
  return pair.gas.makeSlug === pair.hybrid.makeSlug && pair.gas.modelSlug === pair.hybrid.modelSlug;
}

function complaintSentence(side, pair, dates) {
  const who = `the ${pair.year} ${side.makeName} ${side.modelName}`;
  if (side.match === "none") {
    return `NHTSA's files do not have a make and model name matched to ${who}. No complaint count is filled in from a different vehicle.`;
  }
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const counts = `NHTSA lists ${formatNumber(side.recalls)} recall campaigns in the file dated ${recallDate} and ${formatNumber(side.complaints)} complaints received so far in the file dated ${complaintDate} for ${who}.`;
  const split = sameVehicle(pair)
    ? " Those counts are not split between gasoline and hybrid configurations."
    : "";
  const also = side.alsoComplaints
    ? " Other matched NHTSA names are listed on the model year page and are not added to this count."
    : "";
  return `${counts}${split}${also}`;
}

export function hybridDocument(pair, { dates, eia = null }) {
  const epaDate = formatDate(dates.epa);
  const kindTitle = pair.kindLabel === "plug-in hybrid" ? "plug-in hybrid" : "hybrid";
  const columns = [
    { key: "gas", heading: "Gasoline", side: pair.gas },
    { key: "hybrid", heading: pair.kindLabel === "plug-in hybrid" ? "Plug-in hybrid" : "Hybrid", side: pair.hybrid },
  ];
  const cell = (value) => (value ? value : "—");
  const rows = [
    { label: "EPA class", numeric: false, gas: pair.gas.classFamily || "—", hybrid: pair.hybrid.classFamily || "—" },
    { label: "EPA configurations", numeric: true, gas: formatNumber(pair.gas.rows), hybrid: formatNumber(pair.hybrid.rows) },
    { label: "City mpg", numeric: true, gas: cell(span(pair.gas.cityMin, pair.gas.cityMax)), hybrid: cell(span(pair.hybrid.cityMin, pair.hybrid.cityMax)) },
    { label: "Highway mpg", numeric: true, gas: cell(span(pair.gas.hwyMin, pair.gas.hwyMax)), hybrid: cell(span(pair.hybrid.hwyMin, pair.hybrid.hwyMax)) },
    { label: "Combined mpg", numeric: true, gas: cell(span(pair.gas.mpgMin, pair.gas.mpgMax)), hybrid: cell(span(pair.hybrid.mpgMin, pair.hybrid.mpgMax)) },
    { label: "Annual fuel cost", numeric: true, gas: costLabel(pair.gas.costMin, pair.gas.costMax), hybrid: costLabel(pair.hybrid.costMin, pair.hybrid.costMax) },
  ];
  if (pair.gas.kwhMin != null || pair.hybrid.kwhMin != null) {
    rows.push({
      label: "kWh/100 mi",
      numeric: true,
      gas: cell(kwhSpan(pair.gas.kwhMin, pair.gas.kwhMax).replace(/ kWh\/100 mi$/, "")),
      hybrid: cell(kwhSpan(pair.hybrid.kwhMin, pair.hybrid.kwhMax).replace(/ kWh\/100 mi$/, "")),
    });
  }
  if (pair.gas.rangeMin != null || pair.hybrid.rangeMin != null) {
    rows.push({
      label: "Range (miles)",
      numeric: true,
      gas: cell(span(pair.gas.rangeMin, pair.gas.rangeMax)),
      hybrid: cell(span(pair.hybrid.rangeMin, pair.hybrid.rangeMax)),
    });
  }
  const productFuel = pair.gas.fuel && pair.gas.fuel === pair.hybrid.fuel ? pair.gas.fuel : "";
  const eiaProduct = productFuel === "Regular Gasoline" ? "gasoline" : productFuel === "Diesel" ? "diesel" : "";
  let calculatedNote = "";
  if (eia && eiaProduct && eia.product === eiaProduct && eia.usd) {
    const gasCalc = calculatedSpan(pair.gas, eia.usd, productFuel);
    const hybridCalc = calculatedSpan(pair.hybrid, eia.usd, productFuel);
    if (gasCalc && hybridCalc) {
      rows.push({ label: "Calculated annual cost", numeric: true, gas: gasCalc, hybrid: hybridCalc });
      const priceLabel = eiaProduct === "diesel" ? "U.S. on-highway diesel" : "U.S. regular gasoline";
      calculatedNote = `Calculated annual cost is 15,000 miles ÷ EPA combined mpg × the EIA ${priceLabel} price of ${formatUnitPrice(Number(eia.usd))} for the week of ${formatDate(eia.period)} (snapshot retrieved ${formatDate(eia.retrieved)}). It uses the fuel-cost calculator's combined-mpg formula and does not replace fuelCost08.`;
      if (pair.kind === "plug-in-hybrid" && pair.hybrid.kwhMax != null) {
        const sample = calculateCost({
          miles: 15000,
          comb: pair.hybrid.mpgMax,
          kwh: pair.hybrid.kwhMax,
          gallonPrice: eia.usd,
          fuel: productFuel,
          atv: "Plug-in Hybrid",
          mix: "combined",
        });
        if (sample.warning) calculatedNote = `${calculatedNote} ${sample.warning}`;
      }
    }
  }
  const links = [];
  const seenLinks = new Set();
  for (const side of [pair.gas, pair.hybrid]) {
    const key = `${side.makeSlug}/${side.modelSlug}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({
      heading: `${pair.year} ${side.makeName} ${side.modelName}`,
      href: `/${side.makeSlug}/${side.modelSlug}/${pair.year}/`,
      nhtsaHref: nhtsaVehicleUrl(pair.year, side.makeName, side.modelName),
      calculatorHref: `/tools/fuel-cost-calculator/?make=${side.makeSlug}&model=${side.modelSlug}&year=${pair.year}`,
    });
  }
  const notes = [];
  const complaintSides = sameVehicle(pair) ? [pair.gas] : [pair.gas, pair.hybrid];
  for (const side of complaintSides) notes.push(complaintSentence(side, pair, dates));
  if (calculatedNote) notes.push(calculatedNote);
  const sources = [
    `EPA fuel economy file dated ${epaDate}. Gasoline rows are configurations whose fuel contains Gasoline and whose atvType is blank. ${pair.kindLabel === "plug-in hybrid" ? "Plug-in hybrid" : "Hybrid"} rows are atvType ${pair.kind === "plug-in-hybrid" ? "Plug-in Hybrid" : "Hybrid"}. Annual fuel cost is EPA's published fuelCost08 figure for 15,000 miles and 55 percent city driving.`,
    `NHTSA recall file dated ${formatDate(dates.recalls)} and complaint file dated ${formatDate(dates.complaints)}. Counts are campaigns and distinct complaints received so far for the matched model year. They are not divided by EPA configuration when both powertrains share one model name.`,
  ];
  if (!calculatedNote) {
    sources.push(
      "This page does not calculate a second cost from the EIA snapshot when the two sides do not share regular gasoline or diesel. Premium and midgrade gasoline have no default in that snapshot.",
    );
  }
  return {
    title: `${pair.year} ${pair.makeName} ${pair.modelName} ${kindTitle} vs gasoline`,
    eyebrow: "Hybrid and gasoline",
    classLine: `${pair.year} ${pair.makeName} ${pair.modelName}. EPA configurations for this model year, gasoline beside ${kindTitle}.`,
    answer: hybridAnswer(pair, epaDate),
    tableHeading: "EPA fuel economy and annual fuel cost",
    tableCaption: `City, highway, and combined mpg and EPA annual fuel cost for gasoline and ${kindTitle} configurations of the ${pair.year} ${pair.makeName} ${pair.modelName}. Spans cover every matching EPA row. The fuel economy file is dated ${epaDate}.`,
    columns,
    rows,
    notes,
    links,
    linksHeading: "Model year and fuel-cost calculator",
    sourcesHeading: "Sources",
    sources,
  };
}

export function hybridIndexAnswer(count, epaDate) {
  return `EPA's fuel economy file dated ${epaDate} includes gasoline rows and hybrid rows for some of the same models. These ${count} pages list city, highway, and combined mpg and EPA's annual fuel cost for each side. The set follows configuration rows in that file, and it is not a sales ranking.`;
}

export function hybridIndexIntro(count) {
  return `Each page compares conventional gasoline configurations with hybrid or plug-in hybrid configurations of the same make and base model. The model year is the newest year in which both are in the EPA file, from model year ${HYBRID_MIN_YEAR} on. Sibling names that add Hybrid, PHEV, Prime, or Energi stay in that base model. Pairs are ordered by how many EPA configuration rows the model family has. A family can have one hybrid page and one plug-in hybrid page. This page lists ${count} pairs. This list is not a sales ranking.`;
}

export function hybridIndexCaption(epaDate) {
  return `Hybrid and gasoline comparisons from the EPA fuel economy file dated ${epaDate}. Annual fuel cost is the published fuelCost08 span. The order follows EPA configuration rows.`;
}

export function hybridIndexTeaser() {
  return "Same-model hybrid and gasoline pages list EPA city, highway, and combined mpg and the annual fuel cost for both configurations. They are separate from the example pairs of two different models.";
}

export function loadHybridFamilies() {
  if (familyCache) return familyCache;
  const summary = loadSummary();
  const families = [];
  for (const make of summary.makes) {
    const models = make.models.map((model) => ({
      ...model,
      doc: loadModel(make.slug, model.slug),
    }));
    const norms = new Set(models.map((model) => model.doc.modelNorm));
    const groups = new Map();
    for (const model of models) {
      const stem = familyStem(model.doc.modelNorm, norms);
      const group = groups.get(stem) || [];
      group.push(model);
      groups.set(stem, group);
    }
    for (const [stem, members] of groups) {
      const base = members.find((model) => model.doc.modelNorm === stem) || [...members].sort((a, b) => a.slug.localeCompare(b.slug))[0];
      const yearMap = new Map();
      let configCount = 0;
      for (const member of members) {
        for (const [yearText, detail] of Object.entries(member.doc.years || {})) {
          const configs = detail.configs || [];
          configCount += configs.length;
          const y = Number(yearText);
          const bucket = yearMap.get(y) || { y, gas: [], hybrid: [], phev: [] };
          const summaryRow = member.years.find((row) => row.y === y);
          const meta = {
            makeSlug: make.slug,
            makeName: make.name,
            modelSlug: member.slug,
            modelName: member.name,
            match: summaryRow?.match || detail.match || "none",
            complaints: summaryRow?.complaints || 0,
            recalls: summaryRow?.recalls || 0,
            alsoComplaints: summaryRow?.alsoComplaints || 0,
          };
          for (const config of configs) {
            if (isConventionalGas(config)) bucket.gas.push({ config, meta });
            else if (config.atv === "Hybrid") bucket.hybrid.push({ config, meta });
            else if (config.atv === "Plug-in Hybrid") bucket.phev.push({ config, meta });
          }
          yearMap.set(y, bucket);
        }
      }
      families.push({
        makeSlug: make.slug,
        makeName: make.name,
        modelSlug: base.slug,
        modelName: base.name,
        configCount,
        years: [...yearMap.values()],
      });
    }
  }
  familyCache = families;
  return familyCache;
}

export function loadHybridPairs() {
  if (pairCache) return pairCache;
  pairCache = selectHybridPairs(loadHybridFamilies());
  return pairCache;
}

export function readEiaRetail(csvText) {
  const rows = loadPriceSnapshot(csvText);
  const found = {};
  for (const product of ["gasoline", "diesel"]) {
    const row = rows.find((item) => item.product === product && item.area === "US");
    if (!row) continue;
    found[product] = {
      product,
      usd: row.price,
      period: row.period,
      retrieved: row.retrieved,
    };
  }
  return found;
}

export function eiaForPair(pair, retail) {
  const fuel = pair.gas.fuel && pair.gas.fuel === pair.hybrid.fuel ? pair.gas.fuel : "";
  const product = fuel === "Regular Gasoline" ? "gasoline" : fuel === "Diesel" ? "diesel" : "";
  if (!product || !retail?.[product]) return null;
  return retail[product];
}

export function loadEiaRetail() {
  const csv = readFileSync(new URL("../../data/eia-fuel-prices.csv", import.meta.url), "utf8");
  return readEiaRetail(csv);
}
