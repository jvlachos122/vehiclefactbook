import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta, loadModel, loadSummary } from "./catalog.js";
import { classFamily } from "./compare-pairs.js";
import { loadPriceSnapshot } from "./eia-prices.js";
import { NOT_LISTED } from "./ev-range.js";
import { formatDate, formatNumber } from "./format.js";
import { loadFuelCostPages, loadFuelCostYears, yearPhrase } from "./fuel-classes.js";
import { calculateCost, formatDollars, formatPeriod, formatUnitPrice, formatWholeDollars, toUsd } from "./fuel-cost.js";
import { sentenceCount } from "./jsonld-audit.js";

/**
 * Worked examples on the fuel-cost calculator.
 *
 * A model qualifies when one model year inside the fuel-cost class window has
 * both a conventional regular-gasoline row (blank atvType) and a hybrid
 * regular-gasoline row (atvType Hybrid), and the hybrid row's highest combined
 * mpg is higher. The year is the newest year in that window that qualifies.
 * Models are grouped by the gasoline row's EPA class family. A family with no
 * /fuel-cost/ page is skipped. The model with the most EPA configuration rows
 * is kept. The three families with the largest of those counts are shown.
 * Each side is the regular-gasoline row with the highest combined mpg.
 * The annual cost is the calculator's combined-mpg formula at EXAMPLE_MILES
 * and the U.S. regular gasoline price in the committed EIA snapshot.
 * Nothing here is a ranking and nothing is typed in as a finished total.
 */

export const EXAMPLE_COUNT = 3;
export const EXAMPLE_MILES = 15000;
export const FUEL_CALCULATOR_PATH = "/tools/fuel-cost-calculator/";
export const FUEL_CALCULATOR_CRUMBS = [
  { label: "Home", href: "/" },
  { label: "Fuel cost", href: FUEL_CALCULATOR_PATH },
];
export const FUEL_CALCULATOR_BANNED = /\b(avoid|reliable|unreliable|best|worst)\b/i;

function committedFile(name) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "data", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find data/${name}`);
}

let bundleCache;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function wordCount(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length;
}

function assertCopy(text, where) {
  if (FUEL_CALCULATOR_BANNED.test(text)) throw new Error(`Fuel calculator ${where} uses a banned word`);
  return text;
}

function series(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isConventionalGas(config) {
  return !clean(config?.atv) && clean(config?.fuel) === "Regular Gasoline" && positive(config?.comb);
}

function isHybridGas(config) {
  return clean(config?.atv) === "Hybrid" && clean(config?.fuel) === "Regular Gasoline" && positive(config?.comb);
}

function byEconomy(left, right) {
  return (
    clean(left.model).localeCompare(clean(right.model), "en") ||
    (Number(left.displ) || 0) - (Number(right.displ) || 0) ||
    (Number(left.cylinders) || 0) - (Number(right.cylinders) || 0) ||
    clean(left.trany).localeCompare(clean(right.trany), "en") ||
    clean(left.drive).localeCompare(clean(right.drive), "en")
  );
}

function pickRow(configs, predicate) {
  const rows = (configs || []).filter(predicate);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((config) => Number(config.comb)));
  const tied = rows.filter((config) => Number(config.comb) === max);
  tied.sort(byEconomy);
  return tied[0];
}

function configCount(doc) {
  let total = 0;
  for (const year of Object.values(doc?.years || {})) total += (year?.configs || []).length;
  return total;
}

function mpgLabel(value) {
  return positive(value) ? formatNumber(positive(value)) : NOT_LISTED;
}

function configurationLabel(config) {
  const engine = [config.displ ? `${config.displ}L` : "", config.cylinders ? `${config.cylinders}-cyl` : ""].filter(Boolean).join(" ");
  return [clean(config.model), engine, clean(config.trany), clean(config.drive)].filter(Boolean).join(", ");
}

function classLink(family, pages) {
  if (!family) return null;
  const page = pages.find((item) => item.family === family);
  if (!page) return null;
  return { family, href: page.path, label: page.label };
}

function sideFrom(config, powertrain, usd, pages) {
  const result = calculateCost({
    miles: EXAMPLE_MILES,
    comb: Number(config.comb),
    city: config.cityMpg,
    hwy: config.hwy,
    gallonPrice: usd,
    fuel: "Regular Gasoline",
    atv: clean(config.atv),
    mix: "combined",
  });
  if (result.status !== "ok") {
    throw new Error(`Fuel example ${powertrain} ${config.model} did not calculate (${result.status})`);
  }
  const family = classFamily(config.vclass);
  const link = classLink(family, pages);
  const fuelCost08 = positive(config.cost);
  return {
    powertrain,
    atv: clean(config.atv),
    fuel: "Regular Gasoline",
    configName: clean(config.model),
    displ: config.displ ?? null,
    cylinders: config.cylinders ?? null,
    trany: clean(config.trany),
    drive: clean(config.drive),
    vclass: clean(config.vclass),
    family,
    classHref: link?.href || "",
    classLabel: link?.label || family,
    label: configurationLabel(config),
    city: positive(config.cityMpg),
    hwy: positive(config.hwy),
    comb: Number(config.comb),
    cityLabel: mpgLabel(config.cityMpg),
    hwyLabel: mpgLabel(config.hwy),
    combLabel: mpgLabel(config.comb),
    fuelCost08,
    fuelCostLabel: fuelCost08 == null ? NOT_LISTED : formatWholeDollars(fuelCost08),
    calculated: result.cost,
    calculatedLabel: formatDollars(result.cost),
  };
}

function qualify(doc, windowYears) {
  const years = Object.keys(doc?.years || {})
    .map(Number)
    .filter((year) => windowYears.has(year))
    .sort((a, b) => b - a);
  for (const year of years) {
    const configs = doc.years[String(year)]?.configs || [];
    const gas = pickRow(configs, isConventionalGas);
    const hybrid = pickRow(configs, isHybridGas);
    if (!gas || !hybrid) continue;
    if (Number(hybrid.comb) <= Number(gas.comb)) continue;
    return { year, gas, hybrid };
  }
  return null;
}

function methodParagraphs(facts) {
  const electric = facts.electricNote
    ? `EIA marks the ${facts.electricYear} residential electricity rows in this snapshot as ${facts.electricNote}.`
    : "The residential electricity rows in this snapshot carry no extra note.";
  return [
    `The form above divides a distance by an EPA fuel-economy rate and multiplies by a price. Annual mode opens with the miles box set to ${facts.miles}. Trip mode clears that box so the distance can be one drive rather than a full year. The driving-mix control has four settings. Combined uses the combined mpg, or the combined kilowatt-hours per 100 miles, printed on the chosen EPA row. City only and highway only each use that one rating. The split setting takes the city percent of the miles, divides those miles by city mpg, divides the rest by highway mpg, and adds the gallons. It does not add the city and highway ratings and then divide by two. An electric row ignores the mix and uses combined kilowatt-hours per 100 miles, because the committed row has no separate city or highway kilowatt-hour rate.`,
    `The price boxes start from the snapshot committed in data/eia-fuel-prices.csv. Regular gasoline and on-highway diesel are weekly retail averages, and those published averages include taxes. Residential electricity is a monthly cents-per-kilowatt-hour average. ${electric} The area menu can replace the national row with a PADD region for gasoline or diesel, or with a state for electricity. Premium gasoline and midgrade gasoline have no row in the snapshot. When the configuration lists one of those fuels, the form keeps the gallon price already in the box and the result says that price is not an EIA default for that fuel. Clearing a price leaves the calculated cost blank. The fuelCost08 figure stays on the result, because that column is copied from the EPA row and is not a product of the price box.`,
    `The worked-example table is filled in when the site is built, from EPA configuration rows in the fuel-economy file dated ${facts.epaDate}. A model is eligible only when one of ${facts.years} contains both a conventional regular-gasoline configuration and a hybrid regular-gasoline configuration. Conventional means the atvType cell is blank and the fuel cell says Regular Gasoline. Hybrid means atvType is Hybrid and the fuel cell says the same thing. The hybrid row also has to show a higher combined mpg than the gasoline row, so the table is not repeating one rate under two labels. The year is the newest year in that window that meets the test. Eligible models are grouped by the gasoline row's EPA size class. A 2WD or 4WD suffix on that class name is dropped before the grouping, which is how the class rankings are built. A family with no published fuel-cost class page is left out. Inside a family, the model with the most configuration rows in the whole file is kept, and a tie goes to the newer year, then the make name, then the model name. The three families with the largest of those counts are shown. This build uses ${facts.names}.`,
    `On each side, the configuration is the regular-gasoline row with the highest combined mpg. If several rows share that mpg, the EPA model string decides, then the lower displacement, then the lower cylinder count, then the transmission, then the drive. The calculated annual cost is ${facts.miles} divided by that combined mpg, times the U.S. regular gasoline price of ${facts.price} per gallon for the week of ${facts.gasPeriod}. The snapshot was retrieved ${facts.retrieved}. Both sides of one model use that single price, so the gap between the two costs is the gap in combined mpg. City mpg and highway mpg are on the same line so the combined figure can be matched to one committed row. They are not the inputs to the calculated column. The EPA fuelCost08 column is the annual figure stored on the row. EPA's notes describe fuelCost08 as an annual figure at a distance of ${facts.miles} miles with the city share at 55 percent, using fuel prices this committed file does not carry. The calculated column will not, in general, equal fuelCost08, and it is not presented as a replacement for it.`,
    `Read the amounts as arithmetic on a laboratory rating and one national average. A different pump price, a different distance, towing, and winter weather all change what is spent, which is why the form lets either box be overwritten. Plug-in hybrids are not in this table. On the form, a plug-in hybrid is costed from mpg and the gallon price alone, and the result says the kilowatt-hour rate was not added on top. An all-electric configuration uses kilowatt-hours per 100 miles and the electricity price instead of gallons. The three models are not ordered as a recommendation, and the table does not use complaint counts, recall campaigns, or star ratings. The configuration-row count that selects a model counts EPA rows. It is not a sales volume. The vehicle name links to that model year. The class name links to the class ranking for that row's EPA family. The model hub lists the other model years.`,
  ].map((paragraph, index) => assertCopy(paragraph, `method paragraph ${index + 1}`));
}

function buildBundle() {
  const meta = loadMeta();
  const pages = loadFuelCostPages();
  const yearList = loadFuelCostYears();
  const windowYears = new Set(yearList);
  if (!windowYears.size) throw new Error("Fuel calculator examples have no fuel-cost class years");
  const prices = loadPriceSnapshot(readFileSync(committedFile("eia-fuel-prices.csv"), "utf8"));
  const gas = prices.find((row) => row.product === "gasoline" && row.area === "US");
  const diesel = prices.find((row) => row.product === "diesel" && row.area === "US");
  const elec = prices.find((row) => row.product === "electricity" && row.area === "US");
  if (!gas || !diesel || !elec) throw new Error("EIA snapshot is missing a U.S. price");
  const priceUsd = toUsd(gas.price, gas.unit);
  if (!priceUsd) throw new Error("U.S. gasoline price did not convert");
  const candidates = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      const found = qualify(doc, windowYears);
      if (!found) continue;
      const family = classFamily(found.gas.vclass);
      const link = classLink(family, pages);
      if (!link) continue;
      candidates.push({
        makeName: doc.make,
        makeSlug: doc.makeSlug,
        modelName: doc.model,
        modelSlug: doc.modelSlug,
        configCount: configCount(doc),
        year: found.year,
        family,
        gas: found.gas,
        hybrid: found.hybrid,
      });
    }
  }
  const byFamily = new Map();
  for (const candidate of candidates) {
    const list = byFamily.get(candidate.family) || [];
    list.push(candidate);
    byFamily.set(candidate.family, list);
  }
  const winners = [];
  for (const list of byFamily.values()) {
    list.sort(
      (a, b) =>
        b.configCount - a.configCount ||
        b.year - a.year ||
        a.makeName.localeCompare(b.makeName, "en") ||
        a.modelName.localeCompare(b.modelName, "en"),
    );
    winners.push(list[0]);
  }
  winners.sort((a, b) => b.configCount - a.configCount || a.family.localeCompare(b.family, "en"));
  const chosen = winners.slice(0, EXAMPLE_COUNT);
  if (chosen.length < EXAMPLE_COUNT) {
    throw new Error(`Fuel calculator examples found ${chosen.length} class families, need ${EXAMPLE_COUNT}`);
  }
  const examples = chosen.map((candidate) => {
    const gasSide = sideFrom(candidate.gas, "Gasoline", priceUsd, pages);
    const hybridSide = sideFrom(candidate.hybrid, "Hybrid", priceUsd, pages);
    if (!gasSide.classHref) throw new Error(`No fuel-cost class page for ${candidate.family}`);
    if (!hybridSide.classHref) {
      hybridSide.classHref = gasSide.classHref;
      hybridSide.classLabel = gasSide.classLabel;
    }
    const yearHref = `/${candidate.makeSlug}/${candidate.modelSlug}/${candidate.year}/`;
    const modelHref = `/${candidate.makeSlug}/${candidate.modelSlug}/`;
    return {
      makeName: candidate.makeName,
      makeSlug: candidate.makeSlug,
      modelName: candidate.modelName,
      modelSlug: candidate.modelSlug,
      year: candidate.year,
      configCount: candidate.configCount,
      family: candidate.family,
      classLabel: gasSide.classLabel,
      classHref: gasSide.classHref,
      yearHref,
      modelHref,
      gas: gasSide,
      hybrid: hybridSide,
    };
  });
  const miles = formatNumber(EXAMPLE_MILES);
  const price = formatUnitPrice(Number(priceUsd));
  const gasPeriod = formatDate(gas.period);
  const retrieved = formatDate(gas.retrieved);
  const epaDate = formatDate(meta.dates.epa);
  const years = yearPhrase(yearList);
  const names = series(examples.map((example) => `the ${example.year} ${example.makeName} ${example.modelName} in the ${example.classLabel} class`));
  const paragraphs = methodParagraphs({
    miles,
    price,
    gasPeriod,
    retrieved,
    epaDate,
    years,
    names,
    electricNote: clean(elec.note),
    electricYear: String(elec.period || "").slice(0, 4),
  });
  const methodText = paragraphs.join(" ");
  if (wordCount(methodText) < 300) {
    throw new Error(`Fuel calculator method is ${wordCount(methodText)} words`);
  }
  const caption = assertCopy(
    `Annual fuel cost for three models that each have a conventional regular-gasoline configuration and a hybrid regular-gasoline configuration in ${years}. Each calculated cost is ${miles} miles divided by that row's EPA combined mpg, times the U.S. regular gasoline price of ${price} per gallon for the week of ${gasPeriod}. That price is the U.S. gasoline row committed in data/eia-fuel-prices.csv, retrieved ${retrieved}. The row on each side is the regular-gasoline configuration with the highest combined mpg. EPA fuelCost08 is the annual figure stored on the row and is not recomputed from this price.`,
    "example caption",
  );
  const classLinks = [];
  const seenClass = new Set();
  for (const example of examples) {
    for (const side of [example.gas, example.hybrid]) {
      if (!side.classHref || seenClass.has(side.classHref)) continue;
      seenClass.add(side.classHref);
      classLinks.push({ href: side.classHref, label: side.classLabel });
    }
  }
  const rows = examples.flatMap((example) =>
    [example.gas, example.hybrid].map((side) => ({
      vehicle: `${example.year} ${example.makeName} ${example.modelName}`,
      yearHref: example.yearHref,
      powertrain: side.powertrain,
      label: side.label,
      cityLabel: side.cityLabel,
      hwyLabel: side.hwyLabel,
      combLabel: side.combLabel,
      calculatedLabel: side.calculatedLabel,
      fuelCostLabel: side.fuelCostLabel,
      classLabel: side.classLabel,
      classHref: side.classHref,
    })),
  );
  return {
    examples,
    rows,
    paragraphs,
    methodText,
    caption,
    classLinks,
    hubLinks: examples.map((example) => ({
      href: example.modelHref,
      label: `${example.makeName} ${example.modelName}`,
    })),
    miles: EXAMPLE_MILES,
    priceUsd,
    priceLabel: price,
    gasPeriod: gas.period,
    retrieved: gas.retrieved,
    epaDate: meta.dates.epa,
    years: [...windowYears].sort((a, b) => a - b),
    gas,
    diesel,
    elec,
    prices,
    electricPeriodLabel: formatPeriod(elec.period),
  };
}

function bundle() {
  if (!bundleCache) bundleCache = buildBundle();
  return bundleCache;
}

export function loadFuelCalculatorView() {
  return bundle();
}

export function selectFuelExamples() {
  return bundle().examples;
}

export function fuelExampleFingerprint() {
  const view = bundle();
  return {
    miles: view.miles,
    priceUsd: view.priceUsd,
    examples: view.examples.map((example) => ({
      makeSlug: example.makeSlug,
      modelSlug: example.modelSlug,
      year: example.year,
      classHref: example.classHref,
      gas: {
        configName: example.gas.configName,
        displ: example.gas.displ,
        cylinders: example.gas.cylinders,
        trany: example.gas.trany,
        drive: example.gas.drive,
        comb: example.gas.comb,
        calculatedLabel: example.gas.calculatedLabel,
        fuelCostLabel: example.gas.fuelCostLabel,
      },
      hybrid: {
        configName: example.hybrid.configName,
        displ: example.hybrid.displ,
        cylinders: example.hybrid.cylinders,
        trany: example.hybrid.trany,
        drive: example.hybrid.drive,
        comb: example.hybrid.comb,
        calculatedLabel: example.hybrid.calculatedLabel,
        fuelCostLabel: example.hybrid.fuelCostLabel,
      },
    })),
  };
}

export function fuelCalculatorAnswer({ epaDate, epaRows, gasPeriod, electricPeriod, retrieved }) {
  const text = `This calculator turns an EPA mpg or kWh per 100 miles into an annual or trip fuel cost. The rates are the fuel-economy file dated ${epaDate} (${epaRows} rows for model year 2000 and newer), and the starting prices are the EIA gasoline, diesel, and electricity rows committed in data/eia-fuel-prices.csv as of ${gasPeriod} for gasoline and diesel and ${electricPeriod} for electricity, retrieved ${retrieved}. The result uses the price in the form and does not replace the published fuelCost08 figure.`;
  if (sentenceCount(text) < 1 || sentenceCount(text) > 3) {
    throw new Error(`Fuel calculator answer has ${sentenceCount(text)} sentences`);
  }
  if (!String(epaDate || "").trim() || !String(gasPeriod || "").trim() || !String(retrieved || "").trim()) {
    throw new Error("Fuel calculator answer is missing a source date");
  }
  if (!text.includes("data/eia-fuel-prices.csv")) throw new Error("Fuel calculator answer omits the EIA snapshot");
  return assertCopy(text, "answer");
}
