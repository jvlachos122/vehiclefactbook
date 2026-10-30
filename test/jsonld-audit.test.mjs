import assert from "node:assert/strict";
import test from "node:test";
import { auditHtml, classifyPage, sentenceCount } from "../src/lib/jsonld-audit.js";
import {
  article,
  dataset,
  faqPage,
  recallListDataset,
  temporalCoverageFromDates,
  webApp,
} from "../src/lib/schema.js";

const answer = `<h1>Title</h1><div class="answer"><p>NHTSA lists 2 recalls for this page in the file dated Oct 26, 2026.</p></div>`;

function crumb() {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://vehiclefactbook.com/" },
    ],
  };
}

function page(main, graph) {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><script type="application/ld+json">${json}</script></head><body><main id="main">${main}</main></body></html>`;
}

test("temporal coverage uses the file dates", () => {
  assert.equal(temporalCoverageFromDates(["2026-10-19", "2012-07-18"]), "2012-07-18/2026-10-19");
  assert.equal(temporalCoverageFromDates(["2026-10-15"]), "2026-10-15");
  assert.equal(temporalCoverageFromDates([]), "");
});

test("web application names the publisher and author", () => {
  const app = webApp({
    name: "Fuel cost calculator",
    description: "Annual fuel cost from an EPA row.",
    url: "https://vehiclefactbook.com/tools/fuel-cost-calculator/",
  });
  assert.equal(app.publisher["@type"], "Organization");
  assert.equal(app.publisher.name, "Three Pines Company LLC");
  assert.equal(app.author["@type"], "Organization");
  assert.equal(app.author.name, "VehicleFactbook");
  assert.equal(JSON.stringify(app).includes("GovernmentOrganization"), false);
  assert.equal(JSON.stringify(dataset({
    name: "Honda",
    description: "Honda records.",
    url: "https://vehiclefactbook.com/honda/",
    dateModified: "2026-10-25",
  })).includes("GovernmentOrganization"), false);
});

test("page kinds cover every template", () => {
  assert.equal(classifyPage("/index.html"), "home");
  assert.equal(classifyPage("/404.html"), "404");
  assert.equal(classifyPage("/about/index.html"), "static");
  assert.equal(classifyPage("/methodology/index.html"), "methodology");
  assert.equal(classifyPage("/guides/index.html"), "guides-index");
  assert.equal(classifyPage("/guides/what-is-a-tsb/index.html"), "guide");
  assert.equal(classifyPage("/tools/mpg-calculator/index.html"), "tool");
  assert.equal(classifyPage("/compare/index.html"), "tool");
  assert.equal(classifyPage("/recalls/lookup/index.html"), "tool");
  assert.equal(classifyPage("/recalls/do-not-drive/index.html"), "advisory");
  assert.equal(classifyPage("/honda/index.html"), "make");
  assert.equal(classifyPage("/honda/fit/index.html"), "model");
  assert.equal(classifyPage("/honda/fit/years/index.html"), "years");
  assert.equal(classifyPage("/honda/fit/2017/index.html"), "mmy");
});

test("representative pages pass the JSON-LD rules", () => {
  const cases = [
    ["/index.html", [crumb()]],
    ["/about/index.html", [crumb()]],
    ["/404.html", [crumb()]],
    ["/guides/index.html", [crumb()]],
    [
      "/honda/index.html",
      [
        crumb(),
        dataset({
          name: "Honda recalls, complaints, and fuel economy",
          description: "NHTSA and EPA records for Honda.",
          url: "https://vehiclefactbook.com/honda/",
          dateModified: "2026-10-25",
        }),
      ],
    ],
    [
      "/honda/fit/2017/index.html",
      [
        crumb(),
        dataset({
          name: "2017 Honda Fit",
          description: "NHTSA and EPA records for the 2017 Honda Fit.",
          url: "https://vehiclefactbook.com/honda/fit/2017/",
          dateModified: "2026-10-25",
        }),
      ],
    ],
    [
      "/methodology/index.html",
      [
        crumb(),
        dataset({
          name: "Methodology",
          description: "How the files are counted.",
          url: "https://vehiclefactbook.com/methodology/",
          dateModified: "2026-10-25",
        }),
      ],
    ],
    [
      "/tools/fuel-cost-calculator/index.html",
      [
        crumb(),
        webApp({
          name: "Fuel cost calculator",
          description: "Annual fuel cost from an EPA row.",
          url: "https://vehiclefactbook.com/tools/fuel-cost-calculator/",
        }),
      ],
    ],
    [
      "/recalls/takata-airbag/index.html",
      [
        crumb(),
        recallListDataset({
          name: "NHTSA Takata-wording vehicle campaigns",
          description: "Vehicle campaigns whose text contains Takata.",
          path: "/recalls/takata-airbag/",
          dateModified: "2026-10-26",
          dates: ["1995-05-24", "2025-10-31"],
        }),
      ],
    ],
  ];
  for (const [rel, graph] of cases) {
    const result = auditHtml(page(answer, graph), rel);
    assert.deepEqual(result.errors, [], rel);
  }
});

test("guide FAQ text must be visible", () => {
  const faqs = [{ q: "What is a TSB?", a: "A TSB is a technical service bulletin, not a recall." }];
  const main = `<h1>What is a TSB?</h1><div class="answer"><p>A TSB is a manufacturer communication and not a recall on this site.</p></div><h2>Questions</h2><h3>${faqs[0].q}</h3><p>${faqs[0].a}</p>`;
  const graph = [
    crumb(),
    article({
      headline: "What is a TSB",
      description: "A TSB is not a recall.",
      url: "https://vehiclefactbook.com/guides/what-is-a-tsb/",
      datePublished: "2026-10-24",
      dateModified: "2026-10-24",
    }),
    faqPage(faqs),
  ];
  assert.deepEqual(auditHtml(page(main, graph), "/guides/what-is-a-tsb/index.html").errors, []);
  const hidden = page(main, [
    crumb(),
    article({
      headline: "What is a TSB",
      description: "A TSB is not a recall.",
      url: "https://vehiclefactbook.com/guides/what-is-a-tsb/",
      datePublished: "2026-10-24",
      dateModified: "2026-10-24",
    }),
    faqPage([{ q: "What is a TSB?", a: "This sentence is not on the page." }]),
  ]);
  assert.ok(auditHtml(hidden, "/guides/what-is-a-tsb/index.html").errors.includes("FAQPage question is not visible on the page"));
});

test("audit rejects missing structure and forbidden types", () => {
  const home = auditHtml(page("<h1>Title</h1><p>There is no answer box on this page.</p>", [crumb()]), "/index.html");
  assert.ok(home.errors.includes("missing answer box"));

  const late = auditHtml(
    page(`<h1>Title</h1><h2>Later</h2><div class="answer"><p>NHTSA lists 2 recalls for this page in the file dated Oct 26, 2026.</p></div>`, [crumb()]),
    "/index.html",
  );
  assert.ok(late.errors.includes("answer box is below the first section"));

  const ranked = auditHtml(
    page(`<h1>Title</h1><div class="answer"><p>This is the best car in the file dated Oct 26, 2026.</p></div>`, [crumb()]),
    "/index.html",
  );
  assert.ok(ranked.errors.includes("answer box uses a ranking word"));

  const broken = `<!DOCTYPE html><html lang="en"><body><main id="main">${answer}</main><script type="application/ld+json">{not json}</script></body></html>`;
  assert.ok(auditHtml(broken, "/index.html").errors.some((error) => error.startsWith("invalid JSON-LD")));

  const product = auditHtml(page(answer, [crumb(), { "@type": "Product", name: "Civic" }]), "/index.html");
  assert.ok(product.errors.includes("forbidden type Product"));

  const offer = auditHtml(page(answer, [crumb(), { "@type": "Offer", price: "1" }]), "/index.html");
  assert.ok(offer.errors.includes("forbidden type Offer"));

  const government = auditHtml(
    page(answer, [crumb(), { "@type": "Dataset", creator: { "@type": "GovernmentOrganization", name: "NHTSA" } }]),
    "/honda/index.html",
  );
  assert.ok(government.errors.includes("forbidden type GovernmentOrganization"));

  const bareTool = auditHtml(
    page(answer, [crumb(), { "@type": "WebApplication", name: "Compare", url: "https://vehiclefactbook.com/compare/" }]),
    "/compare/index.html",
  );
  assert.ok(bareTool.errors.includes("WebApplication publisher is not Three Pines Company LLC"));

  const epaOnRecall = auditHtml(
    page(answer, [
      crumb(),
      dataset({
        name: "Do not drive",
        description: "Recall flags.",
        url: "https://vehiclefactbook.com/recalls/do-not-drive/",
        dateModified: "2026-10-26",
      }),
    ]),
    "/recalls/do-not-drive/index.html",
  );
  assert.ok(epaOnRecall.errors.includes("recall Dataset must not list EPA as creator"));

  const noDataset = auditHtml(page(answer, [crumb()]), "/honda/fit/years/index.html");
  assert.ok(noDataset.errors.includes("page missing Dataset"));

  const noGuide = auditHtml(page(answer, [crumb()]), "/guides/do-recalls-expire/index.html");
  assert.ok(noGuide.errors.includes("guide page missing Article"));
});

test("answer boxes stay within three sentences", () => {
  assert.equal(sentenceCount("One fact. Two facts. Three facts."), 3);
  assert.equal(sentenceCount("Operated by Three Pines Company LLC. The next sentence stays."), 2);
  assert.equal(sentenceCount("The U.S. file dated Oct 26, 2026 lists two recalls."), 1);
  assert.equal(sentenceCount("NHTSA lists 2 recalls for the 2025 Volkswagen ID. Buzz (file dated Oct 26, 2026)."), 1);
  const long = auditHtml(
    page(
      `<h1>Title</h1><div class="answer"><p>One fact here. Two facts here. Three facts here. Four facts here.</p></div>`,
      [crumb()],
    ),
    "/index.html",
  );
  assert.ok(long.errors.includes("answer box has 4 sentences"));
});

test("ordinary words in an answer are not treated as schema types", () => {
  const main = `<h1>Title</h1><div class="answer"><p>This page does not publish an offer, a review, or a product, and it does not score reliability.</p></div>`;
  const result = auditHtml(page(main, [crumb()]), "/privacy/index.html");
  assert.deepEqual(result.errors, []);
});
