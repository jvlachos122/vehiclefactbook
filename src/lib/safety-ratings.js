import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { variantLabel } from "./answer.js";
import { loadModel, loadSummary } from "./catalog.js";
import { classFamily } from "./compare-pairs.js";
import { yearList } from "./ev-range.js";
import { classMeta, EPA_VEHICLES_URL, labelLower, loadFuelCostPages, temporalCoverage, yearPhrase } from "./fuel-classes.js";
import { formatDate, formatNumber, plural } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";

/**
 * NHTSA 5-star ratings by the EPA size classes already published at /fuel-cost/.
 *
 * The year window is the newest SAFETY_YEAR_COUNT model years in data/ncap.
 * A variant is placed only when the model crosswalk (the ncap list already
 * stored on the model year) points at one model year, and that model year's
 * EPA configs share a single class family. A trailing 2WD or 4WD label is
 * removed with the same classFamily rule as fuel cost. Two classes are not
 * guessed. A class without a fuel-cost page is not given a safety page.
 *
 * Overall "Not Rated" stays the words Not rated. It is never shown as zero.
 * Stars are per variant (body and drive). NHTSA compares similar size and
 * weight only. Pre-2011 stars use a different method and are not listed.
 *
 * A class page holds every variant table when that HTML fits the site limit.
 * A larger class keeps a 5-star list and links to one page per model year.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const SAFETY_INDEX = "/safety-ratings/";
export const SAFETY_YEAR_COUNT = 3;
export const SAFETY_HTML_LIMIT = 60 * 1024;
export const SAFETY_CHROME_BYTES = 18000;
export const NHTSA_RATINGS_URL = "https://api.nhtsa.gov/SafetyRatings";
export const SAFETY_BANNED = /\b(safest|best|worst|avoid|reliable|unreliable)\b/i;

const CAVEAT =
  "Each rating is for one variant, body and drive, and NHTSA compares vehicles of similar size and weight only, and a pre-2011 rating is a different method and is not listed here.";

let cache;

export function assertSafetyCopy(text) {
  const value = String(text || "");
  if (SAFETY_BANNED.test(value)) throw new Error(`Safety rating copy uses a banned word: ${value}`);
  return value;
}

function assertAnswer(text) {
  const value = assertSafetyCopy(text);
  if (sentenceCount(value) > 3) throw new Error(`Safety rating answer has ${sentenceCount(value)} sentences: ${value}`);
  return value;
}

export function pluralLabel(label) {
  const lower = labelLower(label);
  if (/s$/i.test(lower)) return lower;
  return `${lower}s`;
}

export function starLabel(value) {
  const text = String(value ?? "").trim();
  if (/^[1-5]$/.test(text)) return text;
  return "Not rated";
}

export function isRatedStar(value) {
  return /^[1-5]$/.test(String(value ?? "").trim());
}

export function isFiveStar(value) {
  return String(value ?? "").trim() === "5";
}

export function possibilityLabel(value) {
  if (value == null || value === "") return "not listed";
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return "not listed";
  return String(number);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function fullRowHtml(row) {
  return `<tr><td><a href="${escapeHtml(row.href)}">${escapeHtml(row.vehicle)}</a></td><td>${escapeHtml(row.variant)}</td><td class="num">${escapeHtml(row.overallLabel)}</td><td class="num">${escapeHtml(row.frontLabel)}</td><td class="num">${escapeHtml(row.sideLabel)}</td><td class="num">${escapeHtml(row.rolloverLabel)}</td><td class="num">${escapeHtml(row.possibilityLabel)}</td></tr>`;
}

export function nameRowHtml(row) {
  return `<tr><td><a href="${escapeHtml(row.href)}">${escapeHtml(row.vehicle)}</a></td><td>${escapeHtml(row.variant)}</td></tr>`;
}

export function rowBytes(rows, htmlFor = fullRowHtml) {
  let total = 0;
  for (const row of rows) total += htmlFor(row).length;
  return total;
}

export function pageFits(bytes) {
  return bytes + SAFETY_CHROME_BYTES <= SAFETY_HTML_LIMIT;
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function yearGroupLabel(years) {
  if (years.length === 1) return String(years[0]);
  if (years.length === 2) return `${years[0]} and ${years[1]}`;
  return `${years.slice(0, -1).join(", ")}, and ${years.at(-1)}`;
}

export function fetchSentence(years, fetchedByYear) {
  const groups = [];
  for (const year of years) {
    const date = fetchedByYear[year] || "";
    const last = groups.at(-1);
    if (last && last.date === date) last.years.push(year);
    else groups.push({ date, years: [year] });
  }
  const parts = groups.map((group) => {
    const when = formatDate(group.date) || "an undated fetch";
    return `${when} for ${yearGroupLabel(group.years)}`;
  });
  return assertSafetyCopy(`The Safety Ratings cache was fetched ${listPhrase(parts)}.`);
}

function countClause(subject, total, rated, five, notRated) {
  if (!total) return "";
  if (!rated) return `${subject}, and all ${formatNumber(total)} are marked Not rated.`;
  const fiveClause = five
    ? `${formatNumber(five)} ${five === 1 ? "is" : "are"} 5 stars overall`
    : "none are 5 stars overall";
  if (!notRated) return `${subject}: ${formatNumber(rated)} ${rated === 1 ? "has" : "have"} an overall star (${fiveClause}).`;
  return `${subject}: ${formatNumber(rated)} ${rated === 1 ? "has" : "have"} an overall star (${fiveClause}) and ${formatNumber(notRated)} ${notRated === 1 ? "is" : "are"} marked Not rated.`;
}

function countsOf(rows) {
  let rated = 0;
  let five = 0;
  for (const row of rows) {
    if (row.rated) rated += 1;
    if (row.five) five += 1;
  }
  return { total: rows.length, rated, five, notRated: rows.length - rated };
}

export function safetyIndexAnswer(catalog) {
  const { years, totals, placed, unplaced } = catalog;
  const subject = `NHTSA's Safety Ratings files for ${yearPhrase(years)} list ${plural(totals.variants, "variant")}`;
  const first = countClause(subject, totals.variants, totals.rated, totals.five, totals.notRated);
  let second;
  if (!totals.variants) second = "No variant is listed for those model years.";
  else if (!unplaced) second = "The class pages list every one of those variants.";
  else if (!placed) second = "None of those variants are listed on a class page.";
  else second = `The class pages list ${formatNumber(placed)} of those variants, and the other ${formatNumber(unplaced)} are not placed.`;
  return assertAnswer(`${first} ${second} ${CAVEAT}`);
}

export function safetyClassAnswer(page) {
  if (!page.rows.length) {
    const first = `For ${yearPhrase(page.years)}, no NHTSA variant is placed in the ${page.labelLower} class.`;
    const second = "A variant is placed only when its matched model year has this EPA class and no other class.";
    return assertAnswer(`${first} ${second} ${CAVEAT}`);
  }
  const subject = `For ${yearPhrase(page.years)}, this page lists ${plural(page.rows.length, `${page.labelLower} variant`)}`;
  const first = countClause(subject, page.rows.length, page.ratedCount, page.fiveCount, page.notRatedCount);
  const second = "These are the variants whose matched model year has only this EPA class.";
  return assertAnswer(`${first} ${second} ${CAVEAT}`);
}

export function safetyYearAnswer(page, yearRow) {
  const subject = `For model year ${yearRow.year}, this page lists ${plural(yearRow.rows.length, `${page.labelLower} variant`)}`;
  const first = countClause(subject, yearRow.rows.length, yearRow.ratedCount, yearRow.fiveCount, yearRow.notRatedCount);
  const second = "These are the variants whose matched model year has only this EPA class.";
  return assertAnswer(`${first} ${second} ${CAVEAT}`);
}

export function safetyFaqs(page, years = page.years) {
  const covered = yearPhrase(years);
  const faqs = [
    {
      q: `Does one overall star cover every ${page.labelLower}?`,
      a: "No. NHTSA rates each variant, a body and drive combination. Two variants of the same model year can have different stars.",
    },
    {
      q: `Are stars on this ${page.labelLower} page comparable with a pre-2011 rating?`,
      a: `No. NHTSA changed the rating method for model year 2011. This page uses ${covered} only, and a pre-2011 rating is not listed beside these stars.`,
    },
    {
      q: `What does Not rated mean for a ${page.labelLower}?`,
      a: "NHTSA published the variant and marked the rating Not rated. The cell says Not rated, and it is not shown as zero stars.",
    },
    {
      q: `Why would a variant be missing from this ${page.labelLower} page?`,
      a: `A variant is listed only when the model crosswalk matches it to one model year and that model year has a single EPA class, ${page.family}. A variant with no match, or a model year with more than one class, is counted on the safety ratings index and is not given a class.`,
    },
  ];
  return faqs.map((faq) => ({ q: assertSafetyCopy(faq.q), a: assertSafetyCopy(faq.a) }));
}

export function safetyIndexFaqs(years) {
  return [
    {
      q: "Which model years are in these safety rating tables?",
      a: assertSafetyCopy(`The tables use ${yearPhrase(years)}, the newest ${years.length} model years in the committed Safety Ratings files.`),
    },
    {
      q: "How is a variant assigned to an EPA class?",
      a: assertSafetyCopy(
        "The model crosswalk matches the NHTSA name to one model year. The page uses that model year's EPA size class after a trailing 2WD or 4WD label is removed. If the model year has more than one class, the variant is not placed.",
      ),
    },
    {
      q: "Are stars from before model year 2011 compared here?",
      a: assertSafetyCopy(
        "No. NHTSA changed the rating method for model year 2011. Those older stars are not listed, and they are not compared with the stars on these pages.",
      ),
    },
    {
      q: "Is Not rated the same as zero stars?",
      a: assertSafetyCopy(
        "No. Not rated means NHTSA published the variant and did not assign that star rating. These pages show the words Not rated and do not show a zero.",
      ),
    },
  ];
}

function caption(text) {
  return assertSafetyCopy(text);
}

export function fiveCaption(count, years, fetchedByYear) {
  return caption(
    `Variants with an overall rating of 5 for ${yearPhrase(years)}. Front, side, and rollover are that variant's stars. Rollover possibility is the API figure, as recorded. Not rated is not shown as zero. ${plural(count, "row")}. ${fetchSentence(years, fetchedByYear)}`,
  );
}

export function fiveListCaption(count, years) {
  return caption(
    `Variants with an overall rating of 5 for ${yearPhrase(years)}. Front, side, rollover, and rollover possibility are on the model year pages. Not rated is not shown as zero. ${plural(count, "row")}.`,
  );
}

export function otherCaption(count, years) {
  return caption(
    `Variants with an overall star other than 5 for ${yearPhrase(years)}. Not rated is not shown as zero. ${plural(count, "row")}.`,
  );
}

export function notRatedCaption(count, years) {
  return caption(
    `Variants NHTSA marks Not rated overall for ${yearPhrase(years)}. A Not rated cell is not zero stars. Rollover possibility stays the API figure. ${plural(count, "row")}.`,
  );
}

export function yearCountCaption(mode) {
  if (mode === "split") {
    return caption(
      "Counts by model year. Open a model year for the variant tables, with 5-star overall rows first. Not rated is not shown as zero.",
    );
  }
  return caption("Counts by model year. No variant is placed in this class for these model years. Not rated is not shown as zero.");
}

export function safetySourceParts(page, epaDate, year) {
  const years = year ? [year] : page.years;
  const fetched = fetchSentence(years, page.fetchedByYear);
  const scope = year ? `Model year ${year}. ` : "";
  return {
    before: `${scope}Source: NHTSA `,
    apiLabel: "Safety Ratings API",
    apiHref: NHTSA_RATINGS_URL,
    middle: `. ${fetched} EPA size class ${page.family} comes from the `,
    epaLabel: "fueleconomy.gov vehicles file",
    epaHref: EPA_VEHICLES_URL,
    after: assertSafetyCopy(
      ` dated ${formatDate(epaDate)}. A trailing 2WD or 4WD label is removed from VClass. Not rated is the API's text and is not shown as zero. A pre-2011 rating uses a different method and is not listed.`,
    ),
  };
}

export function safetyIndexSourceParts(catalog, epaDate) {
  return {
    before: "Source: NHTSA ",
    apiLabel: "Safety Ratings API",
    apiHref: NHTSA_RATINGS_URL,
    middle: `. ${fetchSentence(catalog.years, catalog.fetchedByYear)} EPA size class comes from the `,
    epaLabel: "fueleconomy.gov vehicles file",
    epaHref: EPA_VEHICLES_URL,
    after: assertSafetyCopy(
      ` dated ${formatDate(epaDate)}. The newest ${catalog.years.length} model years in the Safety Ratings cache are listed. A variant is placed only when the crosswalk matches one model year and that model year has a single EPA class. Not rated is the API's text and is not shown as zero. A pre-2011 rating uses a different method and is not listed.`,
    ),
  };
}

export function safetyIndexCaption(years) {
  return caption(
    `EPA size classes that have a fuel-cost page, for ${yearPhrase(years)}. Rated is an overall star. 5-star overall is part of the rated count. Not rated is not zero. Sorted by class name.`,
  );
}

export function safetyYearTableCaption(years) {
  return caption(
    `Safety Ratings file counts for ${yearPhrase(years)}. Rated is an overall star. 5-star overall is included in rated. Not rated is not zero. Placed means the variant is on one class page.`,
  );
}

export function ambiguousCaption(models, variants) {
  return caption(
    `Model years with more than one EPA size class. Their variants are not placed on a class page. ${plural(models, "model year")}, ${plural(variants, "variant")}.`,
  );
}

export function noMatchCaption(count) {
  return caption(
    `Variants in the Safety Ratings files that the model crosswalk does not attach to a published model year. A class is not guessed from the name. ${plural(count, "variant")}.`,
  );
}

export function unplacedLead(catalog) {
  const parts = [
    `${plural(catalog.noMatch, "variant")} ${catalog.noMatch === 1 ? "has" : "have"} no matched model year`,
    `${plural(catalog.ambiguousVariants, "variant")} ${catalog.ambiguousVariants === 1 ? "is" : "are"} on a model year with more than one EPA class`,
  ];
  if (catalog.outsideVariants) {
    parts.push(
      `${plural(catalog.outsideVariants, "variant")} ${catalog.outsideVariants === 1 ? "is" : "are"} in a class without a fuel-cost page`,
    );
  }
  if (catalog.noClass) {
    parts.push(`${plural(catalog.noClass, "variant")} ${catalog.noClass === 1 ? "has" : "have"} no EPA class on the matched model year`);
  }
  let text;
  if (parts.length === 1) text = `${parts[0]}.`;
  else if (parts.length === 2) text = `${parts[0]}, and ${parts[1]}.`;
  else text = `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}.`;
  return assertSafetyCopy(text);
}

export function outsideClassNote(catalog) {
  if (!catalog.outsideClasses.length) return "";
  const parts = catalog.outsideClasses.map((item) => `${item.labelLower} (${plural(item.count, "variant")})`);
  const verb = catalog.outsideClasses.length === 1 ? "has" : "have";
  const pronoun = catalog.outsideClasses.length === 1 ? "that class does" : "those classes do";
  return assertSafetyCopy(
    `${listPhrase(parts)} ${verb} an EPA class and ${verb === "has" ? "does" : "do"} not have a fuel-cost page, so ${pronoun} not get a safety ratings page.`,
  );
}

export function fuelCostLink(page) {
  return {
    href: page.fuelPath,
    label: `${page.label} fuel cost`,
    after: assertSafetyCopy(" uses the same EPA size class."),
  };
}

export function safetyLinkForFuel(page) {
  return {
    href: page.path,
    label: `NHTSA 5-star rated ${page.plural}`,
    after: assertSafetyCopy(" lists overall, front, side, and rollover stars for this EPA class."),
  };
}

export function safetyIndexLink() {
  return {
    href: SAFETY_INDEX,
    label: "NHTSA 5-star ratings by EPA class",
    after: assertSafetyCopy(" uses these same size classes."),
  };
}

export function emptyFiveSentence() {
  return assertSafetyCopy("No variant on this page has an overall rating of 5.");
}

export function splitFiveSentence(count) {
  return assertSafetyCopy(
    `${plural(count, "variant")} ${count === 1 ? "is" : "are"} 5 stars overall. The rows are on the model year pages below.`,
  );
}

function rowSort(left, right) {
  return (
    left.year - right.year ||
    left.make.localeCompare(right.make, "en") ||
    left.model.localeCompare(right.model, "en") ||
    left.variant.localeCompare(right.variant, "en") ||
    left.vehicleId - right.vehicleId
  );
}

function ncapWindow() {
  const years = readdirSync(join(root, "data/ncap"))
    .filter((name) => /^\d{4}\.json$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .filter((year) => Number.isInteger(year))
    .sort((a, b) => a - b);
  return years.slice(-SAFETY_YEAR_COUNT);
}

function loadYearDoc(year) {
  const doc = JSON.parse(readFileSync(join(root, "data/ncap", `${year}.json`), "utf8"));
  if (Number(doc.year) !== year) throw new Error(`NCAP file ${year}.json says year ${doc.year}`);
  return {
    year,
    fetchedAt: String(doc.fetchedAt || "").slice(0, 10),
    variants: Array.isArray(doc.variants) ? doc.variants : [],
  };
}

function vehicleKey(year, id) {
  const number = Number(id);
  if (!Number.isInteger(number) || number <= 0) return "";
  return `${year}:${number}`;
}

function buildRow(year, variant, hit) {
  const variantText = variantLabel(variant.description, year, hit.make, hit.model) || "variant";
  const overall = variant.overall;
  return {
    year,
    vehicleId: Number(variant.vehicleId),
    make: hit.make,
    model: hit.model,
    makeSlug: hit.makeSlug,
    modelSlug: hit.modelSlug,
    href: `/${hit.makeSlug}/${hit.modelSlug}/${year}/`,
    vehicle: `${year} ${hit.make} ${hit.model}`,
    variant: variantText,
    overall: String(overall ?? ""),
    front: String(variant.front ?? ""),
    side: String(variant.side ?? ""),
    rollover: String(variant.rollover ?? ""),
    overallLabel: starLabel(overall),
    frontLabel: starLabel(variant.front),
    sideLabel: starLabel(variant.side),
    rolloverLabel: starLabel(variant.rollover),
    possibility: variant.rolloverPossibility,
    possibilityLabel: possibilityLabel(variant.rolloverPossibility),
    rated: isRatedStar(overall),
    five: isFiveStar(overall),
    family: hit.family,
  };
}

function yearSlice(page, year, rows, fetchedByYear) {
  const stats = countsOf(rows);
  const years = [year];
  return {
    year,
    rows,
    fiveRows: rows.filter((row) => row.five),
    otherRows: rows.filter((row) => row.rated && !row.five),
    notRatedRows: rows.filter((row) => !row.rated),
    ratedCount: stats.rated,
    fiveCount: stats.five,
    notRatedCount: stats.notRated,
    path: rows.length ? `${page.path}${year}/` : "",
    fiveCaption: rows.some((row) => row.five) ? fiveCaption(stats.five, years, fetchedByYear) : "",
    otherCaption: rows.some((row) => row.rated && !row.five) ? otherCaption(stats.rated - stats.five, years) : "",
    notRatedCaption: rows.some((row) => !row.rated) ? notRatedCaption(stats.notRated, years) : "",
    fullBytes: rowBytes(rows),
  };
}

function buildPage(fuel, rows, years, fetchedByYear) {
  const sorted = [...rows].sort(rowSort);
  const stats = countsOf(sorted);
  const fullBytes = rowBytes(sorted);
  const fiveRows = sorted.filter((row) => row.five);
  const nameBytes = rowBytes(fiveRows, nameRowHtml);
  const split = !pageFits(fullBytes);
  const showFiveList = split && fiveRows.length > 0 && pageFits(nameBytes);
  const page = {
    family: fuel.family,
    slug: fuel.slug,
    label: fuel.label,
    labelLower: labelLower(fuel.label),
    plural: pluralLabel(fuel.label),
    path: `${SAFETY_INDEX}${fuel.slug}/`,
    fuelPath: fuel.path,
    years,
    fetchedByYear,
    rows: sorted,
    fiveRows,
    otherRows: sorted.filter((row) => row.rated && !row.five),
    notRatedRows: sorted.filter((row) => !row.rated),
    ratedCount: stats.rated,
    fiveCount: stats.five,
    notRatedCount: stats.notRated,
    fullBytes,
    nameBytes,
    split,
    showFiveList,
    fiveCaption: fiveRows.length ? fiveCaption(stats.five, years, fetchedByYear) : "",
    fiveListCaption: fiveRows.length ? fiveListCaption(stats.five, years) : "",
    otherCaption: stats.rated - stats.five > 0 ? otherCaption(stats.rated - stats.five, years) : "",
    notRatedCaption: stats.notRated ? notRatedCaption(stats.notRated, years) : "",
  };
  page.byYear = years.map((year) => yearSlice(page, year, sorted.filter((row) => row.year === year), fetchedByYear));
  if (!split) {
    for (const yearRow of page.byYear) yearRow.path = "";
  }
  for (const yearRow of page.byYear) {
    if (!yearRow.path) continue;
    if (!pageFits(yearRow.fullBytes)) {
      throw new Error(`Safety ratings ${page.slug} ${yearRow.year} is ${yearRow.fullBytes} row bytes plus chrome, over ${SAFETY_HTML_LIMIT}`);
    }
  }
  if (split && showFiveList && !pageFits(nameBytes)) {
    throw new Error(`Safety ratings ${page.slug} 5-star list does not fit`);
  }
  page.yearCaption = yearCountCaption(split ? "split" : "empty");
  return page;
}

function buildCatalog() {
  const years = ncapWindow();
  if (years.length !== SAFETY_YEAR_COUNT) throw new Error(`NCAP window has ${years.length} years`);
  const docs = years.map(loadYearDoc);
  const fetchedByYear = Object.fromEntries(docs.map((doc) => [doc.year, doc.fetchedAt]));
  const windowSet = new Set(years);
  const fuelPages = loadFuelCostPages();
  const fuelFamilies = new Set(fuelPages.map((page) => page.family));
  const slugs = new Set();
  for (const page of fuelPages) {
    if (!page.slug || page.slug === "index" || slugs.has(page.slug)) throw new Error(`Safety ratings slug is not usable: ${page.slug}`);
    slugs.add(page.slug);
  }
  if (loadSummary().makes.some((make) => make.slug === "safety-ratings")) {
    throw new Error("Make slug safety-ratings collides with /safety-ratings/");
  }

  const hits = new Map();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const year of years) {
        const yearRow = doc.years?.[String(year)];
        if (!yearRow?.ncap?.length) continue;
        const families = new Set();
        for (const config of yearRow.configs || []) {
          const family = classFamily(config.vclass);
          if (family) families.add(family);
        }
        const familyList = [...families].sort((a, b) => a.localeCompare(b, "en"));
        for (const variant of yearRow.ncap) {
          const key = vehicleKey(year, variant.vehicleId);
          if (!key) continue;
          const hit = {
            make: doc.make,
            model: doc.model,
            makeSlug: doc.makeSlug,
            modelSlug: doc.modelSlug,
            year,
            families: familyList,
            family: familyList.length === 1 ? familyList[0] : "",
          };
          const previous = hits.get(key);
          if (previous && (previous.makeSlug !== hit.makeSlug || previous.modelSlug !== hit.modelSlug)) {
            throw new Error(`NCAP ${key} matches /${previous.makeSlug}/${previous.modelSlug}/ and /${hit.makeSlug}/${hit.modelSlug}/`);
          }
          hits.set(key, hit);
        }
      }
    }
  }

  const byFamily = new Map();
  const ambiguousMap = new Map();
  const outsideMap = new Map();
  const noMatchMap = new Map();
  const byYear = new Map(years.map((year) => [year, {
    year,
    variants: 0,
    rated: 0,
    five: 0,
    notRated: 0,
    placed: 0,
    notPlaced: 0,
  }]));
  let noMatch = 0;
  let ambiguousVariants = 0;
  let outsideVariants = 0;
  let noClass = 0;
  const seen = new Set();

  for (const doc of docs) {
    for (const variant of doc.variants) {
      const key = vehicleKey(doc.year, variant.vehicleId);
      if (!key) {
        noMatch += 1;
        const makeName = String(variant.make || "").trim() || "(blank make)";
        const makeKey = `${doc.year}\0${makeName}`;
        noMatchMap.set(makeKey, (noMatchMap.get(makeKey) || 0) + 1);
        const bucket = byYear.get(doc.year);
        bucket.variants += 1;
        bucket.notRated += 1;
        bucket.notPlaced += 1;
        continue;
      }
      if (seen.has(key)) throw new Error(`Duplicate NCAP vehicle ${key}`);
      seen.add(key);
      const rated = isRatedStar(variant.overall);
      const five = isFiveStar(variant.overall);
      const bucket = byYear.get(doc.year);
      bucket.variants += 1;
      if (five) bucket.five += 1;
      if (rated) bucket.rated += 1;
      else bucket.notRated += 1;

      const hit = hits.get(key);
      if (!hit) {
        noMatch += 1;
        bucket.notPlaced += 1;
        const makeName = String(variant.make || "").trim() || "(blank make)";
        const makeKey = `${doc.year}\0${makeName}`;
        noMatchMap.set(makeKey, (noMatchMap.get(makeKey) || 0) + 1);
        continue;
      }
      if (hit.families.length === 0) {
        noClass += 1;
        bucket.notPlaced += 1;
        continue;
      }
      if (hit.families.length > 1) {
        ambiguousVariants += 1;
        bucket.notPlaced += 1;
        const modelKey = `${hit.makeSlug}/${hit.modelSlug}/${doc.year}`;
        const current = ambiguousMap.get(modelKey);
        if (current) current.count += 1;
        else {
          ambiguousMap.set(modelKey, {
            year: doc.year,
            make: hit.make,
            model: hit.model,
            makeSlug: hit.makeSlug,
            modelSlug: hit.modelSlug,
            href: `/${hit.makeSlug}/${hit.modelSlug}/${doc.year}/`,
            classes: hit.families.map((family) => classMeta(family).label).sort((a, b) => a.localeCompare(b, "en")),
            count: 1,
          });
        }
        continue;
      }
      if (!fuelFamilies.has(hit.family)) {
        outsideVariants += 1;
        bucket.notPlaced += 1;
        outsideMap.set(hit.family, (outsideMap.get(hit.family) || 0) + 1);
        continue;
      }
      const row = buildRow(doc.year, variant, hit);
      if (row.overallLabel === "0" || row.frontLabel === "0" || row.sideLabel === "0" || row.rolloverLabel === "0") {
        throw new Error(`NCAP ${key} star rendered as zero`);
      }
      const list = byFamily.get(hit.family);
      if (list) list.push(row);
      else byFamily.set(hit.family, [row]);
      bucket.placed += 1;
    }
  }

  let cacheGap = 0;
  for (const [key, hit] of hits) {
    if (!windowSet.has(hit.year)) continue;
    if (!seen.has(key)) cacheGap += 1;
  }

  const pages = fuelPages.map((fuel) => buildPage(fuel, byFamily.get(fuel.family) || [], years, fetchedByYear));
  const placed = pages.reduce((sum, page) => sum + page.rows.length, 0);
  const totals = {
    variants: 0,
    rated: 0,
    five: 0,
    notRated: 0,
  };
  for (const bucket of byYear.values()) {
    totals.variants += bucket.variants;
    totals.rated += bucket.rated;
    totals.five += bucket.five;
    totals.notRated += bucket.notRated;
  }
  const unplaced = noMatch + ambiguousVariants + outsideVariants + noClass;
  if (placed + unplaced !== totals.variants) {
    throw new Error(`Safety rating counts do not add up: placed ${placed}, unplaced ${unplaced}, file ${totals.variants}`);
  }
  const ambiguousModels = [...ambiguousMap.values()].sort(
    (a, b) => a.year - b.year || a.make.localeCompare(b.make, "en") || a.model.localeCompare(b.model, "en"),
  );
  const noMatchByMake = [...noMatchMap.entries()]
    .map(([key, count]) => {
      const [year, make] = key.split("\0");
      return { year: Number(year), make, count };
    })
    .sort((a, b) => a.year - b.year || b.count - a.count || a.make.localeCompare(b.make, "en"));
  const outsideClasses = [...outsideMap.entries()]
    .map(([family, count]) => {
      const meta = classMeta(family);
      return { family, label: meta.label, labelLower: labelLower(meta.label), count };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "en"));

  return {
    years,
    fetchedByYear,
    pages,
    totals,
    byYear: years.map((year) => byYear.get(year)),
    placed,
    unplaced,
    noMatch,
    ambiguousVariants,
    ambiguousModels,
    noMatchByMake,
    outsideVariants,
    outsideClasses,
    noClass,
    cacheGap,
  };
}

function catalog() {
  if (!cache) cache = buildCatalog();
  return cache;
}

export function loadSafetyCatalog() {
  return catalog();
}

export function loadSafetyPages() {
  return catalog().pages;
}

export function loadSafetyYears() {
  return catalog().years;
}

export function findSafetyPage(slug) {
  return loadSafetyPages().find((page) => page.slug === slug) || null;
}

export function safetyClassPaths() {
  return loadSafetyPages().map((page) => ({
    params: { slug: page.slug },
    props: { slug: page.slug },
  }));
}

export function safetyYearPaths() {
  const paths = [];
  for (const page of loadSafetyPages()) {
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

export function safetyPaths() {
  const paths = [SAFETY_INDEX];
  for (const page of loadSafetyPages()) {
    paths.push(page.path);
    if (!page.split) continue;
    for (const yearRow of page.byYear) {
      if (yearRow.path) paths.push(yearRow.path);
    }
  }
  return paths;
}

export { temporalCoverage, yearList, yearPhrase };
