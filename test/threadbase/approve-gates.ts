// test/threadbase/approve-gates.ts
//
// Wraps a `sendProgressEvent` stub so every gate is answered Approve, as the
// phone would, by signalling the turn workflow that emitted the gate_open.
import { Context } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import type { ProgressEvent } from '@threadbase-sh/agent-types';

import { gateAnswerSignal } from '../../src/threadbase/signals';

export function approvingGates(client: Client, send: (ev: ProgressEvent) => Promise<void>) {
  return async (ev: ProgressEvent): Promise<void> => {
    const { workflowId } = Context.current().info.workflowExecution;
    await send(ev);
    if (ev.type !== 'gate_open') return;
    const { gateId } = ev.payload as { gateId: string };
    await client.workflow.getHandle(workflowId).signal(gateAnswerSignal, { gateId, optionIndex: 0 });
  };
}
