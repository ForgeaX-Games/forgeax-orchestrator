import { afterEach, describe, expect, it } from 'bun:test';
import {
  getDeliveryEnricher,
  initOrchestrationSeams,
  resetOrchestrationSeams,
} from '../src/orchestration-seams';
import { hostToolRunCtx } from '../src/kernel/forgeax-builtin-tools';

afterEach(() => {
  resetOrchestrationSeams();
});

describe('orchestration delivery seam', () => {
  it('registers and returns the injected enricher without interpreting checkpoint state', () => {
    const delivery = {
      enrich: async () => ({
        outcome: 'done',
        files: [],
        meta: { durationMs: 0, agents: [] },
      }),
    };

    initOrchestrationSeams({ delivery });

    expect(getDeliveryEnricher()).toBe(delivery);
  });

  it('binds sid and game into the host-tool delivery context', async () => {
    let seen: unknown;
    initOrchestrationSeams({
      delivery: {
        enrich: async (claim, context) => {
          seen = context;
          return { ...claim, files: [], meta: { durationMs: 0, agents: [] } };
        },
      },
    });

    const ctx = hostToolRunCtx({
      sid: 'sid-1',
      agentId: 'forge',
      projectRoot: '/tmp/project',
      game: 'demo',
    });
    await ctx.delivery?.enrich({ outcome: 'done' });

    expect(seen).toEqual({
      sid: 'sid-1',
      agentId: 'forge',
      projectRoot: '/tmp/project',
      game: 'demo',
    });
  });
});
