import { loadModel, loadSummary } from "./catalog.js";
import { classFamily } from "./compare-pairs.js";
import { yearList } from "./ev-range.js";
import {
  EPA_VEHICLES_URL,
  articleFor,
  classMeta,
  labelLower,
  loadFuelCostPages,
  sectionFor,
  temporalCoverage,
  trimKey,
  yearPhrase,
} from "./fuel-classes.js";
import { formatDate, plural } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";

/**
 * Greenhouse gas scores (ghgScore) for model years 2025–2027.
 *
 * The committed configuration records store ghgScore as `ghg` and feScore as
 * `fe`. FuelEconomy.gov's data description puts the smog rating on the
 * separate emissions file as `score`, not as a vehicle-file field named
 * smogRating. These records do not include that field, so the pages do not
 * list smog scores.
 *
 * A score is an integer from 1 to 10. −1, 0, blanks, and any other value are
 * not available and are never shown as a score. The build already stores a
 * negative ghgScore as null; the check still treats a raw −1 the same way.
 *
 * Classes are the EPA size classes that already have a /fuel-cost/ page. A
 * trailing 2WD or 4WD label is removed with the same classFamily rule.
 * Electric, plug-in hybrid, and hydrogen rows are a separate table.
 *
 * A class page lists every configuration with a greenhouse gas score of 10.
 * When fewer than SCORE_TEN_TINY configurations score 10, it also lists
 * configurations that score 9. A class whose configuration tables do not fit
 * the site's HTML limit links to one page per model year.
 */

export const SCORE_INDEX = "/smog-and-ghg-scores/";
export const SCORE_YEARS = [2025, 2026, 2027];
export const SCORE_TEN_TINY = 15;
export const NOT_AVAILABLE = "not available";
export const SCORE_HTML_LIMIT = 60 * 1024;
export const SCORE_CHROME_BYTES = 28000;
export const SCORE_BANNED = /\b(avoid|best|worst|reliable|unreliable)\b/i;

export const EPA_GHG_URL = "https://www.epa.gov/greenvehicles/greenhouse-gas-rating";
export const EPA_SMOG_URL = "https://www.epa.gov/greenvehicles/smog-rating";
export const EPA_LABEL_URL = "https://www.epa.gov/fueleconomy/interactive-version-gasoline-vehicle-label";
export const FE_DATA_URL = "https://www.fueleconomy.gov/feg/ws/";
export const SOURCE_RETRIEVED = "2026-11-14";

export const SCORE_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let cache;

export function assertScoreCopy(text) {
  const value = String(text || "");
  if (SCORE_BANNED.test(value)) throw new Error(`Score copy uses a banned word: ${value}`);
  return value;
}

function assertAnswer(text) {
  const value = assertScoreCopy(text);
  if (sentenceCount(value) > 3) throw new Error(`Score answer has ${sentenceCount(value)} sentences: ${value}`);
  return value;
}

export function listedScore(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(number) || number < 1 || number > 10) return null;
  return number;
}

export function scoreLabel(value) {
  const score = listedScore(value);
  return score == null ? NOT_AVAILABLE : String(score);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function configLabel(record) {
  const trim = trimKey(record);
  if (record.drive && !trim.includes(record.drive)) return `${trim}, ${record.drive}`;
  return trim;
}

export function scoreRowHtml(row) {
  const fuel = row.fuel || "not listed";
  return `<tr><td><a href="${escapeHtml(row.href)}">${escapeHtml(row.vehicle)}</a></td><td>${escapeHtml(row.trim)}</td><td>${escapeHtml(fuel)}</td><td class="num">${escapeHtml(row.scoreLabel)}</td></tr>`;
}

export function rowBytes(rows) {
  let total = 0;
  for (const row of rows) total += scoreRowHtml(row).length;
  return total;
}

export function pageFits(bytes) {
  return bytes + SCORE_CHROME_BYTES <= SCORE_HTML_LIMIT;
}

function emptyCounts() {
  const scores = {};
  for (const score of SCORE_KEYS) scores[score] = 0;
  return { scores, notAvailable: 0, total: 0 };
}

function addCount(bucket, score) {
  bucket.total += 1;
  if (score == null) bucket.notAvailable += 1;
  else bucket.scores[score] += 1;
}

function plugHeading(rows) {
  const parts = [];
  if (rows.some((row) => row.kind === "ev")) parts.push("Electric");
  if (rows.some((row) => row.kind === "phev")) parts.push("plug-in hybrid");
  if (rows.some((row) => row.kind === "hydrogen")) parts.push("hydrogen");
  if (!parts.length) return "Electric and plug-in hybrid";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function combustionHeading() {
  return "Gasoline and other fuels";
}

function subjectFor(rows, section) {
  if (section === "combustion") {
    return "Gasoline, diesel, and other configurations that are not electric, plug-in hybrid, or hydrogen.";
  }
  return `${plugHeading(rows)} configurations.`;
}

function tableCaption(rows, score, years, epaDate, section) {
  const dated = formatDate(epaDate);
  return assertScoreCopy(
    `Greenhouse gas score ${score}. ${subjectFor(rows, section)} Sorted by model year, make, and model for ${yearPhrase(years)}. EPA file dated ${dated}. ${plural(rows.length, "row")}.`,
  );
}

export function scoreSections(listed, years, epaDate) {
  const sections = [];
  for (const id of ["plug", "combustion"]) {
    const rows = listed.filter((row) => row.section === id);
    if (!rows.length) continue;
    const scores = [...new Set(rows.map((row) => row.score))].sort((a, b) => b - a);
    sections.push({
      id,
      heading: assertScoreCopy(id === "plug" ? plugHeading(rows) : combustionHeading()),
      tables: scores.map((score) => {
        const tableRows = rows.filter((row) => row.score === score);
        return {
          score,
          caption: tableCaption(tableRows, score, years, epaDate, id),
          rows: tableRows,
        };
      }),
    });
  }
  return sections;
}

function separationSentence(listed) {
  const plug = listed.filter((row) => row.section === "plug");
  const combustion = listed.filter((row) => row.section === "combustion");
  const plugClause = plug.length
    ? `${plugHeading(plug)} configurations are in their own table`
    : "No electric, plug-in hybrid, or hydrogen configuration is in this score list";
  const combustionClause = combustion.length
    ? `${plural(combustion.length, "gasoline or other configuration")} ${combustion.length === 1 ? "is" : "are"} in a separate table`
    : "no gasoline or other configuration is in this score list";
  return `${plugClause}, and ${combustionClause}.`;
}

function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function nineSentence(listNines, score10, score9, where) {
  if (!listNines) {
    return `Scores of 9 are not listed, because this class has ${plural(score10, "configuration")} with a score of 10.`;
  }
  if (!score9) {
    const verb = where === "this page" ? "has" : "have";
    return `Fewer than ${SCORE_TEN_TINY} configurations in this class score 10, and ${where} ${verb} no configuration with a score of 9.`;
  }
  const verb = where === "this page" ? "lists" : "list";
  return `Fewer than ${SCORE_TEN_TINY} configurations in this class score 10, so ${where} also ${verb} ${plural(score9, "configuration")} with a score of 9.`;
}

export function scoreIndexAnswer(catalog, epaDate) {
  const dated = formatDate(epaDate);
  const first = `In the EPA fuel economy file dated ${dated}, ghgScore is the greenhouse gas score on a scale from 1 to 10, and a value of −1 is not available.`;
  const second = `Model years ${yearList(SCORE_YEARS)} have ${plural(catalog.scored, "configuration")} with a score and ${plural(catalog.notAvailable, "configuration")} marked not available.`;
  const third = "The smog rating is a separate 1 to 10 EPA scale, and these committed configuration records do not include it.";
  return assertAnswer(`${first} ${second} ${third}`);
}

export function scoreClassAnswer(page, epaDate) {
  const dated = formatDate(epaDate);
  const first = `In the EPA fuel economy file dated ${dated}, ${plural(page.score10, `${page.labelLower} configuration`)} in ${yearPhrase(page.years)} have a greenhouse gas score of 10.`;
  const plug = page.listed.filter((row) => row.section === "plug");
  const second = page.split
    ? `The configuration list is on a page for each model year, and ${lowerFirst(plugHeading(plug))} configurations are in their own table.`
    : separationSentence(page.listed);
  const third = nineSentence(page.listNines, page.score10, page.score9, page.split ? "the model year pages" : "this page");
  return assertAnswer(`${first} ${second} ${third}`);
}

export function scoreYearAnswer(page, yearRow, epaDate) {
  const dated = formatDate(epaDate);
  const first = `In the EPA fuel economy file dated ${dated}, ${plural(yearRow.score10, `${page.labelLower} configuration`)} in model year ${yearRow.year} have a greenhouse gas score of 10.`;
  const second = separationSentence(yearRow.listed);
  const third = nineSentence(page.listNines, page.score10, yearRow.score9, "this page");
  return assertAnswer(`${first} ${second} ${third}`);
}

export function distributionCaption(epaDate) {
  const dated = formatDate(epaDate);
  return assertScoreCopy(
    `ghgScore for ${yearPhrase(SCORE_YEARS)}. Not available is a blank, a value outside 1 to 10, or −1, and it is not shown as a score. EPA file dated ${dated}.`,
  );
}

export function classIndexCaption(epaDate) {
  const dated = formatDate(epaDate);
  return assertScoreCopy(
    `EPA size classes that have a fuel-cost page. A class page lists configurations with a greenhouse gas score of 10, and also a score of 9 when fewer than ${SCORE_TEN_TINY} configurations score 10. Electric and plug-in hybrid rows are in their own table. Sorted by class name. EPA file dated ${dated}.`,
  );
}

export function yearCountCaption(page, epaDate) {
  const dated = formatDate(epaDate);
  return assertScoreCopy(
    `Greenhouse gas scores for ${page.labelLower} configurations by model year. Each model year links to its configuration list. EPA file dated ${dated}.`,
  );
}

export function sectionGapNote(listed, section, listNines) {
  if (listed.some((row) => row.section === section)) return "";
  const who = section === "plug"
    ? "No electric, plug-in hybrid, or hydrogen configuration"
    : "No gasoline, diesel, or other configuration";
  const scores = listNines ? "10 or 9" : "10";
  return assertScoreCopy(`${who} in this list has a greenhouse gas score of ${scores}.`);
}

export function emptyScoreNote(listed, listNines) {
  if (listed.length) return "";
  const scores = listNines ? "10 or 9" : "10";
  return assertScoreCopy(`No configuration in this list has a greenhouse gas score of ${scores}.`);
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function outsideClassNote(outside) {
  if (!outside.length) return "";
  const names = outside.map((item) => `${item.label} (${plural(item.configs, "configuration")})`);
  const tens = outside.reduce((sum, item) => sum + item.score10, 0);
  const scoreClause = tens
    ? `${plural(tens, "configuration")} in ${outside.length === 1 ? "that class" : "those classes"} ${tens === 1 ? "has" : "have"} a greenhouse gas score of 10 and ${tens === 1 ? "is" : "are"} not listed here.`
    : `None of those configurations have a greenhouse gas score of 10.`;
  return assertScoreCopy(
    `${listPhrase(names)} ${outside.length === 1 ? "does" : "do"} not have a fuel-cost page, so ${outside.length === 1 ? "it does" : "they do"} not have a greenhouse gas score page. ${scoreClause}`,
  );
}

export function ghgMeaningText() {
  const retrieved = formatDate(SOURCE_RETRIEVED);
  return assertScoreCopy(
    `EPA's greenhouse gas rating page says the rating reflects vehicle tailpipe emissions of carbon dioxide, and that carbon dioxide typically constitutes 99% of tailpipe greenhouse gas emissions. EPA says vehicles that score a 10 are the cleanest. The rating does not include emissions from producing the fuel. Retrieved ${retrieved}. That page publishes the numeric scale by model year. The copy retrieved ${retrieved} includes model year 2025 and earlier years, and it does not show a scale labeled 2026 or 2027.`,
  );
}

export function smogMeaningText() {
  const retrieved = formatDate(SOURCE_RETRIEVED);
  return assertScoreCopy(
    `EPA's smog rating page says the rating reflects tailpipe emissions that contribute to local and regional air pollution, and that vehicles that score a 10 are the cleanest. For model year 2018 and later, EPA says the chart was recalibrated for Tier 3 emission standards, and that a model year 2018 or later rating of 3 is about the same as a model year 2017 rating of 6. Retrieved ${retrieved}.`,
  );
}

export function labelMeaningText() {
  const retrieved = formatDate(SOURCE_RETRIEVED);
  return assertScoreCopy(
    `The gasoline vehicle label describes the Fuel Economy and Greenhouse Gas Rating as a 1 to 10 rating based on fuel economy and greenhouse gas emissions, and the smog rating as a 1 to 10 rating based on exhaust emissions that contribute to air pollution. Retrieved ${retrieved}.`,
  );
}

export function fieldMeaningText() {
  const retrieved = formatDate(SOURCE_RETRIEVED);
  return assertScoreCopy(
    `FuelEconomy.gov's vehicle data description calls ghgScore the EPA GHG score and feScore the EPA Fuel Economy Score, and it says −1 means not available for both. The emissions data description calls score the EPA smog rating for fuel type 1, on a scale from 1 to 10. It does not name a vehicle-file field smogRating. These configuration records store ghgScore and feScore and do not store score or smogRating, so the tables list ghgScore only. Retrieved ${retrieved}.`,
  );
}

export function vehiclesFileText(epaDate) {
  const dated = formatDate(epaDate);
  return assertScoreCopy(
    `Counts and configuration lists use ghgScore from the committed EPA fuel economy file dated ${dated}. Definitions were retrieved ${formatDate(SOURCE_RETRIEVED)}.`,
  );
}

export function scoreIndexFaqs() {
  return [
    {
      q: "What does a greenhouse gas score of 10 mean?",
      a: "EPA's greenhouse gas rating page says vehicles that score a 10 are the cleanest. The rating reflects tailpipe carbon dioxide and does not include emissions from producing the fuel.",
    },
    {
      q: "What does a smog rating of 10 mean?",
      a: "EPA's smog rating page says vehicles that score a 10 are the cleanest. The rating reflects tailpipe emissions that contribute to local and regional air pollution. These configuration records do not include the smog rating, so this site does not list smog scores.",
    },
    {
      q: "Why is a greenhouse gas score shown as not available?",
      a: "FuelEconomy.gov's data description says a ghgScore of −1 means not available. A blank or a value outside 1 to 10 is treated the same way and is not shown as a score.",
    },
    {
      q: "Why are electric vehicles in a separate table?",
      a: "Electric, plug-in hybrid, and hydrogen configurations are listed apart from gasoline and diesel, the same separation as the fuel-cost class pages. Annual fuel cost for a class stays on that class's fuel-cost page.",
    },
  ].map((faq) => ({ q: assertScoreCopy(faq.q), a: assertScoreCopy(faq.a) }));
}

export function scoreClassFaqs(page) {
  const nine = page.listNines
    ? page.score9
      ? `Scores of 10, and ${plural(page.score9, "configuration")} with a score of 9, because fewer than ${SCORE_TEN_TINY} configurations score 10.`
      : `A greenhouse gas score of 10. Fewer than ${SCORE_TEN_TINY} configurations score 10, and none score 9.`
    : `A greenhouse gas score of 10. A score of 9 is not listed because ${plural(page.score10, "configuration")} score 10.`;
  return [
    {
      q: `Which greenhouse gas scores are listed for ${articleFor(page.label)}?`,
      a: assertScoreCopy(`${nine} A value of −1 is not available and is not listed as a score.`),
    },
    {
      q: "Does this page list the smog rating?",
      a: assertScoreCopy("No. The committed configuration records do not include the smog rating. EPA's smog rating page describes that rating separately."),
    },
    {
      q: `Where is annual fuel cost for ${articleFor(page.label)}?`,
      a: assertScoreCopy("Annual fuel cost for this class is on the fuel-cost page. These tables do not repeat fuelCost08."),
    },
  ];
}

export function fuelCostLink(page) {
  return {
    href: page.fuelPath,
    label: `${page.label} annual fuel cost`,
    after: assertScoreCopy(" lists fuelCost08 for this class."),
  };
}

function rowSort(left, right) {
  return (
    right.score - left.score ||
    left.year - right.year ||
    left.make.localeCompare(right.make, "en") ||
    left.model.localeCompare(right.model, "en") ||
    left.trim.localeCompare(right.trim, "en") ||
    left.fuel.localeCompare(right.fuel, "en") ||
    left.href.localeCompare(right.href)
  );
}

function presentRow(record) {
  return {
    ...record,
    trim: configLabel(record),
    vehicle: `${record.year} ${record.make} ${record.model}`,
    scoreLabel: scoreLabel(record.score),
  };
}

function countsOf(records) {
  let score10 = 0;
  let score9 = 0;
  let notAvailable = 0;
  for (const record of records) {
    if (record.score === 10) score10 += 1;
    else if (record.score === 9) score9 += 1;
    else if (record.score == null) notAvailable += 1;
  }
  return { score10, score9, notAvailable, configs: records.length };
}

function yearSlice(page, year, records) {
  const counts = countsOf(records);
  const listed = records
    .filter((record) => record.score === 10 || (page.listNines && record.score === 9))
    .map(presentRow)
    .sort(rowSort);
  return {
    year,
    ...counts,
    listed,
    path: page.split ? `${page.path}${year}/` : "",
    bytes: rowBytes(listed),
  };
}

function buildClass(fuel, records) {
  const counts = countsOf(records);
  const listNines = counts.score10 < SCORE_TEN_TINY;
  const listed = records
    .filter((record) => record.score === 10 || (listNines && record.score === 9))
    .map(presentRow)
    .sort(rowSort);
  const bytes = rowBytes(listed);
  const page = {
    family: fuel.family,
    slug: fuel.slug,
    label: fuel.label,
    labelLower: labelLower(fuel.label),
    path: `${SCORE_INDEX}${fuel.slug}/`,
    fuelPath: fuel.path,
    years: SCORE_YEARS,
    ...counts,
    listNines,
    listed,
    bytes,
    split: !pageFits(bytes),
  };
  page.byYear = SCORE_YEARS.map((year) => yearSlice(page, year, records.filter((record) => record.year === year)));
  if (!page.split) {
    for (const yearRow of page.byYear) yearRow.path = "";
  }
  for (const yearRow of page.byYear) {
    if (!yearRow.path) continue;
    if (!pageFits(yearRow.bytes)) {
      throw new Error(`Greenhouse gas scores ${page.slug} ${yearRow.year} is ${yearRow.bytes} row bytes plus chrome, over ${SCORE_HTML_LIMIT}`);
    }
  }
  return page;
}

function collect() {
  const fuelPages = loadFuelCostPages();
  const fuelByFamily = new Map(fuelPages.map((page) => [page.family, page]));
  const byFamily = new Map();
  const outsideMap = new Map();
  let blankClass = 0;
  const distribution = SCORE_YEARS.map((year) => ({ year, ...emptyCounts() }));
  const byYear = new Map(distribution.map((row) => [row.year, row]));
  const totals = emptyCounts();

  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const year of SCORE_YEARS) {
        const yearRow = doc.years?.[String(year)];
        if (!yearRow) continue;
        for (const config of yearRow.configs || []) {
          const score = listedScore(config.ghg);
          const family = classFamily(config.vclass);
          const record = {
            year,
            make: doc.make,
            makeSlug: doc.makeSlug,
            model: doc.model,
            modelSlug: doc.modelSlug,
            configName: String(config.model || "").replace(/\s+/g, " ").trim(),
            vclass: String(config.vclass || "").replace(/\s+/g, " ").trim(),
            family,
            drive: String(config.drive || "").replace(/\s+/g, " ").trim(),
            fuel: String(config.fuel || "").replace(/\s+/g, " ").trim(),
            atv: String(config.atv || "").replace(/\s+/g, " ").trim(),
            trany: String(config.trany || "").replace(/\s+/g, " ").trim(),
            displ: config.displ,
            cylinders: config.cylinders,
            score,
            kind: sectionKind(config),
            section: sectionFor(config),
            href: `/${doc.makeSlug}/${doc.modelSlug}/${year}/`,
          };
          addCount(byYear.get(year), score);
          addCount(totals, score);
          if (!family) {
            blankClass += 1;
            continue;
          }
          if (!fuelByFamily.has(family)) {
            const bucket = outsideMap.get(family) || { family, configs: 0, score10: 0 };
            bucket.configs += 1;
            if (score === 10) bucket.score10 += 1;
            outsideMap.set(family, bucket);
            continue;
          }
          const list = byFamily.get(family);
          if (list) list.push(record);
          else byFamily.set(family, [record]);
        }
      }
    }
  }

  if (loadSummary().makes.some((make) => make.slug === "smog-and-ghg-scores")) {
    throw new Error("Make slug smog-and-ghg-scores collides with /smog-and-ghg-scores/");
  }
  const slugs = new Set();
  const pages = [];
  for (const fuel of fuelPages) {
    if (!fuel.slug || fuel.slug === "index" || slugs.has(fuel.slug)) {
      throw new Error(`Greenhouse gas score slug is not usable: ${fuel.slug}`);
    }
    slugs.add(fuel.slug);
    pages.push(buildClass(fuel, byFamily.get(fuel.family) || []));
  }
  pages.sort((a, b) => a.label.localeCompare(b.label, "en") || a.slug.localeCompare(b.slug));
  const outside = [...outsideMap.values()]
    .map((item) => ({ ...item, label: classMeta(item.family).label }))
    .sort((a, b) => a.label.localeCompare(b.label, "en") || a.family.localeCompare(b.family, "en"));
  const scored = totals.total - totals.notAvailable;
  return {
    years: SCORE_YEARS,
    distribution,
    totals,
    scored,
    notAvailable: totals.notAvailable,
    pages,
    outside,
    blankClass,
  };
}

function sectionKind(config) {
  if (config?.atv === "Plug-in Hybrid") return "phev";
  if (config?.atv === "FCV" || config?.atv === "eFCV" || config?.fuel === "Hydrogen") return "hydrogen";
  if (config?.atv === "EV" || config?.fuel === "Electricity") return "ev";
  return "other";
}

function catalog() {
  if (!cache) cache = collect();
  return cache;
}

export function loadScoreCatalog() {
  return catalog();
}

export function loadScorePages() {
  return catalog().pages;
}

export function findScorePage(slug) {
  return loadScorePages().find((page) => page.slug === slug) || null;
}

export function scoreClassPaths() {
  return loadScorePages().map((page) => ({
    params: { slug: page.slug },
    props: { slug: page.slug },
  }));
}

export function scoreYearPaths() {
  const paths = [];
  for (const page of loadScorePages()) {
    if (!page.split) continue;
    for (const yearRow of page.byYear) {
      if (!yearRow.path) continue;
      paths.push({
        params: { slug: page.slug, year: String(yearRow.year) },
        props: { slug: page.slug, year: yearRow.year },
      });
    }
  }
  return paths;
}

export function scorePaths() {
  const paths = [SCORE_INDEX];
  for (const page of loadScorePages()) {
    paths.push(page.path);
    if (!page.split) continue;
    for (const yearRow of page.byYear) {
      if (yearRow.path) paths.push(yearRow.path);
    }
  }
  return paths;
}

export function scoreListedCount(pages = loadScorePages()) {
  return pages.reduce((sum, page) => sum + page.listed.length, 0);
}

export { EPA_VEHICLES_URL, temporalCoverage, yearPhrase };
