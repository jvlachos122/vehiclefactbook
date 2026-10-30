import { site } from "./site.js";

export const nhtsaOrg = {
  "@type": "Organization",
  name: "National Highway Traffic Safety Administration",
  url: "https://www.nhtsa.gov/",
};

export const epaOrg = {
  "@type": "Organization",
  name: "U.S. Environmental Protection Agency",
  url: "https://www.epa.gov/",
};

export const siteOrg = {
  "@type": "Organization",
  name: site.name,
  url: site.url,
};

export const publisherOrg = {
  "@type": "Organization",
  name: site.legalName,
};

export function temporalCoverageFromDates(dates) {
  const iso = [...(dates || [])]
    .map((value) => String(value || ""))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  if (!iso.length) return "";
  if (iso[0] === iso[iso.length - 1]) return iso[0];
  return `${iso[0]}/${iso[iso.length - 1]}`;
}

export function dataset({ name, description, url, dateModified, creators, temporalCoverage = "2000/2027" }) {
  return {
    "@type": "Dataset",
    name,
    description,
    url,
    creator: creators ?? [nhtsaOrg, epaOrg],
    temporalCoverage,
    license: "https://www.usa.gov/government-works",
    isAccessibleForFree: true,
    dateModified,
  };
}

export function recallListDataset({ name, description, path, dateModified, dates }) {
  return dataset({
    name,
    description,
    url: new URL(path, site.url).href,
    dateModified,
    creators: [nhtsaOrg],
    temporalCoverage: temporalCoverageFromDates(dates),
  });
}

export function webApp({ name, description, url }) {
  return {
    "@type": "WebApplication",
    name,
    description,
    url,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    isAccessibleForFree: true,
    author: siteOrg,
    publisher: publisherOrg,
  };
}

export function article({ headline, description, url, datePublished, dateModified }) {
  return {
    "@type": "Article",
    headline,
    description,
    url,
    datePublished,
    dateModified,
    author: siteOrg,
    publisher: publisherOrg,
  };
}

export function faqPage(faqs) {
  return {
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.a,
      },
    })),
  };
}
