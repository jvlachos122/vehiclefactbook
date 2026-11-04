import { formatDate, kwhSpan, plural, span } from "./format.js";

function escapeReg(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function variantLabel(description, year, make, model) {
  let text = String(description || "").trim();
  const prefix = new RegExp(`^${year}\\s+${escapeReg(make)}\\s+${escapeReg(model)}\\s+`, "i");
  text = text.replace(prefix, "").trim();
  return text || String(description || "").trim();
}

export function pre2011RatingSentence() {
  return "NHTSA's pre-2011 rating, not comparable to later stars, is not shown here.";
}

function starSentence(year, variants, make, model) {
  if (year < 2011) return pre2011RatingSentence();
  const list = variants || [];
  if (!list.length) {
    return "No NHTSA 5-star rating in the SafetyRatings API is matched to this model year.";
  }
  const rated = list.filter((variant) => /^\d$/.test(String(variant.overall || "")));
  if (!rated.length) {
    return "NHTSA lists crash-test variants for this model year and marks the overall rating Not rated.";
  }
  const stars = rated.map((variant) => Number(variant.overall));
  const low = Math.min(...stars);
  const high = Math.max(...stars);
  if (rated.length === 1) {
    const label = variantLabel(rated[0].description, year, make, model);
    return `NHTSA rated the ${label} ${rated[0].overall} stars overall.`;
  }
  if (low === high) return `NHTSA rated ${rated.length} variants ${low} stars overall.`;
  return `NHTSA overall stars for rated variants run from ${low} to ${high}.`;
}

function usableRange(min, max) {
  return min != null && max != null && Number(min) > 0 && Number(max) > 0;
}

function epaSentence(row, epaDate) {
  const parts = [];
  const mpg = usableRange(row.mpgMin, row.mpgMax) ? span(row.mpgMin, row.mpgMax, "mpg combined") : "";
  const mpge = usableRange(row.mpgeMin, row.mpgeMax) ? span(row.mpgeMin, row.mpgeMax, "MPGe combined") : "";
  const kwh = usableRange(row.kwhMin, row.kwhMax) ? kwhSpan(row.kwhMin, row.kwhMax) : "";
  if (mpg) parts.push(mpg);
  if (mpge) parts.push(mpge);
  if (kwh) parts.push(kwh);
  if (!parts.length) return "";
  const varying =
    (row.mpgMin != null && row.mpgMin !== row.mpgMax) ||
    (row.mpgeMin != null && row.mpgeMin !== row.mpgeMax) ||
    (row.kwhMin != null && row.kwhMin !== row.kwhMax);
  return `EPA rates it ${parts.join(" and ")}${varying ? " depending on configuration" : ""} (fuel economy file dated ${epaDate}).`;
}

function nameList(items) {
  const names = items.map((item) => item.name).filter(Boolean);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function mmyAnswer({ make, model, year, row, detail, dates }) {
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const epaDate = formatDate(dates.epa);
  const caveat = "counts are raw, not rates, and more complaints can mean more cars sold";
  let nhtsa;
  if (row.match === "none") {
    nhtsa = `NHTSA's recall, complaint, and investigation files do not have a make and model name matched to the ${year} ${make} ${model} (recall file dated ${recallDate}; complaint file dated ${complaintDate}), and the files may list it under a different name.`;
  } else if (detail?.splitNames && nameList(detail.also || [])) {
    const names = nameList(detail.also || []);
    const nameWord = (detail.also || []).length === 1 ? "name" : "names";
    nhtsa = `NHTSA does not list the EPA model name ${model} for ${year}; under the matched ${nameWord} ${names}, NHTSA lists ${plural(row.recalls, "recall campaign")} and ${plural(row.complaints, "complaint")} received so far (recall file dated ${recallDate}; complaint file dated ${complaintDate}); ${caveat}.`;
  } else {
    nhtsa = `NHTSA lists ${plural(row.recalls, "recall campaign")} and ${plural(row.complaints, "complaint")} received so far for the ${year} ${make} ${model} (recall file dated ${recallDate}; complaint file dated ${complaintDate}); ${caveat}.`;
  }
  const sentences = [nhtsa, starSentence(year, detail?.ncap, make, model)];
  const epa = epaSentence(row, epaDate);
  if (epa) sentences.push(epa);
  return sentences.filter(Boolean).join(" ");
}

export function rollup(models) {
  let recalls = 0;
  let complaints = 0;
  let mmy = 0;
  let dnd = 0;
  let park = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  const mpg = [];
  for (const model of models) {
    for (const year of model.years) {
      recalls += year.recalls || 0;
      complaints += year.complaints || 0;
      dnd += year.dnd || 0;
      park += year.park || 0;
      mmy += 1;
      if (year.y < minY) minY = year.y;
      if (year.y > maxY) maxY = year.y;
      if (year.mpgMin != null) mpg.push(year.mpgMin);
      if (year.mpgMax != null) mpg.push(year.mpgMax);
    }
  }
  return {
    models: models.length,
    recalls,
    complaints,
    mmy,
    dnd,
    park,
    minY: Number.isFinite(minY) ? minY : null,
    maxY: Number.isFinite(maxY) ? maxY : null,
    mpgMin: mpg.length ? Math.min(...mpg) : null,
    mpgMax: mpg.length ? Math.max(...mpg) : null,
  };
}

export function homeAnswer(counts, dates) {
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const epaDate = formatDate(dates.epa);
  return [
    `EPA's fuel-economy file dated ${epaDate} lists ${counts.epaRowsMy2000.toLocaleString("en-US")} rows for model year 2000 and newer: ${counts.rawMakes.toLocaleString("en-US")} make names, ${counts.rawModels.toLocaleString("en-US")} models, and ${counts.mmySpine.toLocaleString("en-US")} model years, published here as ${counts.publishedMakes.toLocaleString("en-US")} makes and ${counts.publishedModels.toLocaleString("en-US")} models after spellings that normalize to the same name share a page, including Mini and MINI.`,
    `NHTSA's recall file dated ${recallDate} contains ${counts.vehicleCampaignsPost2010.toLocaleString("en-US")} vehicle campaigns with a report date in 2010 or later, and the pre-2010 file contains ${counts.vehicleCampaignsPre2010.toLocaleString("en-US")} vehicle campaigns.`,
    `The complaint file dated ${complaintDate} contains ${counts.complaintVehicleOdino.toLocaleString("en-US")} distinct vehicle complaints.`,
  ].join(" ");
}

export function makeAnswer(name, models, dates, facts = {}) {
  const totals = rollup(models);
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const epaDate = formatDate(dates.epa);
  const total = Number(facts.total) || 0;
  const dnd = Number(facts.dnd) || 0;
  const park = Number(facts.park) || 0;
  let range = "";
  if (facts.minDate && facts.maxDate) {
    const min = formatDate(facts.minDate);
    const max = formatDate(facts.maxDate);
    range = min === max ? `, with report date ${min}` : `, with report dates from ${min} through ${max}`;
  }
  const sentences = [
    `NHTSA's recall file dated ${recallDate} lists ${plural(total, "vehicle campaign")} matched to ${name} model years on this site${range}, including ${plural(dnd, "campaign")} marked do not drive and ${plural(park, "campaign")} marked park outside.`,
    `Across ${plural(totals.models, "model")} and ${plural(totals.mmy, "model year")} (${totals.minY}–${totals.maxY}), matched NHTSA records on the model year pages add up to ${plural(totals.recalls, "recall row")} and ${plural(totals.complaints, "complaint")} (complaint file dated ${complaintDate}), and a campaign that covers more than one model year is counted on each of those pages; complaint figures are raw counts, not rates, and more complaints can mean more cars sold.`,
  ];
  if (totals.mpgMin != null) {
    sentences.push(
      `EPA rates non-electric configurations ${span(totals.mpgMin, totals.mpgMax, "mpg combined")} (fuel economy file dated ${epaDate}).`,
    );
  }
  return sentences.join(" ");
}

export function modelAnswer(make, model, years, dates) {
  const totals = rollup([{ years }]);
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const epaDate = formatDate(dates.epa);
  const withNhtsa = years.filter((year) => year.hasNhtsa);
  const sentences = [
    `For the ${make} ${model}, model years ${totals.minY}–${totals.maxY} on this site have ${plural(totals.recalls, "matched recall")} and ${plural(totals.complaints, "matched complaint")} (recall file dated ${recallDate}; complaint file dated ${complaintDate}).`,
  ];
  if (withNhtsa.length >= 2) {
    const ranked = [...withNhtsa].sort((a, b) => b.complaints - a.complaints || b.y - a.y);
    const high = ranked[0];
    const low = ranked[ranked.length - 1];
    sentences.push(
      `Matched complaint counts run from ${low.complaints.toLocaleString("en-US")} in ${low.y} to ${high.complaints.toLocaleString("en-US")} in ${high.y}, and these are raw counts, not rates.`,
    );
  } else if (!withNhtsa.length) {
    sentences.push("No model year in this list has a matched NHTSA recall, complaint, or investigation record.");
  }
  if (totals.mpgMin != null) {
    sentences.push(`EPA rates non-electric configurations ${span(totals.mpgMin, totals.mpgMax, "mpg combined")} (file dated ${epaDate}).`);
  }
  return sentences.join(" ");
}

export function yearsAnswer(make, model, years, dates) {
  const withComplaints = years.filter((year) => year.hasNhtsa);
  const complaintDate = formatDate(dates.complaints);
  if (withComplaints.length < 1) {
    return `NHTSA's files dated ${complaintDate} do not have matched complaint counts for the ${make} ${model} model years in this table.`;
  }
  const ranked = [...withComplaints].sort((a, b) => b.complaints - a.complaints || b.y - a.y);
  const high = ranked[0];
  const low = ranked[ranked.length - 1];
  return `For the ${make} ${model}, matched NHTSA complaint counts in this table run from ${low.complaints.toLocaleString("en-US")} (${low.y}) to ${high.complaints.toLocaleString("en-US")} (${high.y}). The complaint file is dated ${complaintDate}. These are raw counts, not rates, and a higher count can mean more vehicles were sold or that a newer model year has had less time for complaints to be reported.`;
}
