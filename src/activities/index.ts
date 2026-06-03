// src/activities/index.ts
// Barrel for Temporal's flat activity namespace. Worker.create({ activities })
// expects a single object exposing every callable activity by name.

export { processTask, reviewTask, productSignOff } from './agents';
export { sendProgressEvent } from './progress';
