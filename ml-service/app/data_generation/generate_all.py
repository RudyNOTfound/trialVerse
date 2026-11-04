"""Run the whole GLU-301 synthetic data pipeline.

    cd ml-service && python -m app.data_generation.generate_all
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from app.config import TrialConfig, default_config
from app.data_generation import ecg, participants, validation, visits
from app.data_generation.utils import write_csv

log = logging.getLogger("glu301.generate")


def _ends_05(s: pd.Series) -> float:
    return round(float((s.dropna().astype(int) % 5 == 0).mean()), 4)


def build_summary(cfg: TrialConfig, ds: validation.Dataset, ecg_status: str) -> dict:
    """Aggregate statistics written to metadata/generation_summary.json (minus timestamp/validation)."""
    p, v, t, e = ds.participants, ds.visits, ds.training, ds.ecg_metadata
    done = v[v["status"] == "completed"]
    sites = {}
    for sid in cfg.site_ids:
        pp, dd = p[p["site_id"] == sid], done[done["site_id"] == sid]
        sites[sid] = {
            "participants": int(len(pp)),
            "participant_retention_rate": round(float(1 - pp["dropped_out"].mean()), 4),
            "visit_completion_rate": round(float((v[v["site_id"] == sid]["status"] == "completed").mean()), 4),
            "otp_verification_rate": round(float(dd["otp_verified"].mean()), 4),
            "unverified_visits": int((dd["otp_verified"] == 0).sum()),
            "measurements": {
                "systolic_bp": {"mean": round(float(dd["systolic_bp"].mean()), 2), "sd": round(float(dd["systolic_bp"].std()), 2),
                                "share_ending_0_or_5": _ends_05(dd["systolic_bp"])},
                "diastolic_bp": {"mean": round(float(dd["diastolic_bp"].mean()), 2), "sd": round(float(dd["diastolic_bp"].std()), 2),
                                 "share_ending_0_or_5": _ends_05(dd["diastolic_bp"])},
                "heart_rate": {"mean": round(float(dd["heart_rate"].mean()), 2), "sd": round(float(dd["heart_rate"].std()), 2)},
                "weight_kg": {"mean": round(float(dd["weight_kg"].mean()), 2), "sd": round(float(dd["weight_kg"].std()), 2)},
                "glucose_mg_dl": {"mean": round(float(dd["glucose_mg_dl"].mean()), 2), "sd": round(float(dd["glucose_mg_dl"].std()), 2)},
            },
        }
    n_refs = int(len(e))
    n_unique = int(e["ecg_id"].nunique()) if n_refs else 0
    return {
        "trial_id": cfg.trial_id, "condition": cfg.condition, "random_seed": cfg.seed,
        "training_participants": int(len(t)), "demo_participants": int(len(p)), "sites": len(cfg.sites),
        "scheduled_visits_per_participant": cfg.scheduled_visits, "scheduled_visits": int(len(v)),
        "completed_visits": int((v["status"] == "completed").sum()), "missed_visits": int((v["status"] == "missed").sum()),
        "ecg": {"status": ecg_status, "images": n_unique, "references": n_refs, "reused_references": n_refs - n_unique},
        "training_dropout_distribution": {"not_dropped_out": int((t["dropped_out"] == 0).sum()),
                                          "dropped_out": int((t["dropped_out"] == 1).sum()),
                                          "dropout_rate": round(float(t["dropped_out"].mean()), 4)},
        "demo_dropout_rate": round(float(p["dropped_out"].mean()), 4),
        "fraud_injection": {"enabled": cfg.fraud.enabled, "site_id": cfg.fraud.site_id,
                            "config": dataclasses.asdict(cfg.fraud)},
        "site_statistics": sites,
    }


def run_pipeline(cfg: TrialConfig, validate: bool = True, check_reproducibility: bool = True) -> dict:
    """Generate every dataset under `cfg.output_dir`, validate, and return the summary dict."""
    out = Path(cfg.output_dir)
    for sub in ("training", "demo", "ecgs", "metadata"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    training = participants.generate_training_data(cfg)
    demo = participants.generate_demo_participants(cfg)
    sites = participants.build_sites_table(cfg, demo)
    all_visits = visits.generate_visits(cfg, demo)
    truth_otp = visits.inject_otp_batch_fraud(cfg, all_visits)

    ecg_status = "ok"
    try:
        ecg.generate_ecg_images(cfg, out / "ecgs")
    except ecg.ECGGenerationError as exc:
        log.warning("ECG generation skipped: %s", exc)
        ecg_status = f"skipped: {exc}"
    if ecg_status == "ok":
        all_visits, ecg_meta, truth_ecg = ecg.assign_ecg_references(cfg, all_visits, out / "ecgs")
    else:
        ecg_meta = pd.DataFrame(columns=ecg.ECG_METADATA_COLUMNS)
        truth_ecg = pd.DataFrame(columns=["visit_id", "site_id", "anomaly_type", "detail"])

    # Feature-safe `visits_missed`: only misses *before* the participant's dropout point, so the feature
    # never encodes the label. Post-dropout misses remain visible in visits.csv.
    demo["visits_missed"] = validation.expected_visits_missed(all_visits, demo)
    reimb = visits.generate_reimbursements(cfg, all_visits, demo)
    truth = pd.concat([truth_otp, truth_ecg], ignore_index=True)

    write_csv(training, out / "training" / "dropout_training.csv")
    write_csv(demo, out / "demo" / "participants.csv")
    write_csv(all_visits, out / "demo" / "visits.csv")
    write_csv(sites, out / "demo" / "sites.csv")
    write_csv(ecg_meta, out / "demo" / "ecg_metadata.csv")
    write_csv(reimb, out / "demo" / "reimbursements.csv")
    # Ground-truth labels for evaluating integrity detectors; deliberately NOT part of visits.csv.
    write_csv(truth, out / "metadata" / "fraud_ground_truth.csv")

    ds = validation.load_dataset(out)  # validate what was actually written
    summary = build_summary(cfg, ds, ecg_status)
    results = validation.run_all_checks(ds, cfg) if validate else []
    summary["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    summary_path = out / "metadata" / "generation_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")  # needed for the repro comparison
    if check_reproducibility and validate:
        with tempfile.TemporaryDirectory() as tmp:
            run_pipeline(dataclasses.replace(cfg, output_dir=Path(tmp)), validate=False, check_reproducibility=False)
            diffs = validation.compare_output_dirs(out, Path(tmp))
        results.append(validation.CheckResult("reproducibility (second run is identical)", not diffs, "; ".join(diffs)))
    summary["validation"] = [dataclasses.asdict(c) for c in results]
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    validation.raise_on_failure(results)
    return summary


def main(argv: Optional[list] = None) -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Generate the GLU-301 synthetic dataset.")
    parser.add_argument("--output-dir", type=Path, default=None, help="default: ml-service/generated_data")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--no-ecg", action="store_true", help="skip ECG image generation")
    parser.add_argument("--skip-reproducibility-check", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    overrides = {}
    if args.seed is not None:
        overrides["seed"] = args.seed
    if args.no_ecg:
        overrides["generate_ecg"] = False
    cfg = default_config(output_dir=args.output_dir, **overrides)
    summary = run_pipeline(cfg, check_reproducibility=not args.skip_reproducibility_check)
    n_ok = sum(1 for c in summary["validation"] if c["passed"])
    log.info("Done: %s -> %d/%d validation checks passed", cfg.output_dir, n_ok, len(summary["validation"]))


if __name__ == "__main__":
    main()
