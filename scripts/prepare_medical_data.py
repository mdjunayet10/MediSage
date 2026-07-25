#!/usr/bin/env python3
"""Build a small local JSONL knowledge pack from ruslanmv/ai-medical-dataset.

The source dataset is very large, so this script uses Hugging Face streaming and
writes only a configurable sample. The generated JSONL is intentionally ignored
by git.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a lightweight MediSage RAG knowledge pack.")
    parser.add_argument("--rows", type=int, default=5000, help="Number of rows to save (default: 5000).")
    parser.add_argument("--seed", type=int, default=42, help="Shuffle seed.")
    parser.add_argument(
        "--buffer-size",
        type=int,
        default=20_000,
        help="Streaming shuffle buffer. Larger values improve diversity but use more memory.",
    )
    parser.add_argument(
        "--output",
        default="server/data/medical_knowledge.jsonl",
        help="Output JSONL path.",
    )
    return parser.parse_args()


def clean(value: Any, limit: int) -> str:
    if value is None:
        return ""
    text = " ".join(str(value).split())
    return text[:limit]


def main() -> None:
    args = parse_args()
    if args.rows < 1:
        raise SystemExit("--rows must be at least 1")

    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency. Run: python3 -m pip install datasets"
        ) from exc

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    print("Streaming ruslanmv/ai-medical-dataset from Hugging Face...")
    dataset = load_dataset("ruslanmv/ai-medical-dataset", split="train", streaming=True)
    dataset = dataset.shuffle(seed=args.seed, buffer_size=args.buffer_size)

    written = 0
    with output.open("w", encoding="utf-8") as handle:
        for row in dataset:
            question = clean(row.get("question"), 800)
            context = clean(row.get("context"), 3000)
            if not question and not context:
                continue
            handle.write(json.dumps({"question": question, "context": context}, ensure_ascii=False) + "\n")
            written += 1
            if written % 500 == 0:
                print(f"Saved {written:,} rows...")
            if written >= args.rows:
                break

    print(f"Done. Saved {written:,} rows to {output}")
    print("Restart the server so it loads the new knowledge pack.")


if __name__ == "__main__":
    main()
