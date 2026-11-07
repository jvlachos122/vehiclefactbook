import { primaryNameGroup } from "./campaigns.js";
import { loadModel, loadSummary } from "./catalog.js";
import { clip, formatDate, metaDescription, plural } from "./format.js";

/**
 * Component count pages.
 *
 * A page exists only when the component list already stored on the model year
 * has at least COMPONENT_MIN distinct complaints. That list is the top ten
 * components for the headline NHTSA name. When the EPA name is not itself an
 * NHTSA name, the model year page shows the matched name with the most
 * complaints, and these pages use that same list. Other matched names stay on
 * the model year page. A component outside the stored top ten has no count in
 * the committed file, so it is not given a page.
 *
 * The count is distinct complaints for that component. It is not a rate.
 * Crash, fire, injury, and death figures are stored for the model year, not
 * for one component, and these pages do not copy them.
 */
export const COMPONENT_MIN = 50;
export const COMPONENT_TITLE_LIMIT = 65;

const PII_KEYS = new Set(["vin", "city", "operator", "dealer", "vehicle_operator", "narrative", "cdescr"]);

let pageCache;
let hrefCache;
let modelCache;

export function componentSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function displayedComplaints(yearDetail) {
  if (!yearDetail || yearDetail.match === "none") return null;
  if (yearDetail.splitNames) {
    const primary = primaryNameGroup(yearDetail);
    if (!primary?.complaints) return null;
    return {
      complaints: primary.complaints,
      nhtsaName: String(primary.name || ""),
      split: true,
    };
  }
  if (!yearDetail.complaints) return null;
  return { complaints: yearDetail.complaints, nhtsaName: "", split: false };
}

export function qualifyingComponents(complaints) {
  const items = [];
  const seen = new Set();
  for (const item of complaints?.top || []) {
    const component = String(item?.component || "").trim();
    const n = Number(item?.n);
    if (!component || !Number.isFinite(n) || n < COMPONENT_MIN) continue;
    const slug = componentSlug(component);
    if (!slug) {
      throw new Error(`Component ${JSON.stringify(component)} has an empty slug`);
    }
    if (seen.has(slug)) {
      throw new Error(`Component slug collision ${slug} for ${JSON.stringify(component)}`);
    }
    seen.add(slug);
    items.push({ component, n, slug });
  }
  return items;
}

function pagePath(makeSlug, modelSlug, year, slug) {
  return `/${makeSlug}/${modelSlug}/${year}/${slug}/`;
}

export function loadComponentPages() {
  if (pageCache) return pageCache;
  const pages = [];
  const paths = new Set();
  for (const make of loadSummary().makes) {
    for (const model of make.models) {
      const doc = loadModel(make.slug, model.slug);
      for (const summaryYear of model.years) {
        const detail = doc.years?.[String(summaryYear.y)];
        const displayed = displayedComplaints(detail);
        if (!displayed) continue;
        let items;
        try {
          items = qualifyingComponents(displayed.complaints);
        } catch (error) {
          throw new Error(`${make.slug}/${model.slug}/${summaryYear.y}: ${error.message}`);
        }
        const siblings = items.map((item) => ({
          component: item.component,
          n: item.n,
          slug: item.slug,
          path: pagePath(make.slug, model.slug, summaryYear.y, item.slug),
        }));
        for (const item of items) {
          const path = pagePath(make.slug, model.slug, summaryYear.y, item.slug);
          if (paths.has(path)) throw new Error(`Duplicate component path ${path}`);
          paths.add(path);
          const page = {
            makeSlug: make.slug,
            makeName: make.name,
            modelSlug: model.slug,
            modelName: model.name,
            year: summaryYear.y,
            component: item.component,
            slug: item.slug,
            n: item.n,
            listN: Number(displayed.complaints.n) || 0,
            mmyN: Number(summaryYear.complaints) || 0,
            nhtsaName: displayed.nhtsaName,
            split: displayed.split,
            yearsPage: Boolean(model.yearsPage),
            path,
            siblings: siblings.filter((sibling) => sibling.slug !== item.slug),
          };
          assertNoPii(page);
          pages.push(page);
        }
      }
    }
  }
  pageCache = pages;
  return pages;
}

function assertNoPii(page) {
  const stack = [page];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (PII_KEYS.has(String(key).toLowerCase())) {
        throw new Error(`Component page record includes ${key}`);
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
}

function indexes() {
  if (!hrefCache) {
    hrefCache = new Map();
    modelCache = new Set();
    for (const page of loadComponentPages()) {
      modelCache.add(`${page.makeSlug}/${page.modelSlug}`);
      const key = `${page.makeSlug}/${page.modelSlug}/${page.year}`;
      let bucket = hrefCache.get(key);
      if (!bucket) {
        bucket = {};
        hrefCache.set(key, bucket);
      }
      bucket[page.component] = page.path;
    }
  }
  return { hrefCache, modelCache };
}

export function componentHrefs(makeSlug, modelSlug, year) {
  return indexes().hrefCache.get(`${makeSlug}/${modelSlug}/${year}`) || {};
}

export function modelHasComponentPage(makeSlug, modelSlug) {
  return indexes().modelCache.has(`${makeSlug}/${modelSlug}`);
}

export function componentPaths() {
  return loadComponentPages().map((page) => ({
    params: {
      make: page.makeSlug,
      model: page.modelSlug,
      year: String(page.year),
      component: page.slug,
    },
    props: { page },
  }));
}

export function componentDocumentTitle(page) {
  const full = `${page.year} ${page.makeName} ${page.modelName}: ${page.component} complaints`;
  if (full.length <= COMPONENT_TITLE_LIMIT) return full;
  const shorter = `${page.year} ${page.makeName} ${page.modelName} component complaints`;
  if (shorter.length <= COMPONENT_TITLE_LIMIT) return shorter;
  return clip(shorter, COMPONENT_TITLE_LIMIT);
}

export function componentAnswer(page, complaintDate) {
  const date = formatDate(complaintDate);
  const dated = date ? ` in the complaint file dated ${date}` : "";
  const count = plural(page.n, "distinct complaint");
  const who = page.split
    ? `for the matched name ${page.nhtsaName} on the ${page.year} ${page.makeName} ${page.modelName}`
    : `for the ${page.year} ${page.makeName} ${page.modelName}`;
  const first = `NHTSA lists ${count} with component ${page.component} ${who}${dated}.`;
  const overlap = "one complaint can be counted under more than one component";
  let second;
  if (page.split && page.mmyN !== page.listN) {
    second = `That name has ${plural(page.listN, "distinct complaint")}, the model year total across matched names is ${plural(page.mmyN, "distinct complaint")}, and ${overlap}.`;
  } else if (page.split) {
    second = `That name has ${plural(page.listN, "distinct complaint")}, and ${overlap}.`;
  } else {
    second = `This model year lists ${plural(page.listN, "distinct complaint")} for the same name, and ${overlap}.`;
  }
  const third = "Counts are raw, not rates, and more complaints can mean more cars sold.";
  return `${first} ${second} ${third}`;
}

export function componentMetaDescription(page, complaintDate) {
  return metaDescription(componentAnswer(page, complaintDate));
}
