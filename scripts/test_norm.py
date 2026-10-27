#!/usr/bin/env python3
"""Normalization and matching rules. No source files required."""

import unittest
from pathlib import Path

from lib_norm import assign_year, load_manual, norm_make, norm_model, slug

CROSSWALK = Path(__file__).resolve().parents[1] / "data" / "model-crosswalk.csv"


def manual_for(make: str) -> dict[str, set[str]]:
    loaded = load_manual(CROSSWALK)
    want = norm_make(make)
    out = {}
    for (make_norm, model_norm), names in loaded.items():
        if make_norm == want:
            out.setdefault(model_norm, set()).update(names)
    return out


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


class CrosswalkTests(unittest.TestCase):
    def names(self, assigned, model_id):
        return set(assigned.get(model_id, []))

    def test_known_pickup_and_body_suffixes(self):
        assigned, _methods, unused = assign_year(
            "DODGE",
            [("ram", "RAM1500PICKUP", "Ram 1500 Pickup"), ("van", "RAMVAN1500", "Ram Van 1500")],
            {"RAM1500", "RAM2500", "RAM3500", "RAMVAN", "RAM"},
            {},
        )
        self.assertEqual(self.names(assigned, "ram"), {"RAM1500"})
        self.assertEqual(self.names(assigned, "van"), {"RAMVAN"})
        self.assertEqual(unused, {"RAM2500", "RAM3500", "RAM"})

        assigned, _methods, unused = assign_year(
            "DODGE",
            [("a", "RAMVAN1500", "Ram Van 1500"), ("b", "RAMVAN2500", "Ram Van 2500")],
            {"RAMVAN", "RAM1500"},
            {},
        )
        self.assertNotIn("RAMVAN", self.names(assigned, "a") | self.names(assigned, "b"))
        self.assertIn("RAMVAN", unused)
        self.assertIn("RAM1500", unused)

        assigned, _methods, unused = assign_year(
            "DODGE",
            [("dak", "DAKOTAPICKUP", "Dakota Pickup")],
            {"DAKOTA", "DURANGO"},
            {},
        )
        self.assertEqual(self.names(assigned, "dak"), {"DAKOTA"})
        self.assertEqual(unused, {"DURANGO"})

        assigned, _methods, unused = assign_year(
            "CHEVROLET",
            [("s10", "S10PICKUP", "S10 Pickup"), ("ssr", "SSRPICKUP", "SSR Pickup")],
            {"S10", "SSR", "SILVERADO"},
            {},
        )
        self.assertEqual(self.names(assigned, "s10"), {"S10"})
        self.assertEqual(self.names(assigned, "ssr"), {"SSR"})
        self.assertEqual(unused, {"SILVERADO"})

    def test_cargo_and_passenger_do_not_share_a_generic_name(self):
        assigned, _methods, unused = assign_year(
            "CHEVROLET",
            [
                ("cargo", "EXPRESSCARGO", "Express Cargo"),
                ("pass", "EXPRESSPASSENGER", "Express Passenger"),
            ],
            {"EXPRESS", "EXPRESS1500", "EXPRESS2500"},
            {},
        )
        self.assertEqual(assigned, {})
        self.assertEqual(unused, {"EXPRESS", "EXPRESS1500", "EXPRESS2500"})

        assigned, _methods, unused = assign_year(
            "MERCEDES",
            [("c", "METRISCARGO", "Metris Cargo"), ("p", "METRISPASSENGER", "Metris Passenger")],
            {"METRIS"},
            {},
        )
        self.assertEqual(assigned, {})
        self.assertEqual(unused, {"METRIS"})

    def test_coupe_and_spider_tie_when_both_exist(self):
        assigned, _methods, unused = assign_year(
            "MCLAREN",
            [("coupe", "570SCOUPE", "570S Coupe")],
            {"570S", "720S"},
            {},
        )
        self.assertEqual(self.names(assigned, "coupe"), {"570S"})
        self.assertEqual(unused, {"720S"})

        assigned, _methods, unused = assign_year(
            "MCLAREN",
            [("coupe", "570SCOUPE", "570S Coupe"), ("spider", "570SSPIDER", "570S Spider")],
            {"570S", "570SSPIDER"},
            {},
        )
        self.assertNotIn("570S", self.names(assigned, "coupe") | self.names(assigned, "spider"))
        self.assertIn("570S", unused)
        self.assertEqual(self.names(assigned, "spider"), {"570SSPIDER"})

    def test_slash_parts_and_the_models_they_must_not_absorb(self):
        assigned, _methods, unused = assign_year(
            "VOLKSWAGEN",
            [
                ("golf", "GOLFGTI", "Golf/GTI"),
                ("jetta", "JETTA", "Jetta"),
                ("rabbit", "RABBIT", "Rabbit"),
                ("r32", "R32", "R32"),
            ],
            {"GOLF", "GTI", "GOLFR", "GOLFSPORTWAGEN", "JETTA", "RABBIT", "R32"},
            manual_for("Volkswagen"),
        )
        self.assertEqual(
            self.names(assigned, "golf"),
            {"GOLF", "GTI", "GOLFR", "GOLFSPORTWAGEN"},
        )
        self.assertEqual(self.names(assigned, "jetta"), {"JETTA"})
        self.assertEqual(self.names(assigned, "rabbit"), {"RABBIT"})
        self.assertEqual(self.names(assigned, "r32"), {"R32"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "SUBARU",
            [("combo", "IMPREZAOUTBACKSPORT", "Impreza/Outback Sport")],
            {"IMPREZA", "OUTBACK", "OUTBACKSPORT", "IMPREZAWRX"},
            {},
        )
        self.assertEqual(self.names(assigned, "combo"), {"IMPREZA", "OUTBACKSPORT"})
        self.assertEqual(unused, {"OUTBACK", "IMPREZAWRX"})

        assigned, _methods, unused = assign_year(
            "SUBARU",
            [
                ("combo", "LEGACYOUTBACK", "Legacy/Outback"),
                ("outback", "OUTBACK", "Outback"),
                ("legacy", "LEGACY", "Legacy"),
            ],
            {"LEGACY", "OUTBACK"},
            {},
        )
        self.assertEqual(self.names(assigned, "legacy"), {"LEGACY"})
        self.assertEqual(self.names(assigned, "outback"), {"OUTBACK"})
        self.assertNotIn("combo", assigned)

        assigned, _methods, unused = assign_year(
            "JEEP",
            [("lib", "LIBERTYCHEROKEE", "Liberty/Cherokee"), ("grand", "GRANDCHEROKEE", "Grand Cherokee")],
            {"LIBERTY", "CHEROKEE", "GRANDCHEROKEE"},
            {},
        )
        self.assertEqual(self.names(assigned, "lib"), {"LIBERTY", "CHEROKEE"})
        self.assertEqual(self.names(assigned, "grand"), {"GRANDCHEROKEE"})

        assigned, _methods, _unused = assign_year(
            "JEEP",
            [("cherokee", "CHEROKEE", "Cherokee"), ("lib", "LIBERTYCHEROKEE", "Liberty/Cherokee")],
            {"CHEROKEE", "LIBERTY"},
            {},
        )
        self.assertEqual(self.names(assigned, "cherokee"), {"CHEROKEE"})
        self.assertEqual(self.names(assigned, "lib"), {"LIBERTY"})

    def test_prefix_collisions_stay_apart(self):
        assigned, _methods, unused = assign_year(
            "MAZDA",
            [("cx5", "CX5", "CX-5"), ("cx50", "CX50", "CX-50")],
            {"CX5", "CX50", "CX5TURBO"},
            {},
        )
        self.assertEqual(self.names(assigned, "cx5"), {"CX5", "CX5TURBO"})
        self.assertEqual(self.names(assigned, "cx50"), {"CX50"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "INFINITI",
            [("q5", "Q5", "Q5"), ("q50", "Q50", "Q50")],
            {"Q5", "Q50"},
            {},
        )
        self.assertEqual(self.names(assigned, "q5"), {"Q5"})
        self.assertEqual(self.names(assigned, "q50"), {"Q50"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "FORD",
            [("f150", "F150", "F150"), ("ev", "F150LIGHTNING", "F-150 Lightning")],
            {"F150", "F250", "F350", "F150LIGHTNING"},
            {},
        )
        self.assertEqual(self.names(assigned, "f150"), {"F150"})
        self.assertEqual(self.names(assigned, "ev"), {"F150LIGHTNING"})
        self.assertEqual(unused, {"F250", "F350"})

        assigned, _methods, unused = assign_year(
            "FIAT",
            [("base", "500", "500"), ("ev", "500E", "500e"), ("ell", "500L", "500 L")],
            {"500", "500E", "500L"},
            {},
        )
        self.assertEqual(self.names(assigned, "base"), {"500"})
        self.assertEqual(self.names(assigned, "ev"), {"500E"})
        self.assertEqual(self.names(assigned, "ell"), {"500L"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "BMW",
            [("m", "M", "M"), ("m3", "M3", "M3"), ("m4", "M4", "M4"), ("x5", "X5", "X5")],
            {"M3", "M4", "M5", "X5"},
            {},
        )
        self.assertNotIn("m", assigned)
        self.assertEqual(self.names(assigned, "m3"), {"M3"})
        self.assertEqual(self.names(assigned, "m4"), {"M4"})
        self.assertEqual(self.names(assigned, "x5"), {"X5"})
        self.assertEqual(unused, {"M5"})

    def test_make_prefix_is_exact_concatenation(self):
        assigned, _methods, unused = assign_year(
            "MAZDA",
            [("three", "3", "3"), ("speed", "SPEED3", "Speed 3")],
            {"MAZDA3", "MAZDASPEED3", "CX30"},
            {},
        )
        self.assertEqual(self.names(assigned, "three"), {"MAZDA3"})
        self.assertEqual(self.names(assigned, "speed"), {"MAZDASPEED3"})
        self.assertEqual(unused, {"CX30"})

        assigned, _methods, unused = assign_year(
            "POLESTAR",
            [("two", "2", "2"), ("three", "3", "3")],
            {"POLESTAR2", "POLESTAR3"},
            {},
        )
        self.assertEqual(self.names(assigned, "two"), {"POLESTAR2"})
        self.assertEqual(self.names(assigned, "three"), {"POLESTAR3"})
        self.assertEqual(unused, set())

    def test_reviewed_rows_override_a_weaker_prefix(self):
        assigned, _methods, unused = assign_year(
            "LAND ROVER",
            [("rr", "RANGEROVER", "Range Rover"), ("ev", "EVOQUE", "Evoque")],
            {"RANGEROVER", "RANGEROVEREVOQUE", "RANGEROVERSPORT"},
            manual_for("Land Rover"),
        )
        self.assertEqual(self.names(assigned, "ev"), {"RANGEROVEREVOQUE"})
        self.assertEqual(self.names(assigned, "rr"), {"RANGEROVER", "RANGEROVERSPORT"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "MINI",
            [
                ("cooper", "COOPER", "Cooper"),
                ("country", "COUNTRYMAN", "Countryman"),
                ("jcw", "JOHNCOOPERWORKS", "John Cooper Works"),
                ("roadster", "ROADSTER", "Roadster"),
                ("club", "CLUBMAN", "Clubman"),
            ],
            {
                "COOPER",
                "COOPERS",
                "COOPERCOUNTRYMAN",
                "COOPERSCOUNTRYMAN",
                "JCW",
                "JCWCLUBMAN",
                "JCWCOUNTRYMANALL4",
                "COOPERROADSTER",
                "COOPERCLUBMAN",
            },
            manual_for("MINI"),
        )
        self.assertIn("COOPER", self.names(assigned, "cooper"))
        self.assertIn("COOPERS", self.names(assigned, "cooper"))
        self.assertNotIn("COOPERCOUNTRYMAN", self.names(assigned, "cooper"))
        self.assertEqual(
            self.names(assigned, "country"),
            {"COOPERCOUNTRYMAN", "COOPERSCOUNTRYMAN", "JCWCOUNTRYMANALL4"},
        )
        self.assertEqual(self.names(assigned, "jcw"), {"JCW"})
        self.assertEqual(self.names(assigned, "roadster"), {"COOPERROADSTER"})
        self.assertTrue(self.names(assigned, "club") >= {"JCWCLUBMAN", "COOPERCLUBMAN"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "HUMMER",
            [("h3", "H3", "H3"), ("h3t", "H3T", "H3T")],
            {"H3", "H3SUT"},
            manual_for("Hummer"),
        )
        self.assertEqual(self.names(assigned, "h3"), {"H3"})
        self.assertEqual(self.names(assigned, "h3t"), {"H3SUT"})
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "PORSCHE",
            [("box", "BOXSTER", "Boxster"), ("cay", "CAYMAN", "Cayman"), ("gen", "718", "718")],
            {"718BOXSTER", "718CAYMAN", "718", "CAYENNE"},
            manual_for("Porsche"),
        )
        self.assertEqual(self.names(assigned, "box"), {"718BOXSTER"})
        self.assertEqual(self.names(assigned, "cay"), {"718CAYMAN"})
        self.assertEqual(self.names(assigned, "gen"), {"718"})
        self.assertEqual(unused, {"CAYENNE"})

    def test_db7_overlap_is_left_unmatched(self):
        assigned, _methods, unused = assign_year(
            "ASTON MARTIN",
            [("gt", "DB7GT", "DB-7 GT"), ("van", "DB7VANTAGE", "DB-7 Vantage")],
            {"DB7", "VANTAGE"},
            manual_for("Aston Martin"),
        )
        self.assertNotIn("DB7", self.names(assigned, "gt") | self.names(assigned, "van"))
        self.assertIn("DB7", unused)
        self.assertIn("VANTAGE", unused)

        assigned, _methods, unused = assign_year(
            "ASTON MARTIN",
            [("van", "DB7VANTAGE", "DB-7 Vantage")],
            {"DB7", "VANTAGE"},
            manual_for("Aston Martin"),
        )
        self.assertEqual(self.names(assigned, "van"), {"DB7"})
        self.assertEqual(unused, {"VANTAGE"})

    def test_trim_does_not_steal_the_base_model(self):
        assigned, _methods, unused = assign_year(
            "CHRYSLER",
            [("base", "300", "300"), ("srt", "300SRT8", "300 SRT8")],
            {"300", "300C"},
            {},
        )
        self.assertEqual(self.names(assigned, "base"), {"300", "300C"})
        self.assertNotIn("srt", assigned)
        self.assertEqual(unused, set())

        assigned, _methods, unused = assign_year(
            "ASTON MARTIN",
            [("v8", "DBXV8", "DBX V8"), ("s", "DBX707", "DBX 707")],
            {"DBX", "DBX707"},
            {},
        )
        self.assertNotIn("v8", assigned)
        self.assertEqual(self.names(assigned, "s"), {"DBX707"})
        self.assertEqual(unused, {"DBX"})

        assigned, _methods, unused = assign_year(
            "ASTON MARTIN",
            [("v8", "DBXV8", "DBX V8")],
            {"DBX", "DBX707"},
            {},
        )
        self.assertEqual(self.names(assigned, "v8"), {"DBX"})
        self.assertEqual(unused, {"DBX707"})

        assigned, _methods, unused = assign_year(
            "FERRARI",
            [("spider", "458SPIDER", "458 Spider"), ("italia", "458ITALIA", "458 Italia")],
            {"458", "458SPIDER", "458ITALIA"},
            {},
        )
        self.assertEqual(self.names(assigned, "spider"), {"458SPIDER"})
        self.assertEqual(self.names(assigned, "italia"), {"458ITALIA"})
        self.assertEqual(unused, {"458"})

        assigned, _methods, unused = assign_year(
            "CHEVROLET",
            [("van", "VAN15002500", "Van 1500/2500"), ("silverado", "SILVERADO", "Silverado")],
            {"2500", "SILVERADO1500"},
            {},
        )
        self.assertNotIn("van", assigned)
        self.assertIn("2500", unused)

        assigned, _methods, unused = assign_year(
            "ALFA ROMEO",
            [("base", "TONALE", "Tonale"), ("awd", "TONALEEAWD", "Tonale eAWD")],
            {"TONALE", "TONALEPHEV"},
            manual_for("Alfa Romeo"),
        )
        self.assertEqual(self.names(assigned, "base"), {"TONALE"})
        self.assertEqual(self.names(assigned, "awd"), {"TONALEPHEV"})
        self.assertEqual(unused, set())

    def test_gr_supra_and_same_name_siblings(self):
        assigned, _methods, unused = assign_year(
            "TOYOTA",
            [("supra", "GRSUPRA", "GR Supra"), ("camry", "CAMRY", "Camry")],
            {"SUPRA", "CAMRY", "GR86"},
            manual_for("Toyota"),
        )
        self.assertEqual(self.names(assigned, "supra"), {"SUPRA"})
        self.assertEqual(self.names(assigned, "camry"), {"CAMRY"})
        self.assertEqual(unused, {"GR86"})

        assigned, _methods, unused = assign_year(
            "TOYOTA",
            [("old", "86", "86"), ("gr", "GR86", "GR 86")],
            {"86", "GR86"},
            manual_for("Toyota"),
        )
        self.assertEqual(self.names(assigned, "old"), {"86"})
        self.assertEqual(self.names(assigned, "gr"), {"GR86"})
        self.assertEqual(unused, set())

    def test_cab_styles_tie(self):
        assigned, _methods, unused = assign_year(
            "ISUZU",
            [("crew", "I370CREWCAB", "i-370 Crew Cab"), ("ext", "I370EXTENDEDCAB", "i-370 Extended Cab")],
            {"I370"},
            {},
        )
        self.assertEqual(assigned, {})
        self.assertEqual(unused, {"I370"})

        assigned, _methods, unused = assign_year(
            "ISUZU",
            [("ext", "I290EXTENDEDCAB", "i-290 Extended Cab")],
            {"I290", "I370"},
            {},
        )
        self.assertEqual(self.names(assigned, "ext"), {"I290"})
        self.assertEqual(unused, {"I370"})

    def test_sls_and_class_still_do_not_cross(self):
        assigned, methods, unused = assign_year(
            "MERCEDES",
            [("sls", "SLSAMG", "SLS AMG"), ("c", "CCLASS", "C-Class"), ("cla", "CLACLASS", "CLA-Class")],
            {"SLS", "AMGSLS", "C300", "CLA250"},
            manual_for("Mercedes-Benz"),
        )
        self.assertEqual(self.names(assigned, "sls"), {"SLS", "AMGSLS"})
        self.assertEqual(self.names(assigned, "c"), {"C300"})
        self.assertEqual(self.names(assigned, "cla"), {"CLA250"})
        self.assertEqual(unused, set())
        self.assertEqual(methods["c"], "class")


if __name__ == "__main__":
    unittest.main()
