// src/engine/pipeline.ts
//
// A pipeline is an ordered list of phases. The engine knows nothing about the
// product that runs it: roles are plain strings, and every side effect goes
// through the PipelineIO the caller hands to runPipeline().

export type Phase =
  | { kind: 'agent'; role: string }
  /** Reviews the latest agent output; on rejection re-runs that agent, up to maxRework times. */
  | { kind: 'review'; role: string; maxRework: number }
  /** A checkpoint before the result is released. Pass-through for now. */
  | { kind: 'gate'; name: string };

export interface PipelineSpec {
  phases: Phase[];
}

export interface Verdict {
  approved: boolean;
  notes: string;
}

/** Present when an agent phase is re-run because its review was rejected. */
export interface Rework {
  attempt: number;
  notes: string;
}

export type PipelineEvent =
  | { kind: 'started'; phase: Phase; attempt?: number }
  | { kind: 'output'; phase: Phase; attempt?: number; content: string; approved?: boolean }
  | { kind: 'finished'; content: string; overruled: boolean };

export interface PipelineIO {
  agent(phase: Extract<Phase, { kind: 'agent' }>, rework?: Rework): Promise<string>;
  review(phase: Extract<Phase, { kind: 'review' }>, content: string): Promise<Verdict>;
  gate(phase: Extract<Phase, { kind: 'gate' }>): Promise<void>;
  /** Called once per event, in order. */
  emit(event: PipelineEvent): Promise<void>;
}

export interface PipelineResult {
  content: string;
  reworkAttempts: number;
  /** The last review still rejected the output when the rework cap ran out. */
  overruled: boolean;
}
