#!/usr/bin/env python3
"""Offline author-side method reproductions, not vLLM integration tests.

    python -I paper/reproduce-pilot-boundaries.py > paper/pilot-boundary-results.json
    python -I paper/reproduce-pilot-boundaries.py --verify > paper/pilot-boundary-verification.json

Only reviewed literal method text below is compiled. Captured modules are data.
No upstream constructor, import, test, model, server, or Ray runtime is executed.
"""

import ast
from array import array
import copy
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
from typing import List, Sequence as GenericSequence, Tuple, Union
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = "paper/pilot-materials-manifest.json"
MANIFEST_SHA256 = "27b43233a80add0e9ccb85df9068b33416700f4935b30299566d90d4e17bf229"
RESULT_PATH = "paper/pilot-boundary-results.json"
REPORT_PATH = "paper/pilot-boundary-reproduction.md"
BASELINE = "4d87dda"

# Exact reviewed method transcriptions; only four-space class indentation is
# removed. All type annotations remain. No captured source text is compiled.
TOKENS_AFTER = '''def get_output_token_ids_to_return(
        self, delta: bool) -> Union[GenericSequence[int], int]:
    """If delta is True, only new tokens since the last call to
    this method are returned"""
    if not delta:
        return self.get_output_token_ids()

    output_len = self.get_output_len()

    # Get the number of new tokens
    num_new_tokens = output_len - self._last_output_token_ids_offset
    self._last_output_token_ids_offset = output_len

    # Return new tokens
    if num_new_tokens == 1:
        # Optimization for single decode token case
        # (which is what we have most of the time)
        return self.data._cached_all_token_ids[-1]

    if num_new_tokens == 0:
        return []

    return self.data._cached_all_token_ids[-num_new_tokens:]
'''
TOKENS_BEFORE = TOKENS_AFTER.replace('    if num_new_tokens == 0:\n        return []\n\n', '', 1)
VERIFY_AFTER = '''def _verify_args(self) -> None:
    if self.n < 1:
        raise ValueError(f"n must be at least 1, got {self.n}.")
    if self.best_of < self.n:
        raise ValueError(f"best_of must be greater than or equal to n, "
                         f"got n={self.n} and best_of={self.best_of}.")
    if not -2.0 <= self.presence_penalty <= 2.0:
        raise ValueError("presence_penalty must be in [-2, 2], got "
                         f"{self.presence_penalty}.")
    if not -2.0 <= self.frequency_penalty <= 2.0:
        raise ValueError("frequency_penalty must be in [-2, 2], got "
                         f"{self.frequency_penalty}.")
    if not 0.0 < self.repetition_penalty <= 2.0:
        raise ValueError("repetition_penalty must be in (0, 2], got "
                         f"{self.repetition_penalty}.")
    if self.temperature < 0.0:
        raise ValueError(
            f"temperature must be non-negative, got {self.temperature}.")
    if not 0.0 < self.top_p <= 1.0:
        raise ValueError(f"top_p must be in (0, 1], got {self.top_p}.")
    if self.top_k < -1 or self.top_k == 0:
        raise ValueError(f"top_k must be -1 (disable), or at least 1, "
                         f"got {self.top_k}.")
    if not 0.0 <= self.min_p <= 1.0:
        raise ValueError("min_p must be in [0, 1], got "
                         f"{self.min_p}.")
    if self.max_tokens is not None and self.max_tokens < 1:
        raise ValueError(
            f"max_tokens must be at least 1, got {self.max_tokens}.")
    if self.logprobs is not None and self.logprobs < 0:
        raise ValueError(
            f"logprobs must be non-negative, got {self.logprobs}.")
    if self.prompt_logprobs is not None and self.prompt_logprobs < 0:
        raise ValueError(f"prompt_logprobs must be non-negative, got "
                         f"{self.prompt_logprobs}.")
'''
VERIFY_BEFORE = VERIFY_AFTER.replace('self.max_tokens is not None and ', '', 1)
VERIFY_TRUTHY = VERIFY_AFTER.replace('self.max_tokens is not None and ', 'self.max_tokens and ', 1)
HELPERS = {
    ('SequenceData', '_update_cached_all_tokens'): '''def _update_cached_all_tokens(self):
    assert isinstance(self._prompt_token_ids, array)
    assert isinstance(self._output_token_ids, array)
    self._cached_all_token_ids: List[int] = list(self._prompt_token_ids +
                                                 self._output_token_ids)
''',
    ('SequenceData', 'output_token_ids'): '''def output_token_ids(self) -> Tuple[int, ...]:
    return tuple(self._output_token_ids)
''',
    ('SequenceData', 'get_output_len'): '''def get_output_len(self) -> int:
    return len(self._output_token_ids)
''',
    ('SequenceData', 'get_output_token_ids'): '''def get_output_token_ids(self) -> Tuple[int, ...]:
    return self.output_token_ids
''',
    ('Sequence', 'get_output_len'): '''def get_output_len(self) -> int:
    return self.data.get_output_len()
''',
    ('Sequence', 'get_output_token_ids'): '''def get_output_token_ids(self) -> Tuple[int, ...]:
    return self.data.get_output_token_ids()
''',
}
HELPER_LINES = {
    ('SequenceData', '_update_cached_all_tokens'): {'before': [211, 215], 'after': [211, 215]},
    ('SequenceData', 'output_token_ids'): {'before': [239, 240], 'after': [239, 240]},
    ('SequenceData', 'get_output_len'): {'before': [278, 279], 'after': [278, 279]},
    ('SequenceData', 'get_output_token_ids'): {'before': [332, 333], 'after': [332, 333]},
    ('Sequence', 'get_output_len'): {'before': [566, 567], 'after': [569, 570]},
    ('Sequence', 'get_output_token_ids'): {'before': [578, 579], 'after': [581, 582]},
}
DEFAULT_FIELDS = {
    'n': 1, 'best_of': 1, 'presence_penalty': 0.0,
    'frequency_penalty': 0.0, 'repetition_penalty': 1.0,
    'temperature': 1.0, 'top_p': 1.0, 'top_k': -1, 'min_p': 0.0,
    'max_tokens': 16, 'logprobs': None, 'prompt_logprobs': None,
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ast_key(node):
    return ast.dump(node, include_attributes=False)


def verify_file(record):
    path = ROOT / record['file']
    raw = path.read_bytes()
    require(len(raw) == record['bytes'] and digest(raw) == record['sha256'],
            'Material byte identity changed: ' + record['file'])
    if 'gitBlobSha1' in record:
        blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        require(blob == record['gitBlobSha1'], 'Git blob mismatch: ' + record['file'])
    return raw


def find_function(source, class_name, function_name, lines=None):
    classes = [n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == class_name]
    require(len(classes) == 1, 'Class lookup not unique')
    nodes = [n for n in classes[0].body if isinstance(n, ast.FunctionDef) and n.name == function_name
             and (lines is None or [n.lineno, n.end_lineno] == lines)]
    require(len(nodes) == 1, 'Function lookup not unique: ' + function_name)
    return nodes[0]


def bind_method(record, source, class_name, function_name, lines, authored, decorators=()):
    node = find_function(source, class_name, function_name, lines)
    require([ast.unparse(n) for n in node.decorator_list] == list(decorators), 'Decorator drift')
    original = ''.join(source.splitlines(keepends=True)[lines[0] - 1:lines[1]])
    require(textwrap.dedent(original) == authored, 'Transcription differs: ' + function_name)
    stripped = copy.deepcopy(node)
    stripped.decorator_list = []
    authored_node = ast.parse(authored).body[0]
    docstring_changed = ast.get_docstring(node, clean=False) != ast.get_docstring(authored_node, clean=False)
    if docstring_changed:
        require(ast.get_docstring(node) == ast.get_docstring(authored_node), 'Docstring content drift')
        stripped.body[0].value.value = authored_node.body[0].value.value
    require(ast_key(stripped) == ast_key(authored_node), 'AST differs')
    return {'file': record['file'], 'source_sha256': record['sha256'], 'commit': record['commit'],
            'source_url': record['sourceUrl'] + '#L' + str(lines[0]) + '-L' + str(lines[1]),
            'class': class_name, 'method': function_name, 'lines': lines,
            'raw_method_sha256': digest(original.encode()), 'authored_method_sha256': digest(authored.encode()),
            'body_ast_sha256': digest(ast_key(ast.Module(body=node.body, type_ignores=[])).encode()),
            'adaptation': {'removed_class_indent_spaces': 4, 'removed_decorators': list(decorators),
                           'annotations_or_signature_changed': False, 'executable_statements_changed': False,
                           'docstring_indentation_dedented': docstring_changed}}


def bind_constructor(record, source, side):
    node = find_function(source, 'SamplingParams', '__init__', [93, 158])
    args = node.args.args
    defaults = {arg.arg: ast.literal_eval(value) for arg, value in zip(args[-len(node.args.defaults):], node.args.defaults)}
    for key, value in DEFAULT_FIELDS.items():
        expected_default = None if key == 'best_of' else value
        require(defaults[key] == expected_default and type(defaults[key]) is type(expected_default), 'Default drift: ' + key)
    attrs = {n.targets[0].attr: ast.unparse(n.value) for n in node.body if isinstance(n, ast.Assign)
             and len(n.targets) == 1 and isinstance(n.targets[0], ast.Attribute)}
    for key in DEFAULT_FIELDS:
        require(attrs[key] == ('best_of if best_of is not None else n' if key == 'best_of' else key), 'Field assignment drift')
    annotation = ast.unparse(next(arg.annotation for arg in args if arg.arg == 'max_tokens'))
    require(annotation == ('int' if side == 'before' else 'Optional[int]'), 'Type annotation drift')
    require(any(isinstance(n, ast.Expr) and ast.unparse(n.value) == 'self._verify_args()' for n in node.body), 'Verifier call missing')
    return {'file': record['file'], 'source_sha256': record['sha256'], 'constructor_lines': [93, 158],
            'max_tokens_annotation': annotation, 'default_fields_checked': DEFAULT_FIELDS,
            'constructor_executed': False,
            'adaptation': 'SimpleNamespace initialized with these verified defaults; explicit per-case overrides; no constructor or subsequent beam/greedy checks'}


def build_function(source, tag):
    tree = ast.parse(source)
    require(len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef), 'Not a single method')
    allowed_names = {'self', 'delta', 'output_len', 'num_new_tokens', 'bool', 'int', 'Union',
                     'GenericSequence', 'Tuple', 'List', 'array', 'len', 'tuple', 'list', 'isinstance', 'ValueError'}
    allowed_attrs = set(DEFAULT_FIELDS) | {'data', '_last_output_token_ids_offset', '_cached_all_token_ids',
                     '_prompt_token_ids', '_output_token_ids', 'get_output_len', 'get_output_token_ids', 'output_token_ids'}
    for node in ast.walk(tree):
        require(not isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal)), 'Forbidden external binding')
        if isinstance(node, ast.Name):
            require(node.id in allowed_names, 'Unexpected name: ' + node.id)
        if isinstance(node, ast.Attribute):
            require(node.attr in allowed_attrs, 'Unexpected attribute: ' + node.attr)
        if isinstance(node, ast.Call):
            require((isinstance(node.func, ast.Name) and node.func.id in {'len', 'tuple', 'list', 'isinstance', 'ValueError'})
                    or (isinstance(node.func, ast.Attribute) and node.func.attr in {'get_output_len', 'get_output_token_ids'}),
                    'Unexpected call')
    namespace = {'__builtins__': {'bool': bool, 'int': int, 'len': len, 'tuple': tuple, 'list': list,
                                'isinstance': isinstance, 'ValueError': ValueError},
                 'Union': Union, 'GenericSequence': GenericSequence, 'Tuple': Tuple, 'List': List, 'array': array}
    exec(compile(tree, '<reviewed-authored-method:' + tag + '>', 'exec'), namespace)
    return namespace[tree.body[0].name]


class DataAdapter:
    """Authored initialization only; no msgspec or upstream class construction."""
    def __init__(self, prompt, output):
        self._prompt_token_ids = array('l', prompt)
        self._output_token_ids = array('l', output)
        self._update_cached_all_tokens()


class SequenceAdapter:
    def __init__(self, prompt, output, offset, cache_override=None):
        self.data = DataAdapter(prompt, output)
        self._last_output_token_ids_offset = offset
        if cache_override is not None:
            self.data._cached_all_token_ids = list(cache_override)


def returned(value):
    # Preserve list vs tuple vs scalar, which JSON alone would conflate.
    return {'status': 'return', 'type': type(value).__name__, 'value': list(value) if isinstance(value, tuple) else value}


def raised(exception_type, message=None):
    result = {'status': 'raise', 'exception_type': exception_type}
    if message is not None:
        result['exception_message'] = message
    return result


def invoke(function, state, *args):
    try:
        return returned(function(state, *args))
    except Exception as error:
        return raised(type(error).__name__, str(error))


def check_expected(actual, expected, identity):
    require(all(actual.get(key) == value for key, value in expected.items()), 'Expected outcome mismatch: ' + identity)
    if expected['status'] == 'return':
        require(actual == expected, 'Return type/value mismatch: ' + identity)


# Literal expectation rows, authored from the stated delta contract and ordinary
# Python types. They are not calculated by rerunning or copying the method.
# Fields: id, domain, prompt, output, offset, delta, cache override, before, after.
TOKEN_CASES = [
    ('zero_empty_cache', 'contract_domain', [], [], 0, True, None, [], []),
    ('zero_prompt_only', 'contract_domain', [10, 11], [], 0, True, None, [10, 11], []),
    ('zero_after_output', 'contract_domain', [10, 11], [20, 21, 22], 3, True, None, [10, 11, 20, 21, 22], []),
    ('zero_no_prompt', 'contract_domain', [], [20, 21], 2, True, None, [20, 21], []),
    ('one_initial', 'contract_domain', [10, 11], [20], 0, True, None, 20, 20),
    ('one_suffix', 'contract_domain', [10, 11], [20, 21, 22], 2, True, None, 22, 22),
    ('two_suffix', 'contract_domain', [10, 11], [20, 21, 22], 1, True, None, [21, 22], [21, 22]),
    ('all_three_outputs', 'contract_domain', [10, 11], [20, 21, 22], 0, True, None, [20, 21, 22], [20, 21, 22]),
    ('two_without_prompt', 'contract_domain', [], [20, 21], 0, True, None, [20, 21], [20, 21]),
    ('non_delta_empty_output', 'contract_domain', [10, 11], [], 0, False, None, (), ()),
    ('non_delta_initial', 'contract_domain', [10, 11], [20, 21, 22], 0, False, None, (20, 21, 22), (20, 21, 22)),
    ('non_delta_existing_offset', 'contract_domain', [10, 11], [20, 21, 22], 2, False, None, (20, 21, 22), (20, 21, 22)),
    ('offset_ahead_by_one', 'unsupported_state_probe', [10, 11], [20, 21], 3, True, None, [11, 20, 21], [11, 20, 21]),
    ('offset_far_ahead', 'unsupported_state_probe', [10, 11], [20, 21], 9, True, None, [], []),
    ('offset_negative', 'unsupported_state_probe', [10, 11], [20, 21], -1, True, None, [11, 20, 21], [11, 20, 21]),
    ('cache_short_multiple', 'unsupported_state_probe', [10, 11], [20, 21, 22], 1, True, [999], [999], [999]),
    ('cache_empty_single', 'unsupported_state_probe', [10, 11], [20], 0, True, [], raised('IndexError'), raised('IndexError')),
    ('cache_stale_zero', 'unsupported_state_probe', [10, 11], [20], 1, True, [999], [999], []),
]


def run_tokens(functions):
    rows = []
    for case_id, domain, prompt, output, offset, delta, override, before, after in TOKEN_CASES:
        row = {'id': case_id, 'domain': domain, 'input': {'prompt': prompt, 'output': output, 'previous_offset': offset,
               'delta': delta, 'cache_override': override}, 'runs': {}}
        for side, expected_value in [('before', before), ('after', after)]:
            state = SequenceAdapter(prompt, output, offset, override)
            original_cache = list(state.data._cached_all_token_ids)
            actual = invoke(functions[side], state, delta)
            expected = expected_value if isinstance(expected_value, dict) else returned(expected_value)
            expected_offset = len(output) if delta else offset
            check_expected(actual, expected, case_id + '/' + side)
            require(state._last_output_token_ids_offset == expected_offset, 'Offset mismatch')
            require(list(state.data._prompt_token_ids) == prompt and list(state.data._output_token_ids) == output
                    and state.data._cached_all_token_ids == original_cache, 'Unexpected token/cache mutation')
            row['runs'][side] = {'expected': expected, 'actual': actual, 'offset_after': state._last_output_token_ids_offset,
                                 'expected_offset_after': expected_offset, 'cache_after': original_cache, 'expectation_passed': True}
        rows.append(row)
    # A real repeated call of the adapted method, without append/reset simulation.
    repeated = {}
    expectations = {'before': [returned(20), returned([10, 11, 20])], 'after': [returned(20), returned([])]}
    for side in ('before', 'after'):
        state = SequenceAdapter([10, 11], [20], 0)
        observations = []
        for index, expected in enumerate(expectations[side]):
            actual = invoke(functions[side], state, True)
            check_expected(actual, expected, 'repeat/' + side + '/' + str(index))
            require(state._last_output_token_ids_offset == 1, 'Repeated call offset mismatch')
            observations.append({'expected': expected, 'actual': actual, 'offset_after': 1, 'expectation_passed': True})
        repeated[side] = observations
    changed = [row['id'] for row in rows if row['runs']['before']['actual'] != row['runs']['after']['actual']]
    require(changed == ['zero_prompt_only', 'zero_after_output', 'zero_no_prompt', 'cache_stale_zero'], 'Changed-input set mismatch')
    return {'input_rows': rows, 'repeated_delta_call': {'prompt': [10, 11], 'output': [20], 'initial_offset': 0,
            'runs': repeated}, 'summary': {'snapshot_inputs': len(rows), 'contract_domain_snapshot_inputs': 12,
            'unsupported_snapshot_inputs': 6, 'repeated_call_scenarios': 1, 'primary_method_calls': 40,
            'expected_checks_passed': 40, 'before_after_changed_snapshot_ids': changed}}


# Author-side lower-bound observations, not an API promise for unsupported types.
# Codes: ok, max (<1), type (incomparable); before/after/truthy counterfactual.
PARAM_CASES = [
    ('none', 'declared_optional_sentinel', None, {}, 'type', 'ok', 'ok'),
    ('negative_one', 'declared_integer_rejection', -1, {}, 'max', 'max', 'max'),
    ('zero', 'declared_integer_rejection', 0, {}, 'max', 'max', 'ok'),
    ('one', 'declared_positive_integer', 1, {}, 'ok', 'ok', 'ok'),
    ('default_sixteen', 'declared_positive_integer', 16, {}, 'ok', 'ok', 'ok'),
    ('none_upstream_test_parameters', 'declared_optional_sentinel', None, {'temperature': 0.01, 'top_p': 0.1}, 'type', 'ok', 'ok'),
    ('none_earlier_n_invalid', 'validation_order_probe', None, {'n': 0}, 'n', 'n', 'n'),
    ('none_later_logprobs_invalid', 'validation_order_probe', None, {'logprobs': -1}, 'type', 'logprobs', 'logprobs'),
    ('one_later_prompt_logprobs_invalid', 'validation_order_probe', 1, {'prompt_logprobs': -1}, 'prompt_logprobs', 'prompt_logprobs', 'prompt_logprobs'),
    ('float_negative', 'unsupported_type_probe', -1.0, {}, 'max', 'max', 'max'),
    ('float_zero', 'unsupported_type_probe', 0.0, {}, 'max', 'max', 'ok'),
    ('float_fraction', 'unsupported_type_probe', 0.5, {}, 'max', 'max', 'max'),
    ('float_above_one', 'unsupported_type_probe', 1.5, {}, 'ok', 'ok', 'ok'),
    ('boolean_false', 'unsupported_type_probe', False, {}, 'max', 'max', 'ok'),
    ('boolean_true', 'unsupported_type_probe', True, {}, 'ok', 'ok', 'ok'),
    ('string_one', 'unsupported_type_probe', '1', {}, 'type', 'type', 'type'),
    ('empty_list', 'unsupported_type_probe', [], {}, 'type', 'type', 'ok'),
]


def param_expected(code, value):
    if code == 'ok':
        return returned(None)
    if code == 'type':
        return raised('TypeError')
    messages = {'max': f'max_tokens must be at least 1, got {value}.',
                'n': 'n must be at least 1, got 0.',
                'logprobs': 'logprobs must be non-negative, got -1.',
                'prompt_logprobs': 'prompt_logprobs must be non-negative, got -1.'}
    return raised('ValueError', messages[code])


def run_params(functions):
    rows = []
    for case_id, domain, value, overrides, before, after, truthy in PARAM_CASES:
        fields = copy.deepcopy(DEFAULT_FIELDS)
        fields.update(overrides)
        fields['max_tokens'] = copy.deepcopy(value)
        # Mimic only the verified constructor best_of default expression.
        if 'n' in overrides:
            fields['best_of'] = overrides['n']
        row = {'id': case_id, 'domain': domain, 'max_tokens_python_type': type(value).__name__, 'input_fields': fields, 'runs': {}}
        for variant, code in [('before', before), ('after', after), ('authored_truthy_guard', truthy)]:
            state = SimpleNamespace(**copy.deepcopy(fields))
            actual = invoke(functions[variant], state)
            expected = param_expected(code, value)
            check_expected(actual, expected, case_id + '/' + variant)
            require(vars(state) == fields, 'Unexpected validator mutation')
            row['runs'][variant] = {'expected': expected, 'actual': actual, 'state_unchanged': True, 'expectation_passed': True}
        rows.append(row)
    changed = [r['id'] for r in rows if r['runs']['before']['actual'] != r['runs']['after']['actual']]
    counterfactual = [r['id'] for r in rows if r['runs']['authored_truthy_guard']['actual'] != r['runs']['after']['actual']]
    require(changed == ['none', 'none_upstream_test_parameters', 'none_later_logprobs_invalid'], 'Unexpected validator changes')
    require(counterfactual == ['zero', 'float_zero', 'boolean_false', 'empty_list'], 'Unexpected truthy-guard differences')
    return {'input_rows': rows, 'summary': {'snapshot_inputs': len(rows), 'unsupported_type_inputs': 8,
            'primary_method_calls': len(rows) * 3, 'expected_checks_passed': len(rows) * 3,
            'before_after_changed_snapshot_ids': changed, 'after_truthy_guard_difference_ids': counterfactual}}


def reproduce():
    require(sys.flags.isolated, 'Run with python -I; do not import local environment modules')
    raw = (ROOT / MANIFEST_PATH).read_bytes()
    require(digest(raw) == MANIFEST_SHA256, 'Manifest changed; review bindings before continuing')
    manifest = json.loads(raw)
    materials, decoded, bindings, constructors = [], {}, {}, {}
    for case in manifest['cases']:
        if case['prNumber'] not in (9034, 2570):
            continue
        for record in case['sourceFiles'] + case['testFiles'] + case['metadataFiles'] + [case['license']]:
            data = verify_file(record)
            materials.append(copy.deepcopy(record))
            if record in case['sourceFiles']:
                side = record['side']
                decoded[(case['prNumber'], side)] = (record, data.decode('utf-8'))
    for side in ('before', 'after'):
        record, source = decoded[(9034, side)]
        bindings['9034_' + side] = [bind_method(record, source, 'Sequence', 'get_output_token_ids_to_return',
            [516, 535 if side == 'before' else 538], TOKENS_BEFORE if side == 'before' else TOKENS_AFTER)]
        for key, authored in HELPERS.items():
            bindings['9034_' + side].append(bind_method(record, source, *key, HELPER_LINES[key][side], authored,
                ('property',) if key[1] == 'output_token_ids' else ()))
        record, source = decoded[(2570, side)]
        bindings['2570_' + side] = [bind_method(record, source, 'SamplingParams', '_verify_args', [160, 194],
                                                  VERIFY_BEFORE if side == 'before' else VERIFY_AFTER)]
        constructors[side] = bind_constructor(record, source, side)
    for (class_name, name), source in HELPERS.items():
        method = build_function(source, class_name + '.' + name)
        cls = DataAdapter if class_name == 'SequenceData' else SequenceAdapter
        setattr(cls, name, property(method) if name == 'output_token_ids' else method)
    tokens = run_tokens({side: build_function(source, '9034-' + side) for side, source in [('before', TOKENS_BEFORE), ('after', TOKENS_AFTER)]})
    params = run_params({side: build_function(source, '2570-' + side) for side, source in
                         [('before', VERIFY_BEFORE), ('after', VERIFY_AFTER), ('authored_truthy_guard', VERIFY_TRUTHY)]})
    return {'schema_version': 1, 'purpose': 'offline source-bound authored local method reproduction, not independent research labels or a benchmark',
            'baseline_commit_prefix': BASELINE,
            'runtime': {'python_implementation': platform.python_implementation(), 'python_version': platform.python_version(),
                        'isolated_mode': bool(sys.flags.isolated)},
            'script': {'file': str(Path(__file__).relative_to(ROOT)), 'sha256': digest(Path(__file__).read_bytes())},
            'manifest': {'file': MANIFEST_PATH, 'sha256': MANIFEST_SHA256},
            'verified_materials': materials, 'source_method_bindings': bindings,
            'sampling_constructor_static_bindings': constructors,
            'authored_counterfactual': {'name': 'authored_truthy_guard', 'source_sha256': digest(VERIFY_TRUTHY.encode()),
                'derivation': 'after _verify_args: replace self.max_tokens is not None and with self.max_tokens and once',
                'historical_variant': False},
            'scope': {'compiled_captured_modules': False, 'upstream_imports': [], 'upstream_constructors_executed': False,
                'upstream_tests_executed': False, 'dependencies_installed': False, 'network_used': False,
                'model_calls': 0, 'ray_runtime_executed': False,
                'sequence_state_adapter': 'Authored classes, array(l) storage, literal offset; six exact source-bound cache/getter helpers; property decorator reapplied. State construction is not upstream Sequence/SequenceData initialization.',
                'sampling_state_adapter': 'SimpleNamespace with statically verified constructor defaults and explicit input overrides; execute full source-bound _verify_args only.',
                'oracle': 'Literal expected type/value/error rows authored separately from executable method text; offset and no-mutation assertions; expectations visible after fix, not independent annotations.',
                'coverage_limit': ['No whole-class lifecycle, append/reset/replacement callers, server streaming or other PR9034 production patches',
                    'No full SamplingParams constructor, beam/greedy validators or generation meaning of None',
                    'Unsupported offsets/cache states/types are boundary probes, not claims of reachable runtime states or legal inputs',
                    'No #2664 actor execution; source card remains static until a suitable Ray runtime',
                    'No review-checkpoint reconstruction, independent later PR, rule-update episode or model-effect evaluation']},
            'vllm_pr_9034': tokens, 'vllm_pr_2570': params,
            'summary': {'status': 'passed', 'real_prs': 2, 'authored_snapshot_inputs': 35,
                        'primary_method_calls': 91, 'expected_checks_passed': 91,
                        'helper_calls_not_counted': True, 'independent_case_or_label_count_established': False}}


def encoded(result):
    return (json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def verify_saved():
    # Use the same reviewed local script in two isolated processes; no shell or
    # repository hooks, and neither reproduction process writes any files.
    command = [sys.executable, '-I', str(Path(__file__).resolve())]
    runs = [subprocess.run(command, cwd=ROOT, check=True, capture_output=True).stdout for _ in range(2)]
    saved = (ROOT / RESULT_PATH).read_bytes()
    require(runs[0] == runs[1] == saved, 'Reruns or saved result differ byte-for-byte')
    data = json.loads(saved)
    require(data['script']['sha256'] == digest(Path(__file__).read_bytes()), 'Result/script binding differs')
    links = []
    report = (ROOT / REPORT_PATH).read_text()
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', report):
        parsed = urlsplit(target)
        if parsed.scheme:
            links.append({'target': target, 'status': 'external_not_network_checked'})
            continue
        path = (ROOT / REPORT_PATH).parent / unquote(parsed.path)
        require(path.is_file(), 'Missing local report link: ' + target)
        if parsed.fragment.startswith('L'):
            match = re.fullmatch(r'L(\d+)(?:-L(\d+))?', parsed.fragment)
            require(match is not None, 'Unrecognized source-line anchor')
            lo, hi = int(match[1]), int(match[2] or match[1])
            require(1 <= lo <= hi <= len(path.read_text().splitlines()), 'Source-line anchor out of range')
        links.append({'target': target, 'status': 'local_file_and_line_range_checked' if parsed.fragment else 'local_file_checked'})
    pointers = []
    for pointer in re.findall(r'`(/vllm_pr_[^`]+)`', report):
        value = data
        for part in pointer.split('/')[1:]:
            value = value[part.replace('~1', '/').replace('~0', '~')]
        pointers.append({'pointer': pointer, 'resolved_type': type(value).__name__})
    binding_checks = 0
    for rows in data['source_method_bindings'].values():
        for row in rows:
            raw = (ROOT / row['file']).read_bytes()
            require(digest(raw) == row['source_sha256'], 'JSON source binding differs')
            lo, hi = row['lines']
            method = ''.join(raw.decode().splitlines(keepends=True)[lo - 1:hi]).encode()
            require(digest(method) == row['raw_method_sha256'], 'JSON method binding differs')
            binding_checks += 1
    for record in data['verified_materials']:
        verify_file(record)
    integrity_probes = verify_rejection_guards(data, saved)
    return {'schema_version': 1, 'status': 'passed', 'isolated_reproduction_processes': 2,
            'reruns_byte_identical': True, 'saved_result_byte_identical': True,
            'artifacts': [{'file': p, 'sha256': digest((ROOT / p).read_bytes())} for p in
                          [str(Path(__file__).relative_to(ROOT)), RESULT_PATH, REPORT_PATH, MANIFEST_PATH]],
            'json_source_method_bindings_rechecked': binding_checks, 'material_bindings_rechecked': len(data['verified_materials']),
            'report_links': links, 'report_json_pointers': pointers,
            'negative_integrity_probes': integrity_probes, 'external_links_network_checked': False}


def verify_rejection_guards(data, saved):
    """Fail-closed checks in a temporary minimal copy; repository bytes untouched."""
    probes = []
    with tempfile.TemporaryDirectory(prefix='pilot-boundary-integrity-') as temporary:
        root = Path(temporary)
        script_path = str(Path(__file__).relative_to(ROOT))
        paths = [script_path, MANIFEST_PATH] + [r['file'] for r in data['verified_materials']]
        for relative in paths:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / relative).read_bytes())
        command = [sys.executable, '-I', str(root / script_path)]
        baseline = subprocess.run(command, cwd=root, check=True, capture_output=True)
        require(baseline.stdout == saved, 'Minimal-copy baseline differs')
        probes.append({'id': 'temporary_copy_baseline', 'status': 'byte_identical'})
        source_path = next(r['file'] for r in data['verified_materials']
                           if r.get('side') == 'before' and 'pr-9034/' in r['file'])
        for name, relative, expected_error in [
            ('manifest_mutation', MANIFEST_PATH, 'Manifest changed; review bindings before continuing'),
            ('source_mutation', source_path, 'Material byte identity changed: ' + source_path),
            ('authored_method_mutation', script_path, 'Transcription differs: get_output_token_ids_to_return')]:
            path = root / relative
            original = path.read_bytes()
            mutated = (original.replace(b'if num_new_tokens == 0:', b'if num_new_tokens <= 0:', 1)
                       if name == 'authored_method_mutation' else original + b'\n')
            require(mutated != original, 'Integrity probe did not modify its copy')
            path.write_bytes(mutated)
            run = subprocess.run(command, cwd=root, check=False, capture_output=True)
            path.write_bytes(original)
            require(run.returncode != 0 and ('RuntimeError: ' + expected_error).encode() in run.stderr,
                    'Integrity mutation was not rejected: ' + name)
            require(not run.stdout, 'Failed integrity probe emitted a result')
            probes.append({'id': name, 'status': 'rejected_before_method_execution', 'error': expected_error})
    return probes


if __name__ == '__main__':
    require(sys.argv[1:] in ([], ['--verify']), 'Only supported flag is --verify')
    result = verify_saved() if sys.argv[1:] else reproduce()
    sys.stdout.buffer.write(encoded(result))
