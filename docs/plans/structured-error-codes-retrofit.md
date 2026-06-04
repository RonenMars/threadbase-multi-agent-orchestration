# Deferred: Structured error codes retrofit across tb-streamer

Status: deferred — not in Plan 3.5 scope. Captured here so we can pick it up without re-deriving.

## Context

Plan 3.5 (multi-agent mode WS wiring) introduces structured error responses for the new multi-agent endpoints:

```json
{ "error": "Conversation history exceeds payload limit", "code": "SESSION_HISTORY_FULL" }
```

Multi-agent codes shipped in Plan 3.5:

- `SESSION_HISTORY_FULL` — 413, payload-size guard fired
- `SESSION_NOT_FOUND` — 404, session not registered
- `TEMPORAL_UNAVAILABLE` — 503, Temporal server unreachable
- `INPUT_REQUIRED` — 400, missing/empty input field
- `INVALID_SESSION_STATE` — 409, e.g., signal sent to cancelled session

Existing PTY-mode endpoints in `tb-streamer/src/server.ts` continue to return unstructured `{error: "human message"}` only. This document captures the retrofit work to bring them in line.

## Why this is deferred

Plan 3.5's scope is "wire the multi-agent surface so users can actually use it." Retrofitting ~15+ existing PTY handlers is:

1. **Wide blast radius.** Every error response shape change is a potential mobile-app regression. The mobile team should sign off on the contract change.
2. **Orthogonal to milestone B.** None of milestone B's user-visible behavior depends on this retrofit.
3. **Needs its own spec.** The codes that map to PTY-mode errors (PTY spawn failed, session in wrong state, terminal output unavailable, etc.) are a separate design question.

## When to do this

Pick this up when ANY of these become true:

- The mobile app team asks for distinguishable error handling on PTY-mode endpoints.
- A second non-mobile consumer (CLI tool, dashboard) wants typed errors.
- The PTY-mode `{error}` strings have caused a real bug (e.g., the app parsed an English error message and broke when the wording changed).
- You're already touching `server.ts` for a major refactor and want to roll the codes in.

If none of these has happened ~6 months after Plan 3.5 ships, this work probably isn't worth doing — the unstructured pattern is fine in practice.

## Scope of work (when picked up)

### Files affected

`tb-streamer/src/server.ts` — every `json(res, <status>, { error: ... })` call. Approximately:

- `handleStartSession` — at least 4 error paths (browseRoot, body shape, path validation, PTY spawn)
- `handleSendInput` — at least 2 (session not found, body shape)
- `handleResume` — similar
- `handleAdopt` — similar
- `handleCancel` — session not found
- `handleSearch` — query validation
- `handleListConversations` — pagination errors
- `handleGetConversation` — not found
- `handleListProjectChats` — query validation
- `handleBrowse` — path validation
- `handleMkdir` — path validation
- `handlePairExchange` — auth failures (multiple)
- `handlePairStart` — already structured? verify
- Error middleware in `src/api/middleware/error.middleware.ts`

### Code naming convention

Codes are `SCREAMING_SNAKE_CASE`, grouped by feature area:

- Session lifecycle: `SESSION_NOT_FOUND`, `SESSION_INVALID_STATE`, `SESSION_ALREADY_RUNNING`, `SESSION_HISTORY_FULL`, etc.
- PTY operations: `PTY_SPAWN_FAILED`, `PTY_NOT_ATTACHED`, `PTY_EXITED`, etc.
- Auth/pairing: `AUTH_REQUIRED`, `AUTH_INVALID`, `PAIR_EXCHANGE_EXPIRED`, `PAIR_RATE_LIMITED`
- Validation: `INPUT_REQUIRED`, `INPUT_TOO_LARGE`, `PATH_NOT_ALLOWED`, `BROWSE_ROOT_NOT_SET` (already exists)
- Infrastructure: `TEMPORAL_UNAVAILABLE`, `CACHE_UNAVAILABLE`, `DB_UNAVAILABLE`

### Implementation pattern

Create `tb-streamer/src/api/errors.ts` with:

```ts
export const ErrorCode = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_HISTORY_FULL: 'SESSION_HISTORY_FULL',
  // ...
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function errorResponse(code: ErrorCode, message: string) {
  return { error: message, code };
}
```

Then refactor every `json(res, status, { error: '...' })` to `json(res, status, errorResponse(ErrorCode.X, '...'))`.

### Mobile app coordination

Before merging the retrofit PR, the mobile app team should:
1. Confirm they're OK with the additive `code` field on existing responses.
2. Decide whether they want to start branching on `code` for any specific error paths.
3. Update their integration tests to expect the new shape (additive, so existing tests should pass).

### Testing

- Unit tests per affected handler: verify the `code` field is present and matches the documented value.
- An exhaustive enum test: build a list of all `ErrorCode` values, verify every handler emits at least one of them on each error path.
- Snapshot tests on response bodies — adds the `code` field without removing `error`.

## Estimated effort

1-2 days of focused work. Most of it is mechanical refactoring. The interesting parts:
- Picking the right code for each existing error (some are ambiguous — e.g., "browse path not allowed" is both a validation AND an authorization concern).
- Updating tests for every affected handler.
- Mobile-app sign-off cycle.

## Reference: Plan 3.5 multi-agent codes (for naming consistency)

When picking codes for retrofit, match the multi-agent precedent set in Plan 3.5:

| Code | HTTP status | Meaning |
|---|---|---|
| `SESSION_NOT_FOUND` | 404 | sessionId not in store |
| `SESSION_HISTORY_FULL` | 413 | payload-size guard fired |
| `SESSION_INVALID_STATE` | 409 | signal sent to wrong-state session |
| `INPUT_REQUIRED` | 400 | missing input field |
| `TEMPORAL_UNAVAILABLE` | 503 | Temporal server unreachable |

Existing precedent in code: `BROWSE_ROOT_NOT_SET` (verified at `tb-streamer/src/server.ts:1380, 1543, 1562`) — the only structured code in the codebase as of milestone B.

## Out of scope for the retrofit

- Internationalization of `error` message strings (separate i18n concern).
- A new error format with nested causes / stack traces.
- WebSocket message error codes (the WS layer has its own message types).
- Changing HTTP status codes — the retrofit only adds the `code` field; status codes stay as they are.
