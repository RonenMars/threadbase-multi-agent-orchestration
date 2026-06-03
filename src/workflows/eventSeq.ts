// src/workflows/eventSeq.ts
//
// Deterministic monotonic counter for a single turn's progress events.
// Created INSIDE workflow code, so the counter state lives in the workflow's
// in-memory state — Temporal rebuilds it on replay by re-running the workflow
// up to the current point. No clocks, no randomness, no I/O.

export function createSeq(start = 0): () => number {
  let n = start;
  return () => n++;
}
