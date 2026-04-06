import { HookOutput } from './types.js';

export interface CodexStopHookOutput {
  continue?: boolean;
  decision?: 'block';
  reason?: string;
  stopReason?: string;
}

export function serializeStopHookOutput(output: HookOutput): string | null {
  switch (output.decision) {
    case 'block':
      return JSON.stringify({
        decision: 'block',
        reason: output.reason,
      } satisfies CodexStopHookOutput);
    case 'continue':
      return null;
    case 'stop':
      return JSON.stringify({
        continue: false,
        stopReason: output.text,
      } satisfies CodexStopHookOutput);
  }
}
