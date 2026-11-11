import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findModel, loadModel, loadSummary } from "../src/lib/catalog.js";
import { classFamily } from "../src/lib/compare-pairs.js";
import { answerConfig } from "../src/lib/ev-range.js";
import {
  FUEL_COST_BANNED,
  FUEL_COST_CALCULATOR,
  FUEL_COST_INDEX,
  FUEL_COST_MIN_MODELS,
  FUEL_COST_YEAR_COUNT,
  blankClassNote,
  buildClassPage,
  fuelCostAnswer,
  fuelCostCaveatText,
  fuelCostFaqs,
  fuelCostIndexAnswer,
  fuelCostIndexFaqs,
  fuelCostSourceParts,
  loadFuelCostCatalog,
  modelFuelCostLinks,
  normalizeConfig,
  omittedClassNote,
  orderedSections,
  positiveNumber,
} from "../src/lib/fuel-classes.js";
import { formatDate, formatNumber, money } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";

const SAMPLES = ["small-suv", "midsize-car", "standard-pickup", "minivan"];

function positive(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function kindOf(config) {
  if (config.atv === "Plug-in Hybrid") return "phev";
  if (config.atv === "FCV" || config.atv === "eFCV" || config.fuel === "Hydrogen") return "hydrogen";
  if (config.atv === "EV" || config.fuel === "Electricity") return "ev";
  return "other";
}

function trimOf(row) {
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

function tableSort(left, right) {
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

function rowKey(row) {
  return [row.year, row.makeSlug, row.modelSlug, row.section, row.cost, row.trim, row.fuel, row.drive, row.comb].join("|");
}

function walk(years) {
  const window = new Set(years);
  const records = [];
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const [yearKey, yearRow] of Object.entries(doc.years || {})) {
        const year = Number(yearKey);
        if (!window.has(year)) continue;
        for (const config of yearRow.configs || []) {
          const kind = kindOf(config);
          records.push({
            year,
            make: doc.make,
            makeSlug: doc.makeSlug,
            model: doc.model,
            modelSlug: doc.modelSlug,
            configName: clean(config.model),
            vclass: clean(config.vclass),
            family: classFamily(config.vclass),
            drive: clean(config.drive),
            fuel: clean(config.fuel),
            trany: clean(config.trany),
            displ: positive(config.displ),
            cylinders: positive(config.cylinders),
            comb: positive(config.comb),
            cost: positive(config.cost),
            kind,
            section: kind === "other" ? "combustion" : "plug",
            href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
          });
        }
      }
    }
  }
  return records;
}

function newestYears() {
  const years = new Set();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const yearKey of Object.keys(doc.years || {})) {
        const year = Number(yearKey);
        if (Number.isInteger(year) && (doc.years[yearKey].configs || []).length) years.add(year);
      }
    }
  }
  return [...years].sort((a, b) => b - a).slice(0, FUEL_COST_YEAR_COUNT).sort((a, b) => a - b);
}

function recompute(family, years) {
  const records = walk(years).filter((record) => record.family === family);
  const listed = records.filter((record) => record.cost > 0);
  const sections = {};
  for (const section of ["combustion", "plug"]) {
    const groups = new Map();
    for (const record of listed.filter((item) => item.section === section)) {
      const row = { ...record, trim: trimOf(record) };
      const key = `${row.makeSlug}|${row.modelSlug}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    const rows = [];
    for (const list of groups.values()) {
      const low = [...list].sort(extremeSort("low"))[0];
      const high = [...list].sort(extremeSort("high"))[0];
      rows.push(low);
      if (high.cost !== low.cost) rows.push(high);
    }
    rows.sort(tableSort);
    sections[section] = rows;
  }
  const costs = listed.map((record) => record.cost);
  return {
    records,
    listed,
    sections,
    min: costs.length ? Math.min(...costs) : null,
    max: costs.length ? Math.max(...costs) : null,
    models: new Set(listed.map((record) => `${record.makeSlug}/${record.modelSlug}`)).size,
    omitted: records.length - listed.length,
  };
}

function doc(make, model, year, config) {
  return normalizeConfig(
    { make, makeSlug: make.toLowerCase(), model, modelSlug: model.toLowerCase().replace(/\s+/g, "-") },
    year,
    config,
  );
}

test("a missing fuelCost08 is omitted and is not $0", () => {
  for (const value of [0, "0", null, "", -1, Number.NaN]) assert.equal(positiveNumber(value), null);
  const records = [
    doc("Honda", "Odyssey", 2026, { model: "Odyssey", vclass: "Minivan - 2WD", fuel: "Regular Gasoline", atv: "", comb: 22, cost: 0, trany: "Automatic" }),
    doc("Honda", "Odyssey", 2026, { model: "Odyssey", vclass: "Minivan - 2WD", fuel: "Regular Gasoline", atv: "", comb: 22, cost: null, trany: "Automatic" }),
    doc("Toyota", "Sienna", 2026, { model: "Sienna", vclass: "Minivan - 2WD", fuel: "Regular Gasoline", atv: "Hybrid", comb: 36, cost: 2100, trany: "Automatic" }),
    doc("Kia", "Carnival", 2026, { model: "Carnival", vclass: "Minivan - 4WD", fuel: "Regular Gasoline", atv: "", comb: 22, cost: 2800, trany: "Automatic" }),
  ];
  const page = buildClassPage("Minivan", records);
  assert.equal(page.omittedCost, 2);
  assert.equal(page.configCount, 2);
  const rows = [...page.combustion, ...page.plug];
  assert.equal(rows.some((row) => row.costLabel === "$0" || !(row.cost > 0)), false);
  assert.equal(rows.some((row) => row.make === "Honda"), false);
});

test("2WD and 4WD share a class and electric rows stay in their own section", () => {
  assert.equal(classFamily("Small Sport Utility Vehicle 4WD"), "Small Sport Utility Vehicle");
  assert.equal(classFamily("Small Sport Utility Vehicle - 2WD"), "Small Sport Utility Vehicle");
  const records = [
    doc("Chevrolet", "Equinox", 2026, { model: "Equinox FWD", vclass: "Small Sport Utility Vehicle 2WD", fuel: "Regular Gasoline", atv: "", comb: 27, cost: 2300, displ: 1.5, cylinders: 4, trany: "Automatic 6-spd", drive: "Front-Wheel Drive" }),
    doc("Chevrolet", "Equinox", 2026, { model: "Equinox AWD", vclass: "Small Sport Utility Vehicle 4WD", fuel: "Regular Gasoline", atv: "", comb: 26, cost: 2400, displ: 1.5, cylinders: 4, trany: "Automatic 6-spd", drive: "All-Wheel Drive" }),
    doc("Chevrolet", "Equinox", 2026, { model: "Equinox EV FWD", vclass: "Small Sport Utility Vehicle 2WD", fuel: "Electricity", atv: "EV", comb: 108, cost: 700, trany: "Automatic (A1)", drive: "Front-Wheel Drive" }),
    doc("Jeep", "Wrangler", 2026, { model: "Wrangler 4WD", vclass: "Small Sport Utility Vehicle 4WD", fuel: "Premium Gasoline", atv: "", comb: 19, cost: 4100, displ: 3.6, cylinders: 6, trany: "Automatic 8-spd", drive: "4-Wheel Drive" }),
    doc("Toyota", "RAV4", 2026, { model: "RAV4 Prime", vclass: "Small Sport Utility Vehicle 4WD", fuel: "Regular Gasoline", atv: "Plug-in Hybrid", comb: 38, cost: 1750, trany: "Automatic", drive: "All-Wheel Drive" }),
    doc("Volkswagen", "ID. Buzz", 2026, { model: "ID. Buzz Pro", vclass: "Small Sport Utility Vehicle 2WD", fuel: "Electricity", atv: "EV", comb: 80, cost: 900, trany: "Automatic (A1)", drive: "Rear-Wheel Drive" }),
    doc("Hyundai", "Tucson", 2026, { model: "Tucson", vclass: "Small Sport Utility Vehicle 2WD", fuel: "Regular Gasoline", atv: "", comb: 28, cost: 2200, trany: "Automatic", drive: "Front-Wheel Drive" }),
    doc("Honda", "CR-V", 2026, { model: "CR-V AWD", vclass: "Small Sport Utility Vehicle 4WD", fuel: "Regular Gasoline", atv: "", comb: 29, cost: 2100, trany: "Automatic", drive: "All-Wheel Drive" }),
  ];
  const page = buildClassPage("Small Sport Utility Vehicle", records);
  assert.equal(page.slug, "small-suv");
  assert.deepEqual(page.vclasses, ["Small Sport Utility Vehicle 2WD", "Small Sport Utility Vehicle 4WD"]);
  assert.equal(page.plug.every((row) => row.kind === "ev" || row.kind === "phev"), true);
  assert.equal(page.combustion.every((row) => row.kind === "other"), true);
  assert.equal(page.plug.some((row) => row.model === "ID. Buzz"), true);
  const text = fuelCostAnswer(page, "2026-09-29");
  assert.equal(sentenceCount(text) <= 3, true, text);
  assert.match(text, /\$700/);
  assert.match(text, /\$4,100/);
  assert.match(text, /15,000 miles and 55 percent city driving/);
  assert.match(text, /does not list the fuel prices/);
  assert.doesNotMatch(text, FUEL_COST_BANNED);
  assert.doesNotMatch(text, /\$0/);
  const faqs = fuelCostFaqs(page);
  assert.equal(faqs.length, 3);
  for (const faq of faqs) {
    assert.doesNotMatch(`${faq.q} ${faq.a}`, FUEL_COST_BANNED);
    assert.equal(faq.q.length > 0 && faq.a.length > 0, true);
  }
});

test("the published window is the newest model years and classes match a recompute", () => {
  assert.equal(FUEL_COST_YEAR_COUNT === 2 || FUEL_COST_YEAR_COUNT === 3, true);
  assert.equal(FUEL_COST_MIN_MODELS >= 2, true);
  const catalog = loadFuelCostCatalog();
  const years = newestYears();
  assert.deepEqual(catalog.years, years);
  assert.equal(years.length, FUEL_COST_YEAR_COUNT);
  const records = walk(years);
  const byFamily = new Map();
  for (const record of records) {
    if (!record.family) continue;
    const list = byFamily.get(record.family) || [];
    list.push(record);
    byFamily.set(record.family, list);
  }
  const expectedSlugs = [];
  for (const [family, familyRecords] of byFamily) {
    const models = new Set(familyRecords.filter((record) => record.cost > 0).map((record) => `${record.makeSlug}/${record.modelSlug}`));
    if (models.size >= FUEL_COST_MIN_MODELS) expectedSlugs.push(family);
  }
  assert.equal(catalog.pages.length, expectedSlugs.length);
  assert.equal(catalog.pages.length + catalog.omitted.length, byFamily.size);
  for (const page of catalog.pages) assert.equal(page.modelCount >= FUEL_COST_MIN_MODELS, true, page.slug);
  for (const item of catalog.omitted) assert.equal(item.modelCount < FUEL_COST_MIN_MODELS, true, item.family);
  assert.doesNotMatch(omittedClassNote(catalog.omitted), FUEL_COST_BANNED);
  assert.doesNotMatch(blankClassNote(catalog.blankClass), FUEL_COST_BANNED);

  const bySlug = new Map(catalog.pages.map((page) => [page.slug, page]));
  for (const slug of SAMPLES) {
    const page = bySlug.get(slug);
    assert.ok(page, slug);
    const expected = recompute(page.family, years);
    assert.equal(page.configCount, expected.listed.length, slug);
    assert.equal(page.omittedCost, expected.omitted, slug);
    assert.equal(page.modelCount, expected.models, slug);
    assert.equal(page.low.cost, expected.min, slug);
    assert.equal(page.high.cost, expected.max, slug);
    assert.deepEqual(page.combustion.map(rowKey), expected.sections.combustion.map(rowKey), `${slug} combustion`);
    assert.deepEqual(page.plug.map(rowKey), expected.sections.plug.map(rowKey), `${slug} plug`);
    for (const row of [...page.combustion, ...page.plug]) {
      assert.equal(row.cost > 0, true, rowKey(row));
      assert.notEqual(row.costLabel, "$0");
      assert.equal(row.costLabel, money(row.cost));
      assert.equal(row.href, `/${row.makeSlug}/${row.modelSlug}/${row.year}/`);
      const found = findModel(row.makeSlug, row.modelSlug);
      assert.equal(found.model.years.some((item) => item.y === row.year), true, row.href);
      if (row.section === "plug") assert.equal(row.kind === "ev" || row.kind === "phev" || row.kind === "hydrogen", true);
      else assert.equal(row.kind, "other");
      if (row.comb == null) assert.equal(row.combLabel, "not listed");
      else assert.equal(row.combLabel.endsWith(row.kind === "ev" || row.kind === "hydrogen" ? "MPGe" : "mpg"), true);
    }
    const text = fuelCostAnswer(page, "2026-09-29");
    assert.equal(sentenceCount(text) <= 3, true, text);
    assert.match(text, new RegExp(money(expected.min).replace("$", "\\$")));
    assert.match(text, new RegExp(money(expected.max).replace("$", "\\$")));
    assert.match(text, new RegExp(`${page.low.year} ${answerConfig(page.low.make)} ${answerConfig(page.low.model)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /15,000 miles and 55 percent city driving/);
    assert.match(text, /does not list the fuel prices/);
    assert.doesNotMatch(text, FUEL_COST_BANNED);
    assert.doesNotMatch(text, /\$0/);
    const sections = orderedSections(page, "2026-09-29");
    const costs = sections.flatMap((section) => section.rows.map((row) => row.cost));
    const sorted = [...costs].sort((a, b) => a - b);
    assert.deepEqual(sections.flatMap((section) => section.rows.map((row) => row.cost)), sections.map((section) => section.rows.map((row) => row.cost)).flat());
    for (const section of sections) {
      const sectionCosts = section.rows.map((row) => row.cost);
      assert.deepEqual(sectionCosts, [...sectionCosts].sort((a, b) => a - b), `${slug} ${section.id}`);
      assert.doesNotMatch(section.caption, FUEL_COST_BANNED);
      assert.match(section.caption, /fuelCost08/);
    }
    assert.equal(costs[0], expected.min);
    assert.equal(costs.at(-1) === undefined || Math.max(...costs) === expected.max, true);
    assert.deepEqual(sorted[0], expected.min);
    const source = fuelCostSourceParts(page, "2026-09-29");
    assert.match(`${source.before}${source.linkLabel}${source.after}`, /2WD or 4WD/);
    assert.doesNotMatch(`${source.before}${source.linkLabel}${source.after}`, FUEL_COST_BANNED);
    if (page.family === "Small Sport Utility Vehicle") {
      assert.equal(page.vclasses.includes("Small Sport Utility Vehicle 2WD"), true);
      assert.equal(page.vclasses.includes("Small Sport Utility Vehicle 4WD"), true);
    }
  }
});

test("index, faqs, and links stay on the EPA figure", () => {
  const catalog = loadFuelCostCatalog();
  const index = fuelCostIndexAnswer(catalog.pages, catalog.years, "2026-09-29");
  assert.equal(sentenceCount(index) <= 3, true, index);
  assert.match(index, new RegExp(`${formatNumber(catalog.pages.length)} size classes`));
  assert.doesNotMatch(index, /classs/);
  assert.match(index, /15,000 miles and 55 percent city driving/);
  assert.doesNotMatch(index, FUEL_COST_BANNED);
  const faqs = fuelCostIndexFaqs(catalog.years);
  assert.equal(faqs.length >= 2, true);
  for (const faq of faqs) assert.doesNotMatch(`${faq.q} ${faq.a}`, FUEL_COST_BANNED);
  assert.equal(fuelCostCaveatText().includes("Your cost will differ"), true);
  assert.equal(fuelCostCaveatText().includes("fuel cost calculator"), true);
  assert.doesNotMatch(fuelCostCaveatText(), FUEL_COST_BANNED);
  for (const page of catalog.pages) {
    assert.equal(page.path, `${FUEL_COST_INDEX}${page.slug}/`);
    assert.equal(page.low.costLabel === "$0", false);
    const links = modelFuelCostLinks(page.low.makeSlug, page.low.modelSlug);
    assert.equal(links.some((link) => link.path === page.path), true, page.slug);
  }
  const slugs = catalog.pages.map((page) => page.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of ["small-suv", "midsize-car", "standard-pickup"]) assert.equal(slugs.includes(slug), true);
  const dated = formatDate("2026-09-29");
  assert.match(index, new RegExp(dated.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("templates render the recomputed answer, table order, and visible FAQ", () => {
  const index = readFileSync("src/pages/fuel-cost/index.astro", "utf8");
  const page = readFileSync("src/pages/fuel-cost/[slug].astro", "utf8");
  const table = readFileSync("src/components/FuelCostTable.astro", "utf8");
  assert.match(index, /fuelCostIndexAnswer/);
  assert.match(index, /fuelCostIndexFaqs/);
  assert.match(index, /faqPage\(faqs\)/);
  assert.match(index, /<h3>\{faq\.q\}<\/h3>/);
  assert.match(index, /page\.low\.costLabel/);
  assert.match(page, /fuelCostAnswer/);
  assert.match(page, /orderedSections/);
  assert.match(page, /fuelCostFaqs/);
  assert.match(page, /faqPage\(faqs\)/);
  assert.match(page, /<h3>\{faq\.q\}<\/h3>/);
  assert.match(page, /fuelCostCaveatParts/);
  assert.match(table, /row\.href/);
  assert.match(table, /row\.costLabel/);
  assert.match(table, /row\.combLabel/);
  assert.doesNotMatch(table, /\.sort\(/);
  assert.match(readFileSync("src/pages/tools/fuel-cost-calculator.astro", "utf8"), /href="\/fuel-cost\/"/);
  assert.match(readFileSync("src/pages/index.astro", "utf8"), /href="\/fuel-cost\/"/);
  assert.match(readFileSync("src/components/Footer.astro", "utf8"), /href="\/fuel-cost\/"/);
  assert.match(readFileSync("src/pages/[make]/[model]/index.astro", "utf8"), /modelFuelCostLinks/);
  assert.match(readFileSync("src/pages/methodology.astro", "utf8"), /href="\/fuel-cost\/"/);
  assert.equal(FUEL_COST_CALCULATOR, "/tools/fuel-cost-calculator/");
});
