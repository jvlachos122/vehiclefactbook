import assert from "node:assert/strict";
import test from "node:test";
import { hybridModelKeys, hybridPairsForModel, loadHybridPairs } from "../src/lib/hybrid-pairs.js";

test("every hybrid comparison is listed for each model it names", () => {
  const pairs = loadHybridPairs();
  assert.ok(pairs.length > 0);
  const slugs = new Set();
  for (const pair of pairs) {
    assert.equal(slugs.has(pair.slug), false);
    slugs.add(pair.slug);
    const keys = hybridModelKeys(pair);
    assert.ok(keys.length >= 1, pair.slug);
    for (const key of keys) {
      const [make, model] = key.split("/");
      const linked = hybridPairsForModel(make, model).map((item) => item.slug);
      assert.ok(linked.includes(pair.slug), `${pair.slug} missing on ${key}`);
    }
  }
});
