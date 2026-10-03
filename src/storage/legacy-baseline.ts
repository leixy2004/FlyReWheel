// Frozen adoption boundary for the pre-ledger release. Do not regenerate when adding migrations.
// Names/checksums describe the bytes being adopted, not proof those bytes historically ran.
export const LEGACY_BASELINE = [
  {
    "name": "001_initial",
    "checksum": "27ec7bfccbe265234d819d5336e80b0429733b577c1136a97653625b357ceab8",
    "tables": [
      "qe_rule_bundles",
      "qe_case_lineages",
      "qe_source_splits",
      "qe_problem_cases",
      "qe_runs",
      "qe_findings",
      "qe_feedback",
      "qe_evaluations",
      "qe_proposals",
      "qe_active_rules",
      "qe_promotions"
    ],
    "routines": [
      "qe_reject_mutation"
    ]
  },
  {
    "name": "002_artifact_links",
    "checksum": "3024191b93140345d6ae193bd174efa6c4456dd179f83b03819a605413693e39",
    "tables": [
      "qe_artifact_links"
    ],
    "routines": []
  },
  {
    "name": "003_change_snapshots",
    "checksum": "dae68d208cf9614e61f8982a9067a5f7f9082f7b969a04e5673efda964ccbbe2",
    "tables": [
      "qe_change_snapshots"
    ],
    "routines": []
  },
  {
    "name": "004_semantic_reviews",
    "checksum": "076b1d0f6bc67cff9bf5994810af896e79b0677f65201aadce9d720ebfadf479",
    "tables": [
      "qe_semantic_reviews",
      "qe_semantic_review_findings",
      "qe_semantic_review_feedback",
      "qe_rule_revision_requests"
    ],
    "routines": []
  },
  {
    "name": "005_github_pr_evidence",
    "checksum": "aa2ae2c38812ab52e03dc8c7d388baae750cb5f70227d8926f193cfc456c8e97",
    "tables": [
      "qe_github_pr_evidence"
    ],
    "routines": []
  },
  {
    "name": "006_revision_comparisons",
    "checksum": "1d3fbd195fb9fb9abef2a3767d14e004ea97599bba147e61224469e8d8a214bc",
    "tables": [
      "qe_rule_revision_comparisons",
      "qe_rule_revision_decisions"
    ],
    "routines": []
  },
  {
    "name": "007_pr_mining",
    "checksum": "5c608c1ac9124e51185e5f2532af3158dfa275a72c5695cae068c725418d0343",
    "tables": [
      "qe_pr_mining_requests",
      "qe_pr_mining_candidates"
    ],
    "routines": []
  },
  {
    "name": "008_revision_generation",
    "checksum": "874f4a6e29faf1a2858f0b682180f556db7122fb01ca62056648ec57c31f127b",
    "tables": [
      "qe_revision_candidates"
    ],
    "routines": []
  },
  {
    "name": "009_github_pr_history",
    "checksum": "b473d294462b89d4c083571b50735781859073af14c35544b21099c3a231825f",
    "tables": [
      "qe_github_pr_history"
    ],
    "routines": [
      "qe_history_plan_immutable"
    ]
  },
  {
    "name": "010_revision_outcomes",
    "checksum": "a291efa27b3d7afc4becce72a3e88f27cab29ce5dd2595a79b31b33fe07f3e57",
    "tables": [
      "qe_revision_outcomes"
    ],
    "routines": []
  },
  {
    "name": "011_semantic_governance",
    "checksum": "94702653b2c7705c4c23409d65fe6f45c788da6a8f9ca12ada5cf88349a2e091",
    "tables": [
      "qe_local_semantic_governance_events",
      "qe_local_semantic_governance_heads"
    ],
    "routines": []
  },
  {
    "name": "012_application_jobs",
    "checksum": "6efb2bfe5fdfa9332e5647ac60a9eef072f8126ef2dc31a946a28160a0f695a8",
    "tables": [
      "qe_application_jobs"
    ],
    "routines": [
      "qe_application_job_transition"
    ]
  },
  {
    "name": "013_repository_contexts",
    "checksum": "a68e0cd90bdad52fbe833f2fe2596c95c397897fc6ec09f06185944b931b4a90",
    "tables": [
      "qe_repository_contexts"
    ],
    "routines": []
  },
  {
    "name": "014_governed_reviews",
    "checksum": "9dff96799a8943a54d1a11632ab00d3f3ea34fcdd8fd0de2be496e852d537ee4",
    "tables": [
      "qe_governed_review_plans",
      "qe_governed_review_admissions"
    ],
    "routines": []
  }
] as const;
