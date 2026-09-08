import { describe, expect, it, mock } from 'bun:test';
import { applyDevRegistration } from '../src/api/extensions';

function createDependencies() {
  return {
    register: mock((value: unknown) => ({
      ok: true as const,
      registration: value as { registrationId: string },
    })),
    reload: mock(async () => ({ generation: 8 }) as never),
    snapshot: mock(() => ({ generation: 7 }) as never),
  };
}

describe('dev extension API', () => {
  it('refreshes heartbeat state without incrementing the registry generation', async () => {
    const dependencies = createDependencies();
    const registration = { registrationId: 'native-dev' };
    const heartbeat = await applyDevRegistration(
      registration,
      'native-dev',
      false,
      dependencies,
    );

    expect(heartbeat).toEqual({
      status: 200,
      body: {
        ok: true,
        registrationId: 'native-dev',
        generation: 7,
      },
    });
    expect(dependencies.register).toHaveBeenCalledWith(registration);
    expect(dependencies.reload).not.toHaveBeenCalled();

    const reload = await applyDevRegistration(
      registration,
      'native-dev',
      true,
      dependencies,
    );

    expect(reload.status).toBe(200);
    expect(reload.body).toMatchObject({ generation: 8 });
    expect(dependencies.reload).toHaveBeenCalledTimes(1);
  });
});
