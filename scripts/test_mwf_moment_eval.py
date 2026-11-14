#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Match the pattern used by test_mwf_gold_loop.py so the module imports work
# whether the test is launched as `python3 scripts/test_mwf_moment_eval.py` or
# `python3 -m unittest scripts.test_mwf_moment_eval` from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mwf_moment_eval as mme  # noqa: E402
import mwf_alignment_loop as loop  # noqa: E402
import mwf_add_gold_example as add_gold  # noqa: E402
import mwf_alignment_status as status  # noqa: E402
import mwf_extract_moments as extract  # noqa: E402
import mwf_gold_loop as gold_loop  # noqa: E402
import mwf_gold_profile as gold_profile  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
MOMENT_ID = "stage-4-no-shared-agreement-closure"
REAL_MOMENT_ID = "stage-1-fact-reflection"
PHASE1_MOMENT_IDS = [
    "stage-1-emotional-pivot",
    "stage-2-empathy-validation",
    "stage-2-refinement-round",
    "stage-3-mutual-reveal",
    "stage-3-validity-gate",
    "stage-4-willingness-selection",
    "stage-4-no-shared-agreement",
    "transition-stage-2-to-3",
]
TRAJECTORY_MOMENT_IDS = [
    "stage-1-trajectory-fact-to-handoff",
    "stage-2-trajectory-empathy-cycle",
    "stage-3-trajectory-needs-flow",
    "stage-4-trajectory-willingness-to-close",
]
TENDING_MOMENT_IDS = [
    "stage-4-tending-structured-checkin",
]


class TestYamlParsing(unittest.TestCase):
    def test_yaml_parsing_complete(self) -> None:
        moment = mme.load_moment(MOMENT_ID)

        required = {"id", "stages", "description", "seed", "trigger", "capture", "rubric", "improver"}
        self.assertTrue(required.issubset(moment.keys()))
        self.assertTrue(
            moment["rubric"]["reference_transcript_lines"].endswith("james-catherine.md:1257-1306"),
            moment["rubric"]["reference_transcript_lines"],
        )
        self.assertGreaterEqual(len(moment["rubric"]["dimensions"]), 2)
        self.assertEqual(moment["rubric"]["overall_pass_threshold"], 4.0)
        self.assertTrue(
            any(item["id"] == "no_invented_shared_agreement" for item in moment["rubric"]["hard_invariants"])
        )

    def test_stage1_real_moment_yaml_parsing_complete(self) -> None:
        moment = mme.load_moment(REAL_MOMENT_ID)

        self.assertEqual(moment["id"], REAL_MOMENT_ID)
        self.assertEqual(moment["rubric"]["reference_transcript_lines"], "docs/product/source-material/golden-transcripts/adam-eve.md:43-67")
        self.assertEqual(moment["rubric"]["judge_prompt"], "eval/scorer/judge-prompts/stage-1-fact-reflection.md")
        self.assertTrue(
            {"no_stage_jump_content", "no_advice_or_solutioning", "no_grading_of_user"}.issubset(
                {item["id"] for item in moment["rubric"]["hard_invariants"]}
            )
        )

    def test_phase1_library_moments_are_authored_with_required_shape(self) -> None:
        for moment_id in PHASE1_MOMENT_IDS:
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                self.assertEqual(moment["id"], moment_id)
                self.assertEqual(len(moment["rubric"]["dimensions"]), 3)
                self.assertGreaterEqual(len(moment["rubric"]["hard_invariants"]), 2)
                judge_prompt = REPO_ROOT / moment["rubric"]["judge_prompt"]
                self.assertTrue(judge_prompt.exists(), f"{judge_prompt} missing")
                self.assertIn("expected_response", moment)

    def test_list_moments_includes_phase1_library(self) -> None:
        moment_ids = set(mme.list_moments())
        for moment_id in PHASE1_MOMENT_IDS:
            self.assertIn(moment_id, moment_ids)
        for moment_id in TENDING_MOMENT_IDS:
            self.assertIn(moment_id, moment_ids)

    def test_tending_library_moments_are_authored_with_required_shape(self) -> None:
        for moment_id in TENDING_MOMENT_IDS:
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                self.assertEqual(moment["id"], moment_id)
                self.assertEqual(moment["rubric"]["reference_transcript_lines"], "docs/product/source-material/golden-transcripts/core-protocol-update.md:261-283")
                self.assertEqual(moment["rubric"]["judge_prompt"], "eval/scorer/judge-prompts/stage-4-tending-structured-checkin.md")
                self.assertTrue((REPO_ROOT / moment["rubric"]["judge_prompt"]).exists())
                self.assertTrue(
                    {"no_agreement_equals_resolution", "no_generic_extension_after_failed_support", "private_reminders_stay_private"}.issubset(
                        {item["id"] for item in moment["rubric"]["hard_invariants"]}
                    )
                )

    def test_tending_mock_scoring_catches_bad_extension_and_partner_notification(self) -> None:
        moment = mme.load_moment("stage-4-tending-structured-checkin")

        score = mme.score_response(
            moment,
            "The agreement resolved the need. It did not help, but just keep going with the same plan. Your private reminder will notify your partner.",
        )

        failed = {item["id"] for item in score["hard_invariants"] if not item["pass"]}
        self.assertTrue(
            {"no_agreement_equals_resolution", "no_generic_extension_after_failed_support", "private_reminders_stay_private"}.issubset(failed)
        )

    def test_gold_loop_scenarios_come_from_registry(self) -> None:
        self.assertEqual(gold_loop.SCENARIOS["adam-eve"], ("Adam", "Eve"))
        self.assertEqual(gold_loop.SCENARIOS["james-catherine"], ("James", "Catherine"))
        self.assertEqual(gold_loop.scenario_sides("james-catherine"), ["james", "catherine"])
        self.assertEqual(
            gold_loop.scenario_gold_profile_path("james-catherine"),
            REPO_ROOT / "eval/gold-profiles/james-catherine.json",
        )

    def test_gold_scenario_gates_are_valid(self) -> None:
        payload = json.loads((REPO_ROOT / "eval/gold-scenarios.json").read_text())
        allowed_modes = {"fresh_gold_loop", "snapshot_replay", "seed_target_stage", "full_flow_gate"}
        scenario_ids = {item["id"] for item in payload["scenarios"]}

        for scenario in payload["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                self.assertTrue(scenario["participants"])
                self.assertTrue((REPO_ROOT / scenario["gold_profile"]).exists())
                self.assertTrue((REPO_ROOT / scenario["reference_transcript"]).exists())
                self.assertIn(scenario["id"], scenario_ids)

                gates = scenario.get("gates") or [scenario.get("gate", {})]
                self.assertTrue(gates)
                for gate in gates:
                    mode = gate.get("mode", "fresh_gold_loop")
                    self.assertIn(mode, allowed_modes)
                    self.assertGreater(float(gate.get("target_score", 4.0)), 0)
                    self.assertGreater(int(gate.get("max_iterations", 1)), 0)
                    if mode in {"fresh_gold_loop", "full_flow_gate", "snapshot_replay"}:
                        self.assertGreaterEqual(int(gate.get("stop_after_stage", 2)), 1)
                    if mode == "snapshot_replay":
                        self.assertTrue(gate.get("snapshot_ref"))
                    if mode == "seed_target_stage":
                        self.assertTrue(gate.get("seed_target_stage"))

    def test_gold_snapshot_registry_shape(self) -> None:
        payload = json.loads((REPO_ROOT / "eval/gold-snapshot-registry.json").read_text())
        scenario_ids = {item["id"] for item in json.loads((REPO_ROOT / "eval/gold-scenarios.json").read_text())["scenarios"]}
        seen_ids: set[str] = set()

        self.assertIsInstance(payload.get("snapshots"), list)
        for entry in payload["snapshots"]:
            with self.subTest(snapshot=entry.get("id")):
                self.assertIsInstance(entry.get("id"), str)
                self.assertNotIn(entry["id"], seen_ids)
                seen_ids.add(entry["id"])
                self.assertIn(entry.get("scenario"), scenario_ids)
                self.assertIsInstance(entry.get("snapshot"), str)
                self.assertGreaterEqual(int(entry.get("starts_at_stage", 1)), 1)
                self.assertIsInstance(entry.get("starts_for"), list)
                self.assertTrue(entry.get("purpose"))
                self.assertIsInstance(entry.get("expected_state"), list)
                self.assertIsInstance(entry.get("target_behaviors"), list)
                self.assertIsInstance(entry.get("required_invariants"), list)

    def test_gold_loop_actor_prompt_requires_clicking_feel_heard_cta(self) -> None:
        actor = gold_loop.Actor("Eve", "http://localhost:8082/session/test?e2e-user-id=eve")
        partner = gold_loop.Actor("Adam", "http://localhost:8082/session/test?e2e-user-id=adam")

        prompt = gold_loop.build_actor_prompt(
            actor,
            partner,
            "session-test",
            2,
            REPO_ROOT / "eval/runs/test-run",
            "adam-eve",
        )
        resume_prompt = gold_loop.build_resume_prompt(actor, partner, "session-test", 2)

        for text in (prompt, resume_prompt):
            self.assertIn('If a visible Stage 1 "I feel heard" / feel-heard confirmation CTA is present', text)
            self.assertIn("click the CTA", text)
            self.assertIn("Do not type a chat message to satisfy a product gate", text)
            self.assertIn("Do not report Stage 2 progress unless the UI actually moves past the Stage 1 gate", text)

    def test_gold_loop_uses_profile_initiator_separate_from_registry_order(self) -> None:
        james_catherine = gold_loop.infer_role_shape_from_profile("james-catherine")
        self.assertEqual(james_catherine["initiator"], "Catherine")
        self.assertEqual(james_catherine["invited"], "James")
        self.assertEqual(gold_loop.scenario_start_character("james-catherine"), "Catherine")

        adam_eve = gold_loop.infer_role_shape_from_profile("adam-eve")
        self.assertEqual(adam_eve["initiator"], "Adam")
        self.assertEqual(adam_eve["invited"], "Eve")
        self.assertEqual(gold_loop.scenario_start_character("adam-eve"), "Adam")

    def test_gold_loop_profile_initiator_inference_generalizes_from_stage0_evidence(self) -> None:
        profile = {
            "stage_profiles": {
                "stage_0": {
                    "mwf_effect_to_preserve": [
                        "MWF lines 1-2: Before we begin, let's put together a short message for Blair.",
                    ],
                },
            },
        }
        with mock.patch.dict(gold_loop.SCENARIOS, {"alex-blair": ("Alex", "Blair")}), \
             mock.patch.object(gold_loop, "load_gold_profile", return_value=profile):
            role_shape = gold_loop.infer_role_shape_from_profile("alex-blair")

        self.assertEqual(role_shape["initiator"], "Alex")
        self.assertEqual(role_shape["invited"], "Blair")
        self.assertEqual(role_shape["confidence"], "medium")

    def test_fresh_session_initiator_invariant_catches_mismatch(self) -> None:
        run_data = {
            "start": {"mode": "fresh"},
            "role_shape": {"initiator": "Catherine", "invited": "James", "confidence": "high"},
            "session_roles": {"assigned_character": "James", "partner_character": "Catherine"},
        }

        result = gold_loop.check_session_started_with_profile_initiator(run_data, "james-catherine")

        self.assertEqual(result["status"], "fail")
        self.assertIn("profile initiator", result["evidence"][0])

    def test_visible_control_tag_invariant_catches_feel_heard_xml_tag(self) -> None:
        transcripts = [
            (
                Path("catherine-stage1.md"),
                "- side: `catherine`\n- stage: `1`\n\n**[2026-05-06 15:00:00] AI:**\n<feel_heard_check>Y</feel_heard_check>\n\n",
            )
        ]

        result = gold_loop.check_no_visible_control_tags(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("<feel_heard_check>", result["evidence"][0])

    def test_visible_control_tag_invariant_catches_ready_share_xml_tag(self) -> None:
        transcripts = [
            (
                Path("james-stage2.md"),
                "- side: `james`\n- stage: `2`\n\n**[2026-05-06 15:00:00] AI:**\n<ready-share>Y</ready-share>\n\n",
            )
        ]

        result = gold_loop.check_no_visible_control_tags(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("<ready-share>", result["evidence"][0])

    def test_visible_control_tag_invariant_catches_needs_ready_payload(self) -> None:
        transcripts = [
            (
                Path("catherine-stage1.md"),
                "\n".join(
                    [
                        "- side: `catherine`",
                        "- stage: `1`",
                        "",
                        "**[2026-05-06 15:00:00] AI:**",
                        "<needs_ready>",
                        "{",
                        '  "core_needs": ["clarity"],',
                        '  "boundary": "Reacting is not causing"',
                        "}",
                        "</needs_ready>",
                        "Okay. You're clear on what you need.",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_no_visible_control_tags(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("<needs_ready>", result["evidence"][0])

    def test_chat_copy_visible_input_invariant_accepts_following_user_turn(self) -> None:
        transcripts = [
            (
                Path("adam-stage1.md"),
                "\n".join(
                    [
                        "# Adam Stage 1 Transcript",
                        "",
                        "- side: `adam`",
                        "- stage: `1`",
                        "- visible_cta_state: see milestone/system lines when captured",
                        "",
                        "**[2026-05-06 15:00:00] AI:**",
                        "In the meantime, let's keep going so you're not just sitting here.",
                        "",
                        "**[2026-05-06 15:00:10] Adam:**",
                        "It starts gently sometimes, but I hear urgency in it.",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_chat_copy_has_visible_input(transcripts)

        self.assertEqual(result["status"], "pass")

    def test_chat_copy_visible_input_invariant_fails_without_metadata_or_user_turn(self) -> None:
        transcripts = [
            (
                Path("adam-stage1.md"),
                "\n".join(
                    [
                        "# Adam Stage 1 Transcript",
                        "",
                        "- side: `adam`",
                        "- stage: `1`",
                        "- visible_cta_state: see milestone/system lines when captured",
                        "",
                        "**[2026-05-06 15:00:00] AI:**",
                        "In the meantime, let's keep going so you're not just sitting here.",
                        "",
                        "### STAGE 1 COMPLETED",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_chat_copy_has_visible_input(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("adam-stage1.md", result["evidence"][0])

    def test_chat_copy_visible_input_invariant_ignores_shared_context_quotes(self) -> None:
        transcripts = [
            (
                Path("eve-stage2.md"),
                "\n".join(
                    [
                        "# Eve Stage 2 Transcript",
                        "",
                        "- side: `eve`",
                        "- stage: `2`",
                        "- visible_cta_state: see milestone/system lines when captured",
                        "",
                        "---",
                        "**📤 Adam SHARED WITH YOU:**",
                        "I'm telling you this because I'm still here and still love you.",
                        "*2026-05-07 04:03:45*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_chat_copy_has_visible_input(transcripts)

        self.assertEqual(result["status"], "pass")

    def test_shared_context_blocks_must_be_labeled_in_stable_transcripts(self) -> None:
        transcripts = [
            (
                Path("adam-stage2.md"),
                "\n".join(
                    [
                        "# Adam Stage 2 Transcript",
                        "",
                        "- side: `adam`",
                        "- stage: `2`",
                        "",
                        "---",
                        "The resentment is already here, and I hate that I carry it.",
                        "*2026-05-07 00:31:15*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_transcript_shared_context_blocks_labeled(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("unlabeled separator block", result["evidence"][0])

    def test_shared_context_blocks_accept_explicit_partner_label(self) -> None:
        transcripts = [
            (
                Path("adam-stage2.md"),
                "\n".join(
                    [
                        "# Adam Stage 2 Transcript",
                        "",
                        "- side: `adam`",
                        "- stage: `2`",
                        "",
                        "---",
                        "**📤 Eve SHARED WITH YOU:**",
                        "The resentment is already here, and I hate that I carry it.",
                        "*2026-05-07 00:31:15*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_transcript_shared_context_blocks_labeled(transcripts)

        self.assertEqual(result["status"], "pass")

    def test_shared_context_directionality_catches_own_suggestion_labeled_as_partner_shared(self) -> None:
        transcripts = [
            (
                Path("james-stage2.md"),
                "\n".join(
                    [
                        "# James Stage 2 Transcript",
                        "",
                        "- side: `james`",
                        "- stage: `2`",
                        "",
                        "---",
                        "💡 SHARE SUGGESTION (to help Catherine understand you better):",
                        "I feel convicted before I finish speaking.",
                        "*2026-05-07 04:15:05*",
                        "---",
                        "",
                        "---",
                        "**📤 Catherine SHARED WITH YOU:**",
                        "I feel convicted before I finish speaking.",
                        "*2026-05-07 04:17:16*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_shared_context_directionality(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("duplicates this side's own share suggestion", result["evidence"][0])

    def test_shared_context_directionality_accepts_distinct_partner_context(self) -> None:
        transcripts = [
            (
                Path("james-stage2.md"),
                "\n".join(
                    [
                        "# James Stage 2 Transcript",
                        "",
                        "- side: `james`",
                        "- stage: `2`",
                        "",
                        "---",
                        "💡 SHARE SUGGESTION (to help Catherine understand you better):",
                        "I feel convicted before I finish speaking.",
                        "*2026-05-07 04:15:05*",
                        "---",
                        "",
                        "---",
                        "**📤 Catherine SHARED WITH YOU:**",
                        "I need safety before I can keep trying.",
                        "*2026-05-07 04:17:16*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_shared_context_directionality(transcripts)

        self.assertEqual(result["status"], "pass")

    def test_internal_reconciler_analysis_fails_stable_transcript_invariant(self) -> None:
        transcripts = [
            (
                Path("eve-stage2.md"),
                "\n".join(
                    [
                        "# Eve Stage 2 Transcript",
                        "",
                        "- side: `eve`",
                        "- stage: `2`",
                        "",
                        "---",
                        "**📊 RECONCILER ANALYSIS (Your empathy vs Adam's actual feelings):",
                        "  Alignment: 75%",
                        "  Gap Severity: moderate",
                        "  Action: OFFER_OPTIONAL**",
                        "*2026-05-07 04:31:15*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_no_internal_reconciler_analysis(transcripts)

        self.assertEqual(result["status"], "fail")
        self.assertIn("internal reconciler analysis leaked", result["evidence"][0])

    def test_internal_reconciler_analysis_allows_clean_share_blocks(self) -> None:
        transcripts = [
            (
                Path("eve-stage2.md"),
                "\n".join(
                    [
                        "# Eve Stage 2 Transcript",
                        "",
                        "- side: `eve`",
                        "- stage: `2`",
                        "",
                        "---",
                        "**📤 Adam SHARED WITH YOU:**",
                        "I feel scared that I am proving your point.",
                        "*2026-05-07 04:31:15*",
                        "---",
                        "",
                    ]
                ),
            )
        ]

        result = gold_loop.check_no_internal_reconciler_analysis(transcripts)

        self.assertEqual(result["status"], "pass")

    def test_gold_loop_service_env_defaults_to_real_llm(self) -> None:
        args = gold_loop.build_parser().parse_args(
            ["run", "--api-url", "http://localhost:3000", "--app-url", "http://localhost:8082"]
        )

        env = gold_loop.build_loop_service_env(args, base_env={})

        self.assertEqual(env["MOCK_LLM"], "false")
        self.assertEqual(env["E2E_AUTH_BYPASS"], "true")
        self.assertEqual(env["NODE_ENV"], "development")

    def test_gold_loop_service_env_preserves_explicit_mock_llm_override(self) -> None:
        args = gold_loop.build_parser().parse_args(
            ["run", "--api-url", "http://localhost:3000", "--app-url", "http://localhost:8082"]
        )

        env = gold_loop.build_loop_service_env(args, base_env={"MOCK_LLM": "true"})

        self.assertEqual(env["MOCK_LLM"], "true")

    def test_gold_profile_generator_emits_role_shape(self) -> None:
        profile = gold_profile.build_profile(
            REPO_ROOT / "docs/product/source-material/golden-transcripts/james-catherine.md",
            "james-catherine",
        )

        self.assertEqual(profile["role_shape"]["initiator"], "Catherine")
        self.assertEqual(profile["role_shape"]["invited"], "James")

    def test_trajectory_moment_schema_validation(self) -> None:
        for moment_id in TRAJECTORY_MOMENT_IDS:
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                self.assertIn("trajectory", moment)
                self.assertGreaterEqual(len(moment["trajectory"]), 3)
                self.assertEqual(len(moment["rubric"]["dimensions"]), 3)

    def test_malformed_trajectory_rejected(self) -> None:
        moment = mme.load_moment("stage-1-trajectory-fact-to-handoff")
        malformed = dict(moment)
        malformed["trajectory"] = [{"user_turn": "missing ai"}]

        with self.assertRaises(mme.MomentEvalError):
            mme.validate_moment(malformed)


class TestSeederIdempotence(unittest.TestCase):
    def test_seeder_idempotence_clean_session_ids(self) -> None:
        moment = mme.load_moment(MOMENT_ID)
        first = mme.seed_state(moment)
        second = mme.seed_state(moment)

        self.assertNotEqual(first.session_id, second.session_id)
        self.assertEqual(first.rows, second.rows)
        self.assertEqual(first.rows["participants"], 2)
        self.assertGreaterEqual(first.rows["stage4Proposals"], 2)
        self.assertTrue(any(s["choice"] == "WILLING" for s in first.selections))
        self.assertTrue(any(s["choice"] == "NOT_WILLING" for s in first.selections))


class TestRunnerHappyPath(unittest.TestCase):
    def test_runner_happy_path_with_mocked_backend(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with mock.patch.object(mme, "RUNS_ROOT", tmp_path):
                args = mme.build_parser().parse_args(
                    ["run", "--moment", MOMENT_ID, "--max-iterations", "1", "--no-improve"]
                )
                created = mme.run_loop(args)

            self.assertEqual(len(created), 1)
            run_dir = created[0]
            for name in [
                "seed-state.json",
                "ai-response.md",
                "state-delta.json",
                "score.json",
                "score-rationale.md",
                "run.json",
            ]:
                self.assertTrue((run_dir / name).exists(), f"{name} missing")


class TestScorer(unittest.TestCase):
    def test_scorer_schema_validation(self) -> None:
        moment = mme.load_moment(MOMENT_ID)
        score = mme.score_response(
            moment,
            "There is no overlap, so no shared agreement. Your individual commitment stands.",
        )

        self.assertIsInstance(score["overall_score"], float)
        self.assertIsInstance(score["dimensions"], dict)
        self.assertIsInstance(score["hard_invariants"], list)
        self.assertIn(score["verdict"], {"eval_pass", "eval_warn", "eval_fail"})
        for item in score["hard_invariants"]:
            self.assertTrue({"id", "pass"}.issubset(item.keys()))

    def test_hard_invariant_failure_overrides_scores(self) -> None:
        moment = mme.load_moment(MOMENT_ID)
        score = mme.score_response(
            moment,
            "You both agreed to the pause agreement. Your shared agreement is in place.",
        )

        invariant = next(
            item for item in score["hard_invariants"] if item["id"] == "no_invented_shared_agreement"
        )
        self.assertFalse(invariant["pass"])
        self.assertEqual(score["verdict"], "eval_fail")

    def test_stage1_hard_invariant_failure_overrides_mock_judge_scores(self) -> None:
        moment = mme.load_moment(REAL_MOMENT_ID)
        score = mme.score_response(
            moment,
            "You should try a strategy and ask Eve what she needs next.",
            real=True,
            mock_judge=True,
        )

        self.assertEqual(score["verdict"], "eval_fail")
        self.assertTrue(any(not item["pass"] for item in score["hard_invariants"]))

    def test_stage1_advice_invariant_catches_what_different_looks_like(self) -> None:
        self.assertFalse(
            mme.evaluate_stage1_hard_invariant(
                "no_advice_or_solutioning",
                'What does "being different" look like in your head?',
            )
        )

    def test_phase1_expected_responses_pass_mock_scoring(self) -> None:
        for moment_id in PHASE1_MOMENT_IDS:
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                state = mme.seed_state(moment)
                score = mme.score_response(moment, mme.default_ai_response(state))
                self.assertEqual(score["verdict"], "eval_pass", score)

    def test_phase1_hard_invariants_have_negative_cases(self) -> None:
        cases = {
            "stage-1-emotional-pivot": "Great. You feel fully heard, so now write an empathy attempt and move to agreement.",
            "stage-2-empathy-validation": "Give a verdict: yes or no, is it accurate or not? Then we can make proposals.",
            "stage-2-refinement-round": "Here is the corrected version I fixed for you. Now name your needs.",
            "stage-3-mutual-reveal": "You both have a shared need and common ground. The overlap is obvious.",
            "stage-3-validity-gate": "The overlap is clear, so we can rush into Stage 4 proposals now.",
            "stage-4-willingness-selection": "You should have picked more. You owe them a shared agreement.",
            "stage-4-no-shared-agreement": "You both agreed to the pause agreement. Your shared agreement is in place.",
            "transition-stage-2-to-3": "What do you need from Eve? You should try an action step next.",
        }
        for moment_id, bad_response in cases.items():
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                score = mme.score_response(moment, bad_response)
                self.assertEqual(score["verdict"], "eval_fail", score)
                self.assertTrue(any(not item["pass"] for item in score["hard_invariants"]))

    def test_trajectory_expected_responses_pass_mock_scoring(self) -> None:
        for moment_id in TRAJECTORY_MOMENT_IDS:
            with self.subTest(moment_id=moment_id):
                moment = mme.load_moment(moment_id)
                state = mme.seed_state(moment)
                score = mme.score_response(moment, mme.default_ai_response(state))
                self.assertEqual(score["verdict"], "eval_pass", score)


class TestImprover(unittest.TestCase):
    def test_improver_invocation_and_version_tracking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            run_dir = tmp_path / "run"
            run_dir.mkdir()
            with mock.patch.object(mme, "PROMPT_VERSIONS_ROOT", tmp_path / "prompt-versions"), \
                 mock.patch.object(mme, "BASELINES_ROOT", tmp_path / "baselines"):
                moment = mme.load_moment(MOMENT_ID)
                score = mme.score_response(moment, "You both agreed to a shared agreement.")
                version = mme.run_improver(
                    run_dir, moment, score, allow_protected_branch_patch=True
                )

            self.assertTrue(version.exists())
            self.assertEqual(version.parent, tmp_path / "prompt-versions/mwf/stage-4")
            self.assertTrue((run_dir / "improvement-plan.md").exists())
            self.assertTrue((run_dir / "patch-summary.md").exists())

    def test_stage1_improver_writes_stage1_version_not_stage4(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            run_dir = tmp_path / "run"
            run_dir.mkdir()
            with mock.patch.object(mme, "PROMPT_VERSIONS_ROOT", tmp_path / "prompt-versions"), \
                 mock.patch.object(mme, "BASELINES_ROOT", tmp_path / "baselines"):
                moment = mme.load_moment(REAL_MOMENT_ID)
                score = mme.score_response(moment, "Thin reflection.", real=True, mock_judge=True)
                version = mme.run_improver(run_dir, moment, score, allow_protected_branch_patch=True)

            self.assertEqual(version.parent, tmp_path / "prompt-versions/mwf/stage-1")
            self.assertIn("Stage 4 remains untouched", version.read_text(encoding="utf-8"))

    def test_branch_protection_refuses_main_for_patch_mode(self) -> None:
        with mock.patch.object(mme, "git_branch", return_value="main"):
            with self.assertRaises(mme.MomentEvalError) as ctx:
                mme.ensure_patch_branch(False)
        self.assertIn("Refusing patch mode on protected branch 'main'", str(ctx.exception))

    def test_cross_moment_regularization_keeps_non_regressing_revision(self) -> None:
        moment = mme.load_moment("stage-2-empathy-validation")
        result = mme.evaluate_cross_moment_regularization(moment)

        self.assertTrue(result["pass"], result)
        self.assertGreaterEqual(result["same_stage_moment_count"], 1)

    def test_cross_moment_regularization_rejects_score_regression(self) -> None:
        moment = mme.load_moment("stage-2-empathy-validation")
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(mme, "BASELINES_ROOT", Path(tmp)):
                result = mme.evaluate_cross_moment_regularization(
                    moment,
                    {"stage-2-refinement-round": "Generic response that misses the required refinement details."},
                )

        self.assertFalse(result["pass"])
        failed = [item for item in result["results"] if item["moment"] == "stage-2-refinement-round"][0]
        self.assertIn("dropped below baseline", failed["reason"])

    def test_cross_moment_regularization_accepts_equal_low_baseline(self) -> None:
        source = {"id": "source", "stages": [1]}
        other = {
            "id": "other",
            "stages": [1],
            "rubric": {"hard_invariants": [], "dimensions": [], "overall_pass_threshold": 4.0},
        }
        low_score = {
            "overall_score": 2.5,
            "hard_invariants": [],
            "dimensions": {},
            "verdict": "eval_fail",
        }

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(mme, "BASELINES_ROOT", Path(tmp)), \
                 mock.patch.object(mme, "load_same_stage_moments", return_value=[other]), \
                 mock.patch.object(mme, "seed_state", return_value=mock.Mock()), \
                 mock.patch.object(mme, "default_ai_response", return_value="same low response"), \
                 mock.patch.object(mme, "score_response", return_value=low_score):
                result = mme.evaluate_cross_moment_regularization(source)

        self.assertTrue(result["pass"], result)
        self.assertEqual(result["results"][0]["baseline"], 2.5)
        self.assertEqual(result["results"][0]["score"], 2.5)

    def test_cross_moment_regularization_accepts_small_delta_drop(self) -> None:
        source = {"id": "source", "stages": [1]}
        other = {
            "id": "other",
            "stages": [1],
            "rubric": {"hard_invariants": [], "dimensions": [], "overall_pass_threshold": 4.0},
        }
        candidate_score = {
            "overall_score": 2.97,
            "hard_invariants": [],
            "dimensions": {},
            "verdict": "eval_fail",
        }

        with tempfile.TemporaryDirectory() as tmp:
            baseline_dir = Path(tmp)
            (baseline_dir / "other.json").write_text(
                json.dumps({"moment_id": "other", "overall_score": 3.0, "source": "test"}),
                encoding="utf-8",
            )
            with mock.patch.object(mme, "BASELINES_ROOT", baseline_dir), \
                 mock.patch.object(mme, "load_same_stage_moments", return_value=[other]), \
                 mock.patch.object(mme, "seed_state", return_value=mock.Mock()), \
                 mock.patch.object(mme, "default_ai_response", return_value="unused"), \
                 mock.patch.object(mme, "score_response", return_value=candidate_score):
                result = mme.evaluate_cross_moment_regularization(source, {"other": "candidate"})

        self.assertTrue(result["pass"], result)
        self.assertEqual(result["results"][0]["minimum_score"], 2.95)

    def test_cross_moment_regularization_rejects_large_delta_drop_with_logged_baseline(self) -> None:
        source = {"id": "source", "stages": [1]}
        other = {
            "id": "other",
            "stages": [1],
            "rubric": {"hard_invariants": [], "dimensions": [], "overall_pass_threshold": 4.0},
        }
        candidate_score = {
            "overall_score": 2.9,
            "hard_invariants": [],
            "dimensions": {},
            "verdict": "eval_fail",
        }

        with tempfile.TemporaryDirectory() as tmp:
            baseline_dir = Path(tmp)
            (baseline_dir / "other.json").write_text(
                json.dumps({"moment_id": "other", "overall_score": 3.0, "source": "test"}),
                encoding="utf-8",
            )
            with mock.patch.object(mme, "BASELINES_ROOT", baseline_dir), \
                 mock.patch.object(mme, "load_same_stage_moments", return_value=[other]), \
                 mock.patch.object(mme, "seed_state", return_value=mock.Mock()), \
                 mock.patch.object(mme, "default_ai_response", return_value="unused"), \
                 mock.patch.object(mme, "score_response", return_value=candidate_score):
                result = mme.evaluate_cross_moment_regularization(source, {"other": "candidate"})

        self.assertFalse(result["pass"], result)
        self.assertEqual(result["results"][0]["baseline"], 3.0)
        self.assertIn("baseline 3.0", result["results"][0]["reason"])

    def test_initial_baseline_write_is_not_overwritten_by_later_runs(self) -> None:
        moment = {"id": "baseline-moment"}
        first = {"overall_score": 2.5, "verdict": "eval_fail", "dimensions": {}}
        second = {"overall_score": 3.5, "verdict": "eval_warn", "dimensions": {}}

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(mme, "BASELINES_ROOT", Path(tmp)):
                first_path = mme.ensure_initial_baseline(moment, first)
                second_path = mme.ensure_initial_baseline(moment, second)
                payload = json.loads((Path(tmp) / "baseline-moment.json").read_text(encoding="utf-8"))

        self.assertIsNotNone(first_path)
        self.assertIsNone(second_path)
        self.assertEqual(payload["overall_score"], 2.5)

    def test_cross_moment_regularization_rejects_hard_invariant_regression(self) -> None:
        moment = mme.load_moment("stage-3-validity-gate")
        result = mme.evaluate_cross_moment_regularization(
            moment,
            {"stage-3-mutual-reveal": "You both have common ground and overlap, so skip noticing."},
        )

        self.assertFalse(result["pass"])
        failed = [item for item in result["results"] if item["moment"] == "stage-3-mutual-reveal"][0]
        self.assertIn("hard invariant failed", failed["reason"])

    def test_cross_moment_regularization_uses_real_judge_when_requested(self) -> None:
        moment = mme.load_moment("stage-2-empathy-validation")
        judged = (
            {
                "dimensions": {
                    "integrates_feedback": {"score": 4.5, "rationale": "ok"},
                    "keeps_thread": {"score": 4.5, "rationale": "ok"},
                    "non_corrective_tone": {"score": 4.5, "rationale": "ok"},
                    "honors_empathy_completion": {"score": 4.5, "rationale": "ok"},
                    "orients_next_stage": {"score": 4.5, "rationale": "ok"},
                    "no_premature_needs_extraction": {"score": 4.5, "rationale": "ok"},
                    "review_invited": {"score": 4.5, "rationale": "ok"},
                    "feedback_integrated": {"score": 4.5, "rationale": "ok"},
                    "validation_honored": {"score": 4.5, "rationale": "ok"},
                }
            },
            {"model": "mock"},
        )
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(mme, "BASELINES_ROOT", Path(tmp)), \
                 mock.patch.object(mme, "score_with_real_judge", return_value=judged) as real_judge:
                result = mme.evaluate_cross_moment_regularization(moment, real=True, mock_judge=False)

        self.assertTrue(result["pass"], result)
        self.assertGreaterEqual(real_judge.call_count, 1)

    def test_improvement_plan_logs_cross_moment_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            run_dir = tmp_path / "run"
            run_dir.mkdir()
            with mock.patch.object(mme, "PROMPT_VERSIONS_ROOT", tmp_path / "prompt-versions"), \
                 mock.patch.object(mme, "BASELINES_ROOT", tmp_path / "baselines"):
                moment = mme.load_moment("stage-2-empathy-validation")
                score = mme.score_response(moment, "Thin response.")
                mme.run_improver(run_dir, moment, score, allow_protected_branch_patch=True)

            plan = (run_dir / "improvement-plan.md").read_text(encoding="utf-8")
            self.assertIn("## Cross-Moment Regularization", plan)
            self.assertIn("stage-2-refinement-round", plan)


class TestRealModePlumbing(unittest.TestCase):
    def test_real_seed_uses_helper_boundary(self) -> None:
        fake_seed = {"sessionId": "cmomentreal123", "rows": {"Session": 1}, "messages": [], "stageProgress": []}
        with mock.patch.object(mme, "run_real_helper", return_value=fake_seed) as helper:
            result = mme.real_seed_state(mme.load_moment(REAL_MOMENT_ID))

        self.assertEqual(result["sessionId"], "cmomentreal123")
        helper.assert_called_once_with("seed")

    def test_cost_guard_refuses_before_real_judge(self) -> None:
        moment = mme.load_moment(REAL_MOMENT_ID)
        args = mme.build_parser().parse_args(
            [
                "run",
                "--moment",
                REAL_MOMENT_ID,
                "--real",
                "--mock-response",
                "A local response that should never reach the judge.",
                "--max-judge-cost-cents",
                "0",
            ]
        )
        args.mock_judge = False

        with mock.patch.object(mme, "real_seed_state", return_value={"sessionId": "cmomentreal123"}), \
             mock.patch.object(mme, "score_with_real_judge") as judge:
            with self.assertRaises(mme.MomentEvalError) as ctx:
                mme.run_real_iteration(moment, args, None, None)

        self.assertIn("Judge cost guard refused call", str(ctx.exception))
        judge.assert_not_called()

    def test_real_mode_flag_defaults_to_real_judge(self) -> None:
        args = mme.build_parser().parse_args(["run", "--moment", REAL_MOMENT_ID, "--real", "--max-iterations", "1"])
        if args.mock_judge is None:
            args.mock_judge = not args.real
        self.assertFalse(args.mock_judge)

    def test_real_trajectory_uses_trajectory_helper_boundary(self) -> None:
        moment = mme.load_moment("stage-1-trajectory-fact-to-handoff")
        args = mme.build_parser().parse_args(
            ["run", "--moment", moment["id"], "--real", "--mock-judge", "--max-iterations", "1"]
        )
        fake = {
            "seed": {"sessionId": "cmomenttrajectory"},
            "aiResponse": "Trajectory response with solid fear without deciding",
            "stateDelta": {"trajectory_steps": [{"turn": 1}]},
        }
        with mock.patch.object(mme, "run_real_helper", return_value=fake) as helper:
            state, response, state_delta, _score, _raw = mme.run_real_iteration(moment, args, None, None)

        self.assertEqual(state["sessionId"], "cmomenttrajectory")
        self.assertIn("Trajectory response", response)
        self.assertIn("trajectory_steps", state_delta)
        helper.assert_called_once()
        self.assertEqual(helper.call_args.args[0], "run-trajectory")

    def test_flat_real_judge_result_is_normalized(self) -> None:
        moment = mme.load_moment("stage-2-empathy-validation")
        flat = {
            "parsed": {
                "confirm_or_refine_invitation": 9,
                "non_forcing_posture": 8,
                "protects_consent": 7,
                "rationale": "Flat result",
            },
            "raw": "{}",
        }
        with mock.patch.object(mme, "run_real_helper", return_value=flat):
            parsed, _raw = mme.score_with_real_judge(moment, "What landed? What felt off?")

        self.assertEqual(parsed["dimensions"]["confirm_or_refine_invitation"]["score"], 4.5)
        self.assertEqual(parsed["dimensions"]["non_forcing_posture"]["score"], 4.0)

    def test_root_dimension_real_judge_result_is_normalized(self) -> None:
        moment = mme.load_moment("stage-1-emotional-pivot")
        root_dimensions = {
            "parsed": {
                "emotional_reflection": {"score": 8, "rationale": "Good"},
                "listening_mode": {"score": 9, "rationale": "Good"},
                "no_premature_gate": {"score": 10, "rationale": "Good"},
            },
            "raw": "{}",
        }
        with mock.patch.object(mme, "run_real_helper", return_value=root_dimensions):
            parsed, _raw = mme.score_with_real_judge(moment, "What is she saying about you?")

        self.assertEqual(parsed["dimensions"]["emotional_reflection"]["score"], 4.0)
        self.assertEqual(parsed["dimensions"]["no_premature_gate"]["score"], 5.0)

    def test_fenced_real_judge_raw_json_is_reparsed(self) -> None:
        moment = mme.load_moment("stage-3-mutual-reveal")
        fenced = {
            "parsed": {"parse_error": True},
            "raw": """```json
{
  "dimensions": {
    "mutual_need_visibility": {"score": 4, "rationale": "Good"},
    "no_overlap_analysis": {"score": 4, "rationale": "Good"},
    "open_non_directive_question": {"score": 3, "rationale": "Adequate"}
  }
}
```""",
        }
        with mock.patch.object(mme, "run_real_helper", return_value=fenced):
            parsed, _raw = mme.score_with_real_judge(moment, "What do you notice as both needs are visible?")

        self.assertEqual(parsed["dimensions"]["mutual_need_visibility"]["score"], 4)
        self.assertEqual(parsed["dimensions"]["open_non_directive_question"]["score"], 3)

    def test_malformed_fenced_real_judge_dimensions_object_is_repaired(self) -> None:
        moment = mme.load_moment("stage-2-empathy-validation")
        malformed = {
            "parsed": {"parse_error": True},
            "raw": """```json
{
  "dimensions": {
    "confirm_or_refine_invitation": {"score": 4, "rationale": "Good"},
    "non_forcing_posture": {"score": 3, "rationale": "Adequate"},
    "protects_consent": {"score": 4, "rationale": "Good"}
  ]
}
```""",
        }
        with mock.patch.object(mme, "run_real_helper", return_value=malformed):
            parsed, _raw = mme.score_with_real_judge(moment, "What feels right and what feels off?")

        self.assertEqual(parsed["dimensions"]["confirm_or_refine_invitation"]["score"], 4)
        self.assertEqual(parsed["dimensions"]["non_forcing_posture"]["score"], 3)


class TestAlignmentLoop(unittest.TestCase):
    def write_loop_config(self, path: Path, moment_ids: list[str], estimated_cost_cents: float = 2.0) -> Path:
        path.write_text(
            json.dumps(
                {
                    "cost_caps": {
                        "per_run_cents": 500,
                        "per_day_cents": 2000,
                        "estimated_judge_cost_cents": estimated_cost_cents,
                    },
                    "moments": [{"id": moment_id, "threshold": 4.0} for moment_id in moment_ids],
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_alignment_loop_dry_run_writes_summary_without_prs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config = self.write_loop_config(
                tmp_path / "config.json",
                ["stage-1-emotional-pivot", "stage-2-empathy-validation"],
            )
            with mock.patch.object(loop, "ALIGNMENT_RUNS_ROOT", tmp_path / "alignment-runs"), \
                 mock.patch.object(loop.mme, "RUNS_ROOT", tmp_path / "runs"):
                args = loop.build_parser().parse_args(
                    ["--config", str(config), "--dry-run", "--timestamp", "phase4-dry-run-test"]
                )
                summary = loop.run_alignment_loop(args)

            self.assertEqual(summary["verdict"], "complete")
            self.assertTrue(summary["dry_run"])
            self.assertEqual(len(summary["moments"]), 2)
            self.assertTrue((tmp_path / "alignment-runs/phase4-dry-run-test/summary.json").exists())
            self.assertTrue(all("pr" not in item for item in summary["moments"]))

    def test_alignment_loop_cost_cap_aborts_after_partial_progress(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config = self.write_loop_config(
                tmp_path / "config.json",
                ["stage-1-emotional-pivot", "stage-2-empathy-validation", "stage-3-mutual-reveal"],
            )
            with mock.patch.object(loop, "ALIGNMENT_RUNS_ROOT", tmp_path / "alignment-runs"), \
                 mock.patch.object(loop.mme, "RUNS_ROOT", tmp_path / "runs"):
                args = loop.build_parser().parse_args(
                    [
                        "--config",
                        str(config),
                        "--dry-run",
                        "--per-run-cap-cents",
                        "5",
                        "--timestamp",
                        "phase4-cap-test",
                    ]
                )
                with self.assertRaises(loop.AlignmentLoopError):
                    loop.run_alignment_loop(args)

            summary = json.loads((tmp_path / "alignment-runs/phase4-cap-test/summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["verdict"], "aborted")
            self.assertIn("Per-run cost cap", summary["aborted_reason"])
            self.assertEqual(len(summary["moments"]), 2)

    def test_alignment_loop_records_score_error_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config = self.write_loop_config(
                tmp_path / "config.json",
                ["stage-1-emotional-pivot", "stage-2-empathy-validation"],
            )
            run_dir = tmp_path / "runs/moment-stage-2-empathy-validation"
            run_dir.mkdir(parents=True)
            (run_dir / "score.json").write_text(json.dumps({"overall_score": 4.5, "verdict": "eval_pass"}), encoding="utf-8")
            with mock.patch.object(loop, "ALIGNMENT_RUNS_ROOT", tmp_path / "alignment-runs"), \
                 mock.patch.object(loop.mme, "RUNS_ROOT", tmp_path / "runs"), \
                 mock.patch.object(loop.mme, "run_loop", side_effect=[RuntimeError("bad judge json"), [run_dir]]):
                args = loop.build_parser().parse_args(
                    ["--config", str(config), "--dry-run", "--timestamp", "score-error-test"]
                )
                summary = loop.run_alignment_loop(args)

        self.assertEqual(summary["verdict"], "complete")
        self.assertEqual(summary["moments"][0]["status"], "score_error")
        self.assertIn("bad judge json", summary["moments"][0]["error"])
        self.assertEqual(summary["moments"][1]["status"], "scored")

    def test_alignment_pr_creation_uses_expected_metadata_and_label(self) -> None:
        def completed(cmd: list[str], stdout: str = "") -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        commands: list[list[str]] = []

        def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(cmd)
            if cmd[:3] == ["gh", "pr", "create"]:
                return completed(cmd, "https://github.com/example/repo/pull/123\n")
            return completed(cmd)

        with tempfile.TemporaryDirectory() as tmp:
            request = loop.PrRequest(
                moment_id="stage-2-empathy-validation",
                stage_label="stage-2",
                timestamp="20260506-120000",
                score=1.25,
                threshold=4.0,
                body="## Candidate\n\nPrompt revision details.",
                artifact_paths=[REPO_ROOT / "eval/alignment-loop-config.yaml"],
                borderline=True,
            )
            with mock.patch.object(loop, "ALIGNMENT_RUNS_ROOT", Path(tmp)), \
                 mock.patch.object(loop, "git_current_branch", return_value="main"), \
                 mock.patch.object(loop, "run_command", side_effect=fake_run):
                result = loop.create_alignment_pr(request)

        self.assertEqual(result["url"], "https://github.com/example/repo/pull/123")
        self.assertEqual(result["branch"], "loop/alignment-stage-2-empathy-validation-20260506-120000")
        self.assertEqual(result["label"], "loop:auto-improvement")
        self.assertTrue(result["draft"])
        self.assertIn(["git", "switch", "-c", request.branch_name], commands)
        self.assertIn(["git", "switch", "main"], commands)
        pr_create = [cmd for cmd in commands if cmd[:3] == ["gh", "pr", "create"]][0]
        self.assertIn(request.title, pr_create)
        self.assertIn("(score 1.25/target 4.00)", request.title)
        self.assertIn("--draft", pr_create)
        self.assertIn(["gh", "pr", "edit", result["url"], "--add-label", "loop:auto-improvement"], commands)

    def test_gold_comparison_artifact_includes_reference_and_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "ai-response.md").write_text("Candidate response under review.\n", encoding="utf-8")
            (run_dir / "score-rationale.md").write_text("Overall score: 1.0\n", encoding="utf-8")
            moment = mme.load_moment("adam-eve-stage-2-consent-gate-169")
            score = {"overall_score": 1.0, "verdict": "eval_fail"}

            comparison = loop.write_gold_comparison(run_dir, moment, score)
            text = comparison.read_text(encoding="utf-8")
        self.assertIn("docs/product/source-material/golden-transcripts/adam-eve.md", text)
        self.assertIn("Candidate response under review.", text)
        self.assertIn("Overall score: 1.0", text)

    def test_outer_loop_regression_converts_pr_to_draft_and_comments(self) -> None:
        def completed(cmd: list[str], stdout: str = "") -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        commands: list[list[str]] = []

        def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(cmd)
            return completed(cmd)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            prompt_version = tmp_path / "v01.md"
            prompt_version.write_text("bad revision", encoding="utf-8")
            args = loop.build_parser().parse_args(
                [
                    "--mock-outer-loop-score",
                    "3.0",
                    "--outer-loop-baseline-score",
                    "4.0",
                    "--timestamp",
                    "phase5-outer-loop-test",
                ]
            )
            with mock.patch.object(loop, "ALIGNMENT_RUNS_ROOT", tmp_path / "alignment-runs"), \
                 mock.patch.object(loop, "run_command", side_effect=fake_run):
                result = loop.run_outer_loop_validation(
                    pr={"url": "https://github.com/example/repo/pull/123"},
                    moment_id="stage-2-empathy-validation",
                    prompt_version=prompt_version,
                    timestamp="phase5-outer-loop-test",
                    args=args,
                )

        self.assertEqual(result["status"], "regressed")
        self.assertTrue(result["regressed"])
        self.assertIn(["gh", "pr", "ready", "--undo", "https://github.com/example/repo/pull/123"], commands)
        comment = [cmd for cmd in commands if cmd[:3] == ["gh", "pr", "comment"]][0]
        self.assertIn("E2E regression detected", comment[-1])
        self.assertIn("outer-loop/stage-2-empathy-validation", comment[-1])


class TestGoldExampleOnboarding(unittest.TestCase):
    def test_gold_profile_extracts_process_shape_from_transcript_evidence(self) -> None:
        profile = gold_profile.build_profile(
            REPO_ROOT / "docs/product/source-material/golden-transcripts/james-catherine.md",
            "james-catherine",
        )

        self.assertEqual(profile["scenario_shape"]["primary"], "no_shared_agreement_or_unresolved_closure")
        self.assertEqual(profile["participant_profiles"]["james"]["resistance_level"]["level"], "high")
        self.assertIn("Catherine", profile["participants"])
        self.assertTrue(profile["scenario_shape"]["evidence"])

    def test_gold_example_onboarding_copies_scaffolds_indexes_and_runs_tests(self) -> None:
        def completed(cmd: list[str]) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 0, stdout="OK\n", stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fixture = tmp_path / "New Couple.md"
            fixture.write_text(
                "\n".join(
                    [
                        "# New Couple",
                        "",
                        "## Stage 1",
                        "",
                        "**Alex:** I keep going quiet.",
                        "",
                        "**MWF:** Something in you goes quiet before it gets a chance to be heard.",
                        "",
                        "## Stage 2",
                        "",
                        "**Blair:** That is close, but it misses the fear.",
                        "",
                        "**MWF:** Keep the part that landed and bring the fear into the next version.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            with mock.patch.object(add_gold, "TRANSCRIPTS_ROOT", tmp_path / "golden-transcripts"), \
                 mock.patch.object(add_gold, "MOMENTS_ROOT", tmp_path / "moments"), \
                 mock.patch.object(add_gold, "INDEX_PATH", tmp_path / "moments/README.md"), \
                 mock.patch.object(add_gold, "SCENARIOS_PATH", tmp_path / "gold-scenarios.json"), \
                 mock.patch.object(gold_profile, "PROFILES_ROOT", tmp_path / "gold-profiles"), \
                 mock.patch.object(add_gold, "run_command", side_effect=completed) as run_tests:
                result = add_gold.onboard(fixture)

            self.assertEqual(result["tests"], 0)
            self.assertTrue((tmp_path / "golden-transcripts/new-couple.md").exists())
            self.assertEqual(len(result["drafts"]), 2)
            self.assertEqual(result["scenario"]["participants"], ["Alex", "Blair"])
            self.assertTrue(result["scenario"]["live_enabled"])
            self.assertTrue((tmp_path / "gold-profiles/new-couple.json").exists())
            self.assertTrue((tmp_path / "moments/new-couple-stage-1-moment-01.yaml.draft").exists())
            scenarios = json.loads((tmp_path / "gold-scenarios.json").read_text(encoding="utf-8"))
            self.assertEqual(scenarios["scenarios"][0]["id"], "new-couple")
            self.assertIn("new-couple-stage-2-moment-01.yaml.draft", (tmp_path / "moments/README.md").read_text(encoding="utf-8"))
            run_tests.assert_called_once()

    def test_auto_gold_example_onboarding_writes_ready_moments_idempotently(self) -> None:
        def completed(cmd: list[str]) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 0, stdout="OK\n", stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fixture = tmp_path / "Auto Couple.md"
            fixture.write_text(
                "\n".join(
                    [
                        "# Auto Couple",
                        "",
                        "## Stage 1",
                        "",
                        "**Alex:** I keep going quiet before I can explain.",
                        "",
                        "**MWF:** Something in you goes quiet before it gets a chance to be heard. Is that close?",
                        "",
                        "## Stage 2",
                        "",
                        "**Blair:** I can try to see why Alex freezes, but I am still hurt.",
                        "",
                        "**MWF:** Stay with both parts: you can see the fear and still name the hurt underneath it.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            with mock.patch.object(add_gold, "TRANSCRIPTS_ROOT", tmp_path / "golden-transcripts"), \
                 mock.patch.object(add_gold, "MOMENTS_ROOT", tmp_path / "moments"), \
                 mock.patch.object(add_gold, "INDEX_PATH", tmp_path / "moments/README.md"), \
                 mock.patch.object(add_gold, "ALIGNMENT_CONFIG", tmp_path / "alignment-loop-config.yaml"), \
                 mock.patch.object(add_gold, "SCENARIOS_PATH", tmp_path / "gold-scenarios.json"), \
                 mock.patch.object(gold_profile, "PROFILES_ROOT", tmp_path / "gold-profiles"), \
                 mock.patch.object(extract, "MOMENTS_ROOT", tmp_path / "moments"), \
                 mock.patch.object(extract, "JUDGE_PROMPTS_ROOT", tmp_path / "judge-prompts"), \
                 mock.patch.object(add_gold, "run_command", side_effect=completed):
                (tmp_path / "alignment-loop-config.yaml").write_text(
                    json.dumps({"moments": []}), encoding="utf-8"
                )
                first = add_gold.onboard(fixture, auto=True, max_moments=4)
                second = add_gold.onboard(fixture, auto=True, max_moments=4)

            self.assertEqual(first["tests"], 0)
            self.assertGreaterEqual(len(first["moments"]), 2)
            self.assertEqual(second["moments"], [])
            ready = sorted((tmp_path / "moments").glob("*.yaml"))
            self.assertGreaterEqual(len(ready), 2)
            self.assertFalse(list((tmp_path / "moments").glob("*.yaml.draft")))
            payload = json.loads(ready[0].read_text(encoding="utf-8"))
            self.assertTrue(payload["auto_generated"])
            self.assertIn("hard_invariants", payload["rubric"])
            config = json.loads((tmp_path / "alignment-loop-config.yaml").read_text(encoding="utf-8"))
            self.assertEqual(len(config["moments"]), len(ready))

    def test_auto_gold_example_cli_uses_llm_rubrics_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "Auto Couple.md"
            transcript.write_text("# Auto Couple\n", encoding="utf-8")
            with mock.patch.object(
                add_gold,
                "onboard",
                return_value={"transcript": "x", "drafts": [], "moments": [], "judge_prompts": [], "index": "i", "tests": None},
            ) as onboard:
                with contextlib.redirect_stdout(io.StringIO()):
                    result = add_gold.main([str(transcript), "--auto", "--skip-tests"])

        self.assertEqual(result, 0)
        self.assertTrue(onboard.call_args.kwargs["llm_rubrics"])


class TestMomentExtraction(unittest.TestCase):
    def test_parse_transcript_infers_turns_stages_and_substates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.md"
            path.write_text(
                "\n".join(
                    [
                        "# Sample",
                        "## STAGE 1 — THE WITNESS",
                        "**Adam:** I am scared.",
                        "**MWF:** You are scared, and it has been sitting there. Is that close?",
                        "## Stage 3",
                        "Eve: I can share the need.",
                        "MWF: What do you notice as you see both needs?",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            turns = extract.parse_transcript(path)

        self.assertEqual(len(turns), 4)
        self.assertEqual(turns[1].role, "ai")
        self.assertEqual(turns[1].stage, 1)
        self.assertEqual(turns[1].sub_state, "fact-reflection")
        self.assertEqual(turns[3].sub_state, "mutual-reveal")

    def test_extract_moments_builds_seed_rubric_and_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.md"
            path.write_text(
                "\n".join(
                    [
                        "# Sample",
                        "## Stage 1",
                        "**Adam:** I am scared she is right about me.",
                        "**MWF:** You are holding a painful possibility without knowing what to do with it. Is that close?",
                        "## Stage 4",
                        "**Eve:** I am not willing to pick that.",
                        "**MWF:** Then there is no shared agreement on that proposal, and the process closes without pressure.",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = extract.extract_moments(path, max_moments=4)

        self.assertEqual(len(result["selected_moments"]), 2)
        moment = result["selected_moments"][0]["moment"]
        self.assertIn("seed", moment)
        self.assertIn("prior_history_summary", moment["seed"])
        self.assertIn("dimensions", moment["rubric"])
        self.assertIn("Gold AI Turn", result["selected_moments"][0]["judge_prompt"])

    def test_llm_rubric_generation_uses_real_helper_and_normalizes_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.md"
            path.write_text("# Sample\n\n## Stage 1\n**Adam:** I am scared.\n**MWF:** You are scared. Is that close?\n", encoding="utf-8")
            ai_turn = extract.TranscriptTurn(
                role="ai",
                speaker="MWF",
                content="You are scared. Is that close?",
                start_line=5,
                end_line=5,
                stage=1,
                sub_state="fact-reflection",
            )
            trigger = extract.TranscriptTurn(
                role="user",
                speaker="Adam",
                content="I am scared.",
                start_line=4,
                end_line=4,
                stage=1,
                sub_state="fact-reflection",
            )
            fake = {
                "model": "haiku-test",
                "durationMs": 123,
                "usage": {"input_tokens": 10, "output_tokens": 20},
                "promptCaching": "full transcript sent as cache_control ephemeral system block",
                "parsed": {
                    "dimensions": [
                        {
                            "id": "Fact Reflection",
                            "description": "Reflects the fear without solving.",
                            "pass_threshold": 4,
                            "evidence_excerpt": "You are scared.",
                        },
                        {"id": "Consent", "description": "Asks whether it is close.", "pass_threshold": 4},
                        {"id": "No Advice", "description": "Avoids advice.", "pass_threshold": 4},
                    ]
                },
                "raw": "{}",
            }
            with mock.patch.object(extract.mme, "run_real_helper", return_value=fake) as helper:
                dimensions, raw = extract.generate_rubric_via_llm(path, ai_turn, trigger, "excerpt")

        self.assertEqual(raw["model"], "haiku-test")
        self.assertEqual(dimensions[0]["id"], "fact_reflection")
        self.assertTrue(dimensions[0]["llm_generated"])
        self.assertIn("Evidence: You are scared.", dimensions[0]["description"])
        helper.assert_called_once()
        self.assertEqual(helper.call_args.args[0], "rubric")
        self.assertEqual(helper.call_args.kwargs["stdin"]["aiTurn"]["content"], ai_turn.content)


class TestAlignmentStatus(unittest.TestCase):
    def test_alignment_status_generation_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            prompts = tmp_path / "stage-prompts.ts"
            prompts.write_text("export const prompt = 'stable';\n", encoding="utf-8")
            versions = tmp_path / "prompt-versions"
            (versions / "mwf/stage-1").mkdir(parents=True)
            (versions / "mwf/stage-1/v01.md").write_text("candidate\n", encoding="utf-8")
            runs = tmp_path / "runs/moment-stage-1-fact-reflection-20260506-000000-iter-01"
            runs.mkdir(parents=True)
            (runs / "run.json").write_text(json.dumps({"moment": "stage-1-fact-reflection"}), encoding="utf-8")
            (runs / "score.json").write_text(json.dumps({"overall_score": 4.2, "verdict": "eval_pass"}), encoding="utf-8")
            align = tmp_path / "alignment-runs/phase5"
            align.mkdir(parents=True)
            (align / "summary.json").write_text(
                json.dumps(
                    {
                        "started_at": "2026-05-06T00:00:00Z",
                        "cost_spent_cents": 2,
                        "moments": [
                            {
                                "id": "stage-1-fact-reflection",
                                "outer_loop": {"status": "passed", "run_dir": "outer-loop/run"},
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            transcripts = tmp_path / "golden-transcripts"
            transcripts.mkdir()
            (transcripts / "fixture.md").write_text("# Fixture\n", encoding="utf-8")
            with mock.patch.object(status, "STAGE_PROMPTS", prompts), \
                 mock.patch.object(status, "PROMPT_VERSIONS_ROOT", versions), \
                 mock.patch.object(status, "MOMENT_RUNS_ROOT", tmp_path / "runs"), \
                 mock.patch.object(status, "ALIGNMENT_RUNS_ROOT", tmp_path / "alignment-runs"), \
                 mock.patch.object(status, "TRANSCRIPTS_ROOT", transcripts), \
                 mock.patch.object(status, "open_loop_prs", return_value=[]):
                first = status.render(limit=5)
                second = status.render(limit=5)

        self.assertEqual(first, second)
        self.assertIn("## Production Prompt", first)
        self.assertIn("## Latest Candidate Revisions", first)
        self.assertIn("## Open Loop PRs", first)
        self.assertIn("## Score Trends", first)
        self.assertIn("## Cost", first)
        self.assertIn("## Last E2E Outer Loop", first)
        self.assertIn("## Gold Examples", first)


class TestCli(unittest.TestCase):
    def test_cli_help_mentions_required_flags(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/mwf_moment_eval.py", "--help"],
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(result.returncode, 0)
        for needle in [
            "run",
            "run-library",
            "--moment",
            "--target-score",
            "--max-iterations",
            "--mock-judge",
            "--allow-protected-branch-patch",
        ]:
            self.assertIn(needle, result.stdout)

    def test_run_library_creates_one_run_per_moment_with_mock_judge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with mock.patch.object(mme, "RUNS_ROOT", tmp_path):
                args = mme.build_parser().parse_args(["run-library", "--max-iterations", "1", "--no-improve"])
                if args.mock_judge is None:
                    args.mock_judge = not args.real
                created = mme.run_library(args)
                self.assertGreaterEqual(len(created), len(PHASE1_MOMENT_IDS))
                created_ids = {
                    __import__("json").loads((path / "run.json").read_text(encoding="utf-8"))["moment"]
                    for path in created
                }
        for moment_id in PHASE1_MOMENT_IDS:
            self.assertIn(moment_id, created_ids)

    def test_trajectory_runner_persists_intermediate_ai_responses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with mock.patch.object(mme, "RUNS_ROOT", tmp_path):
                args = mme.build_parser().parse_args(
                    [
                        "run",
                        "--moment",
                        "stage-3-trajectory-needs-flow",
                        "--max-iterations",
                        "1",
                        "--no-improve",
                    ]
                )
                if args.mock_judge is None:
                    args.mock_judge = not args.real
                created = mme.run_loop(args)
                delta = __import__("json").loads((created[0] / "state-delta.json").read_text(encoding="utf-8"))

        self.assertEqual(len(delta["trajectory_steps"]), 4)
        for step in delta["trajectory_steps"]:
            self.assertIn("ai_response_persisted", step)
            self.assertIn("seed_for_next_turn", step)


if __name__ == "__main__":
    unittest.main()
