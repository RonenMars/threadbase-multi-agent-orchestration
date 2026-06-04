// Mock WSHub sink for integration tests.
//
// Captures every WSMessage that the production code would broadcast to
// connected WebSocket clients. Scenarios assert against the captured array
// instead of opening real sockets.
//
// The shape mirrors tb-streamer's WSHub#broadcast — the route handler in
// progress.routes.ts only depends on the broadcast method, so a minimal
// duck-typed sink is sufficient.

export interface WSSink {
  /** Called by the production progress route. Captures the message in order. */
  broadcast(message: unknown): void;
  /** All messages received, in the order they were broadcast. */
  readonly captured: ReadonlyArray<unknown>;
  /** Reset for reuse across multiple scenario steps inside one test. */
  reset(): void;
}

export function createWSSink(): WSSink {
  const messages: unknown[] = [];
  return {
    broadcast(message: unknown): void {
      messages.push(message);
    },
    get captured(): ReadonlyArray<unknown> {
      return messages;
    },
    reset(): void {
      messages.length = 0;
    },
  };
}
