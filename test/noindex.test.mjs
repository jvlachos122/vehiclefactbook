import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadIndexableCampaigns } from "../src/lib/campaigns.js";
import { loadComponentPages } from "../src/lib/components.js";
import { loadSummary } from "../src/lib/catalog.js";
import { loadComplaintPages } from "../src/lib/make-complaints.js";
import {
  RECALL_PHRASE_WORDS,
  RECALL_UNIQUE_MIN,
  noindexFamilyCounts,
  noindexFollowPath,
  recallUniqueWords,
  repeatedPhrase,
  tokenizeWords,
  uniqueWordCounts,
} from "../src/lib/noindex.js";

const phrase = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

test("a seven-word passage on exactly 20 percent of pages is repeated text", () => {
  assert.equal(RECALL_PHRASE_WORDS, 7);
  assert.equal(RECALL_UNIQUE_MIN, 50);
  assert.equal(repeatedPhrase(2, 10), true);
  assert.equal(repeatedPhrase(1, 10), false);
  const docs = [[...phrase, "zebra"], [...phrase]];
  for (let index = 0; index < 8; index += 1) {
    docs.push(["only", "page", String(index), "words", "stay", "unshared", "here", "tail"]);
  }
  const counts = uniqueWordCounts(docs);
  assert.equal(counts[0], 1);
  assert.equal(counts[1], 0);
  assert.ok(counts[2] > 1);
});

test("a passage on fewer than 20 percent of pages stays in the unique count", () => {
  const docs = [[...phrase]];
  for (let index = 0; index < 9; index += 1) {
    docs.push(["solo", String(index), "aaaa", "bbbb", "cccc", "dddd", "eeee"]);
  }
  assert.equal(uniqueWordCounts(docs)[0], phrase.length);
});

test("a repeated function word inside a unique sentence still counts", () => {
  const docs = [];
  for (let index = 0; index < 10; index += 1) {
    docs.push(["the", "vehicle", "note", String(index), "aaaa", "bbbb", "cccc", "dddd"]);
  }
  const words = new Set(docs[0]);
  assert.equal(uniqueWordCounts(docs)[0], words.size);
  assert.equal(tokenizeWords("The Vehicle, note.").join(" "), "the vehicle note");
});

test("thin families are noindex, follow and the kept hubs are not", () => {
  const summary = loadSummary();
  const counts = noindexFamilyCounts();
  let years = 0;
  for (const make of summary.makes) {
    assert.equal(noindexFollowPath(`/${make.slug}/`), false, make.slug);
    for (const model of make.models) {
      assert.equal(noindexFollowPath(`/${make.slug}/${model.slug}/`), false);
      if (model.yearsPage) {
        years += 1;
        assert.equal(noindexFollowPath(`/${make.slug}/${model.slug}/years/`), true);
      }
      for (const year of model.years) {
        assert.equal(noindexFollowPath(`/${make.slug}/${model.slug}/${year.y}/`), false);
      }
    }
  }
  assert.equal(counts.component, loadComponentPages().length);
  assert.equal(counts.years, years);
  assert.equal(counts.makeComplaints, loadComplaintPages().length);
  assert.equal(counts.recallPages, loadIndexableCampaigns().length);
  assert.ok(counts.component > 5000);
  assert.ok(counts.years > 600);
  assert.equal(counts.makeComplaints, 52);
  const component = loadComponentPages()[0];
  assert.equal(noindexFollowPath(component.path), true);
  const complaints = loadComplaintPages()[0];
  assert.equal(noindexFollowPath(complaints.path), true);
  assert.equal(noindexFollowPath("/complaints/"), false);
  assert.equal(noindexFollowPath("/recalls/this-week/"), false);
  assert.equal(noindexFollowPath("/recalls/do-not-drive/"), false);
  assert.equal(noindexFollowPath("/tools/trip-fuel-cost/"), false);
  assert.equal(noindexFollowPath("/compare/hybrid/"), false);
  assert.equal(noindexFollowPath("/fuel-cost/"), false);

  let thin = 0;
  let kept = 0;
  for (const campaign of loadIndexableCampaigns()) {
    const path = `/recalls/${campaign.camp}/`;
    const words = recallUniqueWords(path);
    assert.equal(typeof words, "number", path);
    if (words < RECALL_UNIQUE_MIN) {
      thin += 1;
      assert.equal(noindexFollowPath(path), true, path);
    } else {
      kept += 1;
      assert.equal(noindexFollowPath(path), false, path);
    }
  }
  assert.equal(thin, counts.thinRecalls);
  assert.equal(kept, counts.recallPages - thin);
  assert.ok(thin > 0 && kept > 0);
  assert.equal(noindexFollowPath("/honda/accord/"), noindexFollowPath("/honda/accord"));
});

test("the fuel-cost hub links the trip tool and recall copy stays in the template", () => {
  const fuel = readFileSync(new URL("../src/pages/fuel-cost/index.astro", import.meta.url), "utf8");
  assert.match(fuel, /href="\/tools\/trip-fuel-cost\/"/);
  const recall = readFileSync(new URL("../src/pages/recalls/[campno].astro", import.meta.url), "utf8");
  assert.match(recall, /Campaign record/);
  assert.match(recall, /Model years on this site/);
  assert.match(recall, /FLAG_CAVEAT/);
  assert.doesNotMatch(recall, /noindex/);
  const base = readFileSync(new URL("../src/layouts/Base.astro", import.meta.url), "utf8");
  assert.match(base, /noindex, follow/);
});
