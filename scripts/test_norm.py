#!/usr/bin/env python3
"""Normalization and matching rules. No source files required."""

import unittest

from lib_norm import assign_year, norm_make, norm_model, slug


class NormTests(unittest.TestCase):
    def test_make_aliases(self):
        self.assertEqual(norm_make("Mercedes-Benz"), "MERCEDES")
        self.assertEqual(norm_make("MERCEDES BENZ"), "MERCEDES")
        self.assertEqual(norm_make("Honda"), "HONDA")
        self.assertEqual(norm_make("Alfa Romeo"), "ALFA ROMEO")

    def test_model_punctuation(self):
        self.assertEqual(norm_model("F-150"), "F150")
        self.assertEqual(norm_model("CR-V"), "CRV")
        self.assertEqual(norm_model("C-Class"), "CCLASS")
        self.assertEqual(norm_model("3 Series"), "3SERIES")

    def test_slugs(self):
        self.assertEqual(slug("CR-V"), "cr-v")
        self.assertEqual(slug("F-150 Lightning"), "f-150-lightning")
        self.assertEqual(slug("MINI"), "mini")
        self.assertEqual(slug("bZ4X"), "bz4x")

    def test_exact_beats_prime_suffix(self):
        epa = [("rav4", "RAV4"), ("prime", "RAV4PRIME")]
        assigned, methods, _unused = assign_year("TOYOTA", epa, {"RAV4", "RAV4PRIME", "RAV4HYBRID"}, {})
        self.assertEqual(assigned["prime"], ["RAV4PRIME"])
        self.assertIn("RAV4HYBRID", assigned["rav4"])
        self.assertIn("RAV4", assigned["rav4"])
        self.assertEqual(methods["prime"], "exact")

    def test_class_stem_does_not_swallow_longer_class(self):
        epa = [("c", "CCLASS"), ("cl", "CLCLASS"), ("cla", "CLACLASS")]
        names = {"C300", "CL500", "CLA250", "AMGC43"}
        assigned, methods, unused = assign_year("MERCEDES", epa, names, {})
        self.assertIn("C300", assigned["c"])
        self.assertIn("AMGC43", assigned["c"])
        self.assertEqual(assigned["cl"], ["CL500"])
        self.assertEqual(assigned["cla"], ["CLA250"])
        self.assertEqual(unused, set())
        self.assertEqual(methods["c"], "class")

    def test_series_and_exact(self):
        epa = [("three", "3SERIES"), ("x3", "X3")]
        assigned, methods, unused = assign_year("BMW", epa, {"3SERIES", "328I", "X3", "X5"}, {})
        self.assertEqual(set(assigned["three"]), {"3SERIES", "328I"})
        self.assertEqual(assigned["x3"], ["X3"])
        self.assertEqual(unused, {"X5"})
        self.assertEqual(methods["three"], "exact")

    def test_mazda_digit_and_manual(self):
        epa = [("three", "3")]
        assigned, _methods, unused = assign_year("MAZDA", epa, {"MAZDA3", "CX5"}, {})
        self.assertEqual(assigned["three"], ["MAZDA3"])
        self.assertEqual(unused, {"CX5"})

    def test_ambiguous_tie_is_not_assigned(self):
        epa = [("a", "AAAA"), ("b", "BBBB")]
        # Neither exact-matches ZZZZAAAA, both would only tie if ranks and lengths match.
        # A manual tie of equal rank and equal length is skipped.
        manual = {"AAAA": {"SHARED"}, "BBBB": {"SHARED"}}
        _assigned, _methods, unused = assign_year("FORD", epa, {"SHARED"}, manual)
        self.assertEqual(unused, {"SHARED"})

    def test_lightning_stays_off_f150(self):
        epa = [("f150", "F150"), ("ev", "F150LIGHTNING")]
        assigned, _methods, unused = assign_year("FORD", epa, {"F150", "F150LIGHTNINGBEV"}, {})
        self.assertEqual(assigned["f150"], ["F150"])
        self.assertEqual(assigned["ev"], ["F150LIGHTNINGBEV"])
        self.assertEqual(unused, set())


if __name__ == "__main__":
    unittest.main()
