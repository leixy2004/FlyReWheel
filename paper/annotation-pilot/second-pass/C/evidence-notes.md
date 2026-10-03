# Case C: later evidence

These are later materials released for training, not a historical review checkpoint. The local diff is generated from the exact supplied pair. Test files are retained source, not newly executed tests. Reports and comments are source statements, not adjudicated labels. Read evaluator-notes.md for the scope of existing local execution. No actual historical old/new review-rule pair or independent later application is supplied.

Source identity: vLLM PR #9034; before `22f8a69549d30b9b00464141797d274fb6b7e65f`, later `ba30942240d35eb26b503e139eb4b01ccbbeb954`. These identify saved bytes only.

The retained integration test uses a model/server fixture and accompanied serving changes. Those serving files are available only as patches in source-report.json. The test was not run and does not isolate this one method. The full caller/lifecycle invariants and raw review stream are absent.
