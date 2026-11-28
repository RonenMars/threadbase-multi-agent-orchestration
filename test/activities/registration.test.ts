// The worker registers the barrel, so an activity missing from it fails only at
// run time: the workflow task retries for ever and the turn never ends. Tests
// that pass their own activity stubs cannot see that.

import { describe, expect, it } from 'vitest';
import * as registered from '../../src/activities';
import * as agents from '../../src/activities/agents';
import { sendProgressEvent } from '../../src/threadbase/progress';

describe('activities the worker registers', () => {
  it.each(Object.entries({ ...agents, sendProgressEvent }))('includes %s', (name, activity) => {
    expect((registered as Record<string, unknown>)[name]).toBe(activity);
  });
});
