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

function starSentence(year, variants, make, model) {
  if (year < 2011) {
    return "NHTSA star ratings from before model year 2011 use an older method and are not shown here.";
  }
  const list = variants || [];
  if (!list.length) {
    return "No NHTSA 5-star rating in the SafetyRatings API is matched to this model year.";
  }
  const rated = list.filter((variant) => /^\d$/.test(String(variant.overall || "")));
  if (!rated.length) {
    return "NHTSA lists crash-test variants for this model year and marks the overall rating Not Rated.";
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

function epaSentence(row, epaDate) {
  const parts = [];
  const mpg = span(row.mpgMin, row.mpgMax, "mpg combined");
  const mpge = span(row.mpgeMin, row.mpgeMax, "MPGe combined");
  const kwh = kwhSpan(row.kwhMin, row.kwhMax);
  if (mpg) parts.push(mpg);
  if (mpge) parts.push(mpge);
  if (kwh) parts.push(kwh);
  if (!parts.length) return "";
  const varying =
    (row.mpgMin != null && row.mpgMin !== row.mpgMax) ||
    (row.mpgeMin != null && row.mpgeMin !== row.mpgeMax) ||
    (row.kwhMin != null && row.kwhMin !== row.kwhMax);
  let sentence = `EPA rates it ${parts.join(" and ")}${varying ? " depending on configuration" : ""} (fuel economy file dated ${epaDate}).`;
  if (row.costMin != null && row.costMax != null) {
    const cost =
      row.costMin === row.costMax
        ? `$${Number(row.costMin).toLocaleString("en-US")}`
        : `$${Number(row.costMin).toLocaleString("en-US")}–$${Number(row.costMax).toLocaleString("en-US")}`;
    sentence += ` EPA's annual fuel-cost figures for these configurations are ${cost}, based on 15,000 miles and 55% city driving.`;
  }
  return sentence;
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
  const sentences = [];
  if (row.match === "none") {
    sentences.push(
      `NHTSA's recall, complaint, and investigation files do not have a make and model name matched to the ${year} ${make} ${model} (recall file dated ${recallDate}; complaint file dated ${complaintDate}). The files may list it under a different name.`,
    );
  } else if (detail?.splitNames) {
    const names = nameList(detail.also || []);
    sentences.push(
      `NHTSA does not list the EPA model name ${model} for ${year}. Under the matched name${(detail.also || []).length === 1 ? "" : "s"} ${names}, NHTSA lists ${plural(row.recalls, "recall")} and ${plural(row.complaints, "complaint")} (recall file dated ${recallDate}; complaint file dated ${complaintDate}).`,
    );
  } else {
    sentences.push(
      `NHTSA lists ${plural(row.recalls, "recall")} and ${plural(row.complaints, "complaint")} for the ${year} ${make} ${model} (recall file dated ${recallDate}; complaint file dated ${complaintDate}).`,
    );
    if (row.alsoRecalls || row.alsoComplaints) {
      const extraNames = nameList(detail?.also || []);
      const where = extraNames ? ` under ${extraNames}` : " under other NHTSA model names";
      sentences.push(
        `NHTSA also lists ${plural(row.alsoRecalls, "recall")} and ${plural(row.alsoComplaints, "complaint")}${where}. Those counts are separate from the numbers above.`,
      );
    }
  }
  if (row.match !== "none" && (row.dnd || row.park)) {
    const bits = [];
    if (row.dnd) bits.push(`${plural(row.dnd, "recall")} marked do not drive`);
    if (row.park) bits.push(`${plural(row.park, "recall")} marked park outside`);
    sentences.push(`${bits.join(", and ")}.`);
  }
  const topSource = detail?.splitNames
    ? [...(detail.also || [])].sort((a, b) => (b.complaints?.n || 0) - (a.complaints?.n || 0))[0]
    : detail;
  const top = topSource?.complaints?.top?.slice(0, 3) || [];
  if (top.length && row.match !== "none") {
    const list = top.map((item) => `${item.component} (${Number(item.n).toLocaleString("en-US")})`).join(", ");
    const whose = detail?.splitNames && topSource?.name ? ` for ${topSource.name}` : "";
    sentences.push(`The components listed on the most complaints${whose} are ${list}.`);
  }
  if (row.match !== "none" && row.investigations) {
    if (row.invOpen === row.investigations) {
      sentences.push(
        `NHTSA lists ${plural(row.investigations, "investigation")} with no close date in the file.`,
      );
    } else if (row.invOpen) {
      sentences.push(
        `NHTSA lists ${plural(row.investigations, "investigation")}, including ${plural(row.invOpen, "investigation")} with no close date in the file.`,
      );
    } else {
      sentences.push(`NHTSA lists ${plural(row.investigations, "investigation")}.`);
    }
  }
  sentences.push(starSentence(year, detail?.ncap, make, model));
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
    `EPA's fuel-economy file dated ${epaDate} lists ${counts.epaRowsMy2000.toLocaleString("en-US")} rows for model year 2000 and newer: ${counts.rawMakes.toLocaleString("en-US")} make names, ${counts.rawModels.toLocaleString("en-US")} models, and ${counts.mmySpine.toLocaleString("en-US")} model years.`,
    `This site publishes ${counts.publishedMakes.toLocaleString("en-US")} makes and ${counts.publishedModels.toLocaleString("en-US")} models after spellings that normalize to the same name share a page, including Mini and MINI.`,
    `NHTSA's recall file dated ${recallDate} contains ${counts.vehicleCampaignsPost2010.toLocaleString("en-US")} vehicle campaigns with a report date in 2010 or later, and the pre-2010 file contains ${counts.vehicleCampaignsPre2010.toLocaleString("en-US")} vehicle campaigns.`,
    `The complaint file dated ${complaintDate} contains ${counts.complaintVehicleOdino.toLocaleString("en-US")} distinct vehicle complaints.`,
  ].join(" ");
}

export function makeAnswer(name, models, dates) {
  const totals = rollup(models);
  const recallDate = formatDate(dates.recalls);
  const complaintDate = formatDate(dates.complaints);
  const epaDate = formatDate(dates.epa);
  const sentences = [
    `Across ${totals.models.toLocaleString("en-US")} ${name} models and ${totals.mmy.toLocaleString("en-US")} model years (${totals.minY}–${totals.maxY}), matched NHTSA records on this site add up to ${plural(totals.recalls, "recall")} and ${plural(totals.complaints, "complaint")} (recall file dated ${recallDate}; complaint file dated ${complaintDate}).`,
    "A campaign that covers more than one model year is counted on each of those pages, so the recall total is not a count of distinct campaigns.",
  ];
  if (totals.mpgMin != null) {
    sentences.push(
      `EPA combined mpg for non-electric configurations in the file dated ${epaDate} runs from ${span(totals.mpgMin, totals.mpgMax, "mpg")}.`,
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
      `Matched complaint counts run from ${low.complaints.toLocaleString("en-US")} in ${low.y} to ${high.complaints.toLocaleString("en-US")} in ${high.y}. These are raw counts, not rates.`,
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
  return `For the ${make} ${model}, matched NHTSA complaint counts in this table run from ${low.complaints.toLocaleString("en-US")} (${low.y}) to ${high.complaints.toLocaleString("en-US")} (${high.y}). The complaint file is dated ${complaintDate}. These are raw counts, not rates. A higher count can mean more vehicles were sold, and newer model years have had less time for complaints to be reported.`;
}
