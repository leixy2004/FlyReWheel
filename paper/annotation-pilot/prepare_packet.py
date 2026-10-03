#!/usr/bin/env python3
"""Prepare/check local annotation data. Never import or execute captured source."""
import argparse
import base64
import copy
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASELINE = "08bc3a8edc652a3397c2f8b05cd9cd0855b55213"
CAPTURE = ".flyrewheel/github-pr8568.json"
MATERIALS = "paper/pilot-materials-manifest.json"
CASES = {
    "A": (8568, "Request input validation", "ChatCompletionRequest.check_tool_usage", [[147, 173], [378, 427]]),
    "B": (2664, "Asynchronous request registration", "AsyncLLMEngine.add_request", [[205, 218], [305, 319], [347, 401], [415, 465]]),
    "C": (9034, "Output-token selection", "Sequence.get_output_token_ids_to_return", [[181, 215], [238, 279], [414, 443], [482, 535]]),
    "D": (2570, "Sampling argument validation", "SamplingParams.__init__ / _verify_args", [[39, 90], [93, 159], [160, 194]]),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_inputs():
    pins = json.loads((HERE / "audit/input-pins.json").read_text())
    require(pins["baseline_commit"] == BASELINE, "Unexpected pinned baseline")
    data = {}
    for record in pins["files"]:
        path = ROOT / record["file"]
        require(not path.is_symlink(), f"Symlink input refused: {path}")
        raw = path.read_bytes()
        require(len(raw) == record["bytes"] and sha(raw) == record["sha256"],
                f"Pinned input changed: {record['file']}")
        data[record["file"]] = raw
    return pins, data


def numbered(raw, ranges=None):
    lines = raw.decode("utf-8").splitlines(keepends=True)
    ranges = ranges or [[1, len(lines)]]
    parts = []
    for start, end in ranges:
        require(1 <= start <= end <= len(lines), "Invalid source range")
        if len(ranges) > 1:
            parts.append(f"\n[Original lines {start}-{end}]\n")
        for i in range(start, end + 1):
            original = lines[i - 1]
            body = original.rstrip("\r\n")
            ending = original[len(body):]
            if not body:
                # Omit the display separator's space on an actually empty line.
                parts.append(f"{i:04d} |" + ending)
            else:
                # Keep original whitespace bytes; a visible display-only marker
                # prevents them becoming unmarked trailing whitespace in Git.
                marker = "⟦EOL⟧" if body[-1].isspace() else ""
                parts.append(f"{i:04d} | {body}{marker}{ending}")
    return "".join(parts).encode()


def blank_form(stage):
    case = {
        "case_id": None,
        "familiarity": {"recognized_case_or_version": None, "prior_fix_or_result_exposure": None,
                        "details": None, "accidental_exposure_or_deviation": None},
        "timing": {"started_at_utc": None, "ended_at_utc": None, "active_minutes": None,
                   "pause_minutes": None, "unfinished_due_to_time": None},
        "judgment": None, "judgment_explanation": None, "confidence": None,
        "conditional_rule": {"when": None, "require": None, "because": None, "scope": None},
        "applicability_preconditions": [], "exceptions_or_legal_neighbors": [],
        "reusable_rule_supported": None, "repository_specificity": None,
        "specificity_explanation": None, "context_sufficiency": None,
        "evidence": [], "missing_context": [], "limitations": None,
        "historical_as_of_claim": None, "historical_visibility_explanation": None,
        "change_from_first_pass": None, "update_cause_hypotheses": [],
        "update_cause_explanation": None,
    }
    return {
        "form_version": 1, "purpose": "developmental_training_only", "stage": stage,
        "participant_id": None, "session_date": None,
        "python_and_repository_familiarity": None, "completed_independently": None,
        "allowed_materials_only": None, "deviations": None,
        "prior_response_sha256": None,
        "session_timing": {"started_at_utc": None, "ended_at_utc": None,
                           "active_minutes": None, "pause_minutes": None},
        "cases": [dict(copy.deepcopy(case), case_id=k) for k in CASES],
    }


def evidence_notes(case, upstream, identity):
    common = (
        "These are later materials released for training, not a historical review checkpoint. "
        "The local diff is generated from the exact supplied pair. Test files are retained source, "
        "not newly executed tests. Reports and comments are source statements, not adjudicated labels. "
        "Read evaluator-notes.md for the scope of existing local execution. No actual historical "
        "old/new review-rule pair or independent later application is supplied.\n\n"
    )
    specifics = {
        "A": "This pair is the captured PR base/final head, not the separate squash-parent/merge fixtures. "
             "The original earlier review commit is only represented by a hunk in discussion.json; its "
             "full source is absent. Current comment bodies can include edits, and the captured review "
             "objects span different commits. Do not assign the final source to earlier comment times. "
             "discussion.json preserves provider timestamps and source-version references.\n",
        "B": "No test file, raw review/comment stream, version-bound Ray implementation/dependency "
             "context, or executed actor/local path is retained for this case. The PR-body error report "
             "does not fill those gaps. A bounded source interpretation and an unknown runtime judgment "
             "can coexist.\n",
        "C": "The retained integration test uses a model/server fixture and accompanied serving changes. "
             "Those serving files are available only as patches in source-report.json. The test was not "
             "run and does not isolate this one method. The full caller/lifecycle invariants and raw "
             "review stream are absent.\n",
        "D": "A direct constructor test and a model-based regression test are retained but were not run. "
             "The source report claims an earlier accepted contract; earlier history proving that claim "
             "is not retained. Do not infer a historical contract change from a type-annotation edit.\n",
    }
    return (f"# Case {case}: later evidence\n\n{common}"
            f"Source identity: vLLM PR #{upstream}; before `{identity['beforeCommit']}`, "
            f"later `{identity['afterCommit']}`. These identify saved bytes only.\n\n"
            + specifics[case]).encode()


def prepare():
    pins, data = load_inputs()
    inventory = json.loads(data[MATERIALS])
    captures = json.loads(data[CAPTURE])
    items = {c["prNumber"]: c for c in inventory["cases"]}
    files, outputs, mappings = {}, [], []

    def add(path, raw, role, sources=None):
        require(path not in files, f"Duplicate output: {path}")
        files[path] = raw
        outputs.append({"file": path, "bytes": len(raw), "sha256": sha(raw),
                        "release_role": role, "sources": sources or []})

    def author(path, target, role):
        raw = (HERE / path).read_bytes()
        add(target, raw, role, [{"file": "paper/annotation-pilot/" + path,
                                "sha256": sha(raw), "status": "authored_packet_instruction"}])

    for stage in ("first-pass", "second-pass"):
        author(f"authoring/{stage}/START_HERE.md", f"{stage}/START_HERE.md", "neutral_instruction")
        add(f"{stage}/answer-form.blank.json", encoded(blank_form(1 if stage == "first-pass" else 2)),
            "unfilled_form")
    author("authoring/first-pass/rubric.md", "first-pass/rubric.md", "neutral_instruction")
    author("authoring/first-pass/rubric.md", "second-pass/rubric.md", "neutral_instruction")
    author("authoring/second-pass/evaluator-notes.md", "second-pass/evaluator-notes.md", "author_evaluator_notes")
    license_record = items[8568]["license"]
    # A legal notice carries no outcome. Its captured origin is disclosed in audit only.
    add("first-pass/LICENSE.txt", data[license_record["file"]], "legal_notice", [license_record])
    add("first-pass/ATTRIBUTION.txt", (
        "Source files: vLLM contributors, vllm-project/vllm, Apache License 2.0.\n"
        "Source display adds line-number prefixes and selected excerpts. Empty lines omit the prefix's final space.\n"
        "Original trailing source whitespace is preserved before a display-only ⟦EOL⟧ marker, not trimmed.\n"
        "Existing notices and comments remain in the complete source files.\n"
        "Task instructions and response forms are authored for this training exercise.\n"
        "See LICENSE.txt. Exact byte/version mappings are kept separately for audit.\n"
    ).encode(), "legal_notice")

    for case, (pr, title, target, ranges) in CASES.items():
        entry = items[pr]
        identity = copy.deepcopy(entry["sourceIdentity"])
        raw_pair, records, tests = {}, {}, []
        if case == "A":
            snap = captures["evidence"]["snapshot"]
            identity.update(beforeCommit=snap["baseTip"], afterCommit=snap["head"],
                            beforeRole="captured_pr_base", afterRole="captured_final_pr_head")
            identity.pop("sourceVersionMappingCheckedAgainstLocalMergeMetadata", None)
            identity["sourceVersionMappingBasis"] = "saved capture snapshot fields and verified embedded blobs; not seed merge metadata"
            for idx, change in enumerate(snap["changes"]):
                for side in ("before", "after"):
                    record = change.get(side, {})
                    if record.get("state") != "captured":
                        continue
                    raw = base64.b64decode(record["bytesBase64"], validate=True)
                    require(sha(raw) == record["sha256"] and len(raw) == record["byteLength"],
                            "Captured source identity mismatch")
                    blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
                    require(blob == record["objectId"], "Captured Git blob mismatch")
                    provenance = {"file": CAPTURE,
                                  "json_pointer": f"/evidence/snapshot/changes/{idx}/{side}",
                                  "path": record["path"], "side": side, "bytes": len(raw),
                                  "sha256": sha(raw), "gitBlobSha1": blob,
                                  "commit": identity["beforeCommit" if side == "before" else "afterCommit"]}
                    if record["path"].startswith("tests/"):
                        tests.append((record["path"], raw, provenance))
                    else:
                        raw_pair[side], records[side] = raw, provenance
            add("second-pass/A/discussion.json", encoded(captures["evidence"]["discussions"]),
                "later_discussion", [{"file": CAPTURE, "json_pointer": "/evidence/discussions"}])
            add("second-pass/A/source-report.json", encoded(captures["evidence"]["pull"]),
                "later_source_report", [{"file": CAPTURE, "json_pointer": "/evidence/pull"}])
        else:
            for record in entry["sourceFiles"]:
                raw = data[record["file"]]
                require(sha(raw) == record["sha256"], "Source/inventory mismatch")
                blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
                require(blob == record["gitBlobSha1"], "Source Git blob mismatch")
                raw_pair[record["side"]], records[record["side"]] = raw, record
            for record in entry["testFiles"]:
                tests.append((record["file"].split("/after/", 1)[1], data[record["file"]], record))
            report = entry["metadataFiles"][0]
            add(f"second-pass/{case}/source-report.json", data[report["file"]],
                "later_source_report", [report])
        add(f"first-pass/{case}/source.txt", numbered(raw_pair["before"]), "before_source", [records["before"]])
        add(f"first-pass/{case}/excerpts.txt", numbered(raw_pair["before"], ranges),
            "before_source_excerpt", [dict(records["before"], line_ranges=ranges)])
        task = (f"# Case {case}: {title}\n\nInspect `{target}` in the supplied source. "
                "Decide what review claim, if any, the available code and context support. "
                "Use the shared rubric; do not assume a defect or a reusable rule exists.\n\n"
                "Start with `excerpts.txt`; `source.txt` contains the complete captured file. "
                "The selected ranges are navigation aids, not a claim of complete context. "
                "Cite original source lines and identify any other material you would need. "
                "Do not infer unshown dependencies or callers.\n\n"
                "Fill your own case entry in the blank response form. Record applicability, "
                "exceptions or legal neighbors, knowledge specificity, uncertainty, and effort. "
                "Unknown/disputed is allowed; a missing contract is a reason to explain a gap.\n")
        add(f"first-pass/{case}/task.md", task.encode(), "neutral_instruction")
        add(f"second-pass/{case}/later-source.txt", numbered(raw_pair["after"]),
            "after_source", [records["after"]])
        diff = "".join(difflib.unified_diff(raw_pair["before"].decode().splitlines(True),
                                           raw_pair["after"].decode().splitlines(True),
                                           fromfile=f"{case}/before", tofile=f"{case}/later", n=0))
        add(f"second-pass/{case}/change.diff", diff.encode(), "pair_diff", list(records.values()))
        for index, (path, raw, record) in enumerate(tests, 1):
            add(f"second-pass/{case}/test-{index}.txt", (f"Retained upstream test source: {path}\n"
                "Not executed by this packet. Original line numbers follow.\n\n").encode() + numbered(raw),
                "later_test_declaration", [record])
        add(f"second-pass/{case}/evidence-notes.md", evidence_notes(case, pr, identity),
            "later_context_note", [{"file": MATERIALS, "case": entry["caseId"]}])
        mappings.append({"neutral_case_id": case, "upstream_pr": pr, "source_identity": identity,
                         "exact_source_records": records,
                         "selection": "already_inspected_convenience_development_case",
                         "historical_as_of": "not_established", "source_observation": (
                             captures["evidence"]["source"] if case == "A" else entry["sourceObservation"]),
                         "capture_observation_interval": ({"started_at": captures["receipt"]["startedAt"],
                             "completed_at": captures["receipt"]["completedAt"]} if case == "A" else None),
                         "historical_visibility_limit": ("Current non-atomic API capture; earlier review source only a hunk; "
                             "edited bodies and final head cannot be backdated." if case == "A" else
                             "Squash-parent/merge snapshots; no retained raw review stream or visibility checkpoint."),
                         "raw_review_stream_supplied": case == "A", "formal_holdout_eligible": False})
    for source in ("paper/vllm-8568-behavior-results.json", "paper/pilot-boundary-results.json"):
        add("second-pass/reproduction/" + Path(source).name, data[source], "author_recorded_local_execution",
            [{"file": source, "sha256": sha(data[source]), "rerun_in_this_packet": False}])
    first = [x for x in outputs if x["file"].startswith("first-pass/")]
    allowed_roles = {"before_source", "before_source_excerpt", "neutral_instruction", "unfilled_form", "legal_notice"}
    require(all(x["release_role"] in allowed_roles for x in first), "Outcome artifact in first pass")
    for record in first:
        if record["release_role"].startswith("before_source"):
            require(all(x.get("side") == "before" for x in record["sources"]), "Non-before source released")
    manifest = {
        "schema_version": 1, "kind": "developmental_annotation_training_packet", "baseline_commit": BASELINE,
        "new_human_annotations": 0, "historical_as_of_established": False,
        "independent_future_targets": 0, "formal_holdout": False,
        "input_pins_sha256": sha((HERE / "audit/input-pins.json").read_bytes()),
        "generator_sha256": sha(Path(__file__).read_bytes()), "inputs": pins["files"], "cases": mappings,
        "outputs": sorted(outputs, key=lambda x: x["file"]),
        "first_pass_allowlist": sorted(x["file"] for x in first),
        "blinding_limit": "Artifact separation only. Source, attribution, focused ranges or prior familiarity can reveal identity; no perfect-blinding or historical-as-of claim.",
        "legal_notice_exception": "Apache-2.0 license is an outcome-free legal notice; its retained origin at a later commit is disclosed here and no later code is included in pass 1.",
        "display_transform": "Source bytes/hashes are unchanged. Numbered empty lines omit the display separator space. Original trailing source whitespace is preserved before a visible display-only ⟦EOL⟧ marker. Pair diffs are valid zero-context unified diffs to avoid space-only context lines.",
        "execution_scope": "Only this authored generator/validator runs. Captured code and saved result JSON are data. No upstream/reproduction execution, network, model, authentication, publication or commit.",
    }
    return files, manifest


def actual_files():
    found = {}
    for stage in ("first-pass", "second-pass"):
        for path in (HERE / stage).rglob("*"):
            require(not path.is_symlink(), f"Symlink refused: {path}")
            if path.is_file():
                found[path.relative_to(HERE).as_posix()] = path.read_bytes()
    return found


def verify_artifacts(actual, expected):
    require(set(actual) == set(expected),
            f"Output inventory mismatch; extra={sorted(set(actual)-set(expected))}, missing={sorted(set(expected)-set(actual))}")
    for path, raw in expected.items():
        require(actual[path] == raw, f"Output bytes changed: {path}")


def text_value(value, name):
    require(isinstance(value, str) and bool(value.strip()), f"Missing text: {name}")


def timing(value, name):
    from datetime import datetime
    start, end = value["started_at_utc"], value["ended_at_utc"]
    require(isinstance(start, str) and isinstance(end, str) and start.endswith("Z") and end.endswith("Z"),
            f"UTC timing must end in Z: {name}")
    elapsed = (datetime.fromisoformat(end.replace("Z", "+00:00")) -
               datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() / 60
    a, p = value["active_minutes"], value["pause_minutes"]
    require(all(type(x) in (int, float) and x >= 0 for x in (a, p)) and elapsed >= 0,
            f"Invalid timing values: {name}")
    require(abs(a + p - elapsed) <= 1, f"Active + pause minutes inconsistent with clock times: {name}")


def check_answer(form, stage):
    template = blank_form(stage)
    require(set(form) == set(template), "Top-level form fields differ from template")
    for key in ("form_version", "purpose", "stage"):
        require(form[key] == template[key], f"Incorrect {key}")
    for key in ("participant_id", "session_date", "python_and_repository_familiarity"):
        text_value(form[key], key)
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}", form["session_date"]), "Session date must be YYYY-MM-DD")
    for key in ("completed_independently", "allowed_materials_only"):
        require(type(form[key]) is bool, f"Missing yes/no: {key}")
    text_value(form["deviations"], "deviations (use none if none)")
    timing(form["session_timing"], "session")
    if stage == 1:
        require(form["prior_response_sha256"] is None, "First pass cannot refer to a prior response")
    else:
        require(isinstance(form["prior_response_sha256"], str) and
                re.fullmatch(r"[0-9a-f]{64}", form["prior_response_sha256"]), "Missing first-pass response hash")
    require(isinstance(form["cases"], list) and [c.get("case_id") for c in form["cases"]] == list(CASES),
            "Cases must be A, B, C, D once each in order")
    enums = {
        "judgment": {"issue_supported", "no_issue_supported_within_scope", "unknown", "disputed"},
        "confidence": {"low", "medium", "high"},
        "reusable_rule_supported": {"yes", "no", "unknown", "disputed"},
        "repository_specificity": {"generic", "repository_conditioned", "mixed", "unknown", "disputed"},
        "context_sufficiency": {"sufficient_for_bounded_claim", "insufficient", "unknown", "disputed"},
        "historical_as_of_claim": {"not_established", "unknown", "disputed"},
    }
    for case in form["cases"]:
        require(set(case) == set(template["cases"][0]), "Case fields differ from template")
        for key, values in enums.items():
            require(case[key] in values, f"Unfilled/invalid {case['case_id']} {key}")
        for key in ("judgment_explanation", "specificity_explanation", "limitations", "historical_visibility_explanation"):
            text_value(case[key], key)
        timing(case["timing"], case["case_id"])
        require(type(case["timing"]["unfinished_due_to_time"]) is bool, "Missing unfinished timing flag")
        for key in ("recognized_case_or_version", "prior_fix_or_result_exposure"):
            require(type(case["familiarity"][key]) is bool, "Missing familiarity response")
        for key in ("details", "accidental_exposure_or_deviation"):
            text_value(case["familiarity"][key], key)
        for key in ("applicability_preconditions", "exceptions_or_legal_neighbors", "missing_context", "update_cause_hypotheses"):
            require(isinstance(case[key], list), f"Expected list: {key}")
        require(set(case["conditional_rule"]) == {"when", "require", "because", "scope"}, "Invalid rule shape")
        require(all(v is None or isinstance(v, str) for v in case["conditional_rule"].values()), "Rule fields must be text or null")
        require(isinstance(case["evidence"], list) and bool(case["evidence"]), "Missing evidence or gap entry")
        for ev in case["evidence"]:
            require(set(ev) == {"kind", "locator", "claim"}, "Evidence entries need kind, locator, claim")
            allowed = {"source_fact", "source_report", "static_inference", "recorded_local_execution", "assumption", "missing_evidence"}
            if stage == 1:
                allowed -= {"recorded_local_execution", "source_report"}
            require(ev["kind"] in allowed, "Invalid evidence kind for release stage")
            text_value(ev["claim"], "evidence claim")
            loc = ev["locator"]
            require(isinstance(loc, str) and (loc in {"not_supplied", "time_limit", "prior_knowledge"} or
                    re.fullmatch(r"[A-D]/(?:source|excerpts)\.txt:L\d+(?:-L\d+)?", loc) or
                    (stage == 2 and re.fullmatch(r"(?:[A-D]/|reproduction/|evaluator-notes\.md).*", loc))),
                    f"Use a packet locator or missing-evidence marker: {loc}")
        causes = {"no_change_needed", "missing_precondition", "overbroad_scope", "contract_change",
                  "implementation_defect", "insufficient_evidence", "other"}
        for h in case["update_cause_hypotheses"]:
            require(set(h) == {"cause", "status", "supporting_evidence", "competing_explanation", "needed_to_resolve"},
                    "Hypotheses need cause, status, supporting_evidence, competing_explanation, needed_to_resolve")
            require(h["cause"] in causes and h["status"] in {"proposed", "unknown", "disputed"}, "Invalid hypothesis")
            for key in ("supporting_evidence", "competing_explanation", "needed_to_resolve"):
                text_value(h[key], key)
        if stage == 1:
            require(case["change_from_first_pass"] is None and not case["update_cause_hypotheses"],
                    "First pass has no revealed update episode")
        else:
            text_value(case["change_from_first_pass"], "change_from_first_pass (use unchanged with reason)")
            text_value(case["update_cause_explanation"], "update_cause_explanation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--build", action="store_true")
    group.add_argument("--verify", action="store_true")
    group.add_argument("--check-answer", type=Path)
    parser.add_argument("--stage", type=int, choices=[1, 2])
    args = parser.parse_args()
    if args.check_answer:
        require(args.stage is not None, "--stage is required with --check-answer")
        check_answer(json.loads(args.check_answer.read_text()), args.stage)
        print(json.dumps({"structurally_complete": True, "semantic_or_identity_validation": False}))
        return
    require(args.stage is None, "--stage only applies to --check-answer")
    files, manifest = prepare()
    manifest_path = HERE / "audit/provenance-manifest.json"
    if args.build:
        existing = actual_files()
        require(set(existing) <= set(files), "Refusing to overwrite a directory containing extra files/responses")
        for path, raw in files.items():
            destination = HERE / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        manifest_path.write_bytes(encoded(manifest))
    verify_artifacts(actual_files(), files)
    require(manifest_path.read_bytes() == encoded(manifest), "Audit manifest changed or not rebuilt")
    report = {"status": "passed", "baseline_commit": BASELINE, "outputs_verified": len(files),
              "input_files_verified": len(manifest["inputs"]),
              "first_pass_files": len(manifest["first_pass_allowlist"]), "cases": len(CASES),
              "first_pass_has_only_allowlisted_before_source_and_neutral_material": True,
              "later_artifacts_in_first_pass": 0,
              "blank_forms_have_no_annotator_or_judgments": all(
                  blank_form(stage)["participant_id"] is None and
                  all(c["judgment"] is None for c in blank_form(stage)["cases"]) for stage in (1, 2)),
              "provenance_manifest_sha256": sha(manifest_path.read_bytes()),
              "new_human_annotations": 0, "upstream_or_reproduction_code_executed": False,
              "limits": "Exact allowlist/byte separation, not proof of semantic blinding, human independence, historical visibility, or source correctness."}
    (HERE / "audit/validation-report.json").write_bytes(encoded(report))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"Packet check failed: {exc}", file=sys.stderr)
        sys.exit(1)
