"""Local packet checks only; no upstream/reproduction code is executed."""
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("packet", HERE / "prepare_packet.py")
packet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packet)


class PacketChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files, cls.manifest = packet.prepare()

    def test_delivered_bytes_match(self):
        packet.verify_artifacts(packet.actual_files(), self.files)
        # Presentation preserves real trailing source whitespace visibly, while
        # the added line-number prefix does not create trailing blank-line space.
        self.assertEqual(packet.numbered(b"\ntext \n\t\n"),
                         "0001 |\n0002 | text ⟦EOL⟧\n0003 | \t⟦EOL⟧\n".encode())
        for name, raw in self.files.items():
            if name.endswith(("source.txt", "excerpts.txt", ".diff")):
                self.assertTrue(all(line == line.rstrip() for line in raw.decode().splitlines()), name)

    def test_after_source_added_to_first_pass_is_rejected(self):
        altered = dict(self.files)
        altered["first-pass/A/later-source.txt"] = self.files["second-pass/A/later-source.txt"]
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            packet.verify_artifacts(altered, self.files)

    def test_before_replaced_with_after_is_rejected(self):
        altered = dict(self.files)
        altered["first-pass/A/source.txt"] = self.files["second-pass/A/later-source.txt"]
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            packet.verify_artifacts(altered, self.files)

    def test_missing_material_is_rejected(self):
        altered = dict(self.files)
        del altered["first-pass/B/excerpts.txt"]
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            packet.verify_artifacts(altered, self.files)

    def test_blank_templates_have_no_answers_or_identity(self):
        for stage in (1, 2):
            form = packet.blank_form(stage)
            self.assertIsNone(form["participant_id"])
            self.assertIsNone(form["session_timing"]["active_minutes"])
            for case in form["cases"]:
                self.assertIsNone(case["judgment"])
                self.assertIsNone(case["repository_specificity"])
                self.assertIsNone(case["timing"]["active_minutes"])
                self.assertEqual(case["update_cause_hypotheses"], [])
            with self.assertRaisesRegex(ValueError, "Missing text: participant_id"):
                packet.check_answer(form, stage)

    def test_first_pass_material_roles(self):
        allowed = {"before_source", "before_source_excerpt", "neutral_instruction", "unfilled_form", "legal_notice"}
        for record in self.manifest["outputs"]:
            if record["file"].startswith("first-pass/"):
                self.assertIn(record["release_role"], allowed)
                if record["release_role"].startswith("before_source"):
                    self.assertTrue(all(x["side"] == "before" for x in record["sources"]))

    def test_source_pairs_are_not_mixed(self):
        cases = {c["neutral_case_id"]: c for c in self.manifest["cases"]}
        self.assertEqual(cases["A"]["source_identity"]["beforeCommit"], "72fc97a0f100b92f1ff6c6a16e27d12f1c7569aa")
        self.assertEqual(cases["A"]["source_identity"]["afterCommit"], "eae161c33f47a0b760701769f56fc249563f8ed0")
        for case in cases.values():
            self.assertEqual(case["historical_as_of"], "not_established")
            self.assertFalse(case["formal_holdout_eligible"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
