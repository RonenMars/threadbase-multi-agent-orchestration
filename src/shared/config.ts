// Tiny config helper so connection details live in one place.
export const config = {
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'agent-tasks',
  model: process.env.AGENT_MODEL ?? 'claude-opus-4-7',
};
