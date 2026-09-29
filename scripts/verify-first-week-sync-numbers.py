#!/usr/bin/env python3
"""Independently recount the first-week sync headline from local Funnel Pulse rows.

Reads only the caller-supplied cached event/WAU rows and aggregate report. It
prints aggregate counts only; it does not fetch or write production data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

OBSERVED_THROUGH = date(2026, 9, 27)
SYNC_COHORT_WEEK = date(2026, 8, 24)
RETENTION_COHORT_WEEK = date(2026, 9, 7)
SETUP_EVENTS = ("desktop_setup_completed", "desktop_onboarding_step")
REAL_USE_WAU_KINDS = ("sync", "cli", "mcp", "agent", "group", "integration")


def read_json(path: Path, default=None):
    if not path.is_file():
        return default
    return json.loads(path.read_text())


def instant(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def masked_uid(value: object) -> str:
    digest = hashlib.sha256(str(value).encode()).hexdigest()[:12]
    return f"masked-{digest}"


def row_has_probe_marker(row: dict) -> bool:
    if row.get("isInternal") is True or row.get("isAutomated") is True:
        return True
    for field in ("utmSource", "utm_source", "lastTouchUtmSource", "page", "landingPage"):
        value = str(row.get(field) or "").lower()
        if "e2e-verify" in value or value.startswith("/hq-e2e-verify"):
            return True
    return False


def event_rows(root: Path) -> dict[str, list[dict]]:
    event_root = root / "events"
    if not event_root.is_dir():
        raise ValueError(f"Missing event rows directory: {event_root}")
    result: dict[str, list[dict]] = {}
    for event_dir in sorted(path for path in event_root.iterdir() if path.is_dir()):
        by_id = {}
        for path in sorted(event_dir.glob("????-??-??.json")):
            payload = read_json(path, [])
            if isinstance(payload, list):
                rows = payload
            elif isinstance(payload, dict):
                rows = payload.get("events", payload.get("rows", []))
            else:
                rows = []
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                ts = instant(row.get("occurredAt"))
                if not ts or ts.date() > OBSERVED_THROUGH:
                    continue
                key = row.get("eventId") or tuple(
                    row.get(field)
                    for field in (
                        "occurredAt",
                        "personUid",
                        "anonId",
                        "companyUid",
                        "eventName",
                        "step",
                        "action",
                        "outcome",
                    )
                )
                by_id.setdefault(str(key), row)
        result[event_dir.name] = list(by_id.values())
    return result


def excluded_people(events: dict[str, list[dict]], people_class: dict, bad_ids: set[str]) -> set[str]:
    excluded: set[str] = set()
    probe_anons: set[str] = set()
    anon_to_person = {
        str(row["anonId"]): str(row["personUid"])
        for row in events.get("marketing_identity_linked", [])
        if row.get("anonId") and row.get("personUid")
    }
    for rows in events.values():
        for row in rows:
            principal = str(row.get("principalType") or "").lower()
            # Agent/outpost rows may name their human owner. Exclude the machine
            # row without spreading the exclusion to that owner.
            if principal in {"agent", "outpost"}:
                continue
            if row_has_probe_marker(row):
                person = row.get("personUid")
                anon = row.get("anonId")
                if person:
                    excluded.add(str(person))
                if anon:
                    probe_anons.add(str(anon))
    excluded.update(anon_to_person[anon] for anon in probe_anons if anon in anon_to_person)
    for person, classification in people_class.items():
        if not isinstance(classification, dict):
            continue
        if any(classification.get(key) is True for key in ("internal", "probe", "wauInternal")):
            excluded.add(str(person))
    # Funnel Pulse's closure is stored as masked UIDs; compare without printing
    # or persisting the canonical person identifiers.
    for rows in events.values():
        for row in rows:
            person = row.get("personUid")
            if person and masked_uid(person) in bad_ids:
                excluded.add(str(person))
    return excluded


def load_wau_days(root: Path, excluded: set[str]) -> dict[str, dict[str, set[date]]]:
    wau_root = root / "wau"
    if not wau_root.is_dir():
        raise ValueError(f"Missing WAU rows directory: {wau_root}")
    wau_files = sorted(wau_root.glob("????-??-??.json"))
    if not wau_files:
        raise ValueError(f"No WAU rows found under: {wau_root}")
    days: dict[str, dict[str, set[date]]] = defaultdict(lambda: defaultdict(set))
    for path in wau_files:
        day = date.fromisoformat(path.stem)
        if day > OBSERVED_THROUGH:
            continue
        payload = read_json(path, {})
        if not isinstance(payload, dict):
            continue
        for kind, people in payload.items():
            if not isinstance(people, list):
                continue
            for person in people:
                uid = str(person)
                if uid.startswith("prs_") and uid not in excluded:
                    days[uid][str(kind)].add(day)
    return days


def clean_setup(event_name: str, row: dict) -> bool:
    if event_name == "desktop_setup_completed":
        try:
            return int(row.get("failedStageCount")) == 0
        except (TypeError, ValueError):
            return False
    return (
        event_name == "desktop_onboarding_step"
        and row.get("step") == "setup"
        and row.get("outcome") == "all_stages_completed"
    )


def setup_times(events: dict[str, list[dict]], excluded: set[str]) -> dict[str, datetime]:
    earliest: dict[str, datetime] = {}
    for event_name in SETUP_EVENTS:
        for row in events.get(event_name, []):
            person = str(row.get("personUid") or "")
            ts = instant(row.get("occurredAt"))
            if (
                not person.startswith("prs_")
                or person in excluded
                or str(row.get("principalType") or "").lower() in {"agent", "outpost"}
                or row_has_probe_marker(row)
                or not ts
                or not clean_setup(event_name, row)
                or not (date(2026, 8, 24) <= ts.date() <= date(2026, 9, 26))
            ):
                continue
            if person not in earliest or ts < earliest[person]:
                earliest[person] = ts
    return earliest


def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def sync_in_first_week(person: str, setup_at: datetime, wau: dict[str, dict[str, set[date]]]) -> bool:
    setup_day = setup_at.date()
    return any(
        setup_day < day <= setup_day + timedelta(days=6)
        for day in wau.get(person, {}).get("sync", set())
    )


def sync_hours_after_setup(person: str, setup_at: datetime, wau: dict[str, dict[str, set[date]]]) -> float | None:
    days = [day for day in wau.get(person, {}).get("sync", set()) if day > setup_at.date()]
    if not days:
        return None
    first_midpoint = datetime.combine(min(days), time(12, 0), timezone.utc)
    return max(0.0, (first_midpoint - setup_at).total_seconds() / 3600)


def week_two_real_use(person: str, setup_at: datetime, wau: dict[str, dict[str, set[date]]]) -> bool:
    start = setup_at.date() + timedelta(days=7)
    end = setup_at.date() + timedelta(days=13)
    return any(
        start <= day <= end
        for kind in REAL_USE_WAU_KINDS
        for day in wau.get(person, {}).get(kind, set())
    )


def find_report_row(rows: list[dict], predicate, description: str) -> dict:
    found = [row for row in rows if predicate(row)]
    if len(found) != 1:
        raise ValueError(f"Expected one aggregate report row for {description}; found {len(found)}")
    return found[0]


def verify(raw_root: Path, report_path: Path) -> list[tuple[str, bool, str]]:
    events = event_rows(raw_root)
    people_class = read_json(raw_root / "people-class.json", {})
    bad_ids = set(read_json(raw_root / "exclusion-closure.json", {}).get("bad", []))
    excluded = excluded_people(events, people_class, bad_ids)
    wau = load_wau_days(raw_root, excluded)
    setups = setup_times(events, excluded)
    results: list[tuple[str, bool, str]] = []

    sync_cohort = {
        person: setup_at
        for person, setup_at in setups.items()
        if week_start(setup_at.date()) == SYNC_COHORT_WEEK
        and setup_at.date() + timedelta(days=6) <= OBSERVED_THROUGH
    }
    first_week_sync = {
        person: sync_in_first_week(person, setup_at, wau)
        for person, setup_at in sync_cohort.items()
    }
    adopter_n = sum(first_week_sync.values())
    adoption_denominator = len(sync_cohort)
    delays = [
        delay
        for person, setup_at in sync_cohort.items()
        if (delay := sync_hours_after_setup(person, setup_at, wau)) is not None
    ]
    median_hours = round(statistics.median(delays), 1) if delays else None

    report = read_json(report_path)
    if not isinstance(report, dict):
        raise ValueError(f"Missing aggregate usage report: {report_path}")
    adoption_row = find_report_row(
        report.get("adoption_and_time_to_first_use", []),
        lambda row: row.get("scope") == "people"
        and row.get("cohort_week_start") == SYNC_COHORT_WEEK.isoformat()
        and row.get("feature") == "sync_work_bearing",
        "Aug 24 first-week sync adoption",
    )
    adoption_cell = adoption_row.get("adopted_within_first_week", {})
    expected_adoption = (
        adopter_n,
        adoption_denominator,
        round(100 * adopter_n / adoption_denominator, 1) if adoption_denominator else None,
    )
    reported_adoption = (
        adoption_cell.get("count"),
        adoption_cell.get("denominator"),
        adoption_cell.get("percent"),
    )
    results.append(
        (
            "Aug 24 first-week work-bearing sync",
            reported_adoption == expected_adoption == (13, 15, 86.7),
            f"{adopter_n}/{adoption_denominator} ({expected_adoption[2]}%)",
        )
    )
    time_denominator = len(delays)
    report_time = (
        adoption_row.get("time_to_first_use_hours_median"),
        adoption_row.get("first_use_observed_n"),
        adoption_row.get("time_denominator"),
        adoption_row.get("time_cohort_n"),
    )
    computed_time = (median_hours, time_denominator, time_denominator, len(sync_cohort))
    results.append(
        (
            "Aug 24 time to first observed sync",
            report_time == computed_time == (28.1, 14, 14, 15),
            f"{median_hours} hours median ({time_denominator}/{len(sync_cohort)} with observed use)",
        )
    )

    retention_cohort = {
        person: setup_at
        for person, setup_at in setups.items()
        if week_start(setup_at.date()) == RETENTION_COHORT_WEEK
        and setup_at.date() + timedelta(days=13) <= OBSERVED_THROUGH
    }
    retention_groups = {
        True: {"retained": 0, "denominator": 0},
        False: {"retained": 0, "denominator": 0},
    }
    for person, setup_at in retention_cohort.items():
        adopted = sync_in_first_week(person, setup_at, wau)
        bucket = retention_groups[adopted]
        bucket["denominator"] += 1
        bucket["retained"] += int(week_two_real_use(person, setup_at, wau))
    with_sync = retention_groups[True]
    without_sync = retention_groups[False]
    actual_retention = (
        with_sync["retained"],
        with_sync["denominator"],
        round(100 * with_sync["retained"] / with_sync["denominator"], 1) if with_sync["denominator"] else None,
        without_sync["retained"],
        without_sync["denominator"],
        round(100 * without_sync["retained"] / without_sync["denominator"], 1) if without_sync["denominator"] else None,
    )
    retention_row = find_report_row(
        report.get("outcome_by_week1_feature", []),
        lambda row: row.get("scope") == "people"
        and row.get("cohort_week_start") == RETENTION_COHORT_WEEK.isoformat()
        and row.get("week1_feature") == "sync_work_bearing"
        and row.get("outcome") == "week1_retention",
        "Sep 7 week-two retention by first-week sync",
    )
    reported_with = retention_row.get("with_feature", {})
    reported_without = retention_row.get("without_feature", {})
    reported_retention = (
        reported_with.get("count"),
        reported_with.get("denominator"),
        reported_with.get("percent"),
        reported_without.get("count"),
        reported_without.get("denominator"),
        reported_without.get("percent"),
    )
    results.append(
        (
            "Sep 7 week-two real-use retention",
            actual_retention == reported_retention == (45, 55, 81.8, 2, 11, 18.2),
            f"{with_sync['retained']}/{with_sync['denominator']} "
            f"({round(100 * with_sync['retained'] / with_sync['denominator'], 1)}%) vs "
            f"{without_sync['retained']}/{without_sync['denominator']} "
            f"({round(100 * without_sync['retained'] / without_sync['denominator'], 1)}%)",
        )
    )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-root", required=True, type=Path, help="Local Funnel Pulse state with events/ and wau/")
    parser.add_argument("--report", required=True, type=Path, help="Aggregate mid-funnel report JSON")
    args = parser.parse_args()
    try:
        results = verify(args.raw_root, args.report)
    except Exception as error:
        print(f"FAIL checker: {error}")
        return 1
    failures = 0
    for label, passed, detail in results:
        print(f"{'PASS' if passed else 'FAIL'} {label}: {detail}")
        failures += not passed
    print(f"RESULT {'PASS' if failures == 0 else 'FAIL'} ({len(results) - failures}/{len(results)} checks)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
