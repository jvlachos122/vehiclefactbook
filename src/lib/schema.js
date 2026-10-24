export function dataset({ name, description, url, dateModified }) {
  return {
    "@type": "Dataset",
    name,
    description,
    url,
    creator: [
      {
        "@type": "Organization",
        name: "National Highway Traffic Safety Administration",
        url: "https://www.nhtsa.gov/",
      },
      {
        "@type": "Organization",
        name: "U.S. Environmental Protection Agency",
        url: "https://www.epa.gov/",
      },
    ],
    temporalCoverage: "2000/2027",
    license: "https://www.usa.gov/government-works",
    isAccessibleForFree: true,
    dateModified,
  };
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
    author: {
      "@type": "Organization",
      name: "VehicleFactbook",
    },
    publisher: {
      "@type": "Organization",
      name: "Three Pines Company LLC",
    },
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
