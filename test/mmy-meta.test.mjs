import assert from "node:assert/strict";
import test from "node:test";
import { mmyAnswer } from "../src/lib/answer.js";
import { findYear, loadMeta, loadModel, loadSummary } from "../src/lib/catalog.js";
import { formatDate, plural } from "../src/lib/format.js";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { MMY_DESCRIPTION_LIMIT, MMY_TITLE_LIMIT, mmyDocumentTitle, mmyMetaDescription } from "../src/lib/mmy-meta.js";
import { site } from "../src/lib/site.js";

const banned = /\b(avoid|reliable|unreliable|best|worst)\b/i;
const dates = { recalls: "2026-01-02", complaints: "2026-03-04", epa: "2026-05-06" };

test("title keeps the example facts and drops the site name when it does not fit", () => {
  const title = mmyDocumentTitle({
    year: 2017,
    make: "Honda",
    model: "Fit",
    row: { match: "exact", recalls: 2, complaints: 41, mpgMin: 36, mpgMax: 36 },
  });
  assert.equal(title, "2017 Honda Fit: 2 recalls, 41 complaints, 36 MPG combined");
  assert.ok(title.length <= MMY_TITLE_LIMIT);
  assert.equal(title.includes(site.name), false);
});

test("a short title keeps the site name when every fact fits", () => {
  const title = mmyDocumentTitle({
    year: 2012,
    make: "BMW",
    model: "M3",
    row: { match: "none", recalls: 0, complaints: 0, mpgMin: 16, mpgMax: 16 },
  });
  assert.equal(title, `2012 BMW M3: 16 MPG combined | ${site.name}`);
  assert.doesNotMatch(title, /\b0\b/);
});

test("a long title drops the site name, then fuel, then complaints", () => {
  const title = mmyDocumentTitle({
    year: 2012,
    make: "Azure Dynamics",
    model: "Transit Connect Electric Van/Wagon",
    row: { match: "exact", recalls: 2, complaints: 3, mpgMin: 20, mpgMax: 30 },
  });
  assert.equal(title, "2012 Azure Dynamics Transit Connect Electric Van/Wagon: 2 recalls");
  assert.equal(title.length, MMY_TITLE_LIMIT);
  assert.doesNotMatch(title, /MPG|complaint|VehicleFactbook/);
});

test("missing values are omitted and a listed zero is kept", () => {
  const missing = mmyDocumentTitle({
    year: 2003,
    make: "BMW",
    model: "M3",
    row: { match: "none", recalls: 0, complaints: 0, mpgMin: 0, mpgMax: 0, mpgeMin: 0, mpgeMax: 0, starMin: 0, starMax: 0 },
  });
  const missingDescription = mmyMetaDescription({
    year: 2003,
    make: "BMW",
    model: "M3",
    row: { match: "none", recalls: 0, complaints: 0, mpgMin: 0, mpgMax: 0, mpgeMin: 0, mpgeMax: 0, starMin: 0, starMax: 0 },
    dates,
  });
  assert.doesNotMatch(`${missing} ${missingDescription}`, /\b0\b/);
  assert.match(missingDescription, /different name/);
  assert.doesNotMatch(missingDescription, /mpg|MPGe|star/i);

  const listed = mmyDocumentTitle({
    year: 2017,
    make: "Honda",
    model: "Fit",
    row: { match: "exact", recalls: 0, complaints: 43, mpgMin: null, mpgMax: null },
  });
  assert.match(listed, /0 recalls, 43 complaints/);
  assert.doesNotMatch(listed, /MPG/);

  const pre2011 = mmyMetaDescription({
    year: 2008,
    make: "Honda",
    model: "Civic",
    row: { match: "exact", recalls: 2, complaints: 40, mpgMin: 25, mpgMax: 36, starMin: 5, starMax: 5 },
    dates,
  });
  assert.match(pre2011, /2 recalls/);
  assert.match(pre2011, /40 complaints received so far/);
  assert.match(pre2011, /Jan 2, 2026/);
  assert.match(pre2011, /Mar 4, 2026/);
  assert.match(pre2011, /May 6, 2026/);
  assert.doesNotMatch(pre2011, /\d stars?/);
  assert.ok(pre2011.length <= MMY_DESCRIPTION_LIMIT);
});

test("description keeps both file dates, stars, and fuel when they fit", () => {
  const description = mmyMetaDescription({
    year: 2017,
    make: "Honda",
    model: "Fit",
    row: { match: "exact", recalls: 0, complaints: 43, mpgMin: 32, mpgMax: 36, mpgeMin: null, mpgeMax: null, starMin: 5, starMax: 5 },
    dates,
  });
  assert.match(description, /0 recalls and 43 complaints received so far/);
  assert.match(description, /recalls Jan 2, 2026/);
  assert.match(description, /complaints Mar 4, 2026/);
  assert.match(description, /32–36 mpg combined/);
  assert.match(description, /5 stars/);
  const sameDate = mmyMetaDescription({
    year: 2017,
    make: "Honda",
    model: "Fit",
    row: { match: "exact", recalls: 0, complaints: 43, mpgMin: 32, mpgMax: 36, mpgeMin: null, mpgeMax: null, starMin: 5, starMax: 5 },
    dates: { recalls: "2026-03-04", complaints: "2026-03-04", epa: "2026-05-06" },
  });
  assert.match(sameDate, /NHTSA lists 0 recalls and 43 complaints received so far \(Mar 4, 2026\)/);
  assert.match(sameDate, /EPA rates it 32–36 mpg combined \(May 6, 2026\)/);
  assert.doesNotMatch(description, /\b(avoid|reliable|unreliable|best|worst)\b/i);
  assert.ok(description.length <= MMY_DESCRIPTION_LIMIT);

  const electric = mmyDocumentTitle({
    year: 2026,
    make: "Ford",
    model: "Mustang Mach-E",
    row: { match: "exact", recalls: 2, complaints: 1, mpgMin: null, mpgMax: null, mpgeMin: 84, mpgeMax: 110 },
  });
  assert.match(electric, /2 recalls, 1 complaint/);
  assert.doesNotMatch(electric, /\bMPG combined\b/);
});

test("a long unmatched name is not clipped and does not invent a zero", () => {
  const description = mmyMetaDescription({
    year: 2001,
    make: "Azure Dynamics",
    model: "Transit Connect Electric Van/Wagon",
    row: { match: "none", recalls: 0, complaints: 0, mpgMin: 12, mpgMax: 18, starMin: 5, starMax: 5 },
    dates: { recalls: "2026-10-26", complaints: "2026-11-03", epa: "2026-09-29" },
  });
  assert.ok(description.length <= MMY_DESCRIPTION_LIMIT);
  assert.equal(description.includes("…"), false);
  assert.match(description, /different name/);
  assert.match(description, /no NHTSA match yet/);
  assert.match(description, /12–18 mpg combined/);
  assert.doesNotMatch(description, /\b0 recalls?\b/);
  assert.doesNotMatch(description, /\b0 complaints?\b/);
});

test("every published model year title, description, and answer matches the files", () => {
  const summary = loadSummary();
  const metaDates = loadMeta().dates;
  const complaintDate = formatDate(metaDates.complaints);
  const recallDate = formatDate(metaDates.recalls);
  let pages = 0;
  for (const make of summary.makes) {
    for (const model of make.models) {
      const detail = loadModel(make.slug, model.slug);
      for (const row of model.years) {
        pages += 1;
        const title = mmyDocumentTitle({ year: row.y, make: make.name, model: model.name, row });
        const description = mmyMetaDescription({
          year: row.y,
          make: make.name,
          model: model.name,
          row,
          dates: metaDates,
        });
        const yearDetail = detail.years[String(row.y)];
        const answer = mmyAnswer({
          make: make.name,
          model: model.name,
          year: row.y,
          row,
          detail: yearDetail,
          dates: metaDates,
        });
        assert.ok(title.startsWith(`${row.y} ${make.name} ${model.name}`), title);
        assert.ok(title.length <= MMY_TITLE_LIMIT, title);
        assert.ok(description.length >= 40 && description.length <= MMY_DESCRIPTION_LIMIT, description);
        assert.equal(title.includes("…") || description.includes("…"), false, `${title} ${description}`);
        assert.doesNotMatch(title, banned);
        assert.doesNotMatch(description, banned);
        assert.doesNotMatch(answer, banned);
        const sentences = sentenceCount(answer);
        assert.ok(sentences >= 1 && sentences <= 3, answer);
        const fuelText = `${title} ${description}`;
        if (row.mpgMin > 0 || row.mpgeMin > 0) {
          assert.match(fuelText, /mpg combined|MPGe combined/i, fuelText);
        } else {
          assert.doesNotMatch(fuelText, /\b0 (?:mpg|MPG|MPGe)\b/);
        }
        if (row.y < 2011) {
          assert.match(answer, /pre-2011 rating, not comparable/);
          assert.doesNotMatch(description, /\d stars?/);
        } else if (row.starMin != null && row.starMax != null) {
          const stars = row.starMin === row.starMax ? `${row.starMin} star` : `${row.starMin}–${row.starMax} stars`;
          assert.ok(description.includes(stars), description);
        } else {
          assert.doesNotMatch(description, /\d stars?/);
        }
        if (row.match === "none") {
          assert.match(description, /different name/);
          assert.match(answer, /do not have a make and model name matched/);
          assert.match(answer, /different name/);
          assert.doesNotMatch(`${title} ${description} ${answer}`, /\b0 recalls?\b/);
          assert.doesNotMatch(`${title} ${description} ${answer}`, /\b0 complaints?\b/);
        } else {
          assert.ok(description.includes(plural(row.recalls, "recall")), description);
          assert.ok(description.includes(plural(row.complaints, "complaint")), description);
          assert.match(description, /received so far/);
          assert.ok(answer.includes(plural(row.recalls, "recall campaign")), answer);
          assert.match(answer, /complaints? received so far/);
          assert.match(answer, /more complaints can mean more cars sold/);
          assert.ok(answer.includes(complaintDate), answer);
          assert.ok(answer.includes(recallDate), answer);
        }
        assert.ok(description.includes(complaintDate) || description.includes(recallDate), description);
      }
    }
  }
  assert.ok(pages > 8000);
});

test("sample model years use the committed counts", () => {
  const metaDates = loadMeta().dates;
  for (const [makeSlug, modelSlug, year] of [
    ["honda", "fit", 2017],
    ["ford", "mustang-mach-e", 2026],
    ["maybach", "57", 2012],
  ]) {
    const { make, model, row } = findYear(makeSlug, modelSlug, year);
    const detail = loadModel(makeSlug, modelSlug).years[String(year)];
    const title = mmyDocumentTitle({ year, make: make.name, model: model.name, row });
    const description = mmyMetaDescription({ year, make: make.name, model: model.name, row, dates: metaDates });
    const answer = mmyAnswer({ make: make.name, model: model.name, year, row, detail, dates: metaDates });
    assert.ok(title.length <= MMY_TITLE_LIMIT, title);
    assert.ok(description.length <= MMY_DESCRIPTION_LIMIT, description);
    assert.ok(sentenceCount(answer) <= 3, answer);
    if (row.match === "none") {
      assert.match(answer, /different name/);
      assert.doesNotMatch(`${title} ${description}`, /\b0 recalls?\b/);
    } else {
      assert.ok(description.includes(plural(row.recalls, "recall")), description);
      assert.ok(description.includes(plural(row.complaints, "complaint")), description);
      assert.ok(answer.includes(plural(row.complaints, "complaint")), answer);
      assert.ok(answer.includes(formatDate(metaDates.complaints)), answer);
      if (row.mpgMin != null && row.mpgMax != null) {
        assert.ok(answer.includes(String(row.mpgMin)), answer);
        assert.ok(answer.includes(String(row.mpgMax)), answer);
      } else if (row.mpgeMin != null) {
        assert.match(answer, /MPGe combined/);
        assert.doesNotMatch(answer, /mpg combined/);
      }
      if (row.starMin != null && year >= 2011) {
        assert.ok(description.includes(String(row.starMin)), description);
      }
    }
  }
});
