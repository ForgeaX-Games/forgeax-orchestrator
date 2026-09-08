/** Compatibility entry point for the legacy ConsciousAgent loop.
 *
 * Runtime-owned turns live in `runtime/kernel-turn-runner.ts`.  Keeping this
 * narrow adapter prevents the pre-runtime BaseAgent implementation from
 * reintroducing a second kernel execution path while it remains available to
 * existing callers and tests.  The runtime runner is the only implementation
 * that maps provider events and failures onto the event bus.
 */
import {
  runKernelTurn as runRuntimeKernelTurn,
  inferKernelTurnError,
  type KernelTurnOpts as RuntimeKernelTurnOpts,
} from "../runtime/kernel-turn-runner";

export type KernelTurnOpts = RuntimeKernelTurnOpts & {
  /** Legacy history inputs are now owned by the RuntimeAgentHost context. */
  historyLedger?: unknown;
  historyBlackboard?: unknown;
  summonAgentId?: string;
};

export { inferKernelTurnError };

export async function runKernelTurn(opts: KernelTurnOpts) {
  const {
    historyLedger: _historyLedger,
    historyBlackboard: _historyBlackboard,
    summonAgentId: _summonAgentId,
    ...runtimeOpts
  } = opts;
  void _historyLedger;
  void _historyBlackboard;
  void _summonAgentId;
  return runRuntimeKernelTurn(runtimeOpts as RuntimeKernelTurnOpts);
}
