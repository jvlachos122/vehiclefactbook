import { loadMeta, loadModel, loadSummary } from "./catalog.js";
import { classFamily } from "./compare-pairs.js";
import { answerConfig, yearList } from "./ev-range.js";
import { formatDate, formatNumber, money, plural } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";

/**
 * Annual fuel cost by EPA size class.
 *
 * The year window is the newest FUEL_COST_YEAR_COUNT model years that have an
 * EPA configuration in the committed model files. Three years is the width
 * used here, inside the two-to-three-year range for this page.
 *
 * An EPA class family is VClass with a trailing "2WD" or "4WD" label removed.
 * That is the same classFamily rule the example comparisons use, so
 * "Small Sport Utility Vehicle 2WD" and "Small Sport Utility Vehicle 4WD"
 * share /fuel-cost/small-suv/.
 *
 * A class page exists when at least FUEL_COST_MIN_MODELS distinct models have
 * a positive fuelCost08 in the window. Fewer models stay off the index.
 *
 * Each published row is one model in one section (electric / plug-in hybrid,
 * or everything else). The row is that model's lowest fuelCost08. When another
 * configuration of the same model costs more, the highest fuelCost08 is a
 * second row. Configurations between those two figures are not listed, which
 * keeps the page inside the site's HTML size limit. Rows with no positive
 * fuelCost08 are omitted and are not shown as $0.
 *
 * Electric, plug-in hybrid, and hydrogen rows are a separate table so MPGe is
 * not presented as mpg. fuelCost08 already uses EPA's assumed miles and fuel
 * prices. This file does not contain those prices, so the pages do not state one.
 *
 * The sort is fuelCost08 ascending. The pages do not say best, worst, or avoid.
 */

export const FUEL_COST_INDEX = "/fuel-cost/";
export const FUEL_COST_YEAR_COUNT = 3;
export const FUEL_COST_MIN_MODELS = 5;
export const FUEL_COST_CALCULATOR = "/tools/fuel-cost-calculator/";
export const EPA_VEHICLES_URL = "https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip";
export const FUEL_COST_BANNED = /\b(avoid|best|worst|reliable|unreliable)\b/i;

const CLASS_META = new Map([
  ["Two Seaters", { slug: "two-seater", label: "Two seater" }],
  ["Minicompact Cars", { slug: "minicompact-car", label: "Minicompact car" }],
  ["Subcompact Cars", { slug: "subcompact-car", label: "Subcompact car" }],
  ["Compact Cars", { slug: "compact-car", label: "Compact car" }],
  ["Midsize Cars", { slug: "midsize-car", label: "Midsize car" }],
  ["Large Cars", { slug: "large-car", label: "Large car" }],
  ["Small Station Wagons", { slug: "small-wagon", label: "Small station wagon" }],
  ["Midsize Station Wagons", { slug: "midsize-wagon", label: "Midsize station wagon" }],
  ["Small Sport Utility Vehicle", { slug: "small-suv", label: "Small SUV" }],
  ["Standard Sport Utility Vehicle", { slug: "standard-suv", label: "Standard SUV" }],
  ["Sport Utility Vehicle", { slug: "suv", label: "SUV" }],
  ["Minivan", { slug: "minivan", label: "Minivan" }],
  ["Small Pickup Trucks", { slug: "small-pickup", label: "Small pickup" }],
  ["Standard Pickup Trucks", { slug: "standard-pickup", label: "Standard pickup" }],
  ["Pickup Trucks", { slug: "pickup", label: "Pickup" }],
  ["Special Purpose Vehicle", { slug: "special-purpose", label: "Special purpose vehicle" }],
  ["Vans, Passenger Type", { slug: "passenger-van", label: "Passenger van" }],
  ["Vans, Cargo Type", { slug: "cargo-van", label: "Cargo van" }],
  ["Vans", { slug: "van", label: "Van" }],
]);

let cache;

export function positiveNumber(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

export function fuelCostWindow(years) {
  const nums = [...new Set((years || []).map(Number))].filter((year) => Number.isInteger(year)).sort((a, b) => b - a);
  return nums.slice(0, FUEL_COST_YEAR_COUNT).sort((a, b) => a - b);
}

export function classMeta(family) {
  const known = CLASS_META.get(family);
  if (known) return known;
  const slug = String(family || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { slug, label: family };
}

export function labelLower(label) {
  const text = String(label || "");
  if (!text || text === text.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function articleFor(label) {
  const lower = labelLower(label);
  const an = /^(a|e|i|o|u|suv\b)/i.test(lower);
  return `${an ? "an" : "a"} ${lower}`;
}

export function powerKind(config) {
  if (config?.atv === "Plug-in Hybrid") return "phev";
  if (config?.atv === "FCV" || config?.atv === "eFCV" || config?.fuel === "Hydrogen") return "hydrogen";
  if (config?.atv === "EV" || config?.fuel === "Electricity") return "ev";
  return "other";
}

export function sectionFor(config) {
  return powerKind(config) === "other" ? "combustion" : "plug";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function fuelPhrase(fuel) {
  return clean(fuel).toLowerCase();
}

export function trimKey(row) {
  const name = clean(row.configName);
  const base = clean(row.model);
  const distinct = name && name.localeCompare(base, "en", { sensitivity: "accent" }) !== 0;
  const engine = [row.displ ? `${row.displ}L` : "", row.cylinders ? `${row.cylinders}-cyl` : ""].filter(Boolean).join(" ");
  const parts = [];
  if (distinct) parts.push(name);
  if (engine) parts.push(engine);
  if (row.trany) parts.push(row.trany);
  return parts.join(", ") || name || "configuration";
}

function formatComb(value) {
  if (Number.isInteger(value)) return formatNumber(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function combUnitFor(kind) {
  return kind === "ev" || kind === "hydrogen" ? "MPGe" : "mpg";
}

export function combLabel(comb, unit) {
  if (comb == null) return "not listed";
  return `${formatComb(comb)} ${unit}`;
}

export function normalizeConfig(doc, year, config) {
  const kind = powerKind(config);
  const cost = positiveNumber(config?.cost);
  return {
    year,
    make: doc.make,
    makeSlug: doc.makeSlug,
    model: doc.model,
    modelSlug: doc.modelSlug,
    configName: clean(config?.model),
    vclass: clean(config?.vclass),
    family: classFamily(config?.vclass),
    drive: clean(config?.drive),
    fuel: clean(config?.fuel),
    atv: clean(config?.atv),
    trany: clean(config?.trany),
    displ: positiveNumber(config?.displ),
    cylinders: positiveNumber(config?.cylinders),
    comb: positiveNumber(config?.comb),
    cost,
    kind,
    section: kind === "other" ? "combustion" : "plug",
    href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
  };
}

export function tableSort(left, right) {
  return (
    left.cost - right.cost ||
    left.year - right.year ||
    left.make.localeCompare(right.make, "en") ||
    left.model.localeCompare(right.model, "en") ||
    left.trim.localeCompare(right.trim, "en") ||
    left.fuel.localeCompare(right.fuel, "en") ||
    left.drive.localeCompare(right.drive, "en") ||
    left.href.localeCompare(right.href)
  );
}

function preferComb(left, right, higherWins) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (higherWins) return right - left;
  return left - right;
}

function extremeSort(which) {
  const low = which === "low";
  return (left, right) =>
    (low ? left.cost - right.cost : right.cost - left.cost) ||
    right.year - left.year ||
    preferComb(left.comb, right.comb, low) ||
    left.trim.localeCompare(right.trim, "en") ||
    left.fuel.localeCompare(right.fuel, "en") ||
    left.drive.localeCompare(right.drive, "en") ||
    left.href.localeCompare(right.href);
}

function rowFrom(record) {
  const trim = trimKey(record);
  const combUnit = combUnitFor(record.kind);
  if (!(record.cost > 0)) throw new Error("fuel cost row is missing fuelCost08");
  return {
    ...record,
    trim,
    combUnit,
    combLabel: combLabel(record.comb, combUnit),
    costLabel: money(record.cost),
  };
}

function rowKey(row) {
  return [row.year, row.href, row.trim, row.fuel, row.drive, row.cost, row.comb].join("|");
}

export function selectModelRows(records) {
  const groups = new Map();
  for (const record of records) {
    if (!(record.cost > 0)) continue;
    const withTrim = { ...record, trim: trimKey(record) };
    const key = `${record.makeSlug}|${record.modelSlug}|${record.section}`;
    const list = groups.get(key);
    if (list) list.push(withTrim);
    else groups.set(key, [withTrim]);
  }
  const rows = [];
  for (const list of groups.values()) {
    const low = rowFrom([...list].sort(extremeSort("low"))[0]);
    const high = rowFrom([...list].sort(extremeSort("high"))[0]);
    rows.push(low);
    if (high.cost !== low.cost) rows.push(high);
  }
  rows.sort(tableSort);
  return rows;
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function yearPhrase(years) {
  const nums = [...(years || [])];
  if (!nums.length) return "no model year";
  if (nums.length === 1) return `model year ${nums[0]}`;
  return `model years ${yearList(nums)}`;
}

export function temporalCoverage(years) {
  const nums = [...(years || [])];
  if (!nums.length) return "";
  if (nums.length === 1) return String(nums[0]);
  return `${nums[0]}/${nums[nums.length - 1]}`;
}

function tieStats(records, cost) {
  const tied = records.filter((record) => record.cost === cost);
  const fuel = tied[0]?.fuel || "";
  return {
    count: tied.length,
    sameFuel: tied.every((record) => record.fuel === fuel),
  };
}

function onFuel(fuel) {
  const phrase = fuelPhrase(fuel);
  return phrase ? `on ${phrase}` : "with no fuel listed";
}

function tiePhrase(stats) {
  if (stats.count <= 1) return "";
  const shared = stats.sameFuel ? "" : ", which do not all use the same fuel";
  return `, one of ${formatNumber(stats.count)} configurations at that figure${shared}`;
}

function vehiclePhrase(row) {
  return `${row.year} ${answerConfig(row.make)} ${answerConfig(row.model)}`;
}

export function assertFuelCostCopy(text) {
  const value = String(text || "");
  if (FUEL_COST_BANNED.test(value)) throw new Error(`Fuel cost copy uses a banned word: ${value}`);
  return value;
}

function omittedSentence(count) {
  if (!count) return "Every configuration in these years has a fuelCost08.";
  if (count === 1) return "1 configuration in these years has no fuelCost08 and is not listed.";
  return `${formatNumber(count)} configurations in these years have no fuelCost08 and are not listed.`;
}

export function buildClassPage(family, records) {
  const listed = records.filter((record) => record.cost > 0);
  if (!listed.length) return null;
  const meta = classMeta(family);
  if (!meta.slug || meta.slug === "index") throw new Error(`Fuel cost slug is not usable for ${family}`);
  const models = new Set(listed.map((record) => `${record.makeSlug}/${record.modelSlug}`));
  const combustion = selectModelRows(listed.filter((record) => record.section === "combustion"));
  const plug = selectModelRows(listed.filter((record) => record.section === "plug"));
  const displayed = [...combustion, ...plug].sort(tableSort);
  const low = displayed[0];
  const high = displayed[displayed.length - 1];
  const vclasses = [...new Set(records.map((record) => record.vclass).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
  const years = [...new Set(records.map((record) => record.year))].sort((a, b) => a - b);
  return {
    family,
    slug: meta.slug,
    label: meta.label,
    labelLower: labelLower(meta.label),
    path: `${FUEL_COST_INDEX}${meta.slug}/`,
    years,
    yearLabel: yearList(years),
    configCount: listed.length,
    omittedCost: records.length - listed.length,
    modelCount: models.size,
    vclasses,
    combustion,
    plug,
    low,
    high,
    lowTies: tieStats(listed, low.cost),
    highTies: tieStats(listed, high.cost),
    modelKeys: [...models].sort(),
  };
}

function headingFor(section, rows) {
  if (section === "combustion") return "Gasoline and other fuels";
  const parts = [];
  if (rows.some((row) => row.kind === "ev")) parts.push("Electric");
  if (rows.some((row) => row.kind === "phev")) parts.push("plug-in hybrid");
  if (rows.some((row) => row.kind === "hydrogen")) parts.push("hydrogen");
  if (!parts.length) return "Electric and plug-in hybrid";
  const titled = parts.map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part));
  if (titled.length === 1) return titled[0];
  if (titled.length === 2) return `${titled[0]} and ${titled[1]}`;
  return `${titled.slice(0, -1).join(", ")}, and ${titled.at(-1)}`;
}

function combHeading(rows) {
  const units = [...new Set(rows.map((row) => row.combUnit))];
  if (units.length === 1) return `Combined ${units[0]}`;
  return "Combined mpg or MPGe";
}

export function sectionOrder(page) {
  if (!page.combustion.length) return ["plug"];
  if (!page.plug.length) return ["combustion"];
  const combustionMin = page.combustion[0].cost;
  const plugMin = page.plug[0].cost;
  if (plugMin < combustionMin) return ["plug", "combustion"];
  return ["combustion", "plug"];
}

export function orderedSections(page, epaDate) {
  const dated = formatDate(epaDate);
  return sectionOrder(page).map((id) => {
    const rows = page[id];
    const hydrogen = rows.some((row) => row.kind === "hydrogen");
    const subject = id === "plug"
      ? hydrogen
        ? "Electric, plug-in hybrid, and hydrogen configurations. All-electric and hydrogen combined figures are MPGe. Plug-in hybrid combined figures are the stored mpg."
        : "Electric and plug-in hybrid configurations. All-electric combined figures are MPGe. Plug-in hybrid combined figures are the stored mpg."
      : "Gasoline, diesel, hybrid, and other configurations that are not electric or plug-in hybrid. Combined figures are mpg.";
    const caption = assertFuelCostCopy(
      `${subject} Each model is one row at its lowest fuelCost08 and a second row when another configuration costs more. Sorted by fuelCost08, lowest first, for ${yearPhrase(page.years)}. EPA file dated ${dated}. ${plural(rows.length, "row")}.`,
    );
    return {
      id,
      heading: assertFuelCostCopy(headingFor(id, rows)),
      combHeading: combHeading(rows),
      caption,
      rows,
    };
  });
}

export function fuelCostAnswer(page, epaDate) {
  const dated = formatDate(epaDate);
  const file = dated ? ` dated ${dated}` : "";
  const span = page.low.cost === page.high.cost
    ? `an annual fuel cost (fuelCost08) of ${page.low.costLabel}`
    : `annual fuel cost (fuelCost08) from ${page.low.costLabel} to ${page.high.costLabel}`;
  const first = `In the EPA fuel economy file${file}, ${plural(page.configCount, `${page.labelLower} configuration`)} for ${yearPhrase(page.years)} have ${span}.`;
  let second;
  if (page.low.cost === page.high.cost) {
    second = `That figure is the ${vehiclePhrase(page.low)} ${onFuel(page.low.fuel)}${tiePhrase(page.lowTies)}.`;
  } else {
    second = `The lowest figure is ${page.low.costLabel} for the ${vehiclePhrase(page.low)} ${onFuel(page.low.fuel)}${tiePhrase(page.lowTies)}, and the highest figure is ${page.high.costLabel} for the ${vehiclePhrase(page.high)} ${onFuel(page.high.fuel)}${tiePhrase(page.highTies)}.`;
  }
  const third = "EPA's documentation for fuelCost08 uses 15,000 miles and 55 percent city driving, and this file does not list the fuel prices EPA used.";
  const text = `${first} ${second} ${third}`;
  if (sentenceCount(text) > 3) throw new Error(`Fuel cost answer has ${sentenceCount(text)} sentences: ${text}`);
  return assertFuelCostCopy(text);
}

export function fuelCostIndexAnswer(pages, years, epaDate) {
  const dated = formatDate(epaDate);
  const file = dated ? ` dated ${dated}` : "";
  const first = `The EPA fuel economy file${file} sorts fuelCost08 for ${plural(pages.length, "size class", "size classes")} in ${yearPhrase(years)}.`;
  const second = "Each class page names the lowest and highest published figure, and its tables list the lowest and highest figure for each model.";
  const third = "EPA's documentation for fuelCost08 uses 15,000 miles and 55 percent city driving, and this file does not list the fuel prices EPA used.";
  const text = `${first} ${second} ${third}`;
  if (sentenceCount(text) > 3) throw new Error(`Fuel cost index answer has ${sentenceCount(text)} sentences: ${text}`);
  return assertFuelCostCopy(text);
}

export function fuelCostCaveatParts() {
  return {
    before: "These figures are EPA estimates at 15,000 miles per year and 55 percent city driving, using the fuel prices EPA assumed for fuelCost08. Your cost will differ. Enter miles and a price in the ",
    linkLabel: "fuel cost calculator",
    href: FUEL_COST_CALCULATOR,
    after: ".",
  };
}

export function fuelCostCaveatText() {
  const parts = fuelCostCaveatParts();
  return assertFuelCostCopy(`${parts.before}${parts.linkLabel}${parts.after}`);
}

export function fuelCostSourceParts(page, epaDate) {
  const dated = formatDate(epaDate);
  const labels = page.vclasses.length > 1 ? ` The EPA labels on these rows are ${listPhrase(page.vclasses)}.` : "";
  return {
    before: "Source: EPA ",
    linkLabel: "fueleconomy.gov vehicles file",
    href: EPA_VEHICLES_URL,
    after: assertFuelCostCopy(
      ` dated ${dated}. The EPA size class is ${page.family}. A trailing 2WD or 4WD label is removed from VClass, so two-wheel drive and four-wheel drive share this page. ${omittedSentence(page.omittedCost)}${labels}`,
    ),
  };
}

export function fuelCostIndexSourceParts(years, epaDate) {
  const dated = formatDate(epaDate);
  return {
    before: "Source: EPA ",
    linkLabel: "fueleconomy.gov vehicles file",
    href: EPA_VEHICLES_URL,
    after: assertFuelCostCopy(
      ` dated ${dated}. A class page needs at least ${FUEL_COST_MIN_MODELS} models with a positive fuelCost08 in ${yearPhrase(years)}. A trailing 2WD or 4WD label is removed from VClass. Electric and plug-in hybrid rows are in their own table. A configuration with no positive fuelCost08 is not listed.`,
    ),
  };
}

export function fuelCostIndexCaption(years, epaDate) {
  const dated = formatDate(epaDate);
  return assertFuelCostCopy(
    `EPA size classes with at least ${FUEL_COST_MIN_MODELS} models in ${yearPhrase(years)}. The lowest annual fuel cost is the lowest fuelCost08 in that class. EPA file dated ${dated}. Sorted by class name.`,
  );
}

export function fuelCostFaqs(page) {
  const vehicle = articleFor(page.label);
  const faqs = [
    {
      q: `How does EPA calculate annual fuel cost for ${vehicle}?`,
      a: "EPA's fuelCost08 uses 15,000 miles and 55 percent city driving. This file does not list the fuel prices EPA used, so this page does not state a price.",
    },
    {
      q: `Is a lower annual fuel cost a recommendation for ${vehicle}?`,
      a: "No. The tables sort EPA's published fuelCost08. A lower figure is only that estimate, and your cost will differ.",
    },
  ];
  if (page.combustion.length && page.plug.length) {
    faqs.push({
      q: `Why are electric and plug-in hybrid ${page.labelLower} rows in a separate table?`,
      a: "All-electric rows store combined MPGe, and plug-in hybrid rows mix electricity with gasoline. A separate table keeps those figures from being read as the same miles-per-gallon number.",
    });
  }
  return faqs.map((faq) => ({ q: assertFuelCostCopy(faq.q), a: assertFuelCostCopy(faq.a) }));
}

export function fuelCostIndexFaqs(years) {
  return [
    {
      q: "Which model years are in these fuel cost tables?",
      a: assertFuelCostCopy(`The tables use ${yearPhrase(years)}, the newest ${years.length} model years in the committed EPA file.`),
    },
    {
      q: "How are two-wheel drive and four-wheel drive combined?",
      a: assertFuelCostCopy("EPA's VClass often ends in 2WD or 4WD. This site removes that trailing label, and the rows share one class page."),
    },
    {
      q: "Can I use my own fuel price?",
      a: assertFuelCostCopy("Yes. The fuel cost calculator starts from EPA combined mpg or kWh per 100 miles and a price you enter. It does not replace fuelCost08."),
    },
  ].map((faq) => ({ q: assertFuelCostCopy(faq.q), a: faq.a }));
}

export function omittedClassNote(omitted) {
  if (!omitted.length) return "";
  const names = omitted.map((item) => `${item.label} (${plural(item.modelCount, "model")})`);
  return assertFuelCostCopy(
    `${listPhrase(names)} ${omitted.length === 1 ? "is" : "are"} under ${FUEL_COST_MIN_MODELS} models in these years and ${omitted.length === 1 ? "does" : "do"} not have a page.`,
  );
}

export function blankClassNote(count) {
  if (!count) return "";
  if (count === 1) return assertFuelCostCopy("1 configuration with a blank VClass in these years is not placed in a class.");
  return assertFuelCostCopy(`${formatNumber(count)} configurations with a blank VClass in these years are not placed in a class.`);
}

function collectRecords() {
  const records = [];
  const years = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const [yearKey, yearRow] of Object.entries(doc.years || {})) {
        const year = Number(yearKey);
        if (!Number.isInteger(year)) continue;
        let saw = false;
        for (const config of yearRow.configs || []) {
          saw = true;
          records.push(normalizeConfig(doc, year, config));
        }
        if (saw) years.push(year);
      }
    }
  }
  return { records, years: fuelCostWindow(years) };
}

function buildCatalog() {
  const { records, years } = collectRecords();
  const windowSet = new Set(years);
  const inWindow = records.filter((record) => windowSet.has(record.year));
  const byFamily = new Map();
  let blankClass = 0;
  for (const record of inWindow) {
    if (!record.family) {
      blankClass += 1;
      continue;
    }
    const list = byFamily.get(record.family);
    if (list) list.push(record);
    else byFamily.set(record.family, [record]);
  }
  const pages = [];
  const omitted = [];
  const slugs = new Set();
  for (const [family, familyRecords] of byFamily) {
    const page = buildClassPage(family, familyRecords);
    if (!page) continue;
    if (page.modelCount < FUEL_COST_MIN_MODELS) {
      omitted.push({ family, label: page.label, modelCount: page.modelCount, configCount: page.configCount });
      continue;
    }
    if (slugs.has(page.slug)) throw new Error(`Duplicate fuel cost slug ${page.slug}`);
    slugs.add(page.slug);
    pages.push(page);
  }
  pages.sort((a, b) => a.label.localeCompare(b.label, "en") || a.slug.localeCompare(b.slug));
  omitted.sort((a, b) => a.label.localeCompare(b.label, "en") || a.family.localeCompare(b.family, "en"));
  const makes = new Set(loadSummary().makes.map((make) => make.slug));
  if (makes.has("fuel-cost")) throw new Error("Make slug fuel-cost collides with /fuel-cost/");
  return { years, pages, omitted, blankClass };
}

function catalog() {
  if (!cache) cache = buildCatalog();
  return cache;
}

export function loadFuelCostCatalog() {
  return catalog();
}

export function loadFuelCostPages() {
  return catalog().pages;
}

export function loadFuelCostYears() {
  return catalog().years;
}

export function findFuelCostPage(slug) {
  return loadFuelCostPages().find((page) => page.slug === slug) || null;
}

export function fuelCostPaths() {
  return loadFuelCostPages().map((page) => ({
    params: { slug: page.slug },
    props: { slug: page.slug },
  }));
}

export function modelFuelCostLinks(makeSlug, modelSlug) {
  const key = `${makeSlug}/${modelSlug}`;
  const links = [];
  for (const page of loadFuelCostPages()) {
    if (!page.modelKeys.includes(key)) continue;
    links.push({ label: page.label, path: page.path, slug: page.slug });
  }
  return links;
}

export function fuelCostRowCount(pages = loadFuelCostPages()) {
  return pages.reduce((sum, page) => sum + page.combustion.length + page.plug.length, 0);
}

export function displayedRowKey(row) {
  return rowKey(row);
}
