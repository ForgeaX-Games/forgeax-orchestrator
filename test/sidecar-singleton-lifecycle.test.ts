import { describe, expect, test } from 'bun:test';
import { isTrackedSidecarAlive } from '../src/kernel/sidecar-singleton';

describe('sidecar singleton child lifecycle', () => {
  test('treats a naturally exited child as unavailable even when kill was never called', () => {
    expect(isTrackedSidecarAlive({ exitCode: 0, signalCode: null })).toBe(false);
    expect(isTrackedSidecarAlive({ exitCode: 1, signalCode: null })).toBe(false);
  });

  test('treats a signalled child as unavailable and a pending child as live', () => {
    expect(isTrackedSidecarAlive({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
    expect(isTrackedSidecarAlive({ exitCode: null, signalCode: null })).toBe(true);
    expect(isTrackedSidecarAlive(null)).toBe(false);
  });
});
