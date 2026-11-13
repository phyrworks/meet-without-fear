#!/usr/bin/env python3
"""Orchestrate two Codex gold-session actors for Meet Without Fear.

This script coordinates Codex sessions. It does not drive the browser itself.
Each actor must use the mwf-gold-session-tester skill and end every turn with a
machine-readable MWF_GOLD_STATUS block.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


REPO_ROOT = Path(__file__).resolve().parents[1]
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
TESTER_SCRIPT = CODEX_HOME / "skills/mwf-gold-session-tester/scripts/create_gold_session.sh"
TESTER_SKILL = CODEX_HOME / "skills/mwf-gold-session-tester/SKILL.md"
ACTOR_SKILL = CODEX_HOME / "skills/mwf-gold-loop-actor/SKILL.md"
SCORER_SKILL = CODEX_HOME / "skills/mwf-gold-session-scorer/SKILL.md"
IMPROVER_SKILL = CODEX_HOME / "skills/mwf-gold-prompt-improver/SKILL.md"
CODEX_CONFIG = CODEX_HOME / "config.toml"
RUNS_ROOT = REPO_ROOT / "eval/runs"
SCRATCH_ROOT = REPO_ROOT / "docs/product/gold-session-scratch"
TRANSCRIPT_SCRIPT = REPO_ROOT / "backend/scripts/extract-session-transcripts.ts"
REPO_ACTOR_SKILL = REPO_ROOT / "eval/skills/self-improvement/mwf-gold-loop-actor/SKILL.md"
REPO_SCORER_SKILL = REPO_ROOT / "eval/skills/self-improvement/mwf-gold-session-scorer/SKILL.md"
REPO_IMPROVER_SKILL = REPO_ROOT / "eval/skills/self-improvement/mwf-gold-prompt-improver/SKILL.md"
MWF_STAGE_PROMPTS = REPO_ROOT / "backend/src/services/stage-prompts.ts"
PROMPT_VERSIONS_ROOT = REPO_ROOT / "eval/prompt-versions"
SCENARIOS_PATH = REPO_ROOT / "eval/gold-scenarios.json"
GOLD_PROFILES_ROOT = REPO_ROOT / "eval/gold-profiles"

VALID_STATES = {
    "needs_partner",
    "can_continue",
    "stage_limit_reached",
    "completed",
    "bug_blocked",
    "error",
}

TARGET_STAGES = (
    "CREATED",
    "EMPATHY_SHARED_A",
    "FEEL_HEARD_B",
    "RECONCILER_SHOWN_B",
    "CONTEXT_SHARED_B",
    "EMPATHY_REVEALED",
    "NEED_MAPPING_COMPLETE",
    "STRATEGIC_REPAIR_COMPLETE",
)

BOTH_PARTICIPANT_TARGET_STAGES = {
    "FEEL_HEARD_B",
    "RECONCILER_SHOWN_B",
    "CONTEXT_SHARED_B",
    "EMPATHY_REVEALED",
    "NEED_MAPPING_COMPLETE",
    "STRATEGIC_REPAIR_COMPLETE",
}

TARGET_STAGE_NUMBERS = {
    "CREATED": 0,
    "EMPATHY_SHARED_A": 1,
    "FEEL_HEARD_B": 1,
    "RECONCILER_SHOWN_B": 2,
    "CONTEXT_SHARED_B": 3,
    "EMPATHY_REVEALED": 3,
    "NEED_MAPPING_COMPLETE": 4,
    "STRATEGIC_REPAIR_COMPLETE": 4,
}


class GoldLoopError(RuntimeError):
    pass


def load_scenarios() -> dict[str, tuple[str, str]]:
    """Load live gold-loop scenarios from the repo registry."""
    if not SCENARIOS_PATH.exists():
        raise GoldLoopError(f"Missing gold scenario registry: {SCENARIOS_PATH}")
    payload = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    scenarios: dict[str, tuple[str, str]] = {}
    for item in payload.get("scenarios", []):
        if not item.get("live_enabled", True):
            continue
        scenario_id = str(item.get("id", "")).strip()
        participants = item.get("participants")
        transcript = REPO_ROOT / str(item.get("reference_transcript", ""))
        if not scenario_id or not isinstance(participants, list) or len(participants) != 2:
            raise GoldLoopError(f"Invalid scenario registry entry: {item}")
        first, second = (str(participants[0]).strip(), str(participants[1]).strip())
        if not first or not second:
            raise GoldLoopError(f"Scenario {scenario_id!r} must define two named participants")
        if not transcript.exists():
            raise GoldLoopError(f"Scenario {scenario_id!r} references missing transcript: {transcript}")
        profile = item.get("gold_profile")
        if profile and not (REPO_ROOT / str(profile)).exists():
            raise GoldLoopError(f"Scenario {scenario_id!r} references missing gold profile: {profile}")
        scenarios[scenario_id] = (first, second)
    if not scenarios:
        raise GoldLoopError(f"No live gold scenarios found in {SCENARIOS_PATH}")
    return scenarios


SCENARIOS = load_scenarios()


def scenario_sides(scenario: str) -> list[str]:
    return [character.lower() for character in SCENARIOS[scenario]]


def scenario_registry_entry(scenario: str) -> dict[str, Any]:
    payload = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    for item in payload.get("scenarios", []):
        if item.get("id") == scenario:
            return item
    raise GoldLoopError(f"Scenario {scenario!r} not found in {SCENARIOS_PATH}")


def scenario_gold_profile_path(scenario: str) -> Path | None:
    entry = scenario_registry_entry(scenario)
    profile = entry.get("gold_profile")
    if profile:
        return REPO_ROOT / str(profile)
    fallback = GOLD_PROFILES_ROOT / f"{scenario}.json"
    return fallback if fallback.exists() else None


def load_gold_profile(scenario: str) -> dict[str, Any]:
    path = scenario_gold_profile_path(scenario)
    if not path or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def character_from_name(value: Any, participants: Iterable[str]) -> str | None:
    lowered = str(value or "").strip().lower()
    if not lowered:
        return None
    for participant in participants:
        if participant.lower() == lowered:
            return participant
    return None


def infer_role_shape_from_profile(scenario: str) -> dict[str, Any]:
    """Infer session initiation roles from profile evidence without scenario exceptions."""
    participants = list(SCENARIOS[scenario])
    fallback = {
        "initiator": participants[0],
        "invited": participants[1],
        "confidence": "unknown",
        "source": "scenario_registry_order",
        "evidence": [],
    }
    profile = load_gold_profile(scenario)
    if not profile:
        return fallback

    explicit = profile.get("role_shape")
    if isinstance(explicit, dict):
        initiator = character_from_name(explicit.get("initiator"), participants)
        invited = character_from_name(explicit.get("invited"), participants)
        if initiator and invited and initiator != invited:
            return {
                "initiator": initiator,
                "invited": invited,
                "confidence": str(explicit.get("confidence") or "high"),
                "source": str(explicit.get("source") or "profile_role_shape"),
                "evidence": [str(item) for item in explicit.get("evidence") or []],
            }

    stage0 = (profile.get("stage_profiles") or {}).get("stage_0") or {}
    evidence_items = stage0.get("mwf_effect_to_preserve") or []
    evidence_text = "\n".join(str(item) for item in evidence_items)
    if not evidence_text:
        return fallback

    invited_matches: list[tuple[str, str]] = []
    initiator_matches: list[tuple[str, str]] = []
    for participant in participants:
        name = re.escape(participant)
        invited_patterns = [
            rf"\bmessage\s+for\s+{name}\b",
            rf"\bmessage\s+{name}\s+will\s+receive\b",
            rf"\bso\s+{name}\s+knows\b",
        ]
        initiator_patterns = [
            rf"\bthank\s+you,\s*{name}\b",
        ]
        for item in evidence_items:
            text = str(item)
            if any(re.search(pattern, text, re.I) for pattern in invited_patterns):
                invited_matches.append((participant, text))
            if any(re.search(pattern, text, re.I) for pattern in initiator_patterns):
                initiator_matches.append((participant, text))

    invited_candidates = {name for name, _ in invited_matches}
    initiator_candidates = {name for name, _ in initiator_matches}
    invited = next(iter(invited_candidates)) if len(invited_candidates) == 1 else None
    initiator = next(iter(initiator_candidates)) if len(initiator_candidates) == 1 else None
    if invited and not initiator and len(participants) == 2:
        initiator = next(participant for participant in participants if participant != invited)
    if initiator and not invited and len(participants) == 2:
        invited = next(participant for participant in participants if participant != initiator)
    if not initiator or not invited or initiator == invited:
        return fallback

    evidence = [text for name, text in initiator_matches + invited_matches if name in {initiator, invited}]
    confidence = "high" if initiator_candidates and invited_candidates else "medium"
    return {
        "initiator": initiator,
        "invited": invited,
        "confidence": confidence,
        "source": "stage_0_profile_mwf_effect",
        "evidence": evidence[:4],
    }


def scenario_start_character(scenario: str) -> str:
    role_shape = infer_role_shape_from_profile(scenario)
    if role_shape.get("confidence") in {"medium", "high"}:
        return str(role_shape["initiator"])
    return SCENARIOS[scenario][0]


@dataclass
class ActorStatus:
    side: str
    session_id: str
    stage: int | None
    state: str
    blocked_on: str | None = None
    next_action_needed: str | None = None
    scratch_log: str | None = None
    current_url: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def error(cls, side: str, session_id: str, message: str) -> "ActorStatus":
        return cls(
            side=side,
            session_id=session_id,
            stage=None,
            state="error",
            next_action_needed=message,
        )


@dataclass
class Actor:
    character: str
    url: str
    codex_session_id: str | None = None
    status: ActorStatus | None = None
    turns: int = 0

    @property
    def side(self) -> str:
        return self.character.lower()


@dataclass
class IterationResult:
    run_dir: Path
    score: float | None
    verdict: str | None
    improved: bool
    verification_failed: bool = False


@dataclass
class ManagedService:
    name: str
    command: list[str]
    cwd: Path
    log_path: Path
    started: bool
    pid: int | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False, compare=False)


def http_ok(url: str, method: str = "GET", body: bytes | None = None, timeout: float = 5.0) -> bool:
    req = Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (HTTPError, URLError, TimeoutError):
        return False


def post_json(url: str, payload: dict[str, Any], timeout: float = 10.0) -> dict[str, Any]:
    req = Request(url, data=json.dumps(payload).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    with urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_command(
    cmd: list[str],
    cwd: Path = REPO_ROOT,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
    stdout_path: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    stdout_target: Any = subprocess.PIPE
    handle = None
    if stdout_path is not None:
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
        handle = stdout_path.open("a", encoding="utf-8")
        stdout_target = handle
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            timeout=timeout,
            env=env,
            text=True,
            stdout=stdout_target,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        if handle:
            handle.close()


def load_dotenv_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def backend_command_env() -> dict[str, str]:
    env = dict(os.environ)
    for key, value in load_dotenv_file(REPO_ROOT / "backend/.env").items():
        env.setdefault(key, value)
    return env


def start_background_command(
    name: str,
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
) -> ManagedService:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("a", encoding="utf-8")
    handle.write(f"$ {' '.join(cmd)}\n")
    handle.flush()
    process = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=handle,
        stderr=subprocess.STDOUT,
    )
    return ManagedService(name=name, command=cmd, cwd=cwd, log_path=log_path, started=True, pid=process.pid, process=process)


def build_loop_service_env(args: argparse.Namespace, base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base_env if base_env is not None else os.environ)
    env.setdefault("E2E_AUTH_BYPASS", "true")
    # The API honours E2E_AUTH_BYPASS only with NODE_ENV test/development
    # (backend/src/lib/e2e-bypass.ts) and refuses to start otherwise.
    env.setdefault("NODE_ENV", "development")
    env.setdefault("MOCK_LLM", "false")
    env.setdefault("E2E_APP_BASE_URL", args.app_url)
    env.setdefault("EXPO_PUBLIC_E2E_MODE", "true")
    env.setdefault("EXPO_PUBLIC_API_URL", args.api_url)
    env.setdefault("BROWSER", "none")
    return env


def wait_for_http(url: str, timeout: int = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_ok(url, timeout=2.0):
            return True
        time.sleep(2)
    return False


def service_record(service: ManagedService) -> dict[str, Any]:
    return {
        "name": service.name,
        "command": service.command,
        "cwd": str(service.cwd),
        "log_path": str(service.log_path),
        "started": service.started,
        "pid": service.pid,
    }


def write_service_start_info(
    service_dir: Path,
    services: list[ManagedService],
    started_backend: bool,
    status: str,
    failure: str | None = None,
    cleanup: dict[str, Any] | None = None,
) -> dict[str, Any]:
    info: dict[str, Any] = {
        "service_dir": str(service_dir),
        "started_backend": started_backend,
        "status": status,
        "services": [service_record(service) for service in services],
    }
    if failure:
        info["failure"] = failure
    if cleanup is not None:
        info["cleanup"] = cleanup
    (service_dir / "services.json").write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return info


def start_loop_services(args: argparse.Namespace, service_dir: Path) -> tuple[list[ManagedService], dict[str, Any]]:
    services: list[ManagedService] = []
    service_dir.mkdir(parents=True, exist_ok=True)
    env = build_loop_service_env(args)

    backend_started = False
    try:
        if http_ok(f"{args.api_url}/health"):
            services.append(
                ManagedService(
                    name="backend",
                    command=[],
                    cwd=REPO_ROOT,
                    log_path=service_dir / "backend.log",
                    started=False,
                    pid=None,
                )
            )
        else:
            backend = start_background_command(
                "backend",
                ["npm", "run", "dev:api"],
                REPO_ROOT,
                env,
                service_dir / "backend.log",
            )
            services.append(backend)
            backend_started = True
            require(wait_for_http(f"{args.api_url}/health"), f"Backend did not become healthy at {args.api_url}/health")

        if http_ok(args.app_url):
            services.append(
                ManagedService(
                    name="web",
                    command=[],
                    cwd=REPO_ROOT,
                    log_path=service_dir / "web.log",
                    started=False,
                    pid=None,
                )
            )
        else:
            web = start_background_command(
                "web",
                ["npm", "run", "dev:mobile:e2e"],
                REPO_ROOT,
                env,
                service_dir / "web.log",
            )
            services.append(web)
            require(wait_for_http(args.app_url), f"E2E web did not become reachable at {args.app_url}")
    except GoldLoopError as exc:
        cleanup = stop_managed_services(services)
        (service_dir / "cleanup.json").write_text(json.dumps(cleanup, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        write_service_start_info(service_dir, services, backend_started, "fail", failure=str(exc), cleanup=cleanup)
        raise

    info = write_service_start_info(service_dir, services, backend_started, "pass")
    return services, info


def stop_managed_services(services: list[ManagedService], timeout: int = 15) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for service in services:
        if not service.started or service.process is None:
            results[service.name] = {"started": False, "stopped": False}
            continue
        process = service.process
        process.terminate()
        try:
            returncode = process.wait(timeout=timeout)
            results[service.name] = {"started": True, "stopped": True, "pid": service.pid, "returncode": returncode}
        except subprocess.TimeoutExpired:
            process.kill()
            returncode = process.wait(timeout=5)
            results[service.name] = {"started": True, "stopped": True, "killed": True, "pid": service.pid, "returncode": returncode}
    return results


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GoldLoopError(message)


def preflight(api_url: str, app_url: str, skip_services: bool = False) -> dict[str, Any]:
    codex_path = shutil.which("codex")
    agent_browser_path = shutil.which("agent-browser")
    require(codex_path is not None, "codex CLI is not on PATH")
    require(agent_browser_path is not None, "agent-browser CLI is not on PATH")
    require(TESTER_SKILL.exists(), f"Missing tester skill: {TESTER_SKILL}")
    require(ACTOR_SKILL.exists(), f"Missing loop actor skill: {ACTOR_SKILL}")
    require(TESTER_SCRIPT.exists(), f"Missing gold-session script: {TESTER_SCRIPT}")
    require(SCORER_SKILL.exists(), f"Missing scorer skill: {SCORER_SKILL}")
    require(IMPROVER_SKILL.exists(), f"Missing prompt improver skill: {IMPROVER_SKILL}")
    require(CODEX_CONFIG.exists(), f"Missing Codex config: {CODEX_CONFIG}")
    config_text = CODEX_CONFIG.read_text(encoding="utf-8")
    require("browser-use@openai-bundled" in config_text, "Browser Use plugin is not enabled in Codex config")
    require(TRANSCRIPT_SCRIPT.exists(), f"Missing transcript extractor: {TRANSCRIPT_SCRIPT}")

    checks: dict[str, Any] = {
        "codex": codex_path,
        "agent_browser": agent_browser_path,
        "tester_skill": str(TESTER_SKILL),
        "actor_skill": str(ACTOR_SKILL),
        "scorer_skill": str(SCORER_SKILL),
        "improver_skill": str(IMPROVER_SKILL),
        "browser_use_configured": True,
    }
    if skip_services:
        checks["services"] = "skipped"
        return checks

    require(http_ok(f"{api_url}/health"), f"Backend is not healthy at {api_url}/health")
    probe_ok = http_ok(
        f"{api_url}/api/e2e/seed",
        method="POST",
        body=b'{"email":"mwf-gold-loop-probe@e2e.test","name":"Gold Loop Probe"}',
    )
    require(probe_ok, "E2E seed endpoint failed; start backend with E2E_AUTH_BYPASS=true and NODE_ENV=development (or test)")
    require(http_ok(app_url), f"E2E web app is not reachable at {app_url}")
    require(":8082" in app_url or os.environ.get("MWF_ALLOW_NON_E2E_WEB"), "Refusing non-8082 app URL without MWF_ALLOW_NON_E2E_WEB=1")
    checks["services"] = "ok"
    return checks


def parse_key_values(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Z0-9_]+", key):
            values[key] = value.strip()
    return values


def create_gold_session(scenario: str, character: str, api_url: str, app_url: str) -> dict[str, str]:
    participants = SCENARIOS[scenario]
    assigned_name = character_from_name(character, participants)
    if not assigned_name:
        expected = ", ".join(participants)
        raise GoldLoopError(f"Unknown character {character!r} for scenario {scenario!r}; expected {expected}")
    partner_name = next(participant for participant in participants if participant != assigned_name)

    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    assigned_email = f"gold-loop-{assigned_name.lower()}-{stamp}@e2e.test"
    partner_email = f"gold-loop-{partner_name.lower()}-{stamp}@e2e.test"
    seeded = post_json(
        f"{api_url}/api/e2e/seed-session",
        {
            "userA": {"email": assigned_email, "name": assigned_name},
            "userB": {"email": partner_email, "name": partner_name},
            "targetStage": "CREATED",
        },
    )
    if not seeded.get("success"):
        raise GoldLoopError(f"seed-session failed: {seeded}")
    data = seeded["data"]
    page_urls = data.get("pageUrls") or {}
    require(page_urls.get("userA") and page_urls.get("userB"), f"seed-session response missing both page URLs: {seeded}")
    return {
        "SESSION_ID": data["session"]["id"],
        "ASSIGNED_CHARACTER": assigned_name,
        "PARTNER_CHARACTER": partner_name,
        "ASSIGNED_ID": data["userA"]["id"],
        "ASSIGNED_EMAIL": data["userA"]["email"],
        "PARTNER_ID": data["userB"]["id"],
        "PARTNER_EMAIL": data["userB"]["email"],
        "ASSIGNED_URL": page_urls["userA"].replace("http://localhost:8081", app_url),
        "PARTNER_URL": page_urls["userB"].replace("http://localhost:8081", app_url),
    }


def seeded_session_from_target_stage(scenario: str, target_stage: str, api_url: str, app_url: str) -> dict[str, str]:
    if target_stage not in TARGET_STAGES:
        raise GoldLoopError(f"Unknown target stage {target_stage!r}; expected one of: {', '.join(TARGET_STAGES)}")
    if target_stage not in BOTH_PARTICIPANT_TARGET_STAGES:
        raise GoldLoopError(
            f"Target stage {target_stage!r} does not create both participant URLs for the main two-actor loop. "
            f"Use one of: {', '.join(sorted(BOTH_PARTICIPANT_TARGET_STAGES))}"
        )
    first_character, second_character = SCENARIOS[scenario]
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    seeded = post_json(
        f"{api_url}/api/e2e/seed-session",
        {
            "userA": {"email": f"gold-loop-{first_character.lower()}-{stamp}@e2e.test", "name": first_character},
            "userB": {"email": f"gold-loop-{second_character.lower()}-{stamp}@e2e.test", "name": second_character},
            "targetStage": target_stage,
        },
    )
    if not seeded.get("success"):
        raise GoldLoopError(f"seed-session failed: {seeded}")
    data = seeded["data"]
    page_urls = data.get("pageUrls") or {}
    require(page_urls.get("userA") and page_urls.get("userB"), f"seed-session response missing both page URLs: {seeded}")
    return {
        "SESSION_ID": data["session"]["id"],
        "ASSIGNED_CHARACTER": first_character,
        "PARTNER_CHARACTER": second_character,
        "ASSIGNED_ID": data["userA"]["id"],
        "ASSIGNED_EMAIL": data["userA"]["email"],
        "PARTNER_ID": data["userB"]["id"],
        "PARTNER_EMAIL": data["userB"]["email"],
        "ASSIGNED_URL": page_urls["userA"].replace("http://localhost:8081", app_url),
        "PARTNER_URL": page_urls["userB"].replace("http://localhost:8081", app_url),
        "START_MODE": "target_stage",
        "TARGET_STAGE": target_stage,
    }


def restore_snapshot(snapshot_id_or_name: str, run_dir: Path, timeout: int = 180) -> dict[str, Any]:
    script = REPO_ROOT / "scripts/ec2-bot/scripts/restore-snapshot.sh"
    require(script.exists(), f"Missing snapshot restore script: {script}")
    result = run_command([str(script), snapshot_id_or_name], timeout=timeout, stdout_path=run_dir / "snapshot-restore.log")
    restore = {
        "snapshot": snapshot_id_or_name,
        "returncode": result.returncode,
        "stderr": result.stderr,
        "log": str(run_dir / "snapshot-restore.log"),
    }
    if result.returncode != 0:
        (run_dir / "snapshot-restore-error.txt").write_text(result.stderr, encoding="utf-8")
        raise GoldLoopError(f"snapshot restore failed for {snapshot_id_or_name}: {result.stderr.strip()}")
    return restore


def session_from_restored_snapshot(
    scenario: str,
    app_url: str,
    session_id: str | None = None,
) -> dict[str, str]:
    first_character, second_character = SCENARIOS[scenario]
    query_script = f"""
import {{ prisma }} from './src/lib/prisma';

async function main() {{
  const session = await prisma.session.findFirst({{
    where: {json.dumps({"id": session_id} if session_id else {})},
    orderBy: {{ createdAt: 'desc' }},
    include: {{
      relationship: {{
        include: {{
          members: {{
            include: {{ user: {{ select: {{ id: true, email: true, name: true, firstName: true }} }} }},
          }},
        }},
      }},
    }},
  }});
  if (!session) {{
    throw new Error('No restored session found');
  }}
  const members = session.relationship.members.map((member) => member.user);
  console.log(JSON.stringify({{ session, members }}));
  await prisma.$disconnect();
}}

main().catch(async (error) => {{
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
}});
"""
    result = run_command(["npx", "tsx", "-e", query_script], cwd=REPO_ROOT / "backend", timeout=60)
    if result.returncode != 0:
        raise GoldLoopError(f"restored session lookup failed:\n{result.stderr}\n{result.stdout}")
    data = json.loads(result.stdout.strip().splitlines()[-1])
    members = data.get("members") or []
    require(len(members) >= 2, "Restored session must have at least two relationship members for the two-actor loop")

    def find_member(character: str, fallback_index: int) -> dict[str, Any]:
        lowered = character.lower()
        for member in members:
            names = [member.get("firstName"), member.get("name"), member.get("email")]
            if any(value and lowered in str(value).lower() for value in names):
                return member
        return members[fallback_index]

    assigned = find_member(first_character, 0)
    partner = find_member(second_character, 1 if members[0]["id"] == assigned["id"] else 0)
    if partner["id"] == assigned["id"]:
        partner = next(member for member in members if member["id"] != assigned["id"])
    restored_session_id = data["session"]["id"]
    return {
        "SESSION_ID": restored_session_id,
        "ASSIGNED_CHARACTER": first_character,
        "PARTNER_CHARACTER": second_character,
        "ASSIGNED_ID": assigned["id"],
        "ASSIGNED_EMAIL": assigned["email"],
        "PARTNER_ID": partner["id"],
        "PARTNER_EMAIL": partner["email"],
        "ASSIGNED_URL": f"{app_url}/session/{restored_session_id}?e2e-user-id={assigned['id']}&e2e-user-email={assigned['email']}",
        "PARTNER_URL": f"{app_url}/session/{restored_session_id}?e2e-user-id={partner['id']}&e2e-user-email={partner['email']}",
        "START_MODE": "snapshot",
    }


def seed_stage1_session(api_url: str, app_url: str) -> dict[str, str]:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    seeded = post_json(
        f"{api_url}/api/e2e/seed-session",
        {
            "userA": {"email": f"gold-loop-adam-{stamp}@e2e.test", "name": "Adam"},
            "userB": {"email": f"gold-loop-eve-{stamp}@e2e.test", "name": "Eve"},
            "targetStage": "CREATED",
        },
    )
    if not seeded.get("success"):
        raise GoldLoopError(f"seed-session failed: {seeded}")
    data = seeded["data"]
    session_id = data["session"]["id"]
    user_a_id = data["userA"]["id"]
    user_a_email = data["userA"]["email"]
    user_b_id = data["userB"]["id"]
    user_b_email = data["userB"]["email"]

    advance_script = f"""
import {{ prisma }} from './src/lib/prisma';

async function main() {{
const sessionId = {json.dumps(session_id)};
const userAId = {json.dumps(user_a_id)};
const now = new Date();
const stage0CompletedAt = new Date(now.getTime() - 30000);

await prisma.session.update({{
  where: {{ id: sessionId }},
  data: {{
    status: 'INVITED',
    topicFrame: 'Future and stability',
    topicFrameConfirmedAt: stage0CompletedAt,
  }},
}});

await prisma.invitation.updateMany({{
  where: {{ sessionId }},
  data: {{
    messageConfirmed: true,
    messageConfirmedAt: stage0CompletedAt,
    status: 'PENDING',
  }},
}});

await prisma.stageProgress.upsert({{
  where: {{ sessionId_userId_stage: {{ sessionId, userId: userAId, stage: 0 }} }},
  update: {{
    status: 'COMPLETED',
    completedAt: stage0CompletedAt,
    gatesSatisfied: {{ compactSigned: true, compactSignedAt: stage0CompletedAt.toISOString() }},
  }},
  create: {{
    sessionId,
    userId: userAId,
    stage: 0,
    status: 'COMPLETED',
    startedAt: new Date(stage0CompletedAt.getTime() - 30000),
    completedAt: stage0CompletedAt,
    gatesSatisfied: {{ compactSigned: true, compactSignedAt: stage0CompletedAt.toISOString() }},
  }},
}});

await prisma.stageProgress.upsert({{
  where: {{ sessionId_userId_stage: {{ sessionId, userId: userAId, stage: 1 }} }},
  update: {{
    status: 'IN_PROGRESS',
    startedAt: stage0CompletedAt,
    completedAt: null,
    gatesSatisfied: {{}},
  }},
  create: {{
    sessionId,
    userId: userAId,
    stage: 1,
    status: 'IN_PROGRESS',
    startedAt: stage0CompletedAt,
    gatesSatisfied: {{}},
  }},
}});

const existingMessages = await prisma.message.count({{ where: {{ sessionId, forUserId: userAId }} }});
if (existingMessages === 0) {{
  await prisma.message.createMany({{
    data: [
      {{
        sessionId,
        senderId: null,
        forUserId: userAId,
        role: 'SYSTEM',
        content: 'The invitation topic has been confirmed. Adam is now ready for Stage 1 witnessing.',
        stage: 1,
        timestamp: stage0CompletedAt,
      }},
      {{
        sessionId,
        senderId: null,
        forUserId: userAId,
        role: 'AI',
        content: 'Let us slow down and focus on your side for a moment. What feels most important for Eve to understand about what has been happening for you?',
        stage: 1,
        timestamp: now,
      }},
    ],
  }});
}}

await prisma.$disconnect();
console.log(JSON.stringify({{ sessionId, userAId }}));
}}

main().catch(async (error) => {{
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
}});
"""
    result = run_command(["npx", "tsx", "-e", advance_script], cwd=REPO_ROOT / "backend", timeout=60)
    if result.returncode != 0:
        raise GoldLoopError(f"Stage 1 DB seed failed:\n{result.stderr}\n{result.stdout}")

    return {
        "SESSION_ID": session_id,
        "ASSIGNED_CHARACTER": "Adam",
        "PARTNER_CHARACTER": "Eve",
        "ASSIGNED_ID": user_a_id,
        "ASSIGNED_EMAIL": user_a_email,
        "PARTNER_ID": user_b_id,
        "PARTNER_EMAIL": user_b_email,
        "ASSIGNED_URL": f"{app_url}/session/{session_id}?e2e-user-id={user_a_id}&e2e-user-email={user_a_email}",
        "PARTNER_URL": f"{app_url}/session/{session_id}?e2e-user-id={user_b_id}&e2e-user-email={user_b_email}",
    }


def newest_run_dir(scenario: str, iteration: int) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return RUNS_ROOT / f"{stamp}-{scenario}-iter-{iteration:02d}"


def top_level_summary_path(scenario: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return RUNS_ROOT / f"{stamp}-{scenario}-loop-summary.md"


def service_dir_path(scenario: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return RUNS_ROOT / f"{stamp}-{scenario}-services"


def browser_session_name(side: str, session_id: str) -> str:
    return f"mwf-gold-{side.lower()}-{session_id}"


def close_agent_browser_sessions(session_names: Iterable[str]) -> dict[str, Any]:
    """Close named agent-browser sessions and report failures without raising."""
    results: dict[str, Any] = {}
    for name in sorted(set(session_names)):
        if not name:
            continue
        result = run_command(["agent-browser", "--session", name, "close"], timeout=30)
        results[name] = {
            "returncode": result.returncode,
            "stderr": result.stderr.strip(),
        }
    return results


def close_mwf_agent_browser_sessions() -> dict[str, Any]:
    """Best-effort cleanup for stale mwf-gold agent-browser sessions."""
    result = run_command(["agent-browser", "session", "list"], timeout=30)
    sessions: list[str] = []
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            name = line.strip().lstrip("→").strip()
            if name.startswith("mwf-gold-"):
                sessions.append(name)
    return close_agent_browser_sessions(sessions)


def build_actor_prompt(
    actor: Actor,
    partner: Actor,
    session_id: str,
    stop_after_stage: int,
    run_dir: Path,
    scenario: str,
) -> str:
    browser_session = browser_session_name(actor.side, session_id)
    profile_path = scenario_gold_profile_path(scenario)
    profile_line = (
        f"Gold scenario profile: {profile_path}\nRead this before driving the persona; treat it as transcript-derived evidence about behavioral range, resistance, and outcome shape."
        if profile_path
        else "Gold scenario profile: none available; infer behavioral range directly from the golden transcript."
    )
    return f"""Use mwf-gold-loop-actor.

You are {actor.character} in the `{scenario}` golden scenario.
Open this exact assigned E2E URL with agent-browser session `{browser_session}` and drive only {actor.character}:
{actor.url}

Partner side: {partner.character}
Scenario id: {scenario}
Session id: {session_id}
Run artifact directory: {run_dir}
{profile_line}

Continue as {actor.character} until one of these happens:
- the next legitimate action belongs to {partner.character},
- you reach the end of Stage {stop_after_stage},
- the run is completed,
- a product/state/browser bug blocks progress.

If a visible Stage 1 "I feel heard" / feel-heard confirmation CTA is present for {actor.character}, click the CTA. Do not type a chat message to satisfy a product gate. Do not report Stage 2 progress unless the UI actually moves past the Stage 1 gate.

If a visible Stage 0 compact/getting-started screen is present for {actor.character}, including copy like "Ready to begin?" with a "Ready" CTA, click it and continue. The header may show the partner's name because the session is "with {partner.character}"; do not treat that alone as evidence that you are operating the partner side.

If Stage {stop_after_stage} shows a visible share suggestion, context-share decision, validation card, proposal inventory, rank/select/submit controls, draft review, or text input for {actor.character}, treat it as legitimate in-stage work. Respond to that action before reporting "stage_limit_reached". In Stage 4, do not report "stage_limit_reached" merely after adding ideas; use it only after this assigned side has submitted selections or the stage is visibly closed for this side. If the visible next action belongs to {partner.character}, use "needs_partner" with "blocked_on": "{partner.side}".

For Stage 2 specifically, a post-empathy prompt like "Share this with {partner.character}? Review", "Review what you'll share", "Share this version", or "Does this still feel true?" is a required context-share/review action for {actor.character}. Open the review, share/decline/refine in character, and only then report waiting or stage-limit status. Do not stop merely because an empathy attempt was submitted if a share/context review prompt remains visible.

Exchange-history surfaces are diagnostic only. Do not open them to satisfy Stage 2. If exchange history is already open and it blocks controls, dismiss it or reload the page before deciding whether a real stage action remains.

In Stage 4, do not keep adding ideas indefinitely just because the chat input remains visible. Once {actor.character} has contributed one or two concrete proposals or individual commitments and has made visible willingness selections for the current proposal inventory, stop and report `needs_partner` if closure buttons are still disabled because {partner.character}'s private selections, proposals, review, or closure are pending.

For Stage 4 specifically, "stage_limit_reached" must have `"blocked_on": null`. If {actor.character} is waiting for {partner.character} to submit proposals, selections, review, or closure, report `"state": "needs_partner"` instead.

Keep browser observations compact. Prefer `agent-browser ... snapshot -i` over full snapshots, and do not paste long prior transcript history into the final answer.

Do not operate the partner side. Use agent-browser CLI through the mwf-gold-loop-actor skill. Maintain the scratch log required by the gold skills.

End your final answer with exactly one machine-readable status block:

MWF_GOLD_STATUS:
```json
{{
  "side": "{actor.side}",
  "session_id": "{session_id}",
  "stage": 0,
  "state": "needs_partner",
  "blocked_on": "{partner.side}",
  "next_action_needed": "brief concrete next action, or null",
  "scratch_log": "absolute or repo-relative scratch log path, or null",
  "current_url": "current browser URL, or null"
}}
```

Allowed state values: {", ".join(sorted(VALID_STATES))}.
Use "stage_limit_reached" when this side has no more work because Stage {stop_after_stage} is complete for this side.
"""


def build_resume_prompt(actor: Actor, partner: Actor, session_id: str, stop_after_stage: int) -> str:
    return f"""Continue the same mwf-gold-loop-actor run as {actor.character}.

Session id: {session_id}
Partner side: {partner.character}
Stop after Stage {stop_after_stage}.

Inspect the current in-app browser state, continue if {actor.character} has a legitimate action, and stop when blocked on {partner.character}, Stage {stop_after_stage} is reached, completed, or bug-blocked.
If a visible Stage 1 "I feel heard" / feel-heard confirmation CTA is present for {actor.character}, click the CTA. Do not type a chat message to satisfy a product gate. Do not report Stage 2 progress unless the UI actually moves past the Stage 1 gate.
If a visible Stage 0 compact/getting-started screen is present for {actor.character}, including copy like "Ready to begin?" with a "Ready" CTA, click it and continue. The header may show the partner's name because the session is "with {partner.character}"; do not treat that alone as evidence that you are operating the partner side.
If Stage {stop_after_stage} shows a visible share suggestion, context-share decision, validation card, proposal inventory, rank/select/submit controls, draft review, or text input for {actor.character}, handle that in-stage action before reporting "stage_limit_reached". In Stage 4, do not report "stage_limit_reached" merely after adding ideas; use it only after this assigned side has submitted selections or the stage is visibly closed for this side. If the visible next action belongs to {partner.character}, use "needs_partner" with "blocked_on": "{partner.side}".
For Stage 2 specifically, a post-empathy prompt like "Share this with {partner.character}? Review", "Review what you'll share", "Share this version", or "Does this still feel true?" is a required context-share/review action for {actor.character}. Open the review, share/decline/refine in character, and only then report waiting or stage-limit status. Do not stop merely because an empathy attempt was submitted if a share/context review prompt remains visible.
Exchange-history surfaces are diagnostic only. Do not open them to satisfy Stage 2. If exchange history is already open and it blocks controls, dismiss it or reload the page before deciding whether a real stage action remains.
In Stage 4, do not keep adding ideas indefinitely just because the chat input remains visible. Once {actor.character} has contributed one or two concrete proposals or individual commitments and has made visible willingness selections for the current proposal inventory, stop and report `needs_partner` if closure buttons are still disabled because {partner.character}'s private selections, proposals, review, or closure are pending.
For Stage 4 specifically, "stage_limit_reached" must have `"blocked_on": null`. If {actor.character} is waiting for {partner.character} to submit proposals, selections, review, or closure, report `"state": "needs_partner"` instead.
Keep browser observations compact. Prefer `agent-browser ... snapshot -i` over full snapshots, and do not paste long prior transcript history into the final answer.

End with the required MWF_GOLD_STATUS JSON block using one of: {", ".join(sorted(VALID_STATES))}.
"""


def extract_json_objects(text: str) -> Iterable[dict[str, Any]]:
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            yield obj


def parse_status(text: str, expected_side: str | None = None, session_id: str | None = None) -> ActorStatus:
    candidates = list(extract_json_objects(text))
    status_obj = None
    required = {"side", "session_id", "state"}
    for obj in reversed(candidates):
        if required.issubset(obj.keys()):
            status_obj = obj
            break
    if status_obj is None:
        raise GoldLoopError("No MWF_GOLD_STATUS JSON object found")

    side = str(status_obj["side"]).lower()
    state = str(status_obj["state"])
    if expected_side and side != expected_side.lower():
        raise GoldLoopError(f"Status side mismatch: expected {expected_side}, got {side}")
    if session_id and str(status_obj["session_id"]) != session_id:
        raise GoldLoopError(f"Status session mismatch: expected {session_id}, got {status_obj['session_id']}")
    if state not in VALID_STATES:
        raise GoldLoopError(f"Invalid actor state: {state}")

    stage_value = status_obj.get("stage")
    stage = None
    if stage_value is not None:
        try:
            stage = int(stage_value)
        except (TypeError, ValueError) as exc:
            raise GoldLoopError(f"Invalid stage value: {stage_value}") from exc

    return ActorStatus(
        side=side,
        session_id=str(status_obj["session_id"]),
        stage=stage,
        state=state,
        blocked_on=status_obj.get("blocked_on"),
        next_action_needed=status_obj.get("next_action_needed"),
        scratch_log=status_obj.get("scratch_log"),
        current_url=status_obj.get("current_url"),
        raw=status_obj,
    )


UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)


def find_codex_session_id(jsonl_path: Path) -> str | None:
    if not jsonl_path.exists():
        return None
    preferred_keys = ("session_id", "conversation_id", "thread_id", "rollout_id")
    found: list[str] = []

    def walk(value: Any, key_hint: str = "") -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                walk(child, key)
        elif isinstance(value, list):
            for child in value:
                walk(child, key_hint)
        elif isinstance(value, str):
            if key_hint in preferred_keys and UUID_RE.fullmatch(value):
                found.insert(0, value)
            elif UUID_RE.fullmatch(value):
                found.append(value)

    for line in jsonl_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            walk(json.loads(line))
        except json.JSONDecodeError:
            continue
    return found[0] if found else None


def run_codex_status_command(
    cmd: list[str],
    last_path: Path,
    jsonl_path: Path,
    expected_side: str,
    session_id: str,
    timeout: int,
    require_session_id: bool,
) -> tuple[subprocess.CompletedProcess[str], ActorStatus | None]:
    """Run a Codex actor command, accepting a valid status file even if the CLI lingers."""
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    if last_path.exists():
        last_path.unlink()
    deadline = time.time() + timeout if timeout else None
    with jsonl_path.open("a", encoding="utf-8") as handle:
        process = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            stdout=handle,
            stderr=subprocess.STDOUT,
        )
        while True:
            returncode = process.poll()
            if last_path.exists():
                try:
                    status = parse_status(last_path.read_text(encoding="utf-8"), expected_side, session_id)
                    if require_session_id and find_codex_session_id(jsonl_path) is None and returncode is None:
                        session_deadline = time.time() + 10
                        while time.time() < session_deadline and find_codex_session_id(jsonl_path) is None:
                            time.sleep(1)
                            returncode = process.poll()
                            if returncode is not None:
                                break
                    if returncode is None:
                        process.terminate()
                        try:
                            returncode = process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            returncode = process.wait(timeout=5)
                    return subprocess.CompletedProcess(cmd, returncode or 0, "", ""), status
                except Exception:
                    if returncode is not None:
                        break
            if returncode is not None:
                break
            if deadline is not None and time.time() >= deadline:
                process.kill()
                returncode = process.wait(timeout=5)
                return subprocess.CompletedProcess(cmd, returncode, "", "codex actor timed out"), None
            time.sleep(2)

    return subprocess.CompletedProcess(cmd, process.returncode or 1, "", ""), None


def run_codex_actor(
    actor: Actor,
    partner: Actor,
    session_id: str,
    stop_after_stage: int,
    run_dir: Path,
    timeout: int,
    scenario: str,
) -> ActorStatus:
    actor.turns += 1
    jsonl = run_dir / f"codex-{actor.side}.jsonl"
    last = run_dir / f"{actor.side}.last.md"
    if actor.codex_session_id:
        prompt = build_resume_prompt(actor, partner, session_id, stop_after_stage)
        cmd = [
            "codex",
            "exec",
            "resume",
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "-o",
            str(last),
            actor.codex_session_id,
            prompt,
        ]
    else:
        prompt = build_actor_prompt(actor, partner, session_id, stop_after_stage, run_dir, scenario)
        cmd = [
            "codex",
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--cd",
            str(REPO_ROOT),
            "--json",
            "-o",
            str(last),
            prompt,
        ]

    result, status = run_codex_status_command(
        cmd,
        last,
        jsonl,
        actor.side,
        session_id,
        timeout,
        require_session_id=actor.codex_session_id is None,
    )
    if not actor.codex_session_id:
        actor.codex_session_id = find_codex_session_id(jsonl)
    if status is not None:
        status = normalize_actor_status(status)
        actor.status = status
        return status
    if result.returncode != 0:
        status = ActorStatus.error(actor.side, session_id, f"codex exited {result.returncode}: {result.stderr.strip()}")
        actor.status = status
        return status
    try:
        status = parse_status(last.read_text(encoding="utf-8"), actor.side, session_id)
        status = normalize_actor_status(status)
    except Exception as exc:
        status = ActorStatus.error(actor.side, session_id, str(exc))
    actor.status = status
    return status


def run_mock_actor(actor: Actor, partner: Actor, session_id: str, stop_after_stage: int, run_dir: Path, timeout: int) -> ActorStatus:
    del timeout
    actor.turns += 1
    if actor.turns == 1:
        state = "needs_partner"
        stage = 1
        blocked_on = partner.side
    elif actor.turns == 2:
        state = "can_continue"
        stage = 2
        blocked_on = None
    else:
        state = "stage_limit_reached"
        stage = stop_after_stage
        blocked_on = None
    status = ActorStatus(
        side=actor.side,
        session_id=session_id,
        stage=stage,
        state=state,
        blocked_on=blocked_on,
        next_action_needed=f"mock next action for {partner.side}" if blocked_on else None,
        scratch_log=None,
        current_url=actor.url,
    )
    actor.status = status
    (run_dir / f"{actor.side}.last.md").write_text(
        "Mock actor turn.\n\nMWF_GOLD_STATUS:\n```json\n"
        + json.dumps(asdict(status), indent=2)
        + "\n```\n",
        encoding="utf-8",
    )
    (run_dir / f"codex-{actor.side}.jsonl").write_text(
        json.dumps({"mock": True, "side": actor.side, "turn": actor.turns}) + "\n",
        encoding="utf-8",
    )
    return status


TERMINAL_ACTOR_STATES = {"stage_limit_reached", "completed"}
FAILED_ACTOR_STATES = {"bug_blocked", "error"}


def normalize_actor_status(status: ActorStatus) -> ActorStatus:
    """Convert contradictory terminal waits back into partner waits."""
    if status.state in TERMINAL_ACTOR_STATES and status.blocked_on:
        return ActorStatus(
            side=status.side,
            session_id=status.session_id,
            stage=status.stage,
            state="needs_partner",
            blocked_on=status.blocked_on,
            next_action_needed=status.next_action_needed,
            scratch_log=status.scratch_log,
            current_url=status.current_url,
            raw=status.raw,
        )
    return status


def actor_satisfies_stop_boundary(actor: Actor, stop_after_stage: int) -> bool:
    status = actor.status
    if not status:
        return False
    if status.state in TERMINAL_ACTOR_STATES:
        return not status.blocked_on
    try:
        stage = int(status.stage)
    except (TypeError, ValueError):
        return False
    if status.state != "needs_partner" or stage < stop_after_stage:
        return False
    # Stage 2 includes draft/share/reveal/validation work that can reopen the
    # partner after both sides have entered the stage. A blocked partner wait is
    # only a stop boundary for the early Stage 0/1 gates; later stages must
    # clear the blocker before scoring.
    return not status.blocked_on or stop_after_stage < 2


def actor_has_unanswered_blocker(actors: dict[str, Actor], target_side: str, stop_after_stage: int = 0) -> bool:
    target = actors[target_side]
    for actor in actors.values():
        status = actor.status
        if not status or not status.blocked_on:
            continue
        target_has_had_chance = actor.turns >= target.turns if stop_after_stage == 2 else actor.turns > target.turns
        if str(status.blocked_on).lower() == target_side and target_has_had_chance:
            if (
                stop_after_stage < 4
                and actor_satisfies_stop_boundary(actor, stop_after_stage)
                and actor_satisfies_stop_boundary(target, stop_after_stage)
            ):
                continue
            return True
    return False


def choose_next_actor(actors: dict[str, Actor], last_side: str | None = None, stop_after_stage: int = 0) -> Actor | None:
    if any(actor.status and actor.status.state in FAILED_ACTOR_STATES for actor in actors.values()):
        return None
    if all(
        actor_satisfies_stop_boundary(actor, stop_after_stage)
        and not actor_has_unanswered_blocker(actors, side, stop_after_stage)
        for side, actor in actors.items()
    ):
        return None

    for actor in actors.values():
        if actor.status and actor.status.state == "can_continue":
            return actor

    for side, actor in actors.items():
        if actor_has_unanswered_blocker(actors, side, stop_after_stage):
            return actor

    if last_side and actors[last_side].status:
        blocked_on = actors[last_side].status.blocked_on
        if blocked_on:
            blocked_on = str(blocked_on).lower()
            if blocked_on in actors:
                target = actors[blocked_on]
                if not actor_satisfies_stop_boundary(target, stop_after_stage) or actor_has_unanswered_blocker(actors, blocked_on, stop_after_stage):
                    return target

    for actor in actors.values():
        if not actor.status:
            return actor
    if last_side:
        for side, actor in actors.items():
            if side != last_side and actor.status and not actor_satisfies_stop_boundary(actor, stop_after_stage):
                return actor
    for actor in actors.values():
        if actor.status and not actor_satisfies_stop_boundary(actor, stop_after_stage):
            return actor
    return None


def copy_scratch_logs(session_id: str, run_dir: Path) -> list[str]:
    copied: list[str] = []
    if not SCRATCH_ROOT.exists():
        return copied
    target = run_dir / "scratch"
    target.mkdir(exist_ok=True)
    for path in SCRATCH_ROOT.glob(f"*{session_id}*.md"):
        dest = target / path.name
        shutil.copy2(path, dest)
        copied.append(str(dest))
    return copied


STAGE_HEADING_RE = re.compile(r"^## Stage (\d+)\s*$", re.MULTILINE)


def infer_transcript_side(path: Path, text: str, sides: Iterable[str]) -> str | None:
    path_text = path.name.lower()
    for side in sides:
        if side in path_text:
            return side
    title = re.search(r"^# Chat Transcript:\s*(.+?)\s*$", text, re.MULTILINE)
    if title:
        title_text = title.group(1).strip().lower()
        for side in sides:
            if side == title_text or side in title_text.split():
                return side
    return None


def split_transcript_by_stage(text: str, max_stage: int) -> dict[int, str]:
    matches = list(STAGE_HEADING_RE.finditer(text))
    sections: dict[int, str] = {}
    if not matches:
        stripped = text.strip()
        return {0: stripped} if stripped else {}

    first = matches[0]
    prefix = text[: first.start()].strip()
    if prefix:
        sections[0] = prefix

    for index, match in enumerate(matches):
        stage = int(match.group(1))
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body:
            sections[stage] = body
    return {stage: body for stage, body in sections.items() if 0 <= stage <= max_stage}


def format_stage_transcript(side: str, stage: int, source_path: Path, body: str) -> str:
    display_side = side.capitalize()
    return "\n".join(
        [
            f"# {display_side} Stage {stage} Transcript",
            "",
            f"- side: `{side}`",
            f"- stage: `{stage}`",
            f"- source: `{source_path.name}`",
            "- ordering: source transcript chronological order",
            "- privacy: private side transcript; shared events are labeled in-line when present",
            "- visible_cta_state: see milestone/system lines when captured",
            "",
            "## Events",
            "",
            body.strip(),
            "",
        ]
    )


def write_stage_transcript_artifacts(
    transcript_paths: Iterable[Path],
    target_dir: Path,
    scenario: str,
    max_stage: int,
) -> list[str]:
    sides = scenario_sides(scenario)
    by_side: dict[str, Path] = {}
    for path in transcript_paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        side = infer_transcript_side(path, text, sides)
        if side and side not in by_side:
            by_side[side] = path

    written: list[str] = []
    for side in sides:
        source_path = by_side.get(side)
        if source_path is None:
            continue
        text = source_path.read_text(encoding="utf-8", errors="replace")
        sections = split_transcript_by_stage(text, max_stage)
        for stage in range(max_stage + 1):
            body = sections.get(stage, "").strip()
            if not body:
                continue
            dest = target_dir / f"{side}-stage{stage}.md"
            dest.write_text(format_stage_transcript(side, stage, source_path, body), encoding="utf-8")
            written.append(str(dest))
    return written


def write_mock_transcripts(run_dir: Path, scenario: str, max_stage: int) -> list[str]:
    target = run_dir / "transcripts"
    target.mkdir(exist_ok=True)
    written: list[str] = []
    for side in scenario_sides(scenario):
        for stage in range(max_stage + 1):
            dest = target / f"{side}-stage{stage}.md"
            display_side = side.capitalize()
            dest.write_text(
                "\n".join(
                    [
                        f"# {display_side} Stage {stage} Transcript",
                        "",
                        f"- side: `{side}`",
                        f"- stage: `{stage}`",
                        "- speaker: mock actor / mock MWF",
                        "- ordering: deterministic mock order",
                        "- privacy: private side transcript",
                        "- visible_cta_state: mock state",
                        "",
                        "## Events",
                        "",
                        f"1. [{display_side}] Mock participant message for stage {stage}.",
                        f"2. [MWF] Mock facilitator response for {display_side} stage {stage}.",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            written.append(str(dest))
    return written


def extract_transcripts(session_id: str, run_dir: Path, scenario: str, max_stage: int) -> list[str]:
    output_dir = REPO_ROOT / "backend/scripts/transcripts"
    before = set(output_dir.glob(f"*{session_id[:8]}*.md")) if output_dir.exists() else set()
    result = run_command(
        ["npx", "tsx", "scripts/extract-session-transcripts.ts", session_id],
        cwd=REPO_ROOT / "backend",
        timeout=120,
        env=backend_command_env(),
    )
    if result.returncode != 0:
        (run_dir / "transcript-extract-error.txt").write_text(result.stderr + "\n" + result.stdout, encoding="utf-8")
        return []
    target = run_dir / "transcripts"
    target.mkdir(exist_ok=True)
    after = set(output_dir.glob(f"*{session_id[:8]}*.md")) if output_dir.exists() else set()
    paths = sorted(after - before or after)
    copied: list[str] = []
    for path in paths:
        dest = target / path.name
        shutil.copy2(path, dest)
        copied.append(str(dest))
    stable = write_stage_transcript_artifacts((Path(path) for path in copied), target, scenario, max_stage)
    return stable or copied


def capture_db_stage_state(session_id: str, run_dir: Path) -> dict[str, Any]:
    script = r'''
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

(async () => {
  const prisma = new PrismaClient();
  const sessionId = process.argv[1];
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      relationship: { include: { members: { include: { user: true } } } },
      stageProgress: { orderBy: [{ userId: "asc" }, { stage: "asc" }] },
      messages: {
        orderBy: { timestamp: "asc" },
        select: { id: true, role: true, senderId: true, forUserId: true, stage: true, content: true, timestamp: true },
      },
      empathyAttempts: { include: { validations: true }, orderBy: [{ sourceUserId: "asc" }, { sharedAt: "asc" }] },
    },
  });
  if (!session) {
    console.log(JSON.stringify({ error: "session_not_found", sessionId }));
    return;
  }
  const users = session.relationship.members.map((member) => member.user);
  const userName = (id) => users.find((user) => user.id === id)?.name || id || null;
  console.log(JSON.stringify({
    session: { id: session.id, status: session.status },
    users: users.map((user) => ({ id: user.id, name: user.name, email: user.email })),
    stageProgress: session.stageProgress.map((row) => ({
      userId: row.userId,
      user: userName(row.userId),
      stage: row.stage,
      status: row.status,
      completedAt: row.completedAt,
      gates: row.gatesSatisfied,
    })),
    empathyAttempts: session.empathyAttempts.map((attempt) => ({
      id: attempt.id,
      sourceUserId: attempt.sourceUserId,
      sourceUser: userName(attempt.sourceUserId),
      status: attempt.status,
      sharedAt: attempt.sharedAt,
      revealedAt: attempt.revealedAt,
      validations: attempt.validations.map((validation) => ({
        userId: validation.userId,
        user: userName(validation.userId),
        validated: validation.validated,
        validatedAt: validation.validatedAt,
      })),
    })),
    messageStages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      stage: message.stage,
      senderId: message.senderId,
      sender: userName(message.senderId),
      forUserId: message.forUserId,
      forUser: userName(message.forUserId),
      contentPrefix: String(message.content || "").slice(0, 180),
    })),
  }));
  await prisma.$disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
'''
    result = run_command(
        ["npx", "tsx", "-e", script, session_id],
        cwd=REPO_ROOT / "backend",
        timeout=120,
        env=backend_command_env(),
    )
    if result.returncode != 0:
        (run_dir / "db-stage-state-error.txt").write_text(result.stderr + "\n" + result.stdout, encoding="utf-8")
        return {"status": "error", "error": result.stderr.strip() or result.stdout.strip()}
    try:
        state = json.loads(result.stdout)
    except json.JSONDecodeError:
        (run_dir / "db-stage-state-error.txt").write_text(result.stdout, encoding="utf-8")
        return {"status": "error", "error": "invalid_json", "raw": result.stdout}
    (run_dir / "db-stage-state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return state


CONTROL_TAG_RE = re.compile(
    r"</?(?:thinking|draft|dispatch|message|stage|private|shared|tool|analysis|commentary|final|feel[_-]?heard[_-]?check|ready[_-]?share|needs(?:[_-]?ready)?)\b[^>]*>",
    re.I,
)
TRANSCRIPT_METADATA_RE = re.compile(r"^- (side|stage|privacy|visible_cta_state):\s*(.+?)\s*$", re.MULTILINE)
TRANSCRIPT_EVENT_RE = re.compile(r"^(?:\d+\.|\*\*\[|###|---|\[)", re.MULTILINE)
TRANSCRIPT_AI_BLOCK_RE = re.compile(
    r"^\*\*\[(?P<timestamp>[^\]]+)\]\s+AI:\*\*\n(?P<body>.*?)(?=^\*\*\[|^###|^---|\Z)",
    re.M | re.S,
)
CHAT_PROMISE_RE = re.compile(
    r"\b(?:keep (?:talking|exploring|going)|tell me what needs to change|if there's more|if there is more)\b",
    re.I,
)
INPUT_VISIBLE_RE = re.compile(r"\b(?:input|textbox|chat-input|text input)\s*(?:=|:|is)?\s*(?:visible|shown|available|enabled)\b", re.I)


def invariant_result(
    check_id: str,
    passed: bool,
    severity: str = "hard",
    owner: str = "eval_harness",
    dimension: str = "invariants",
    details: str = "",
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": check_id,
        "status": "pass" if passed else "fail",
        "severity": severity,
        "owner": owner,
        "dimension": dimension,
        "details": details,
        "evidence": evidence or [],
    }


def transcript_metadata(text: str) -> dict[str, str]:
    return {match.group(1): match.group(2).strip() for match in TRANSCRIPT_METADATA_RE.finditer(text)}


def read_transcript_texts(transcript_paths: Iterable[str]) -> list[tuple[Path, str]]:
    texts: list[tuple[Path, str]] = []
    for raw_path in transcript_paths:
        path = Path(raw_path)
        if not path.exists():
            continue
        texts.append((path, path.read_text(encoding="utf-8", errors="replace")))
    return texts


def check_no_visible_control_tags(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        for match in CONTROL_TAG_RE.finditer(text):
            evidence.append(f"{path.name}: {match.group(0)}")
            if len(evidence) >= 10:
                break
    return invariant_result(
        "no_visible_internal_control_tags",
        not evidence,
        owner="product_code",
        dimension="visible_text",
        details="Stable transcripts must not expose internal micro-tags or control tags.",
        evidence=evidence,
    )


def check_transcript_side_stage_metadata(
    transcripts: list[tuple[Path, str]],
    scenario: str,
    max_stage: int,
    required_stages: set[int] | None = None,
) -> list[dict[str, Any]]:
    sides = set(scenario_sides(scenario))
    stages = required_stages if required_stages is not None else set(range(max_stage + 1))
    expected = {(side, stage) for side in sides for stage in stages if 0 <= stage <= max_stage}
    observed: set[tuple[str, int]] = set()
    evidence: list[str] = []
    cta_evidence: list[str] = []
    for path, text in transcripts:
        metadata = transcript_metadata(text)
        side = metadata.get("side", "").strip("`").lower()
        stage_text = metadata.get("stage", "").strip("`")
        try:
            stage = int(stage_text)
        except ValueError:
            evidence.append(f"{path.name}: invalid stage metadata {stage_text!r}")
            continue
        if side not in sides:
            evidence.append(f"{path.name}: invalid side metadata {side!r}")
            continue
        observed.add((side, stage))
        expected_name = f"{side}-stage{stage}.md"
        if path.name != expected_name:
            evidence.append(f"{path.name}: expected stable name {expected_name}")
        if "visible_cta_state" not in metadata:
            cta_evidence.append(f"{path.name}: missing visible_cta_state metadata")
    missing = sorted(expected - observed)
    evidence.extend(f"missing transcript for {side} stage {stage}" for side, stage in missing)
    return [
        invariant_result(
            "transcript_side_stage_complete",
            not evidence,
            owner="eval_harness",
            dimension="transcript_extraction",
            details="Stable transcript files must exist for every expected side/stage and carry matching metadata.",
            evidence=evidence,
        ),
        invariant_result(
            "cta_input_visibility_state_sane",
            not cta_evidence,
            owner="eval_harness",
            dimension="transcript_extraction",
            details="Transcript artifacts must include visible CTA/input state metadata or an explicit captured-state note.",
            evidence=cta_evidence,
        ),
    ]


def check_stage4_score_critical_content(
    transcripts: list[tuple[Path, str]],
    scenario: str,
    max_stage: int,
) -> dict[str, Any]:
    if max_stage < 4:
        return invariant_result(
            "stage4_score_critical_content_transcribed",
            True,
            severity="soft",
            owner="eval_harness",
            dimension="transcript_extraction",
            details="Stage 4 score-critical content only applies to runs that target Stage 4.",
            evidence=[f"stop_after_stage={max_stage} skipped"],
        )

    sides = set(scenario_sides(scenario))
    transcript_by_name = {path.name: text for path, text in transcripts}
    required_markers = {
        "proposal inventory": ("STAGE 4 PROPOSAL INVENTORY",),
        "selection evidence": ("Your selection:", "Partner selection:", "Selection submitted:"),
        "coverage audit": ("STAGE 4 NEEDS COVERAGE AUDIT",),
        "closure or product-blocked state": (
            "STAGE 4 CLOSURE",
            "product-blocked",
            "bug_blocked",
            "No Stage 4 closure captured.",
        ),
    }
    evidence: list[str] = []

    for side in sorted(sides):
        name = f"{side}-stage4.md"
        text = transcript_by_name.get(name, "")
        if not text:
            evidence.append(f"{name}: missing Stage 4 transcript")
            continue
        for label, markers in required_markers.items():
            if not any(marker in text for marker in markers):
                evidence.append(f"{name}: missing {label}")

    return invariant_result(
        "stage4_score_critical_content_transcribed",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details=(
            "Stage 4 transcripts must preserve score-critical product state: proposal inventory, "
            "selection evidence, needs coverage audit, and closure/outcome or an explicit product-blocked state."
        ),
        evidence=evidence,
    )


def check_invitee_topic_handoff_transcribed(
    transcripts: list[tuple[Path, str]],
    run_data: dict[str, Any],
    scenario: str,
) -> dict[str, Any]:
    start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
    if str(start.get("mode") or "") != "fresh":
        return invariant_result(
            "invitee_topic_handoff_transcribed",
            True,
            severity="soft",
            owner="eval_harness",
            dimension="transcript_extraction",
            details="Invitee topic handoff transcription applies to fresh sessions; restored/seeded runs may start after the handoff.",
            evidence=[f"start mode {start.get('mode')!r} skipped"],
        )

    sides = scenario_sides(scenario)
    if len(sides) < 2:
        return invariant_result(
            "invitee_topic_handoff_transcribed",
            True,
            severity="soft",
            owner="eval_harness",
            dimension="transcript_extraction",
            details="Invitee topic handoff transcription requires a two-sided scenario.",
            evidence=[f"sides={sides!r}"],
        )

    session_roles = run_data.get("session_roles") if isinstance(run_data.get("session_roles"), dict) else {}
    inviter = str(session_roles.get("assigned_character") or sides[0]).lower()
    invitees = [side for side in sides if side != inviter]
    expected_phrases = (
        "INVITEE TOPIC HANDOFF",
        "Before we begin, this is what",
        "would like to work through with you",
        "This is how things look from their side right now",
    )

    evidence: list[str] = []
    transcript_by_name = {path.name: text for path, text in transcripts}
    for invitee in invitees:
        name = f"{invitee}-stage0.md"
        text = transcript_by_name.get(name, "")
        if not text:
            evidence.append(f"{name}: missing invitee stage 0 transcript")
            continue
        missing = [phrase for phrase in expected_phrases if phrase not in text]
        if missing:
            evidence.append(f"{name}: missing topic handoff transcript phrase(s): {', '.join(missing)}")

    return invariant_result(
        "invitee_topic_handoff_transcribed",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details="Fresh invitee Stage 0 transcripts must preserve the visible topic/process handoff card shown before the invitee opener.",
        evidence=evidence,
    )


def check_stage_limit_reached(run_data: dict[str, Any], scenario: str, max_stage: int) -> dict[str, Any]:
    sides = set(scenario_sides(scenario))
    latest: dict[str, dict[str, Any]] = {}
    evidence: list[str] = []
    for entry in run_data.get("status_history", []):
        side = str(entry.get("side", "")).lower()
        status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
        if side in sides:
            latest[side] = status
        elif side:
            evidence.append(f"unexpected actor side in status history: {side}")
    for side in sorted(sides):
        status = latest.get(side)
        if not status:
            evidence.append(f"{side}: missing final actor status")
            continue
        state = status.get("state")
        stage = status.get("stage")
        try:
            stage_int = int(stage)
            if stage_int < max_stage:
                evidence.append(f"{side}: final stage {stage!r} is below stop_after_stage {max_stage}")
        except (TypeError, ValueError):
            evidence.append(f"{side}: invalid final stage {stage!r}")
            continue
        if state not in TERMINAL_ACTOR_STATES and not (state == "needs_partner" and stage_int >= max_stage):
            evidence.append(f"{side}: final state {state!r} does not satisfy stop_after_stage {max_stage}")
    return invariant_result(
        "stage_limit_reached_correctly",
        not evidence,
        owner="eval_harness",
        dimension="actor_orchestration",
        details="Every scenario side must reach the requested stage limit, a completed state, or a no-action partner wait at the requested stop stage.",
        evidence=evidence,
    )


def check_db_stage_state_matches_stop_gate(run_data: dict[str, Any], scenario: str, max_stage: int) -> dict[str, Any]:
    evidence: list[str] = []
    state = run_data.get("db_stage_state")
    if not isinstance(state, dict) or state.get("status") == "error":
        error = state.get("error") if isinstance(state, dict) else "missing db_stage_state"
        evidence.append(f"db stage state unavailable: {error}")
        return invariant_result(
            "db_stage_state_matches_stop_gate",
            False,
            owner="eval_harness",
            dimension="actor_orchestration",
            details="Gold-loop gate evaluation must inspect DB StageProgress, Message.stage, and empathy lifecycle state instead of trusting actor transcript/status text alone.",
            evidence=evidence,
        )

    users = {str(user.get("name", "")).lower(): str(user.get("id", "")) for user in state.get("users", []) if isinstance(user, dict)}
    progress = state.get("stageProgress") if isinstance(state.get("stageProgress"), list) else []
    messages = state.get("messageStages") if isinstance(state.get("messageStages"), list) else []
    empathy_attempts = state.get("empathyAttempts") if isinstance(state.get("empathyAttempts"), list) else []
    sides = scenario_sides(scenario)
    side_ids = {side: users.get(side) for side in sides}
    start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
    prior_stages = range(0, max_stage)
    if str(start.get("mode") or "") == "target_stage":
        prior_stages = range(0, 0)
    for side, user_id in side_ids.items():
        if not user_id:
            evidence.append(f"{side}: missing DB user")
            continue
        for stage in prior_stages:
            row = next((item for item in progress if item.get("userId") == user_id and item.get("stage") == stage), None)
            if not row:
                evidence.append(f"{side}: missing StageProgress stage {stage}")
            elif row.get("status") != "COMPLETED":
                evidence.append(f"{side}: StageProgress stage {stage} is {row.get('status')!r}, expected COMPLETED")
        row = next((item for item in progress if item.get("userId") == user_id and item.get("stage") == max_stage), None)
        if not row:
            evidence.append(f"{side}: missing StageProgress stop stage {max_stage}")
            continue
        status = row.get("status")
        gates = row.get("gates") if isinstance(row.get("gates"), dict) else {}
        if max_stage == 1:
            if status != "COMPLETED" or gates.get("feelHeardConfirmed") is not True:
                evidence.append(f"{side}: Stage 1 DB gate incomplete: status={status!r} gates={gates!r}")
        elif max_stage == 2:
            attempts = [attempt for attempt in empathy_attempts if attempt.get("sourceUserId") == user_id]
            if not attempts:
                evidence.append(f"{side}: missing EmpathyAttempt for Stage 2")
            else:
                attempt = attempts[-1]
                if attempt.get("status") not in {"READY", "REVEALED", "VALIDATED"}:
                    evidence.append(f"{side}: EmpathyAttempt status {attempt.get('status')!r} is not a completed stop-gate state")
            if status == "COMPLETED":
                if gates.get("empathyValidated") is not True:
                    evidence.append(f"{side}: Stage 2 marked COMPLETED without empathyValidated gate")
            elif status != "GATE_PENDING":
                evidence.append(f"{side}: Stage 2 DB status {status!r} is not GATE_PENDING or COMPLETED at stop gate")
        elif status not in {"GATE_PENDING", "COMPLETED"}:
            evidence.append(f"{side}: Stage {max_stage} DB status {status!r} is not GATE_PENDING or COMPLETED")

    user_message_stages = [
        int(message.get("stage"))
        for message in messages
        if message.get("role") in {"USER", "AI", "EMPATHY_STATEMENT", "SHARED_CONTEXT", "VALIDATION_FEEDBACK"}
        and isinstance(message.get("stage"), int)
    ]
    if user_message_stages and max(user_message_stages) < max_stage:
        evidence.append(f"highest Message.stage is {max(user_message_stages)}, below stop_after_stage {max_stage}")

    return invariant_result(
        "db_stage_state_matches_stop_gate",
        not evidence,
        owner="eval_harness",
        dimension="actor_orchestration",
        details="Gold-loop gate evaluation must inspect DB StageProgress, Message.stage, and empathy lifecycle state instead of trusting actor transcript/status text alone.",
        evidence=evidence,
    )


def check_actor_operated_correct_side(run_data: dict[str, Any], scenario: str) -> dict[str, Any]:
    sides = set(scenario_sides(scenario))
    evidence: list[str] = []
    for entry in run_data.get("status_history", []):
        side = str(entry.get("side", "")).lower()
        status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
        raw_side = str(status.get("side", side)).lower()
        if side not in sides:
            evidence.append(f"status entry side {side!r} is not in scenario")
        if raw_side != side:
            evidence.append(f"status entry side {side!r} has raw side {raw_side!r}")
    return invariant_result(
        "actor_operated_correct_side",
        not evidence,
        owner="actor_skill",
        dimension="actor_fidelity",
        details="Actor status blocks must match the side assigned by the orchestrator.",
        evidence=evidence,
    )


def check_session_started_with_profile_initiator(run_data: dict[str, Any], scenario: str) -> dict[str, Any]:
    role_shape = run_data.get("role_shape") if isinstance(run_data.get("role_shape"), dict) else {}
    confidence = str(role_shape.get("confidence") or "unknown")
    start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
    mode = str(start.get("mode") or "")
    session_roles = run_data.get("session_roles") if isinstance(run_data.get("session_roles"), dict) else {}
    assigned = str(session_roles.get("assigned_character") or "")
    initiator = str(role_shape.get("initiator") or "")

    evidence: list[str] = []
    if mode != "fresh":
        return invariant_result(
            "fresh_session_starts_with_profile_initiator",
            True,
            severity="soft",
            owner="eval_harness",
            dimension="actor_orchestration",
            details="Profile-derived initiator checks apply to fresh sessions; seeded and restored sessions may intentionally begin mid-flow.",
            evidence=[f"start mode {mode!r} skipped"],
        )
    if confidence not in {"medium", "high"}:
        return invariant_result(
            "fresh_session_starts_with_profile_initiator",
            True,
            severity="soft",
            owner="eval_harness",
            dimension="actor_orchestration",
            details="The gold profile did not clearly identify the initiator, so registry order remains the fallback.",
            evidence=[f"profile confidence {confidence!r}"],
        )
    if not assigned:
        evidence.append("run.json missing session_roles.assigned_character")
    if not initiator:
        evidence.append("run.json missing role_shape.initiator")
    if assigned and initiator and assigned.lower() != initiator.lower():
        evidence.append(f"fresh session assigned {assigned!r}, but profile initiator is {initiator!r}")
    return invariant_result(
        "fresh_session_starts_with_profile_initiator",
        not evidence,
        owner="eval_harness",
        dimension="actor_orchestration",
        details="Fresh gold-loop sessions should start with the participant identified by the gold profile's Stage 0 initiation evidence.",
        evidence=evidence,
    )


def check_felt_heard_gate_after_witnessing(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        metadata = transcript_metadata(text)
        stage_text = metadata.get("stage", "").strip("`")
        if stage_text != "1":
            continue
        lowered = text.lower()
        marker = lowered.find("felt heard")
        if marker < 0:
            continue
        before = text[:marker]
        event_count = len(TRANSCRIPT_EVENT_RE.findall(before))
        if event_count < 2:
            evidence.append(f"{path.name}: felt-heard marker appears after only {event_count} prior event(s)")
    return invariant_result(
        "felt_heard_gate_after_substantive_witnessing",
        not evidence,
        owner="product_code",
        dimension="stage_gates",
        details="A live Stage 1 felt-heard gate should not appear before any substantive transcript context.",
        evidence=evidence,
    )


def check_stage1_felt_heard_confirmation_transcribed(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    stage1_transcripts: list[Path] = []
    evidence: list[str] = []
    for path, text in transcripts:
        metadata = transcript_metadata(text)
        stage_text = metadata.get("stage", "").strip("`")
        if stage_text != "1":
            continue
        stage1_transcripts.append(path)
        lowered = text.lower()
        if "confirmed they feel heard" not in lowered:
            evidence.append(f"{path.name}: missing explicit feel-heard confirmation milestone")
    if not stage1_transcripts:
        evidence.append("missing stage 1 transcript artifacts")
    return invariant_result(
        "stage1_felt_heard_confirmation_transcribed",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details="Stable Stage 1 transcripts must make the user's explicit feel-heard confirmation auditable.",
        evidence=evidence,
    )


def skipped_stage1_for_target_stage(run_data: dict[str, Any]) -> bool:
    start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
    if str(start.get("mode") or "") != "target_stage":
        return False
    target_stage = str(start.get("target_stage") or "")
    target_stage_number = TARGET_STAGE_NUMBERS.get(target_stage)
    return target_stage_number is not None and target_stage_number > 1


def check_chat_copy_has_visible_input(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        metadata = transcript_metadata(text)
        visible_cta_state = metadata.get("visible_cta_state", "")
        if INPUT_VISIBLE_RE.search(visible_cta_state):
            continue
        side = metadata.get("side", "").strip("`").lower()
        side_label = side.capitalize()
        for ai_block in TRANSCRIPT_AI_BLOCK_RE.finditer(text):
            block = ai_block.group("body")
            for match in CHAT_PROMISE_RE.finditer(block):
                following_text = text[ai_block.end():]
                next_user_message = (
                    bool(side_label)
                    and re.search(rf"^\*\*\[[^\]]+\]\s+{re.escape(side_label)}:\*\*", following_text, re.MULTILINE)
                )
                if next_user_message:
                    continue
                absolute_start = ai_block.start("body") + match.start()
                absolute_end = ai_block.start("body") + match.end()
                start = max(0, absolute_start - 80)
                end = min(len(text), absolute_end + 80)
                snippet = " ".join(text[start:end].split())
                evidence.append(f"{path.name}: chat-promising copy without input-visible metadata: {snippet}")
                if len(evidence) >= 10:
                    break
            if len(evidence) >= 10:
                break
    return invariant_result(
        "chat_copy_promises_visible_input",
        not evidence,
        owner="product_code",
        dimension="ui_state",
        details="If visible copy invites the user to keep talking, transcript state must show a visible/enabled textbox.",
        evidence=evidence,
    )


def check_partner_private_leakage(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    leak_markers = ("PRIVATE_LEAK", "PARTNER_PRIVATE_LEAK")
    for path, text in transcripts:
        for marker in leak_markers:
            if marker in text:
                evidence.append(f"{path.name}: contains {marker}")
    return invariant_result(
        "no_partner_private_content_leakage",
        not evidence,
        owner="product_code",
        dimension="privacy",
        details="First slice checks explicit leak markers; richer structured leakage checks need DB event metadata.",
        evidence=evidence,
    )


SEPARATOR_BLOCK_RE = re.compile(r"---\s*\n(?P<body>.*?)\n\*20\d\d-\d\d-\d\d [^*]+\*\n---", re.S)
LABELED_SHARED_BLOCK_RE = re.compile(
    r"^(?:\*\*)?(?:[📤💡📝💜❓⚠️✅👁️📊]|YOU SHARED|SHARE SUGGESTION|RECEIVED|AI \(SHARE SUGGESTION\)|[^:\n]+ SHARED WITH YOU)",
    re.I,
)


def check_transcript_shared_context_blocks_labeled(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        for match in SEPARATOR_BLOCK_RE.finditer(text):
            body = match.group("body").strip()
            if not body:
                continue
            first_line = body.splitlines()[0].strip()
            if first_line.startswith("###"):
                continue
            if LABELED_SHARED_BLOCK_RE.search(first_line):
                continue
            if first_line.startswith("**"):
                continue
            snippet = " ".join(body.split())[:160]
            evidence.append(f"{path.name}: unlabeled separator block: {snippet}")
            if len(evidence) >= 10:
                break
    return invariant_result(
        "transcript_shared_context_blocks_labeled",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details="Stable transcript separator blocks must carry explicit labels so private suggestions and shared events are not confused.",
        evidence=evidence,
    )


SHARE_SUGGESTION_BLOCK_RE = re.compile(
    r"💡 SHARE SUGGESTION \(to help (?P<partner>[^)]+) understand you better\):\s*\n"
    r"(?P<content>.*?)\n\*20\d\d-\d\d-\d\d [^*]+\*",
    re.S,
)
PARTNER_SHARED_BLOCK_RE = re.compile(
    r"📤 (?P<partner>[^\n:]+) SHARED WITH YOU:\*\*\s*\n"
    r"(?P<content>.*?)\n\*20\d\d-\d\d-\d\d [^*]+\*",
    re.S,
)


def normalize_transcript_block(text: str) -> str:
    return " ".join(text.strip().strip('"').split())


def check_shared_context_directionality(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        own_suggestions = [
            normalize_transcript_block(match.group("content"))
            for match in SHARE_SUGGESTION_BLOCK_RE.finditer(text)
        ]
        if not own_suggestions:
            continue
        for incoming in PARTNER_SHARED_BLOCK_RE.finditer(text):
            incoming_content = normalize_transcript_block(incoming.group("content"))
            if not incoming_content:
                continue
            for own_suggestion in own_suggestions:
                if incoming_content == own_suggestion:
                    evidence.append(
                        f"{path.name}: partner-shared block duplicates this side's own share suggestion"
                    )
                    break
            if len(evidence) >= 10:
                break
    return invariant_result(
        "shared_context_directionality_consistent",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details="A transcript must not label the current user's own share suggestion as incoming partner-shared context.",
        evidence=evidence,
    )


INTERNAL_RECONCILER_ANALYSIS_RE = re.compile(
    r"RECONCILER ANALYSIS|Gap Severity:|Action:\s*(?:OFFER_|ADVANCE_|WAIT_|COMPLETE)|Alignment:\s*\d+%",
    re.I,
)


def check_no_internal_reconciler_analysis(transcripts: list[tuple[Path, str]]) -> dict[str, Any]:
    evidence: list[str] = []
    for path, text in transcripts:
        for match in INTERNAL_RECONCILER_ANALYSIS_RE.finditer(text):
            start = max(0, match.start() - 80)
            end = min(len(text), match.end() + 80)
            snippet = " ".join(text[start:end].split())
            evidence.append(f"{path.name}: internal reconciler analysis leaked into stable transcript: {snippet}")
            if len(evidence) >= 10:
                break
    return invariant_result(
        "no_internal_reconciler_analysis",
        not evidence,
        owner="eval_harness",
        dimension="transcript_extraction",
        details="Stable transcripts must not expose internal reconciler analysis, alignment scores, or action labels.",
        evidence=evidence,
    )


def run_invariant_checks(run_dir: Path, run_data: dict[str, Any], scenario: str, max_stage: int) -> dict[str, Any]:
    transcripts = read_transcript_texts(run_data.get("transcripts") or [])
    checks: list[dict[str, Any]] = []
    start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
    required_stages: set[int] | None = None
    if str(start.get("mode") or "") == "target_stage":
        target_stage_number = TARGET_STAGE_NUMBERS.get(str(start.get("target_stage") or ""))
        if target_stage_number is not None:
            required_stages = {min(target_stage_number, max_stage)}
    checks.append(check_no_visible_control_tags(transcripts))
    checks.extend(check_transcript_side_stage_metadata(transcripts, scenario, max_stage, required_stages))
    checks.append(check_stage4_score_critical_content(transcripts, scenario, max_stage))
    checks.append(check_invitee_topic_handoff_transcribed(transcripts, run_data, scenario))
    checks.append(check_transcript_shared_context_blocks_labeled(transcripts))
    checks.append(check_shared_context_directionality(transcripts))
    checks.append(check_no_internal_reconciler_analysis(transcripts))
    checks.append(check_partner_private_leakage(transcripts))
    checks.append(check_stage_limit_reached(run_data, scenario, max_stage))
    checks.append(check_db_stage_state_matches_stop_gate(run_data, scenario, max_stage))
    checks.append(check_actor_operated_correct_side(run_data, scenario))
    checks.append(check_session_started_with_profile_initiator(run_data, scenario))
    checks.append(check_felt_heard_gate_after_witnessing(transcripts))
    if skipped_stage1_for_target_stage(run_data):
        checks.append(
            invariant_result(
                "stage1_felt_heard_confirmation_transcribed",
                True,
                severity="soft",
                owner="eval_harness",
                dimension="transcript_extraction",
                details="Stage 1 feel-heard confirmation applies only when the run includes Stage 1.",
                evidence=[f"target_stage={start.get('target_stage')!r} skipped"],
            )
        )
    else:
        checks.append(check_stage1_felt_heard_confirmation_transcribed(transcripts))
    checks.append(check_chat_copy_has_visible_input(transcripts))
    hard_failures = [check for check in checks if check["severity"] == "hard" and check["status"] == "fail"]
    result = {
        "schema_version": 1,
        "status": "fail" if hard_failures else "pass",
        "hard_failures": hard_failures,
        "checks": checks,
    }
    (run_dir / "invariants.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def apply_invariants_to_score(score: dict[str, Any], invariants: dict[str, Any], target_score: float) -> dict[str, Any]:
    hard_failures = invariants.get("hard_failures") if isinstance(invariants, dict) else []
    if not hard_failures:
        score["hard_invariants"] = []
        return score
    score["hard_invariants"] = hard_failures
    not_evaluable_failures = [
        failure for failure in hard_failures
        if failure.get("dimension") in {"actor_orchestration", "transcript_extraction"}
        or failure.get("id") in {"stage_limit_reached_correctly", "transcript_side_stage_complete"}
    ]
    if not_evaluable_failures:
        score["evaluation_scope"] = {
            **(score.get("evaluation_scope") if isinstance(score.get("evaluation_scope"), dict) else {}),
            "prompt_quality": "not_evaluable_for_prompt_quality",
            "reasons": [failure.get("id") for failure in not_evaluable_failures],
        }
        gold_alignment = score.get("gold_alignment") if isinstance(score.get("gold_alignment"), dict) else {}
        gold_alignment["status"] = "not_evaluable_for_prompt_quality"
        gold_alignment["notes"] = "Prompt-quality conclusions are blocked by seeding/access/orchestration/transcript failures."
        score["gold_alignment"] = gold_alignment
    score["verdict"] = "eval_fail"
    try:
        current = float(score.get("overall_score"))
    except (TypeError, ValueError):
        current = target_score - 1
    score["overall_score"] = min(current, max(0, target_score - 1))
    targets = score.setdefault("improvement_targets", [])
    if isinstance(targets, list):
        existing = {
            (target.get("owner"), target.get("dimension"))
            for target in targets
            if isinstance(target, dict)
        }
        for failure in hard_failures:
            key = (failure.get("owner"), failure.get("dimension"))
            if key in existing:
                continue
            targets.append(
                {
                    "owner": failure.get("owner", "eval_harness"),
                    "dimension": failure.get("dimension", "invariants"),
                    "priority": 0,
                    "recommended_action": action_for_owner(str(failure.get("owner", "eval_harness")), False),
                    "rationale": failure.get("details"),
                    "evidence": failure.get("evidence", []),
                }
            )
    return score


REQUIRED_SCORE_DIMENSIONS = ("actor_fidelity", "mwf_handling")
REQUIRED_GOLD_ALIGNMENT = ("actor_fidelity", "mwf_guidance")


def load_score_json(score_path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        loaded = json.loads(score_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"missing score file: {score_path}"
    except json.JSONDecodeError as exc:
        return None, f"malformed score JSON: {exc}"
    if not isinstance(loaded, dict):
        return None, "score JSON root must be an object"
    return loaded, None


def dimension_needs_routing(dimension: dict[str, Any], target_score: float) -> bool:
    if dimension.get("pass") is False:
        return True
    try:
        return float(dimension.get("score")) < target_score
    except (TypeError, ValueError):
        return True


def validate_score_schema(score: dict[str, Any] | None, target_score: float) -> list[str]:
    if score is None:
        return ["score JSON could not be loaded"]

    errors: list[str] = []
    if not isinstance(score.get("overall_score"), (int, float)):
        errors.append("missing or invalid overall_score")
    if not isinstance(score.get("verdict"), str) or not score.get("verdict"):
        errors.append("missing or invalid verdict")

    dimensions = score.get("dimensions")
    if not isinstance(dimensions, dict):
        errors.append("missing or invalid dimensions")
        dimensions = {}
    for name in REQUIRED_SCORE_DIMENSIONS:
        dimension = dimensions.get(name)
        if not isinstance(dimension, dict):
            errors.append(f"missing dimensions.{name}")
            continue
        if "score" not in dimension:
            errors.append(f"missing dimensions.{name}.score")
        if "pass" not in dimension:
            errors.append(f"missing dimensions.{name}.pass")
        if dimension_needs_routing(dimension, target_score):
            if not dimension.get("owner"):
                errors.append(f"missing dimensions.{name}.owner")
            if not dimension.get("recommended_action"):
                errors.append(f"missing dimensions.{name}.recommended_action")

    alignment = score.get("gold_alignment")
    if not isinstance(alignment, dict):
        errors.append("missing or invalid gold_alignment")
    else:
        for name in REQUIRED_GOLD_ALIGNMENT:
            if not isinstance(alignment.get(name), dict):
                errors.append(f"missing or invalid gold_alignment.{name}")

    targets = score.get("improvement_targets")
    if not isinstance(targets, list):
        errors.append("missing or invalid improvement_targets")
        targets = []
    for index, target in enumerate(targets):
        if not isinstance(target, dict):
            errors.append(f"invalid improvement_targets[{index}]")
            continue
        if not target.get("owner"):
            errors.append(f"missing improvement_targets[{index}].owner")
        if not target.get("recommended_action"):
            errors.append(f"missing improvement_targets[{index}].recommended_action")

    routed_dimensions = {
        str(target.get("dimension"))
        for target in targets
        if isinstance(target, dict) and target.get("owner") and target.get("recommended_action")
    }
    for name in REQUIRED_SCORE_DIMENSIONS:
        dimension = dimensions.get(name)
        if isinstance(dimension, dict) and dimension_needs_routing(dimension, target_score):
            if name not in routed_dimensions and not (dimension.get("owner") and dimension.get("recommended_action")):
                errors.append(f"missing owner/action routing for weak dimension {name}")
    return errors


def eval_needs_review_score(
    scenario: str,
    target_score: float,
    validation_errors: list[str],
    raw_score: dict[str, Any] | None = None,
) -> dict[str, Any]:
    score: dict[str, Any] = {
        "schema_version": 1,
        "scenario_id": scenario,
        "verdict": "eval_needs_review",
        "overall_score": 0,
        "dimensions": {
            "actor_fidelity": {
                "score": 0,
                "pass": False,
                "owner": "eval_harness",
                "recommended_action": "patch_eval",
                "rationale": "Automated scorer output was incomplete or malformed.",
                "evidence": validation_errors,
            },
            "mwf_handling": {
                "score": 0,
                "pass": False,
                "owner": "eval_harness",
                "recommended_action": "patch_eval",
                "rationale": "Automated scorer output was incomplete or malformed.",
                "evidence": validation_errors,
            },
        },
        "gold_alignment": {
            "actor_fidelity": {},
            "mwf_guidance": {},
            "status": "needs_review",
            "notes": "Gold alignment could not be trusted because score.json failed schema validation.",
        },
        "improvement_targets": [
            {
                "owner": "eval_harness",
                "dimension": "score_schema",
                "priority": 1,
                "recommended_action": "patch_eval",
                "rationale": "Repair or improve scorer output/schema handling before trusting this run.",
                "evidence": validation_errors,
            }
        ],
        "human_review": {
            "required": True,
            "status": "needs_human_review",
            "reviewer": None,
            "notes": "score.json failed validation after scorer repair retry.",
        },
        "target_score": target_score,
    }
    if raw_score is not None:
        score["raw_score"] = raw_score
    return score


def write_score_validation(run_dir: Path, attempts: list[dict[str, Any]]) -> None:
    (run_dir / "score-validation.json").write_text(
        json.dumps({"attempts": attempts}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def repair_score_with_scorer(
    run_dir: Path,
    scenario: str,
    target_score: float,
    validation_errors: list[str],
    timeout: int,
) -> None:
    score_path = run_dir / "score.json"
    repair_path = run_dir / "score-repair.last.md"
    jsonl = run_dir / "codex-score-repair.jsonl"
    prompt = f"""Use mwf-gold-session-scorer.

The score JSON at this path failed schema validation:
{score_path}

Run directory: {run_dir}
Scenario: {scenario}
Target score: {target_score}

Validation errors:
{json.dumps(validation_errors, indent=2)}

Repair score.json in place. Preserve valid evidence and rationale from the current score when possible, but the final file must include:
- overall_score
- verdict
- dimensions.actor_fidelity
- dimensions.mwf_handling
- gold_alignment.actor_fidelity
- gold_alignment.mwf_guidance
- improvement_targets
- owner and recommended_action routing for each failed or weak dimension

Write only valid JSON to score.json.
"""
    result = run_command(
        ["codex", "exec", "--cd", str(REPO_ROOT), "--json", "-o", str(repair_path), prompt],
        timeout=timeout,
        stdout_path=jsonl,
    )
    if result.returncode != 0:
        (run_dir / "score-repair-error.txt").write_text(result.stderr, encoding="utf-8")


def accept_or_repair_score(
    run_dir: Path,
    scenario: str,
    target_score: float,
    timeout: int,
    allow_repair: bool,
) -> dict[str, Any]:
    score_path = run_dir / "score.json"
    attempts: list[dict[str, Any]] = []

    score, load_error = load_score_json(score_path)
    errors = [load_error] if load_error else validate_score_schema(score, target_score)
    attempts.append({"attempt": "initial", "valid": not errors, "errors": errors})
    if not errors:
        write_score_validation(run_dir, attempts)
        return score if score is not None else {}

    if allow_repair:
        repair_score_with_scorer(run_dir, scenario, target_score, errors, timeout)
        repaired, repair_load_error = load_score_json(score_path)
        repair_errors = [repair_load_error] if repair_load_error else validate_score_schema(repaired, target_score)
        attempts.append({"attempt": "repair", "valid": not repair_errors, "errors": repair_errors})
        if not repair_errors:
            write_score_validation(run_dir, attempts)
            return repaired if repaired is not None else {}
        score = repaired
        errors = repair_errors

    review_score = eval_needs_review_score(scenario, target_score, [str(error) for error in errors if error], score)
    score_path.write_text(json.dumps(review_score, indent=2) + "\n", encoding="utf-8")
    attempts.append({"attempt": "fallback", "valid": True, "errors": []})
    write_score_validation(run_dir, attempts)
    return review_score


def run_scorer(
    run_dir: Path,
    scenario: str,
    timeout: int,
    target_score: float,
    regression_context: dict[str, Any] | None = None,
    mock: bool = False,
) -> dict[str, Any]:
    score_path = run_dir / "score.json"
    profile_path = scenario_gold_profile_path(scenario)
    profile_instruction = (
        f"Gold scenario profile: {profile_path}\nUse this transcript-derived profile to decide what the gold example makes important: process shape, participant resistance, emotional access, non-concessions, and actor risks."
        if profile_path
        else "Gold scenario profile: none available. Infer scenario priorities directly from the golden transcript evidence."
    )
    if mock:
        score = {
            "schema_version": 1,
            "scenario_id": scenario,
            "scenario_version": 1,
            "rubric_version": "gold-flow-rubric-v1",
            "scorer_version": "mwf-gold-session-scorer-v0",
            "verdict": "eval_warn",
            "overall_score": 3.5,
            "dimensions": {
                "actor_fidelity": {
                    "score": 3.5,
                    "mode": "mock",
                    "pass": False,
                    "rationale": "mock actor fidelity needs improvement",
                    "evidence": ["mock"],
                },
                "mwf_handling": {
                    "score": 3,
                    "mode": "mock",
                    "pass": False,
                    "rationale": "mock MWF handling needs improvement",
                    "evidence": ["mock"],
                },
            },
            "human_review": {"required": True, "status": "needs_human_review", "reviewer": None, "notes": "mock score"},
        }
        score = normalize_score_routing(score, target_score=target_score)
        score_path.write_text(json.dumps(score, indent=2) + "\n", encoding="utf-8")
        return accept_or_repair_score(run_dir, scenario, target_score, timeout, allow_repair=False)

    prompt = f"""Use mwf-gold-session-scorer.

Read this MWF gold-session run directory and write the final score JSON to:
{score_path}

Run directory: {run_dir}
Scenario: {scenario}
{profile_instruction}

{regression_context_prompt(regression_context or {"status": "none"})}

Use transcripts/*.md as the primary evidence when present; use codex-*.jsonl only to understand execution errors or missing transcript gaps.
If seeding, access control, browser orchestration, or transcript extraction failed before both sides produced usable stage evidence, mark prompt-quality/MWF-quality conclusions as not_evaluable_for_prompt_quality and route the primary target to eval_harness or product_code instead of scoring the MWF prompt as if the conversation completed.
When prior context is available, compare this run against the previous score, gold_alignment, improvement_targets, and patch/proposal artifacts. Identify likely regression causes when score drops.
Use the golden references, gold scenario profile, and rubric in the meet-without-fear repo. The output must be valid JSON matching the rubric shape from docs/product/gold-flow-eval-harness-spec.md.
"""
    last = run_dir / "scorer.last.md"
    jsonl = run_dir / "codex-scorer.jsonl"
    result = run_command(["codex", "exec", "--cd", str(REPO_ROOT), "--json", "-o", str(last), prompt], timeout=timeout, stdout_path=jsonl)
    if result.returncode != 0:
        raise GoldLoopError(f"scorer failed: {result.stderr.strip()}")
    require(score_path.exists(), f"scorer did not create {score_path}")
    return accept_or_repair_score(run_dir, scenario, target_score, timeout, allow_repair=True)


def owner_for_dimension(name: str, dimension: dict[str, Any]) -> str:
    existing = dimension.get("owner")
    if existing:
        return str(existing)
    if name == "actor_fidelity":
        return "actor_skill"
    if name == "mwf_handling":
        return "mwf_prompts"
    if "privacy" in name or "state" in name or "gate" in name or "product" in name:
        return "product_code"
    return "eval_harness"


def action_for_owner(owner: str, passed: bool) -> str:
    if passed:
        return "none"
    return {
        "actor_skill": "patch_skill",
        "mwf_prompts": "patch_prompt",
        "product_code": "patch_product",
        "eval_harness": "patch_eval",
    }.get(owner, "human_review")


def normalize_score_routing(score: dict[str, Any], target_score: float) -> dict[str, Any]:
    dimensions = score.get("dimensions")
    if not isinstance(dimensions, dict):
        score["dimensions"] = {}
        dimensions = score["dimensions"]

    targets: list[dict[str, Any]] = []
    for name, raw_dimension in dimensions.items():
        if not isinstance(raw_dimension, dict):
            continue
        owner = owner_for_dimension(name, raw_dimension)
        raw_dimension["owner"] = owner
        passed = bool(raw_dimension.get("pass"))
        if raw_dimension.get("score") is not None:
            try:
                passed = passed or float(raw_dimension["score"]) >= target_score
            except (TypeError, ValueError):
                pass
        action = raw_dimension.get("recommended_action") or action_for_owner(owner, passed)
        raw_dimension["recommended_action"] = action
        if action != "none":
            targets.append(
                {
                    "owner": owner,
                    "dimension": name,
                    "priority": 1 if not passed else 3,
                    "recommended_action": action,
                    "rationale": raw_dimension.get("rationale"),
                    "evidence": raw_dimension.get("evidence", []),
                }
            )

    existing_targets = score.get("improvement_targets")
    if not isinstance(existing_targets, list):
        score["improvement_targets"] = targets
    else:
        for target in existing_targets:
            if isinstance(target, dict):
                target.setdefault("owner", owner_for_dimension(str(target.get("dimension", "")), {}))
                target.setdefault("recommended_action", action_for_owner(str(target.get("owner")), False))
        if not existing_targets and targets:
            score["improvement_targets"] = targets
    normalize_gold_alignment(score)
    return score


def normalize_gold_alignment(score: dict[str, Any]) -> None:
    alignment = score.get("gold_alignment")
    if isinstance(alignment, dict):
        alignment.setdefault("actor_fidelity", {})
        alignment.setdefault("mwf_guidance", {})
        return

    score["gold_alignment"] = {
        "actor_fidelity": {},
        "mwf_guidance": {},
        "status": "missing",
        "notes": "Scorer did not provide per-side/per-stage gold alignment. Route to eval_harness if this prevents confident improvement.",
    }
    targets = score.setdefault("improvement_targets", [])
    if isinstance(targets, list):
        has_eval_target = any(isinstance(target, dict) and target.get("owner") == "eval_harness" for target in targets)
        if not has_eval_target:
            targets.append(
                {
                    "owner": "eval_harness",
                    "dimension": "gold_alignment",
                    "priority": 2,
                    "recommended_action": "patch_eval",
                    "rationale": "score.json is missing per-side/per-stage gold_alignment evidence",
                    "evidence": [],
                }
            )


def run_improver(
    run_dir: Path,
    scenario: str,
    timeout: int,
    mock: bool = False,
    improvement_mode: str = "proposal",
    regression_context: dict[str, Any] | None = None,
) -> None:
    plan_path = run_dir / "improvement-plan.md"
    if mock:
        plan_path.write_text("# Mock Improvement Plan\n\nNo live improver was run.\n", encoding="utf-8")
        if improvement_mode == "patch":
            (run_dir / "patch-summary.md").write_text(
                "\n".join(
                    [
                        "# Mock Patch Summary",
                        "",
                        "## Files Changed",
                        "",
                        "- none",
                        "",
                        "## Owner Addressed",
                        "",
                        "- eval_harness",
                        "",
                        "## Score Dimension Addressed",
                        "",
                        "- mock_verification",
                        "",
                        "## Tests To Run",
                        "",
                        "- `python3 -m py_compile scripts/mwf_gold_loop.py scripts/test_mwf_gold_loop.py`",
                        "",
                        "## Expected Next-Run Score Movement",
                        "",
                        "- none; mock patch verification only",
                        "",
                        "## Rollback/Regression Risk",
                        "",
                        "- none",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
        return
    if improvement_mode not in {"proposal", "patch"}:
        raise GoldLoopError(f"Unknown improvement mode: {improvement_mode}")
    edit_instruction = (
        "Also create any versioned prompt proposal files under eval/prompt-versions/ as appropriate. "
        "Do not edit production MWF prompts or code directly."
        if improvement_mode == "proposal"
        else "Also create any versioned prompt proposal files under eval/prompt-versions/ as appropriate. "
        "You may edit production MWF prompt/code files and focused tests when the score identifies a concrete bug or prompt issue. "
        "Keep edits narrow, preserve unrelated worktree changes, and write a patch summary to patch-summary.md in the run directory. "
        "The patch summary must include sections named: Files Changed, Owner Addressed, Score Dimension Addressed, Tests To Run, "
        "Expected Next-Run Score Movement, and Rollback/Regression Risk. Put each test command on its own bullet, preferably in backticks."
    )
    prompt = f"""Use mwf-gold-prompt-improver.

Read this MWF gold-session run directory, compare the score against prior iterations if available, and write an improvement plan to:
{plan_path}

Run directory: {run_dir}
Scenario: {scenario}
Improvement mode: {improvement_mode}

{regression_context_prompt(regression_context or {"status": "none"})}

Use score.json improvement_targets and dimension owner/recommended_action fields to route changes:
- actor_skill / patch_skill: improve repo-owned gold actor/tester skill instructions or tester prompt proposals.
- mwf_prompts / patch_prompt: improve MWF internal prompts or MWF prompt proposals.
- product_code / patch_product: improve UI/backend/state behavior and focused tests.
- eval_harness / patch_eval: improve scorer, transcript extraction, invariant checks, or orchestrator artifacts.

Preserve this owner separation in improvement-plan.md. Do not patch MWF prompts when the failed owner is actor_skill, and do not patch actor skill when the failed owner is mwf_prompts.
If the score regressed from the previous iteration, identify the most likely regression cause from previous patch/proposal artifacts before proposing or making new changes.

{edit_instruction}
"""
    last = run_dir / "improver.last.md"
    jsonl = run_dir / "codex-improver.jsonl"
    result = run_command(["codex", "exec", "--cd", str(REPO_ROOT), "--json", "-o", str(last), prompt], timeout=timeout, stdout_path=jsonl)
    if result.returncode != 0:
        raise GoldLoopError(f"improver failed: {result.stderr.strip()}")


PATCH_SUMMARY_REQUIRED_SECTIONS = {
    "files changed": "files_changed",
    "owner addressed": "owner_addressed",
    "score dimension addressed": "score_dimension_addressed",
    "tests to run": "tests_to_run",
    "expected next-run score movement": "expected_next_run_score_movement",
    "rollback/regression risk": "rollback_regression_risk",
}


def patch_summary_sections(text: str) -> set[str]:
    normalized = text.lower()
    return {
        canonical
        for heading, canonical in PATCH_SUMMARY_REQUIRED_SECTIONS.items()
        if re.search(rf"(^|\n)\s*#+\s*{re.escape(heading)}\s*(\n|$)", normalized)
        or re.search(rf"(^|\n)\s*[-*]\s*\*?{re.escape(heading)}\*?\s*:", normalized)
    }


def extract_test_commands_from_patch_summary(text: str) -> list[str]:
    commands: list[str] = []
    in_tests = False
    for line in text.splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if re.match(r"^#+\s*tests to run\b", lower) or re.match(r"^[-*]\s*\*?tests to run\*?\s*:", lower):
            in_tests = True
            after_colon = stripped.split(":", 1)[1].strip() if ":" in stripped else ""
            if after_colon:
                stripped = after_colon
            else:
                continue
        elif in_tests and stripped.startswith("#"):
            break
        if not in_tests:
            continue
        inline_commands = re.findall(r"`([^`]+)`", stripped)
        if inline_commands:
            commands.extend(command.strip() for command in inline_commands if command.strip())
            continue
        candidate = re.sub(r"^[-*]\s*", "", stripped).strip()
        if not candidate or candidate.lower() in {"none", "n/a", "not run"}:
            continue
        if re.match(r"^(python3?|npm|yarn|pnpm|npx|pytest|uv|bun|make)\b", candidate):
            commands.append(candidate)
    return list(dict.fromkeys(commands))


def run_verification_command(command: str, run_dir: Path, timeout: int) -> dict[str, Any]:
    result = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        timeout=timeout,
        text=True,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    log_name = f"verification-{abs(hash(command))}.log"
    log_path = run_dir / log_name
    log_path.write_text(
        f"$ {command}\n\n# stdout\n{result.stdout}\n\n# stderr\n{result.stderr}\n",
        encoding="utf-8",
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "status": "pass" if result.returncode == 0 else "fail",
        "log": str(log_path),
    }


def verify_patch_mode(run_dir: Path, timeout: int = 300) -> dict[str, Any]:
    patch_summary = run_dir / "patch-summary.md"
    failures: list[str] = []
    commands: list[str] = []
    command_results: list[dict[str, Any]] = []

    if not patch_summary.exists():
        failures.append(f"missing patch summary: {patch_summary}")
    else:
        text = patch_summary.read_text(encoding="utf-8", errors="replace")
        sections = patch_summary_sections(text)
        missing_sections = sorted(set(PATCH_SUMMARY_REQUIRED_SECTIONS.values()) - sections)
        failures.extend(f"missing patch-summary section: {section}" for section in missing_sections)
        commands = extract_test_commands_from_patch_summary(text)
        if not commands:
            failures.append("patch-summary.md does not list any test commands")

    if not failures:
        for command in commands:
            try:
                command_results.append(run_verification_command(command, run_dir, timeout))
            except subprocess.TimeoutExpired:
                command_results.append({"command": command, "status": "fail", "returncode": None, "error": "timeout"})
        failures.extend(
            f"verification command failed: {result['command']}"
            for result in command_results
            if result.get("status") != "pass"
        )

    verification = {
        "schema_version": 1,
        "status": "pass" if not failures else "fail",
        "patch_summary": str(patch_summary),
        "commands": commands,
        "results": command_results,
        "failures": failures,
    }
    (run_dir / "verification.json").write_text(json.dumps(verification, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return verification


def score_below_target(score: Any, target_score: float) -> bool:
    if score is None:
        return True
    try:
        return float(score) < target_score
    except (TypeError, ValueError):
        return True


def should_run_improver(args: argparse.Namespace, iteration: int, overall_score: Any) -> bool:
    if args.always_improve:
        return True
    if not score_below_target(overall_score, args.target_score):
        return False
    return iteration < args.max_iterations or args.improve_on_final_fail


def summarize_score(score: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    verdict = score.get("verdict")
    overall = score.get("overall_score")
    if verdict is not None or overall is not None:
        lines.append(f"- Overall: `{overall}` (`{verdict}`)")
    dimensions = score.get("dimensions")
    if isinstance(dimensions, dict):
        for name, dimension in dimensions.items():
            if not isinstance(dimension, dict):
                continue
            dim_score = dimension.get("score")
            dim_pass = dimension.get("pass")
            lines.append(f"- `{name}`: `{dim_score}` pass=`{dim_pass}`")
    hard_invariants = score.get("hard_invariants")
    if hard_invariants:
        lines.append(f"- Hard invariants: `{len(hard_invariants)}` issue(s)")
    else:
        lines.append("- Hard invariants: none")
    targets = score.get("improvement_targets")
    if isinstance(targets, list) and targets:
        lines.append(f"- Improvement targets: `{len(targets)}`")
        for target in targets[:5]:
            if not isinstance(target, dict):
                continue
            lines.append(
                "- Target: "
                f"owner=`{target.get('owner')}`, "
                f"dimension=`{target.get('dimension')}`, "
                f"action=`{target.get('recommended_action')}`"
            )
    alignment = score.get("gold_alignment")
    if isinstance(alignment, dict):
        status = alignment.get("status", "present")
        actor_sides = alignment.get("actor_fidelity")
        guidance_sides = alignment.get("mwf_guidance")
        actor_count = len(actor_sides) if isinstance(actor_sides, dict) else 0
        guidance_count = len(guidance_sides) if isinstance(guidance_sides, dict) else 0
        lines.append(f"- Gold alignment: `{status}` actor_sides=`{actor_count}` mwf_sides=`{guidance_count}`")
    return lines


def write_loop_summary(
    run_dir: Path,
    run_data: dict[str, Any],
    score: dict[str, Any],
    improved: bool,
) -> None:
    score_value = score.get("overall_score")
    target = run_data.get("target_score")
    passed = not score_below_target(score_value, float(target)) if target is not None else False
    lines = [
        "# MWF Gold Loop Summary",
        "",
        f"Run directory: `{run_dir}`",
        f"Scenario: `{run_data.get('scenario')}`",
        f"Iteration: `{run_data.get('iteration')}`",
        f"Session: `{run_data.get('session_id')}`",
        f"Stop after stage: `{run_data.get('stop_after_stage')}`",
        f"Target score: `{target}`",
        "",
        "## Result",
        "",
        *summarize_score(score),
        "",
        "## Actor Status",
        "",
    ]
    for entry in run_data.get("status_history", []):
        status = entry.get("status", {})
        lines.append(
            "- "
            f"`{entry.get('side')}` turn `{entry.get('turn')}`: "
            f"state=`{status.get('state')}`, stage=`{status.get('stage')}`, "
            f"blocked_on=`{status.get('blocked_on')}`"
        )
    if not run_data.get("status_history"):
        lines.append("- No actor statuses recorded.")
    lines.extend(
        [
            "",
            "## Artifacts",
            "",
            f"- Score: `{run_dir / 'score.json'}`",
            f"- Run data: `{run_dir / 'run.json'}`",
        ]
    )
    transcripts = run_data.get("transcripts") or []
    scratch_logs = run_data.get("scratch_logs") or []
    lines.append(f"- Transcripts: `{len(transcripts)}` file(s)")
    lines.append(f"- Scratch logs: `{len(scratch_logs)}` file(s)")
    lines.extend(["", "## Next Action", ""])
    if passed:
        lines.append("- Target reached. Expand the scenario/stage scope or raise the target.")
    elif run_data.get("verification_failed"):
        lines.append("- Target not reached. Patch verification failed; fix verification failures before rerunning.")
    elif improved:
        lines.append("- Target not reached. Improver ran; review `improvement-plan.md` or `patch-summary.md`, then rerun.")
    else:
        lines.append("- Target not reached. Improver did not run for this iteration.")
    if improved:
        lines.append(f"- Improvement plan: `{run_dir / 'improvement-plan.md'}`")
        patch_summary = run_dir / "patch-summary.md"
        if patch_summary.exists():
            lines.append(f"- Patch summary: `{patch_summary}`")
        verification = run_data.get("verification")
        if isinstance(verification, dict):
            lines.append(f"- Verification: `{verification.get('status')}` (`{run_dir / 'verification.json'}`)")
    human_review = score.get("human_review")
    if isinstance(human_review, dict) and human_review.get("required"):
        lines.extend(["", "## Review", "", f"- Human review: `{human_review.get('status')}`"])
        notes = human_review.get("notes")
        if notes:
            lines.append(f"- Notes: {notes}")
    (run_dir / "loop-summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def read_text_excerpt(path: Path, max_chars: int = 4000) -> str | None:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...[truncated]"


def build_regression_context(previous_run_dir: Path | None) -> dict[str, Any]:
    if previous_run_dir is None:
        return {"status": "none"}
    score = load_json_file(previous_run_dir / "score.json")
    run_data = load_json_file(previous_run_dir / "run.json")
    context: dict[str, Any] = {
        "status": "available",
        "previous_run_dir": str(previous_run_dir),
        "previous_score": score.get("overall_score"),
        "previous_verdict": score.get("verdict"),
        "previous_gold_alignment": score.get("gold_alignment"),
        "previous_improvement_targets": score.get("improvement_targets", []),
        "previous_prompt_skill_versions": run_data.get("prompt_skill_versions") or run_data.get("versions"),
        "previous_invariants": run_data.get("invariants", {}),
        "previous_verification": run_data.get("verification", {}),
    }
    patch_summary = read_text_excerpt(previous_run_dir / "patch-summary.md")
    if patch_summary:
        context["previous_patch_summary"] = patch_summary
    improvement_plan = read_text_excerpt(previous_run_dir / "improvement-plan.md")
    if improvement_plan:
        context["previous_improvement_plan"] = improvement_plan
    return context


def regression_context_prompt(context: dict[str, Any]) -> str:
    if context.get("status") != "available":
        return "Regression context: none. This is the first iteration or no prior run was available."
    return "Regression context from previous iteration:\n" + json.dumps(context, indent=2, sort_keys=True)


def score_movement(previous_score: Any, current_score: Any) -> dict[str, Any]:
    try:
        previous = float(previous_score)
        current = float(current_score)
    except (TypeError, ValueError):
        return {"classification": "incomparable", "previous_score": previous_score, "current_score": current_score, "delta": None}
    delta = current - previous
    if delta > 0.05:
        classification = "improvement"
    elif delta < -0.05:
        classification = "regression"
    else:
        classification = "neutral"
    return {
        "classification": classification,
        "previous_score": previous,
        "current_score": current,
        "delta": delta,
    }


def collect_targets_by_owner(results: list[IterationResult]) -> dict[str, list[str]]:
    by_owner: dict[str, list[str]] = {}
    for result in results:
        score = load_json_file(result.run_dir / "score.json")
        targets = score.get("improvement_targets")
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, dict):
                continue
            owner = str(target.get("owner") or "unknown")
            dimension = str(target.get("dimension") or "unknown")
            action = str(target.get("recommended_action") or "unknown")
            entry = f"iter {result.run_dir.name}: dimension=`{dimension}`, action=`{action}`"
            by_owner.setdefault(owner, [])
            if entry not in by_owner[owner]:
                by_owner[owner].append(entry)
    return by_owner


def collect_start_modes(results: list[IterationResult]) -> list[str]:
    entries: list[str] = []
    for result in results:
        run_data = load_json_file(result.run_dir / "run.json")
        start = run_data.get("start") if isinstance(run_data.get("start"), dict) else {}
        mode = start.get("mode", "unknown")
        detail = ""
        if mode == "target_stage":
            detail = f" target_stage=`{start.get('target_stage')}`"
        elif mode == "snapshot":
            detail = f" snapshot=`{start.get('snapshot')}` session=`{start.get('session_id')}`"
        entries.append(f"- `{result.run_dir.name}`: mode=`{mode}`{detail}")
    return entries


def collect_service_summary(results: list[IterationResult]) -> list[str]:
    entries: list[str] = []
    seen: set[str] = set()
    for result in results:
        run_data = load_json_file(result.run_dir / "run.json")
        services_info = run_data.get("services") if isinstance(run_data.get("services"), dict) else {}
        services = services_info.get("services")
        if not isinstance(services, list):
            continue
        for service in services:
            if not isinstance(service, dict):
                continue
            key = f"{service.get('name')}:{service.get('pid')}:{service.get('started')}"
            if key in seen:
                continue
            seen.add(key)
            entries.append(
                "- "
                f"`{service.get('name')}` started=`{service.get('started')}` "
                f"pid=`{service.get('pid')}` log=`{service.get('log_path')}`"
            )
    return entries


def collect_version_change_summary(results: list[IterationResult]) -> list[str]:
    entries: list[str] = []
    for result in results:
        run_data = load_json_file(result.run_dir / "run.json")
        changes = run_data.get("prompt_skill_version_changes")
        if not isinstance(changes, dict):
            continue
        status = changes.get("status")
        changed = changes.get("changes")
        count = len(changed) if isinstance(changed, list) else 0
        entries.append(f"- `{result.run_dir.name}`: status=`{status}` changes=`{count}`")
        if isinstance(changed, list):
            for change in changed[:5]:
                if not isinstance(change, dict):
                    continue
                entries.append(
                    "- "
                    f"{change.get('status')}: `{change.get('path')}` "
                    f"`{change.get('before_sha256')}` -> `{change.get('after_sha256')}`"
                )
    return entries


def write_top_level_loop_summary(
    summary_path: Path,
    scenario: str,
    target_score: float,
    results: list[IterationResult],
) -> None:
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    target_reached = any(result.score is not None and result.score >= target_score for result in results)
    verification_failed = any(result.verification_failed for result in results)
    lines = [
        "# MWF Gold Loop Run Summary",
        "",
        f"Scenario: `{scenario}`",
        f"Target score: `{target_score}`",
        f"Target reached: `{target_reached}`",
        f"Iterations: `{len(results)}`",
        "",
        "## Iterations",
        "",
    ]
    previous_score: float | None = None
    for result in results:
        delta = "n/a" if previous_score is None or result.score is None else f"{result.score - previous_score:+.2f}"
        previous_score = result.score
        run_data = load_json_file(result.run_dir / "run.json")
        movement = run_data.get("score_movement") if isinstance(run_data.get("score_movement"), dict) else {}
        movement_class = movement.get("classification", "n/a")
        lines.append(
            "- "
            f"`{result.run_dir}` score=`{result.score}` verdict=`{result.verdict}` "
            f"delta=`{delta}` movement=`{movement_class}` "
            f"improved=`{result.improved}` verification_failed=`{result.verification_failed}`"
        )

    lines.extend(["", "## Start Points", ""])
    start_entries = collect_start_modes(results)
    lines.extend(start_entries or ["- None recorded."])

    lines.extend(["", "## Services", ""])
    service_entries = collect_service_summary(results)
    lines.extend(service_entries or ["- None recorded."])

    lines.extend(["", "## Prompt And Skill Versions", ""])
    version_entries = collect_version_change_summary(results)
    lines.extend(version_entries or ["- None recorded."])

    by_owner = collect_targets_by_owner(results)
    lines.extend(["", "## Improvement Targets", ""])
    if by_owner:
        for owner in sorted(by_owner):
            lines.append(f"- `{owner}`: `{len(by_owner[owner])}` target(s)")
            for entry in by_owner[owner][:5]:
                lines.append(f"- {entry}")
    else:
        lines.append("- None recorded.")

    lines.extend(["", "## Patches And Proposals", ""])
    patch_or_proposal = False
    for result in results:
        artifacts: list[str] = []
        for name in ("improvement-plan.md", "patch-summary.md", "verification.json"):
            path = result.run_dir / name
            if path.exists():
                artifacts.append(f"`{path}`")
        if artifacts:
            patch_or_proposal = True
            lines.append(f"- `{result.run_dir.name}`: " + ", ".join(artifacts))
    prompt_versions = sorted((REPO_ROOT / "eval/prompt-versions").glob("**/v*.md"))
    if prompt_versions:
        patch_or_proposal = True
        for path in prompt_versions[-5:]:
            lines.append(f"- Prompt proposal: `{path}`")
    if not patch_or_proposal:
        lines.append("- None recorded.")

    lines.extend(["", "## Tests Run", ""])
    tests_recorded = False
    for result in results:
        verification = load_json_file(result.run_dir / "verification.json")
        commands = verification.get("commands")
        if not isinstance(commands, list) or not commands:
            continue
        tests_recorded = True
        for command in commands:
            lines.append(f"- `{result.run_dir.name}`: `{command}`")
    if not tests_recorded:
        lines.append("- None recorded by patch verification.")

    lines.extend(["", "## Final Recommendation", ""])
    if target_reached:
        lines.append("- Target reached. Expand scenario/stage scope or raise the quality threshold.")
    elif verification_failed:
        lines.append("- Patch verification failed. Fix `verification.json` failures before rerunning the loop.")
    elif results and results[-1].improved:
        lines.append("- Improvement ran but target was not reached. Review the latest improvement artifacts, then rerun.")
    elif results:
        lines.append("- Target not reached and no further improver ran. Inspect the latest improvement targets and choose patch or proposal mode.")
    else:
        lines.append("- No iterations ran.")

    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_browser_smoke(args: argparse.Namespace) -> int:
    checks = preflight(args.api_url, args.app_url, skip_services=args.skip_service_preflight)
    smoke_dir = RUNS_ROOT / "smoke"
    smoke_dir.mkdir(parents=True, exist_ok=True)
    last = smoke_dir / "browser-smoke.last.md"
    jsonl = smoke_dir / "browser-smoke.jsonl"
    browser_session = "mwf-gold-smoke"
    prompt = f"""Use the agent-browser skill/CLI, not Browser Use.

Open {args.app_url} with agent-browser session `{browser_session}`, wait for load, take an interactive snapshot or read visible page state, and report whether browser control worked. If agent-browser reports a stale closed browser context, run `agent-browser --session {browser_session} close` once and retry.

Do not edit files. End with JSON on its own line:
{{"browser_control":"ok"|"failed","url":"...","visible_state":"...","error":null|"..."}}
"""
    cmd = [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        str(REPO_ROOT),
        "--json",
        "-o",
        str(last),
        prompt,
    ]
    try:
        result = run_command(cmd, timeout=args.timeout, stdout_path=jsonl)
    finally:
        cleanup = close_agent_browser_sessions([browser_session])
        (smoke_dir / "browser-cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"preflight": checks, "last_message": str(last), "jsonl": str(jsonl), "returncode": result.returncode}, indent=2))
    if last.exists():
        print(last.read_text(encoding="utf-8"))
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    return 0


def run_stage1_smoke(args: argparse.Namespace) -> int:
    checks = preflight(args.api_url, args.app_url, skip_services=args.skip_service_preflight)
    run_dir = newest_run_dir("adam-eve-stage1-smoke", 1)
    run_dir.mkdir(parents=True, exist_ok=True)
    session = seed_stage1_session(args.api_url, args.app_url)
    session_id = session["SESSION_ID"]
    adam = Actor("Adam", session["ASSIGNED_URL"])
    eve = Actor("Eve", session["PARTNER_URL"])
    run_data: dict[str, Any] = {
        "scenario": "adam-eve",
        "smoke": "stage1-one-side",
        "session_id": session_id,
        "preflight": checks,
        "urls": {"adam": adam.url, "eve": eve.url},
        "created_at": datetime.now().isoformat(),
        "status_history": [],
    }
    write_run_json(run_dir, run_data)

    try:
        status = run_codex_actor(adam, eve, session_id, 1, run_dir, args.actor_timeout, "adam-eve")
    finally:
        run_data["browser_cleanup"] = close_agent_browser_sessions([browser_session_name("adam", session_id)])
        write_run_json(run_dir, run_data)
    run_data["codex_sessions"] = {"adam": adam.codex_session_id}
    run_data["status_history"].append({"side": "adam", "turn": adam.turns, "status": asdict(status), "at": datetime.now().isoformat()})
    run_data["scratch_logs"] = copy_scratch_logs(session_id, run_dir)
    write_run_json(run_dir, run_data)

    print(json.dumps({"run_dir": str(run_dir), "session_id": session_id, "status": asdict(status)}, indent=2))
    if status.state == "error":
        return 1
    return 0


def write_run_json(run_dir: Path, data: dict[str, Any]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def file_fingerprint(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"path": str(path), "exists": path.exists()}
    if not path.exists() or not path.is_file():
        return info
    data = path.read_bytes()
    info["sha256"] = hashlib.sha256(data).hexdigest()
    info["bytes"] = len(data)
    return info


def prompt_version_files_for_scenario(scenario: str) -> list[Path]:
    if not PROMPT_VERSIONS_ROOT.exists():
        return []
    scenario_files = sorted(PROMPT_VERSIONS_ROOT.glob(f"*/{scenario}/v*.md"))
    return [path for path in scenario_files if path.is_file()]


def collect_prompt_skill_versions(scenario: str) -> dict[str, Any]:
    prompt_proposals = prompt_version_files_for_scenario(scenario)
    return {
        "actor_skill_runtime": file_fingerprint(ACTOR_SKILL),
        "scorer_skill_runtime": file_fingerprint(SCORER_SKILL),
        "improver_skill_runtime": file_fingerprint(IMPROVER_SKILL),
        "tester_skill_runtime": file_fingerprint(TESTER_SKILL),
        "actor_skill_repo": file_fingerprint(REPO_ACTOR_SKILL),
        "scorer_skill_repo": file_fingerprint(REPO_SCORER_SKILL),
        "improver_skill_repo": file_fingerprint(REPO_IMPROVER_SKILL),
        "mwf_stage_prompts": file_fingerprint(MWF_STAGE_PROMPTS),
        "prompt_proposals": [file_fingerprint(path) for path in prompt_proposals],
    }


def flatten_version_fingerprints(versions: Any, prefix: str = "") -> dict[str, dict[str, Any]]:
    flattened: dict[str, dict[str, Any]] = {}
    if isinstance(versions, dict):
        if "path" in versions or "sha256" in versions or "exists" in versions:
            key = str(versions.get("path") or prefix)
            flattened[key] = versions
            return flattened
        for key, value in versions.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(flatten_version_fingerprints(value, child_prefix))
    elif isinstance(versions, list):
        for index, value in enumerate(versions):
            child_prefix = f"{prefix}[{index}]"
            flattened.update(flatten_version_fingerprints(value, child_prefix))
    return flattened


def compare_prompt_skill_versions(previous_versions: Any, current_versions: Any) -> dict[str, Any]:
    if not isinstance(previous_versions, dict) or not isinstance(current_versions, dict):
        return {"status": "incomparable", "changes": []}

    previous = flatten_version_fingerprints(previous_versions)
    current = flatten_version_fingerprints(current_versions)
    changes: list[dict[str, Any]] = []
    for key in sorted(set(previous) | set(current)):
        before = previous.get(key)
        after = current.get(key)
        if before is None:
            changes.append(
                {
                    "path": key,
                    "status": "added",
                    "before_sha256": None,
                    "after_sha256": after.get("sha256") if isinstance(after, dict) else None,
                }
            )
            continue
        if after is None:
            changes.append(
                {
                    "path": key,
                    "status": "removed",
                    "before_sha256": before.get("sha256"),
                    "after_sha256": None,
                }
            )
            continue
        if before.get("exists") != after.get("exists") or before.get("sha256") != after.get("sha256"):
            changes.append(
                {
                    "path": key,
                    "status": "changed",
                    "before_sha256": before.get("sha256"),
                    "after_sha256": after.get("sha256"),
                }
            )
    return {"status": "changed" if changes else "unchanged", "changes": changes}


def git_sha() -> str | None:
    result = run_command(["git", "rev-parse", "HEAD"], timeout=10)
    return result.stdout.strip() if result.returncode == 0 else None


def git_branch() -> str | None:
    result = run_command(["git", "branch", "--show-current"], timeout=10)
    return result.stdout.strip() if result.returncode == 0 else None


def ensure_patch_branch(args: argparse.Namespace) -> None:
    if args.improvement_mode != "patch" or args.allow_protected_branch_patch:
        return
    branch = git_branch()
    protected = {"main", "master", "develop", "development"}
    if not branch:
        raise GoldLoopError("Patch mode requires a named git branch; use --allow-protected-branch-patch to override")
    if branch in protected:
        raise GoldLoopError(
            f"Refusing patch mode on protected branch '{branch}'. "
            "Create a codex/* branch or pass --allow-protected-branch-patch."
        )


def run_iteration(
    args: argparse.Namespace,
    iteration: int,
    previous_score: float | None,
    previous_run_dir: Path | None = None,
    service_info: dict[str, Any] | None = None,
) -> IterationResult:
    run_dir = newest_run_dir(args.scenario, iteration)
    run_dir.mkdir(parents=True, exist_ok=True)

    first_character, second_character = SCENARIOS[args.scenario]
    role_shape = infer_role_shape_from_profile(args.scenario)
    start_character = scenario_start_character(args.scenario)
    start_partner_character = next(character for character in (first_character, second_character) if character != start_character)
    start_info: dict[str, Any] = {"mode": "mock" if args.mock_actor else "fresh"}
    if args.mock_actor:
        session = {
            "SESSION_ID": f"mock-session-{iteration}",
            "ASSIGNED_CHARACTER": start_character,
            "PARTNER_CHARACTER": start_partner_character,
            "ASSIGNED_URL": f"{args.app_url}/session/mock-session-{iteration}?e2e-user-id=mock-{start_character.lower()}",
            "PARTNER_URL": f"{args.app_url}/session/mock-session-{iteration}?e2e-user-id=mock-{start_partner_character.lower()}",
        }
    elif args.from_snapshot:
        start_info = restore_snapshot(args.from_snapshot, run_dir)
        session = session_from_restored_snapshot(args.scenario, args.app_url, args.snapshot_session_id)
        start_info["mode"] = "snapshot"
        start_info["session_id"] = session["SESSION_ID"]
    elif args.seed_target_stage:
        session = seeded_session_from_target_stage(args.scenario, args.seed_target_stage, args.api_url, args.app_url)
        start_info = {"mode": "target_stage", "target_stage": args.seed_target_stage, "session_id": session["SESSION_ID"]}
    else:
        session = create_gold_session(args.scenario, start_character, args.api_url, args.app_url)

    session_id = session["SESSION_ID"]
    actors = {
        session["ASSIGNED_CHARACTER"].lower(): Actor(session["ASSIGNED_CHARACTER"], session["ASSIGNED_URL"]),
        session["PARTNER_CHARACTER"].lower(): Actor(session["PARTNER_CHARACTER"], session["PARTNER_URL"]),
    }
    status_history: list[dict[str, Any]] = []
    regression_context = build_regression_context(previous_run_dir)
    prompt_skill_versions = collect_prompt_skill_versions(args.scenario)
    prompt_skill_version_changes = compare_prompt_skill_versions(
        regression_context.get("previous_prompt_skill_versions"),
        prompt_skill_versions,
    )
    if regression_context.get("status") == "available":
        regression_context["prompt_skill_version_changes"] = prompt_skill_version_changes
    run_data: dict[str, Any] = {
        "scenario": args.scenario,
        "iteration": iteration,
        "session_id": session_id,
        "stop_after_stage": args.stop_after_stage,
        "target_score": args.target_score,
        "code_sha": git_sha(),
        "prompt_skill_versions": prompt_skill_versions,
        "prompt_skill_version_changes": prompt_skill_version_changes,
        "start": start_info,
        "role_shape": role_shape,
        "session_roles": {
            "assigned_character": session["ASSIGNED_CHARACTER"],
            "partner_character": session["PARTNER_CHARACTER"],
        },
        "services": service_info,
        "created_at": datetime.now().isoformat(),
        "urls": {side: actor.url for side, actor in actors.items()},
        "codex_sessions": {},
        "status_history": status_history,
        "previous_score": previous_score,
        "previous_run_dir": str(previous_run_dir) if previous_run_dir else None,
        "regression_context": regression_context,
    }
    write_run_json(run_dir, run_data)

    try:
        last_side: str | None = None
        for _ in range(args.max_actor_turns):
            actor = choose_next_actor(actors, last_side, args.stop_after_stage)
            if actor is None:
                break
            partner = next(candidate for candidate in actors.values() if candidate.side != actor.side)
            if args.mock_actor:
                status = run_mock_actor(actor, partner, session_id, args.stop_after_stage, run_dir, args.actor_timeout)
            else:
                status = run_codex_actor(
                    actor,
                    partner,
                    session_id,
                    args.stop_after_stage,
                    run_dir,
                    args.actor_timeout,
                    args.scenario,
                )
            last_side = actor.side
            run_data["codex_sessions"][actor.side] = actor.codex_session_id
            status_history.append({"side": actor.side, "turn": actor.turns, "status": asdict(status), "at": datetime.now().isoformat()})
            write_run_json(run_dir, run_data)
            if status.state in {"bug_blocked", "error"}:
                break
    finally:
        if not args.mock_actor and not args.no_browser_cleanup:
            run_data["browser_cleanup"] = close_agent_browser_sessions(
                browser_session_name(side, session_id) for side in actors
            )
            write_run_json(run_dir, run_data)

    run_data["scratch_logs"] = copy_scratch_logs(session_id, run_dir)
    if args.skip_transcripts:
        run_data["transcripts"] = []
    elif args.mock_actor:
        run_data["transcripts"] = write_mock_transcripts(run_dir, args.scenario, args.stop_after_stage)
    else:
        run_data["transcripts"] = extract_transcripts(session_id, run_dir, args.scenario, args.stop_after_stage)
    if not args.mock_actor:
        run_data["db_stage_state"] = capture_db_stage_state(session_id, run_dir)
    write_run_json(run_dir, run_data)

    run_data["invariants"] = run_invariant_checks(run_dir, run_data, args.scenario, args.stop_after_stage)
    write_run_json(run_dir, run_data)

    score = run_scorer(
        run_dir,
        args.scenario,
        args.scorer_timeout,
        target_score=args.target_score,
        regression_context=regression_context,
        mock=args.mock_actor or args.mock_scorer,
    )
    score = normalize_score_routing(score, args.target_score)
    score = apply_invariants_to_score(score, run_data["invariants"], args.target_score)
    (run_dir / "score.json").write_text(json.dumps(score, indent=2) + "\n", encoding="utf-8")
    overall = score.get("overall_score")
    run_data["score"] = score
    run_data["score_movement"] = score_movement(previous_score, overall)
    write_run_json(run_dir, run_data)

    improved = should_run_improver(args, iteration, overall)
    verification_failed = False
    if improved:
        run_improver(
            run_dir,
            args.scenario,
            args.improver_timeout,
            mock=args.mock_actor or args.mock_scorer,
            improvement_mode=args.improvement_mode,
            regression_context=regression_context,
        )
        if args.improvement_mode == "patch":
            run_data["verification"] = verify_patch_mode(run_dir)
            verification_failed = run_data["verification"].get("status") != "pass"
    run_data["improver_ran"] = improved
    run_data["verification_failed"] = verification_failed
    write_run_json(run_dir, run_data)
    write_loop_summary(run_dir, run_data, score, improved)

    print(f"iteration={iteration} run_dir={run_dir} score={overall}")
    return IterationResult(
        run_dir=run_dir,
        score=float(overall) if overall is not None else None,
        verdict=score.get("verdict"),
        improved=improved,
        verification_failed=verification_failed,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Codex-driven MWF gold-session loops.")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Run the gold-loop orchestrator")
    run.add_argument("--scenario", choices=sorted(SCENARIOS), default="adam-eve")
    run.add_argument("--stop-after-stage", type=int, default=2)
    run.add_argument("--target-score", type=float, default=4.0)
    run.add_argument("--max-iterations", type=int, default=3)
    run.add_argument("--max-actor-turns", type=int, default=12)
    run.add_argument("--actor-timeout", type=int, default=1800)
    run.add_argument("--scorer-timeout", type=int, default=900)
    run.add_argument("--improver-timeout", type=int, default=900)
    run.add_argument("--api-url", default=os.environ.get("MWF_API_URL", "http://localhost:3000"))
    run.add_argument("--app-url", default=os.environ.get("MWF_APP_URL", "http://localhost:8082"))
    run.add_argument(
        "--seed-target-stage",
        choices=TARGET_STAGES,
        help="Start the main loop from an E2E seeded target stage instead of creating a fresh gold session.",
    )
    run.add_argument(
        "--from-snapshot",
        help="Restore a backend DB snapshot id/name/path before starting the loop, then open a restored session.",
    )
    run.add_argument(
        "--snapshot-session-id",
        help="Session id to open after --from-snapshot. Defaults to the newest restored session.",
    )
    run.add_argument("--dry-run", action="store_true", help="Run preflight only; do not create sessions or launch Codex actors")
    run.add_argument("--skip-service-preflight", action="store_true", help="Skip backend/web HTTP checks")
    run.add_argument("--start-services", action="store_true", help="Start missing backend and E2E web services for this loop")
    run.add_argument("--skip-transcripts", action="store_true", help="Do not run DB transcript extraction")
    run.add_argument("--mock-actor", action="store_true", help="Use deterministic fake actor statuses instead of Codex")
    run.add_argument("--mock-scorer", action="store_true", help="Write a deterministic fake score instead of invoking Codex scorer")
    run.add_argument("--always-improve", action="store_true", help="Run improver even when score reaches threshold")
    run.add_argument(
        "--no-improve-on-final-fail",
        action="store_false",
        dest="improve_on_final_fail",
        help="Do not run the improver when the final iteration is still below target",
    )
    run.add_argument("--no-browser-cleanup", action="store_true", help="Leave mwf-gold agent-browser sessions open after actor runs")
    run.add_argument(
        "--allow-protected-branch-patch",
        action="store_true",
        help="Allow --improvement-mode patch on main/master/develop; intended only for disposable checkouts",
    )
    run.add_argument(
        "--improvement-mode",
        choices=("proposal", "patch"),
        default="proposal",
        help="proposal writes versioned recommendations only; patch lets the improver make narrow code/prompt/test edits",
    )
    run.set_defaults(improve_on_final_fail=True)

    parse = sub.add_parser("parse-status", help="Parse a Codex final message status block")
    parse.add_argument("path", type=Path)
    parse.add_argument("--side")
    parse.add_argument("--session-id")

    smoke = sub.add_parser("browser-smoke", help="Verify a spawned Codex actor can use agent-browser")
    smoke.add_argument("--api-url", default=os.environ.get("MWF_API_URL", "http://localhost:3000"))
    smoke.add_argument("--app-url", default=os.environ.get("MWF_APP_URL", "http://localhost:8082"))
    smoke.add_argument("--timeout", type=int, default=180)
    smoke.add_argument("--skip-service-preflight", action="store_true")

    stage1 = sub.add_parser("stage1-smoke", help="Seed Adam at Stage 1 and run one actor turn")
    stage1.add_argument("--api-url", default=os.environ.get("MWF_API_URL", "http://localhost:3000"))
    stage1.add_argument("--app-url", default=os.environ.get("MWF_APP_URL", "http://localhost:8082"))
    stage1.add_argument("--actor-timeout", type=int, default=900)
    stage1.add_argument("--skip-service-preflight", action="store_true")

    cleanup = sub.add_parser("cleanup-browsers", help="Close stale mwf-gold agent-browser sessions")
    cleanup.add_argument("--json", action="store_true", help="Print cleanup result as JSON")

    improve = sub.add_parser("improve-run", help="Run the improver against an existing run directory")
    improve.add_argument("run_dir", type=Path)
    improve.add_argument("--scenario", choices=sorted(SCENARIOS), default="adam-eve")
    improve.add_argument("--improver-timeout", type=int, default=900)
    improve.add_argument("--mock", action="store_true", help="Write a deterministic fake improvement plan")
    improve.add_argument(
        "--improvement-mode",
        choices=("proposal", "patch"),
        default="proposal",
        help="proposal writes versioned recommendations only; patch lets the improver make narrow code/prompt/test edits",
    )
    improve.add_argument(
        "--allow-protected-branch-patch",
        action="store_true",
        help="Allow --improvement-mode patch on main/master/develop; intended only for disposable checkouts",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "parse-status":
            status = parse_status(args.path.read_text(encoding="utf-8"), args.side, args.session_id)
            print(json.dumps(asdict(status), indent=2))
            return 0
        if args.command == "browser-smoke":
            return run_browser_smoke(args)
        if args.command == "stage1-smoke":
            return run_stage1_smoke(args)
        if args.command == "cleanup-browsers":
            cleanup = close_mwf_agent_browser_sessions()
            if args.json:
                print(json.dumps(cleanup, indent=2))
            else:
                print(f"closed {len(cleanup)} mwf-gold browser session(s)")
            return 0
        if args.command == "improve-run":
            ensure_patch_branch(args)
            run_improver(
                args.run_dir.resolve(),
                args.scenario,
                args.improver_timeout,
                mock=args.mock,
                improvement_mode=args.improvement_mode,
            )
            return 0

        services: list[ManagedService] = []
        service_info: dict[str, Any] | None = None
        service_cleanup: dict[str, Any] | None = None
        service_dir: Path | None = None
        try:
            if args.seed_target_stage and args.from_snapshot:
                raise GoldLoopError("Use either --seed-target-stage or --from-snapshot, not both")
            if args.start_services:
                service_dir = service_dir_path(args.scenario)
                services, service_info = start_loop_services(args, service_dir)
            checks = preflight(args.api_url, args.app_url, skip_services=args.skip_service_preflight)
            ensure_patch_branch(args)
            if args.dry_run:
                print(json.dumps({"preflight": checks, "services": service_info, "dry_run": True}, indent=2))
                return 0

            previous_score: float | None = None
            previous_run_dir: Path | None = None
            results: list[IterationResult] = []
            summary_path = top_level_summary_path(args.scenario)
            for iteration in range(1, args.max_iterations + 1):
                result = run_iteration(args, iteration, previous_score, previous_run_dir, service_info)
                results.append(result)
                previous_score = result.score
                previous_run_dir = result.run_dir
                if result.verification_failed:
                    print(f"stopping_after_iteration={iteration} reason=verification_failed")
                    break
                if previous_score is not None and previous_score >= args.target_score:
                    break
            write_top_level_loop_summary(summary_path, args.scenario, args.target_score, results)
            print(f"loop_summary={summary_path}")
        finally:
            if services:
                service_cleanup = stop_managed_services(services)
                if service_dir is not None:
                    (service_dir / "cleanup.json").write_text(json.dumps(service_cleanup, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 0
    except GoldLoopError as exc:
        print(f"mwf_gold_loop: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
