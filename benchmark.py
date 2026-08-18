"""Measure cold-start and warm latency for the deployed flashfun-sdxl endpoint.

The talk needs numbers, not adjectives. This separates the three things that get
conflated when people say "cold start":

  queue/dispatch  -- time from submit to the worker picking the job up
  model load      -- pipeline construction (only paid once per worker)
  generate        -- actual GPU inference

Usage:
    python benchmark.py --endpoint-id <id> --runs 10

    # Endpoint id also read from RUNPOD_ENDPOINT_ID.
    RUNPOD_ENDPOINT_ID=abc123 python benchmark.py

Uses the flash client (`Endpoint(id=...)`) rather than raw REST, per CLAUDE.md.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import time


async def _run_once(endpoint, prompt: str, steps: int, seed: int) -> dict:
    started = time.perf_counter()
    job = await endpoint.runsync(
        {"prompt": prompt, "steps": steps, "seed": seed, "width": 512, "height": 512},
        timeout=900,
    )
    wall_ms = round((time.perf_counter() - started) * 1000)

    output = getattr(job, "output", job)
    if not isinstance(output, dict) or "image" not in output:
        raise RuntimeError(f"unexpected worker output: {str(output)[:400]}")

    return {
        "wall_ms": wall_ms,
        "generate_ms": output["generate_ms"],
        "model_load_ms": output["model_load_ms"],
        "cold": output["cold"],
        "gpu": output["gpu"],
        # Everything not accounted for by inference: queue, dispatch, transport,
        # and base64 of a ~450KB PNG.
        "overhead_ms": wall_ms - output["generate_ms"] - output["model_load_ms"],
    }


def _summarize(label: str, values: list[int]) -> str:
    if not values:
        return f"  {label:<16} --"
    ordered = sorted(values)
    p95 = ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]
    return (
        f"  {label:<16} min {min(ordered):>6}ms   "
        f"p50 {round(statistics.median(ordered)):>6}ms   "
        f"p95 {p95:>6}ms   max {max(ordered):>6}ms"
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--endpoint-id",
        default=os.getenv("RUNPOD_ENDPOINT_ID"),
        help="deployed endpoint id (default: $RUNPOD_ENDPOINT_ID)",
    )
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument(
        "--prompt", default="a lighthouse in a storm, dramatic lighting"
    )
    args = parser.parse_args()

    if not args.endpoint_id:
        parser.error("pass --endpoint-id or set RUNPOD_ENDPOINT_ID")

    from runpod_flash import Endpoint

    endpoint = Endpoint(id=args.endpoint_id)

    print(f"endpoint {args.endpoint_id}  runs={args.runs}  steps={args.steps}\n")

    results: list[dict] = []
    for i in range(args.runs):
        try:
            result = await _run_once(endpoint, f"{args.prompt} #{i}", args.steps, i)
        except Exception as exc:  # keep going; a single failure shouldn't kill the run
            print(f"  run {i + 1:>2}  FAILED  {exc}")
            continue

        results.append(result)
        marker = "COLD" if result["cold"] else "warm"
        print(
            f"  run {i + 1:>2}  {marker:<4}  wall {result['wall_ms']:>6}ms   "
            f"gpu {result['generate_ms']:>4}ms   "
            f"load {result['model_load_ms']:>5}ms   "
            f"overhead {result['overhead_ms']:>5}ms"
        )

    if not results:
        print("\nno successful runs")
        return

    cold = [r for r in results if r["cold"]]
    warm = [r for r in results if not r["cold"]]

    print(f"\n{len(results)} ok / {args.runs} attempted   gpu={results[0]['gpu']}")
    print(f"\ncold starts: {len(cold)}    warm: {len(warm)}")

    if cold:
        print("\nCOLD")
        print(_summarize("wall", [r["wall_ms"] for r in cold]))
        print(_summarize("model load", [r["model_load_ms"] for r in cold]))
    if warm:
        print("\nWARM")
        print(_summarize("wall", [r["wall_ms"] for r in warm]))
        print(_summarize("gpu only", [r["generate_ms"] for r in warm]))
        print(_summarize("overhead", [r["overhead_ms"] for r in warm]))


if __name__ == "__main__":
    asyncio.run(main())
