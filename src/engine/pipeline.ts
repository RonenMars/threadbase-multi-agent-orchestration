// src/engine/pipeline.ts
//
// A pipeline is an ordered list of phases. The engine knows nothing about the
// product that runs it: roles are plain strings, and every side effect goes
// through the PipelineIO the caller hands to runPipeline().

export type Phase =
  | { kind: 'agent'; role: string }
  /** Reviews the latest agent output; on rejection re-runs that agent, up to maxRework times. */
  | { kind: 'review'; role: string; maxRework: number }
  /**
   * A checkpoint before the result is released. Without `options` it is a
   * pass-through (`io.gate`); with them it waits for a human answer.
   */
  | {
    kind: 'gate';
    name: string;
    prompt?: string;
    detail?: string;
    options?: GateOption[];
    /** How long to wait for an answer, in the form `io.wait` accepts. */
    timeout?: string | number;
    /** Index into `options` taken when the timeout passes unanswered. */
    onTimeout?: number;
  };

/** continue: go on to the next phase. rework: re-run the last agent, then ask again. stop: end the run here. */
export type GateAction = 'continue' | 'rework' | 'stop';

export interface GateOption {
  label: string;
  action: GateAction;
}

export interface GateAnswer {
  gateId: string;
  optionIndex: number;
}

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
  | { kind: 'gate_open'; phase: Extract<Phase, { kind: 'gate' }>; gateId: string }
  | { kind: 'gate_closed'; phase: Extract<Phase, { kind: 'gate' }>; gateId: string; optionIndex: number; timedOut: boolean }
  | { kind: 'finished'; content: string; overruled: boolean; stopped: boolean };

export interface PipelineIO {
  agent(phase: Extract<Phase, { kind: 'agent' }>, rework?: Rework): Promise<string>;
  review(phase: Extract<Phase, { kind: 'review' }>, content: string): Promise<Verdict>;
  gate(phase: Extract<Phase, { kind: 'gate' }>): Promise<void>;
  /** A fresh id for a gate, unique across runs (the workflow's uuid4). */
  newId(): string;
  /**
   * Resolves true once `ready()` holds, false if `timeout` passes first.
   * Temporal's condition(): `ready` is re-checked whenever state changes.
   */
  wait(ready: () => boolean, timeout: string | number): Promise<boolean>;
  /** Called once per event, in order. */
  emit(event: PipelineEvent): Promise<void>;
}

export interface PipelineResult {
  content: string;
  reworkAttempts: number;
  /** The last review still rejected the output when the rework cap ran out. */
  overruled: boolean;
  /** A gate answered (or timed out to) Stop. */
  stopped: boolean;
}
