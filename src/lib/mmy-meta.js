import { clip, formatDate, plural, span } from "./format.js";
import { site } from "./site.js";

export const MMY_TITLE_LIMIT = 65;
export const MMY_DESCRIPTION_LIMIT = 155;

function squash(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replaceAll('"', "'")
    .trim();
}

function positive(value) {
  return value != null && value !== "" && Number(value) > 0;
}

function fuelFact(row, mpgToken) {
  if (!row) return "";
  if (positive(row.mpgMin) && positive(row.mpgMax)) return span(row.mpgMin, row.mpgMax, `${mpgToken} combined`);
  if (positive(row.mpgeMin) && positive(row.mpgeMax)) return span(row.mpgeMin, row.mpgeMax, "MPGe combined");
  return "";
}

function starsFact(row, year) {
  if (Number(year) < 2011 || !row) return "";
  const low = Number(row.starMin);
  const high = Number(row.starMax);
  if (!Number.isInteger(low) || !Number.isInteger(high)) return "";
  if (low < 1 || high > 5 || low > high) return "";
  if (low === high) return low === 1 ? "1 star" : `${low} stars`;
  return `${low}–${high} stars`;
}

function listed(row) {
  return Boolean(row?.match && row.match !== "none");
}

function pick(candidates, limit) {
  const cleaned = candidates.map(squash).filter(Boolean);
  for (const text of cleaned) {
    if (text.length <= limit) return text;
  }
  return clip(cleaned[cleaned.length - 1] || "", limit);
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(" ");
}

function nhtsaWhen(dates) {
  const recallDate = formatDate(dates?.recalls);
  const complaintDate = formatDate(dates?.complaints);
  if (recallDate && complaintDate && recallDate === complaintDate) return recallDate;
  const parts = [];
  if (recallDate) parts.push(`recalls ${recallDate}`);
  if (complaintDate) parts.push(`complaints ${complaintDate}`);
  return parts.join("; ");
}

function epaWhen(dates) {
  return formatDate(dates?.epa);
}

export function mmyDocumentTitle({ year, make, model, row }) {
  const identity = `${year} ${make} ${model}`;
  const facts = [];
  if (listed(row)) {
    facts.push(plural(row.recalls, "recall"));
    facts.push(plural(row.complaints, "complaint"));
  }
  const fuel = fuelFact(row, "MPG");
  if (fuel) facts.push(fuel);
  const brand = ` | ${site.name}`;
  const compose = (list, withBrand) => {
    const body = list.length ? `${identity}: ${list.join(", ")}` : identity;
    return withBrand ? `${body}${brand}` : body;
  };
  if (compose(facts, true).length <= MMY_TITLE_LIMIT) return compose(facts, true);
  const kept = facts.slice();
  while (kept.length) {
    const bare = compose(kept, false);
    if (bare.length <= MMY_TITLE_LIMIT) return bare;
    kept.pop();
  }
  if (identity.length <= MMY_TITLE_LIMIT) return identity;
  return clip(identity, MMY_TITLE_LIMIT);
}

export function mmyMetaDescription({ year, make, model, row, dates }) {
  const name = `${year} ${make} ${model}`;
  const fuel = fuelFact(row, "mpg");
  const stars = starsFact(row, year);
  const when = nhtsaWhen(dates);
  const brief = formatDate(dates?.complaints) || formatDate(dates?.recalls);
  const epaDate = epaWhen(dates);
  const epaFull = fuel ? `EPA rates it ${fuel}${epaDate ? ` (${epaDate})` : ""}.` : "";
  const epaShort = fuel ? `EPA: ${fuel}${epaDate ? ` (${epaDate})` : ""}.` : "";
  const epaTiny = fuel ? `EPA: ${fuel}.` : "";
  const starRich = stars ? `NHTSA overall: ${stars}.` : "";
  const starShort = stars ? `Overall: ${stars}.` : "";
  const candidates = [];

  if (listed(row)) {
    const recalls = plural(row.recalls, "recall");
    const complaints = plural(row.complaints, "complaint");
    const voiced = `${name}: NHTSA lists ${recalls} and ${complaints} received so far${when ? ` (${when})` : ""}.`;
    const compact = `${name}: ${recalls} and ${complaints} received so far${when ? ` (${when})` : ""}.`;
    const compactBrief = `${name}: ${recalls} and ${complaints} received so far${brief ? ` (${brief})` : ""}.`;
    candidates.push(
      joinSentences([voiced, epaFull, starRich]),
      joinSentences([voiced, epaFull, starShort]),
      joinSentences([compact, epaFull, starShort]),
      joinSentences([compact, epaShort, starShort]),
      joinSentences([compact, epaTiny, starShort]),
      joinSentences([voiced, starShort]),
      joinSentences([compact, starShort]),
      joinSentences([compact, epaFull]),
      compact,
      compactBrief,
    );
  } else {
    const note = `${name}: NHTSA's files do not have a name matched to this model year, and may list it under a different name${when ? ` (${when})` : ""}.`;
    const mid = `${name}: no NHTSA name match yet; the files may list it under a different name${when ? ` (${when})` : ""}.`;
    const short = `${name}: no NHTSA match yet; it may be listed under a different name${when ? ` (${when})` : ""}.`;
    const briefNote = `${name}: no NHTSA match yet; it may be listed under a different name${brief ? ` (${brief})` : ""}.`;
    candidates.push(
      joinSentences([note, epaFull, starRich]),
      joinSentences([mid, epaFull, starShort]),
      joinSentences([short, epaFull, starShort]),
      joinSentences([short, epaShort, starShort]),
      joinSentences([short, epaTiny, starShort]),
      joinSentences([short, starShort, epaTiny]),
      joinSentences([short, epaTiny]),
      joinSentences([briefNote, epaTiny]),
      briefNote,
    );
  }

  return pick(candidates, MMY_DESCRIPTION_LIMIT);
}
