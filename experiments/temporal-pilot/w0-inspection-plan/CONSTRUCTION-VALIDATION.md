# Offline protocol review vectors

These are hypothetical procedural counterexamples, not observed cases, labels or
executed selector tests. No executable selector or schema changes are introduced.
The independent review checks the companion protocol against these choices:

| Hypothetical input | Required disposition |
| --- | --- |
| First sorted candidate is unsupported; second looks useful | Preserve both; reject first, cap-exclude second; no replacement |
| Two independent invariants hidden in one candidate | Invalid slot consumed; no manual split or second invocation |
| Constructor interrupted after partial output | Failed attempt retained; no rerun |
| Candidate requires a better exception clause | No rewrite in cohort; new development version outside freeze |
| Two candidates share exact semantic key but different anchors | One earliest representative family, both provenance rows retained |
| Near-synonymous keys differ | Separate families; dependence flagged, no independence inference |
| Earliest W1 cell missing; later cell has a persuasive finding | Index unresolved; cannot skip missing cell |
| Earlier completed cell has no finding; next has one | Continue to that first structurally valid finding, before correctness disclosure |
| Locked index later judged Unknown or disputed | Retain blocked index, no next-finding substitution |
| Locked index is TP and repeated-FP denominator is empty | Report composition and unestimable endpoint, no FP-only reselection |
| W2 lacks independent opportunities for a frozen episode | Retain missingness and unestimable endpoints, no replacement episode |
| Citation UUID and span valid but cited code does not justify claim | Structural validity only; independent semantic assessment required |
| Correct disposition with contradicted explanation | Correctness and support differ; not supported strict resolution |
| One support assessor never submits | Missing assessment retained; no fabricated supported consensus |
| Source enumerator omits a possible operation | Limit claim to locked predefined opportunities; no discovery-recall claim |

Checks performed: unchanged frozen 38-row W0 manifest verified with
`node scripts/freeze-w0-inspection-plan.mjs --check`; all three existing planning
tests passed with `node --test tests/w0-inspection-plan.test.mjs`. These tests cover
only roster identity, input pinning and deterministic manifest generation, not the
new prose selector or semantic-support contract. No efficacy tests were run.

Independent methodology reviewer `identity_audit` identified seven selection
freedoms in the first draft. The final revision moves constructor configuration
before further W0 source exposure, moves feedback/gate locks before W2 content,
distinguishes raw output length from the one-retained-candidate cap, fixes family
ordering and source coordinates, blocks malformed W1 cells, and includes every
predefined output slot. The reviewer reread the final protocol and reported no
remaining methodological blocker. That review does not authenticate participants,
implement selectors, approve execution or supply semantic labels.
