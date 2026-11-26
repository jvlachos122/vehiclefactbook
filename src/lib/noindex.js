import { campaignAnswer, loadIndexableCampaigns } from "./campaigns.js";
import { loadComponentPages } from "./components.js";
import { loadMeta, loadSummary } from "./catalog.js";
import { formatDate, formatNumber } from "./format.js";
import { FLAG_CAVEAT } from "./make-recalls.js";
import { loadComplaintPages } from "./make-complaints.js";

/**
 * Pages that stay on the site and are left out of the sitemap.
 *
 * Year-component pages, model /years/ pages, and make /complaints/ pages are
 * thin templates. A recall page is thin when its article has fewer than
 * RECALL_UNIQUE_MIN unique words.
 *
 * A word is unique when it is not part of text repeated across at least 20
 * percent of recall pages. Repeated text is any exact run of
 * RECALL_PHRASE_WORDS words, lowercased, that occurs on at least that share
 * of recall articles. Seven words is a clause, so a pair such as "of the" is
 * not repeated text on its own, and one campaign number inside a shared
 * sentence does not keep the surrounding clause from matching. Twenty percent
 * is count * 5 >= page count, so an exact fifth of the corpus counts as
 * repeated. The article text is the recall template's main copy: the heading,
 * answer, campaign fields, summary, and model-year table. The header, footer,
 * and JSON-LD are not part of it.
 */

export const RECALL_PHRASE_WORDS = 7;
export const RECALL_UNIQUE_MIN = 50;

export function normalizePath(pathname) {
  if (!pathname) return "/";
  let path = String(pathname).split("?")[0].split("#")[0];
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && !path.endsWith("/")) path += "/";
  return path;
}

export function pathFromHtmlRel(rel) {
  let path = String(rel || "").replaceAll("\\", "/");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  else if (path.endsWith(".html")) path = `${path.slice(0, -".html".length)}/`;
  if (!path.endsWith("/")) path += "/";
  return path || "/";
}

export function tokenizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

export function repeatedPhrase(count, pages) {
  return pages > 0 && count * 5 >= pages;
}

export function uniqueWordCounts(docs, phraseWords = RECALL_PHRASE_WORDS) {
  const pages = docs.length;
  const gramDf = new Map();
  if (pages > 0 && phraseWords > 0) {
    for (const words of docs) {
      if (words.length < phraseWords) continue;
      const seen = new Set();
      for (let index = 0; index + phraseWords <= words.length; index += 1) {
        seen.add(words.slice(index, index + phraseWords).join(" "));
      }
      for (const gram of seen) gramDf.set(gram, (gramDf.get(gram) || 0) + 1);
    }
  }
  const hot = new Set();
  for (const [gram, count] of gramDf) {
    if (repeatedPhrase(count, pages)) hot.add(gram);
  }
  return docs.map((words) => {
    if (!words.length) return 0;
    if (words.length < phraseWords || !hot.size) return new Set(words).size;
    const covered = new Uint8Array(words.length);
    for (let index = 0; index + phraseWords <= words.length; index += 1) {
      if (!hot.has(words.slice(index, index + phraseWords).join(" "))) continue;
      for (let offset = 0; offset < phraseWords; offset += 1) covered[index + offset] = 1;
    }
    const left = [];
    for (let index = 0; index < words.length; index += 1) {
      if (!covered[index]) left.push(words[index]);
    }
    return new Set(left).size;
  });
}

export function recallArticleText(campaign, recallDate) {
  const answer = campaignAnswer(campaign, recallDate);
  const reportDates = (campaign.dates || []).map((date) => formatDate(date)).filter(Boolean);
  const fileDate = formatDate(recallDate);
  const makeLabel = campaign.makes.length === 1 ? "page" : "pages";
  const yearLabel = campaign.mmy.length === 1 ? "page" : "pages";
  const parts = [
    "Recall campaign",
    `NHTSA recall ${campaign.camp}`,
    answer,
    "ABOUT THIS DATA",
    campaign.dnd ? "Do not drive" : "",
    campaign.park ? "Park outside" : "",
    `Source: NHTSA recall flat file dated ${fileDate}. This page is not a VIN lookup. NHTSA's recall tool checks a specific vehicle at nhtsa.gov/recalls. The campaign record is ${campaign.camp} at NHTSA.`,
    FLAG_CAVEAT,
    "Campaign record",
    "Field",
    "Value",
    "Campaign",
    campaign.camp,
    "Report date",
    reportDates.length ? reportDates.join(", ") : "—",
    "Component",
    campaign.component || "—",
    "Do not drive",
    campaign.dnd ? "Yes" : "Not marked Yes on the matched rows",
    "Park outside",
    campaign.park ? "Yes" : "Not marked Yes on the matched rows",
    "NHTSA summary",
    campaign.summary || "—",
    "Model years on this site",
    "NHTSA's file lists this campaign on the model years below that this site publishes. The table is those matched rows, not a count of vehicles still unrepaired.",
    `Make ${makeLabel}:`,
    campaign.makes.map((make) => `${make.name} recalls`).join(", "),
    `${formatNumber(campaign.mmy.length)} model year ${yearLabel} that list ${campaign.camp}`,
    "Model year",
    "NHTSA name",
    campaign.components.length > 1 ? "Component" : "",
  ];
  for (const row of campaign.mmy) {
    parts.push(`${row.year} ${row.make} ${row.model}`);
    parts.push(row.nhtsaNames.join(", ") || "—");
    if (campaign.components.length > 1) parts.push(row.components.join("; ") || "—");
  }
  return parts.filter(Boolean).join("\n");
}

let familyCache;

function familySets() {
  if (familyCache) return familyCache;
  const component = new Set(loadComponentPages().map((page) => page.path));
  const years = new Set();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      if (model.yearsPage) years.add(`/${make.slug}/${model.slug}/years/`);
    }
  }
  const complaints = new Set(loadComplaintPages().map((page) => page.path));
  const campaigns = loadIndexableCampaigns();
  const recallDate = loadMeta().dates.recalls;
  const docs = campaigns.map((campaign) => tokenizeWords(recallArticleText(campaign, recallDate)));
  const counts = uniqueWordCounts(docs);
  const recalls = new Set();
  const recallCounts = new Map();
  campaigns.forEach((campaign, index) => {
    const path = `/recalls/${campaign.camp}/`;
    recallCounts.set(path, counts[index]);
    if (counts[index] < RECALL_UNIQUE_MIN) recalls.add(path);
  });
  familyCache = { component, years, complaints, recalls, recallCounts, recallPages: campaigns.length };
  return familyCache;
}

export function noindexFamilyCounts() {
  const sets = familySets();
  return {
    component: sets.component.size,
    years: sets.years.size,
    makeComplaints: sets.complaints.size,
    thinRecalls: sets.recalls.size,
    recallPages: sets.recallPages,
  };
}

export function recallUniqueWords(pathname) {
  const count = familySets().recallCounts.get(normalizePath(pathname));
  return count == null ? null : count;
}

export function noindexFollowPath(pathname) {
  const path = normalizePath(pathname);
  const sets = familySets();
  return sets.component.has(path) || sets.years.has(path) || sets.complaints.has(path) || sets.recalls.has(path);
}
