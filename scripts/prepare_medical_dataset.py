#!/usr/bin/env python3
"""Prepare a bounded, deduplicated local index from ruslanmv/ai-medical-dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

DATASET = "ruslanmv/ai-medical-dataset"
SOURCE_URL = f"https://huggingface.co/datasets/{DATASET}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare MediSage Hugging Face retrieval records.")
    parser.add_argument("--dataset", default=DATASET)
    parser.add_argument("--rows", type=int, default=50_000)
    parser.add_argument("--output", default="server/data/hf_medical_knowledge.jsonl")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--buffer-size", type=int, default=20_000)
    return parser.parse_args()


def normalize(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def stable_id(question: str, context: str) -> str:
    digest = hashlib.sha256(f"{question}\n{context}".encode("utf-8")).hexdigest()[:12].upper()
    return f"HF-MED-{digest}"


def main() -> None:
    args = parse_args()
    if args.dataset != DATASET:
        raise SystemExit(f"--dataset must be exactly {DATASET}")
    if args.rows < 1:
        raise SystemExit("--rows must be at least 1")
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise SystemExit("Missing dependency. Run: python3 -m pip install datasets") from exc

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    stream = load_dataset(DATASET, split="train", streaming=True)
    stream = stream.shuffle(seed=args.seed, buffer_size=args.buffer_size)
    seen: set[str] = set()
    written = 0
    iterator = iter(stream)
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            for row in iterator:
                question = normalize(row.get("question"), 1200)
                context = normalize(row.get("context"), 5000)
                if not question or not context:
                    continue
                record_id = stable_id(question, context)
                if record_id in seen:
                    continue
                seen.add(record_id)
                handle.write(json.dumps({
                    "id": record_id,
                    "dataset": DATASET,
                    "question": question,
                    "context": context,
                    "sourceUrl": SOURCE_URL,
                }, ensure_ascii=False) + "\n")
                written += 1
                if written % 1000 == 0:
                    print(f"Prepared {written:,} unique records…", flush=True)
                if written >= args.rows:
                    break
    finally:
        close = getattr(iterator, "close", None)
        if close:
            close()
    if written == 0:
        temporary.unlink(missing_ok=True)
        raise SystemExit("No valid records were returned; no dataset file was created.")
    temporary.replace(output)
    print(f"Prepared {written:,} records from {DATASET} at {output}")


if __name__ == "__main__":
    main()
