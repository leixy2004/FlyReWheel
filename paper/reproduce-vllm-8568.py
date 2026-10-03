#!/usr/bin/env python3
"""Bounded, offline, developmental reproduction of a captured validator body.

Run from the repository root:
    python -I paper/reproduce-vllm-8568.py > paper/vllm-8568-behavior-results.json

Only the reviewed, author-transcribed function text below is compiled. The
captured repository is parsed as data, never imported or executed. This is not
ChatCompletionRequest.model_validate, a historical checkout, or a benchmark.
"""

import ast
import base64
import copy
import hashlib
import json
import platform
from pathlib import Path
import sys
import textwrap


ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / ".flyrewheel/github-pr8568.json"
PROTOCOL_PATH = "vllm/entrypoints/openai/protocol.py"
TEST_PATH = "tests/tool_use/test_chat_completion_request_validations.py"
CAPTURE_SHA256 = "4c153cd4bd2ef95db4be6d5f1185fc3559ffafaf7feb85df8e57ac549e1cc356"
COMMITS = {
    "base": "72fc97a0f100b92f1ff6c6a16e27d12f1c7569aa",
    "head": "eae161c33f47a0b760701769f56fc249563f8ed0",
    "review_hunk_original": "7aa40bf05fa7cc502c4648d89eeff26b8c97918e",
}
EXPECTED_SOURCE = {
    (PROTOCOL_PATH, "before"): (
        31505, "d3340fb8076b8e9f82a4d0546a845b615ffa79573f5ebf7f61f4cd85ca0671fb",
        "7e9f53b1816d1e74755af62d704d4e295da0e814"),
    (PROTOCOL_PATH, "after"): (
        31507, "54f985fd9d2dea5454e6dd1ea1ce48bda71e383e1fb15696aa4bb97160520369",
        "359012611a34a7dc86be5e54ef890633f50bc8da"),
    (TEST_PATH, "after"): (
        1872, "baac2223cf8d78a461bd96660ea56ddd4340232aa1015d50f7831b78496dbbd6",
        "3d0fe8f06089549a46c5bf513cc53bdca055939c"),
}

# Hand-transcribed from the reviewed head function, lines 380--427. Only the
# four-space class indentation and two decorators (lines 378--379) are omitted.
# Its entire text and AST must match the captured definition before execution.
# Signature is unchanged; cls is unused and receives None in this harness.
HEAD_SOURCE = '''def check_tool_usage(cls, data):

    # if "tool_choice" is not specified but tools are provided,
    # default to "auto" tool_choice
    if "tool_choice" not in data and data.get("tools"):
        data["tool_choice"] = "auto"

    # if "tool_choice" is specified -- validation
    if "tool_choice" in data:

        # ensure that if "tool choice" is specified, tools are present
        if "tools" not in data or data["tools"] is None:
            raise ValueError(
                "When using `tool_choice`, `tools` must be set.")

        # make sure that tool choice is either a named tool
        # OR that it's set to "auto"
        if data["tool_choice"] != "auto" and not isinstance(
                data["tool_choice"], dict):
            raise ValueError(
                "`tool_choice` must either be a named tool or \\"auto\\". "
                "`tool_choice=\\"none\\" is not supported.")

        # ensure that if "tool_choice" is specified as an object,
        # it matches a valid tool
        if isinstance(data["tool_choice"], dict):
            valid_tool = False
            specified_function = data["tool_choice"]["function"]
            if not specified_function:
                raise ValueError(
                    "Incorrectly formatted `tool_choice`. Should be like "
                    "`{\\"type\\": \\"function\\","
                    " \\"function\\": {\\"name\\": \\"my_function\\"}}`")
            specified_function_name = specified_function["name"]
            if not specified_function_name:
                raise ValueError(
                    "Incorrectly formatted `tool_choice`. Should be like "
                    "`{\\"type\\": \\"function\\", "
                    "\\"function\\": {\\"name\\": \\"my_function\\"}}`")
            for tool in data["tools"]:
                if tool["function"]["name"] == specified_function_name:
                    valid_tool = True
                    break
            if not valid_tool:
                raise ValueError(
                    "The tool specified in `tool_choice` does not match any"
                    " of the specified `tools`")
    return data
'''

HEAD_CONDITION = 'if "tool_choice" not in data and data.get("tools"):'
BASE_CONDITION = 'if "tool_choice" not in data and "tools" in data:'
VALIDATION_IF = '    if "tool_choice" in data:\n'
BASE_SOURCE = HEAD_SOURCE.replace(HEAD_CONDITION, BASE_CONDITION, 1)
FLAT_ELIF_SOURCE = HEAD_SOURCE.replace(
    VALIDATION_IF, '    elif "tool_choice" in data:\n', 1)
NESTED_ELIF_SOURCE = HEAD_SOURCE.replace(
    '    ' + HEAD_CONDITION + '\n        data["tool_choice"] = "auto"',
    '    if "tool_choice" not in data:\n'
    '        if data.get("tools"):\n'
    '            data["tool_choice"] = "auto"', 1
).replace(VALIDATION_IF, '    elif "tool_choice" in data:\n', 1)

SOURCES = {
    "base": BASE_SOURCE,
    "head": HEAD_SOURCE,
    "head_flat_elif_counterfactual": FLAT_ELIF_SOURCE,
    "review_hunk_nested_elif_reconstruction": NESTED_ELIF_SOURCE,
}

MISSING_TOOLS = "When using `tool_choice`, `tools` must be set."
INVALID_CHOICE = ('`tool_choice` must either be a named tool or "auto". '
                  '`tool_choice="none" is not supported.')
NAMED_MISMATCH = ("The tool specified in `tool_choice` does not match any"
                  " of the specified `tools`")
ERROR_CODES = {MISSING_TOOLS: "missing_tools", INVALID_CHOICE: "invalid_choice",
               NAMED_MISMATCH: "named_mismatch"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def ast_key(node):
    return ast.dump(node, include_attributes=False)


def read_and_verify_capture():
    raw = CAPTURE.read_bytes()
    require(sha256(raw) == CAPTURE_SHA256, "Capture byte hash mismatch; stop.")
    capture = json.loads(raw)
    snapshot = capture["evidence"]["snapshot"]
    require(snapshot["baseTip"] == COMMITS["base"], "Base commit mismatch.")
    require(snapshot["mergeBase"] == COMMITS["base"], "Merge base mismatch.")
    require(snapshot["head"] == COMMITS["head"], "Head commit mismatch.")
    decoded, records = {}, []
    for change in snapshot["changes"]:
        for side in ("before", "after"):
            record = change[side]
            if record["state"] != "captured":
                continue
            key = (record["path"], side)
            require(key in EXPECTED_SOURCE, "Unexpected captured source.")
            data = base64.b64decode(record["bytesBase64"], validate=True)
            digest = sha256(data)
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            require((len(data), digest, blob) == EXPECTED_SOURCE[key],
                    "Reviewed source bytes do not match.")
            require((record["byteLength"], record["sha256"], record["objectId"])
                    == EXPECTED_SOURCE[key], "Capture metadata mismatch.")
            decoded[key] = data.decode("utf-8")
            records.append({"path": record["path"], "side": side,
                            "byte_length": len(data), "sha256": digest,
                            "git_blob_sha1": blob})
    require(set(decoded) == set(EXPECTED_SOURCE), "Incomplete source binding.")
    return capture, decoded, records


def bind_function(source, authored):
    tree = ast.parse(source)  # Parse only; never compile the captured module.
    classes = [x for x in tree.body if isinstance(x, ast.ClassDef)
               and x.name == "ChatCompletionRequest"]
    require(len(classes) == 1, "Class lookup ambiguous.")
    functions = [x for x in classes[0].body if isinstance(x, ast.FunctionDef)
                 and x.name == "check_tool_usage"]
    require(len(functions) == 1, "Function lookup ambiguous.")
    function = functions[0]
    require((function.lineno, function.end_lineno) == (380, 427),
            "Reviewed function line binding changed.")
    require([ast.unparse(x) for x in function.decorator_list]
            == ["model_validator(mode='before')", "classmethod"],
            "Decorator binding changed.")
    lines = source.splitlines(keepends=True)
    original = "".join(lines[function.lineno - 1:function.end_lineno])
    adapted = textwrap.dedent(original)
    require(adapted == authored, "Authored function text differs from capture.")
    node = copy.deepcopy(function)
    node.decorator_list = []
    require(ast_key(node) == ast_key(ast.parse(authored).body[0]),
            "Adapted AST differs beyond documented decorators/indentation.")
    fields = {x.target.id: x for x in classes[0].body
              if isinstance(x, ast.AnnAssign) and isinstance(x.target, ast.Name)}
    require(ast.literal_eval(fields["tool_choice"].value) == "none",
            "Captured field default changed.")
    require(ast.literal_eval(fields["tools"].value) is None,
            "Captured tools default changed.")
    return {"source_function_lines": [380, 427], "decorator_lines": [378, 379],
            "source_function_sha256": sha256(original.encode()),
            "adapted_function_sha256": sha256(authored.encode()),
            "body_ast_sha256": sha256(ast_key(ast.Module(body=node.body, type_ignores=[])).encode()),
            "adaptation": {"removed_decorators": ["model_validator(mode='before')", "classmethod"],
                           "removed_class_indent_spaces": 4,
                           "signature_changed": False,
                           "signature": "check_tool_usage(cls, data)",
                           "cls_argument": None,
                           "imports_executed_from_capture": [],
                           "field_default_applied_by_harness": False}}


def bind_review_hunk(capture):
    comments = capture["evidence"]["discussions"]["reviewComments"]
    rows = [x for x in comments if x["id"] == 1766097849]
    require(len(rows) == 1, "Expected review hunk absent.")
    comment = rows[0]
    require(comment["originalCommitId"] == COMMITS["review_hunk_original"],
            "Review hunk commit mismatch.")
    hunk = comment["diffHunk"]
    new_lines = []
    for line in hunk.splitlines()[1:]:
        if line.startswith(("+", " ")):
            new_lines.append(line[1:])
    reconstructed_prefix = textwrap.indent(
        textwrap.dedent("\n".join(new_lines)).strip("\n"), "    ")
    require(reconstructed_prefix in NESTED_ELIF_SOURCE,
            "Reconstructed prefix is not the captured hunk's added side.")
    return {"comment_id": comment["id"], "url": comment["url"],
            "original_commit": comment["originalCommitId"],
            "diff_hunk_sha256": sha256(hunk.encode()),
            "added_side_matches_reconstruction": True,
            "historical_full_function_available": False,
            "suffix_source": "captured final head; an explicit counterfactual assumption"}


def build_functions():
    functions = {}
    for name, source in SOURCES.items():
        tree = ast.parse(source)
        require(len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef),
                "Authored program must contain only one function.")
        allowed_names = {"cls", "data", "dict", "isinstance", "ValueError", "valid_tool",
                         "specified_function", "specified_function_name", "tool"}
        require(all(x.id in allowed_names for x in ast.walk(tree) if isinstance(x, ast.Name)),
                "Unexpected function name binding.")
        for node in ast.walk(tree):
            require(not isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal)),
                    "Imports or external-state bindings forbidden.")
            if isinstance(node, ast.Attribute):
                require(isinstance(node.value, ast.Name) and node.value.id == "data"
                        and node.attr == "get", "Unexpected attribute access.")
            if isinstance(node, ast.Call):
                require((isinstance(node.func, ast.Name)
                         and node.func.id in {"isinstance", "ValueError"})
                        or (isinstance(node.func, ast.Attribute) and node.func.attr == "get"),
                        "Unexpected call in reviewed function.")
        namespace = {"__builtins__": {"dict": dict, "isinstance": isinstance, "ValueError": ValueError}}
        exec(compile(tree, "<authored-vllm-8568:" + name + ">", "exec"), namespace)
        function = namespace["check_tool_usage"]
        # Trace entry into the first statement inside the validation branch.
        validation_line = next(node.lineno for node in ast.walk(tree)
                               if isinstance(node, ast.If)
                               and ast.unparse(node.test) == "'tools' not in data or data['tools'] is None")
        functions[name] = (function, validation_line)
    return functions


def tool(name):
    return {"type": "function", "function": {"name": name,
            "parameters": {"type": "object", "properties": {}}}}


def named(name):
    return {"type": "function", "function": {"name": name}}


def make_cases():
    tools = [("missing", None), ("null", None), ("empty", []),
             ("one_alpha", [tool("alpha")]),
             ("two_alpha_beta", [tool("alpha"), tool("beta")])]
    choices = [("missing", None), ("null", None), ("auto", "auto"), ("none", "none"),
               ("named_alpha", named("alpha")), ("named_beta", named("beta")),
               ("named_absent", named("absent"))]
    for tool_kind, tool_value in tools:
        for choice_kind, choice_value in choices:
            data = {"messages": [{"role": "user", "content": "Hello"}],
                    "model": "developmental-offline-placeholder"}
            if tool_kind != "missing":
                data["tools"] = copy.deepcopy(tool_value)
            if choice_kind != "missing":
                data["tool_choice"] = copy.deepcopy(choice_value)
            yield {"id": tool_kind + "/" + choice_kind, "tools_kind": tool_kind,
                   "choice_kind": choice_kind, "input": data}


def run_one(function, validation_line, original):
    data = copy.deepcopy(original)
    observed_lines = set()

    def trace(frame, event, arg):
        if frame.f_code is function.__code__ and event == "line":
            observed_lines.add(frame.f_lineno)
        return trace

    previous = sys.gettrace()
    try:
        sys.settrace(trace)
        returned = function(None, data)
        outcome = {"status": "return", "returned_data": copy.deepcopy(returned),
                   "returns_input_identity": returned is data}
    except Exception as error:
        outcome = {"status": "raise", "exception_type": type(error).__name__,
                   "exception_message": str(error), "error_code": ERROR_CODES.get(str(error), "unexpected")}
    finally:
        sys.settrace(previous)
    outcome["data_after"] = data
    return {"outcome": outcome, "validation_block_entered": validation_line in observed_lines}


# Predeclared small outcome table, independent of the executable source text.
# Each row follows the tools axis: missing, null, empty, one_alpha, two_alpha_beta.
EXPECTED_ROWS = {
    "missing": ["return_missing", "return_missing", "return_missing", "return_auto", "return_auto"],
    "null": ["missing_tools", "missing_tools", "invalid_choice", "invalid_choice", "invalid_choice"],
    "auto": ["missing_tools", "missing_tools", "return_unchanged", "return_unchanged", "return_unchanged"],
    "none": ["missing_tools", "missing_tools", "invalid_choice", "invalid_choice", "invalid_choice"],
    "named_alpha": ["missing_tools", "missing_tools", "named_mismatch", "return_unchanged", "return_unchanged"],
    "named_beta": ["missing_tools", "missing_tools", "named_mismatch", "named_mismatch", "return_unchanged"],
    "named_absent": ["missing_tools", "missing_tools", "named_mismatch", "named_mismatch", "named_mismatch"],
}
TOOLS_AXIS = ["missing", "null", "empty", "one_alpha", "two_alpha_beta"]


def check_expectation(variant, case, execution):
    original = case["input"]
    expected = EXPECTED_ROWS[case["choice_kind"]][TOOLS_AXIS.index(case["tools_kind"])]
    if variant == "base" and case["choice_kind"] == "missing":
        if case["tools_kind"] == "null":
            expected = "missing_tools"
        elif case["tools_kind"] == "empty":
            expected = "return_auto"
    expected_data = copy.deepcopy(original)
    if expected == "return_auto" or (variant == "base" and case["id"] == "null/missing"):
        expected_data["tool_choice"] = "auto"
    outcome = execution["outcome"]
    require(outcome["data_after"] == expected_data, "Unexpected mutation: " + variant + " " + case["id"])
    if expected.startswith("return_"):
        require(outcome["status"] == "return" and outcome["returned_data"] == expected_data
                and outcome["returns_input_identity"], "Unexpected return: " + variant + " " + case["id"])
    else:
        require(outcome["status"] == "raise" and outcome["exception_type"] == "ValueError"
                and outcome["error_code"] == expected, "Unexpected error: " + variant + " " + case["id"])


def main():
    capture, decoded, source_records = read_and_verify_capture()
    bindings = {"base": bind_function(decoded[(PROTOCOL_PATH, "before")], BASE_SOURCE),
                "head": bind_function(decoded[(PROTOCOL_PATH, "after")], HEAD_SOURCE)}
    hunk = bind_review_hunk(capture)
    functions = build_functions()
    cases = []
    for case in make_cases():
        runs = {}
        for variant, (function, line) in functions.items():
            runs[variant] = run_one(function, line, case["input"])
            check_expectation(variant, case, runs[variant])
        case["runs"] = runs
        cases.append(case)
    changed = [x["id"] for x in cases if x["runs"]["base"]["outcome"] != x["runs"]["head"]["outcome"]]
    require(changed == ["null/missing", "empty/missing"], "Unexpected base/head difference set.")
    comparisons = {}
    for variant in SOURCES:
        if variant in ("base", "head"):
            continue
        outcome_differences = [x["id"] for x in cases
                               if x["runs"][variant]["outcome"] != x["runs"]["head"]["outcome"]]
        trace_differences = [x["id"] for x in cases
                             if x["runs"][variant]["validation_block_entered"]
                             != x["runs"]["head"]["validation_block_entered"]]
        require(not outcome_differences, "Unexpected bounded if/elif outcome difference.")
        require(trace_differences == ["one_alpha/missing", "two_alpha_beta/missing"],
                "Unexpected bounded if/elif validation-entry difference.")
        comparisons[variant] = {"outcome_difference_case_ids": outcome_differences,
                                "validation_entry_difference_case_ids": trace_differences}
    result = {
        "schema_version": 1,
        "purpose": "offline, author-side developmental behavior reproduction; not benchmark/model efficacy/human labels",
        "runtime": {"python_implementation": platform.python_implementation(),
                    "python_version": platform.python_version(),
                    "isolated_mode": bool(sys.flags.isolated)},
        "script_sha256": sha256(Path(__file__).read_bytes()),
        "capture": {"repository_relative_path": ".flyrewheel/github-pr8568.json",
                    "sha256": sha256(CAPTURE.read_bytes()), "commits": COMMITS,
                    "source_record_bindings": source_records,
                    "application_evidence_digest_recomputed": False},
        "captured_function_bindings": bindings,
        "review_hunk_binding": hunk,
        "authored_variant_source_sha256": {k: sha256(v.encode()) for k, v in SOURCES.items()},
        "scope": {
            "input_domain": "35 hand-enumerated ordinary Python dictionaries: 5 tools forms x 7 choices",
            "tools_axis": TOOLS_AXIS, "choice_axis": list(EXPECTED_ROWS),
            "observations": "return value, exception type/message, mutated input, return identity; validation entry traced separately",
            "external_module_imports_executed": [],
            "full_pydantic_model_or_http_request_executed": False,
            "upstream_test_file_executed": False,
            "dependencies_installed": False,
            "network_used": False,
            "field_default_applied": False,
            "not_covered": ["full validator order and Pydantic field validation/default injection",
                            "arbitrary or malformed tools and named choices",
                            "custom mappings/objects, concurrent mutation, side-effecting truthiness",
                            "historical early full function, all possible JSON inputs, current vLLM API"]},
        "summary": {"status": "passed", "distinct_inputs": len(cases), "variants": len(SOURCES),
                    "executed_function_calls": len(cases) * len(SOURCES),
                    "expected_outcome_checks_passed": len(cases) * len(SOURCES),
                    "base_head_changed_case_ids": changed, "head_vs_counterfactuals": comparisons},
        "falsified_overbroad_local_claims": [
            {"claim": "Every locally accepted auto choice requires a nonempty tools list",
             "counterexample_case_id": "empty/auto", "variant": "head", "observed": "returns unchanged with auto and []"},
            {"claim": "With empty tools, missing and explicit none tool_choice are interchangeable",
             "counterexample_case_ids": ["empty/missing", "empty/none"], "variant": "head",
             "observed": "missing returns with no choice key; explicit none raises ValueError"}],
        "cases": cases,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
