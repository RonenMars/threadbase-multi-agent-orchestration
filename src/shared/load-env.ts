// Side-effect module: loads .env BEFORE any other import runs.
// Must be imported as the very first line of entrypoints (worker.ts, starter.ts).
// `override: true` makes .env win over pre-set shell vars — important when a
// rotated key in .env would otherwise be shadowed by a stale shell export.
import { config as loadEnv } from 'dotenv';

loadEnv({ override: true });
