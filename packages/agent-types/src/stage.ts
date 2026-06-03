// packages/agent-types/src/stage.ts

/**
 * The seven stages a turn passes through. Declared as a readonly tuple so the
 * `Stage` type is the exact union of these literals — `string` on the wire for
 * additive compatibility, but type-checked internally.
 */
export const STAGES = Object.freeze([
  'thinking',
  'queued',
  'processing',
  'review',
  'rework',
  'sign-off',
  'done',
] as const);

export type Stage = (typeof STAGES)[number];
