import { formatNumber } from "./format.js";
import { sentenceCount } from "./jsonld-audit.js";
import { isMatchedYear, MODEL_FACTS_BANNED } from "./model-facts.js";

/**
 * Short comparisons for a model hub, computed from the model-year rows already
 * on that page and the same rows for the make's other models. A missing
 * figure is left out. Counts are the stored counts, not rates.
 */

const PII = /\b(vins?|dealers?|narrative|cdescr|odino|firstname|lastname|operator)\b/i;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

function guard(text) {
  const value = String(text || "");
  if (MODEL_FACTS_BANNED.test(value)) throw new Error(`model comparison matches a banned word: ${value}`);
  if (PII.test(value) || VIN.test(value)) throw new Error(`model comparison names a complaint detail: ${value}`);
  return value;
}

function mpgHigh(row) {
  const low = Number(row?.mpgMin);
  const high = Number(row?.mpgMax);
  if (!(low > 0) || !(high > 0)) return null;
  return high;
}

function mpgeHigh(row) {
  const low = Number(row?.mpgeMin);
  const high = Number(row?.mpgeMax);
  if (!(low > 0) || !(high > 0)) return null;
  return high;
}

function countOf(row, field) {
  if (!isMatchedYear(row)) return null;
  const number = Number(row?.[field]);
  if (!Number.isFinite(number)) return null;
  return number;
}

function newestPair(rows, valueOf) {
  const found = [];
  for (const row of rows) {
    const value = valueOf(row);
    if (value == null) continue;
    found.push({ year: row.y, value });
  }
  found.sort((a, b) => a.year - b.year);
  if (found.length < 2) return null;
  return [found[found.length - 2], found[found.length - 1]];
}

function pairSentence(prior, newest, singular, pluralLabel) {
  if (prior.value === newest.value) {
    return `The ${prior.year} and ${newest.year} ${pluralLabel} are both ${formatNumber(newest.value)}.`;
  }
  return `The ${newest.year} ${singular} is ${formatNumber(newest.value)} and the ${prior.year} ${singular} is ${formatNumber(prior.value)}.`;
}

function countVerb(count, singular, pluralForm) {
  if (count === 0) return `none ${pluralForm}`;
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

function peerSentence(make, model, year, high, peers) {
  let higher = 0;
  let lower = 0;
  let same = 0;
  let listed = 0;
  for (const peer of peers || []) {
    if (peer.slug === model.slug) continue;
    const row = (peer.years || []).find((item) => item.y === year);
    const peerHigh = mpgHigh(row);
    if (peerHigh == null) continue;
    listed += 1;
    if (peerHigh > high) higher += 1;
    else if (peerHigh < high) lower += 1;
    else same += 1;
  }
  if (!listed) return `No other ${make} model lists a combined mpg for ${year}.`;
  return `Among other ${make} models with a ${year} combined mpg, ${countVerb(higher, "lists", "list")} a higher combined mpg high than ${formatNumber(high)}, ${countVerb(lower, "lists", "list")} a lower high, and ${countVerb(same, "lists", "list")} the same high.`;
}

export function modelComparisonText(make, model, years, peers) {
  const rows = [...(years || [])].filter((row) => Number.isInteger(Number(row?.y))).sort((a, b) => a.y - b.y);
  const sentences = [];
  const mpg = newestPair(rows, mpgHigh);
  const mpge = mpg ? null : newestPair(rows, mpgeHigh);
  if (mpg) sentences.push(pairSentence(mpg[0], mpg[1], "combined mpg high", "combined mpg highs"));
  else if (mpge) sentences.push(pairSentence(mpge[0], mpge[1], "combined MPGe high", "combined MPGe highs"));
  const complaints = newestPair(rows, (row) => countOf(row, "complaints"));
  if (complaints) sentences.push(pairSentence(complaints[0], complaints[1], "matched complaint count", "matched complaint counts"));
  if (mpg) sentences.push(peerSentence(make, model, mpg[1].year, mpg[1].value, peers));
  else {
    const recalls = newestPair(rows, (row) => countOf(row, "recalls"));
    if (recalls) sentences.push(pairSentence(recalls[0], recalls[1], "recall campaign count", "recall campaign counts"));
  }
  const text = sentences.length
    ? sentences.slice(0, 3).join(" ")
    : `${make} ${model.name} does not have two model years with a combined mpg or two matched model years with a complaint count, so there is no year-to-year comparison.`;
  const count = sentenceCount(text);
  if (count < 1 || count > 3) throw new Error(`${make} ${model.name} comparison has ${count} sentences`);
  return guard(text);
}
