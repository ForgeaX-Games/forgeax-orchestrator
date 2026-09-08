import { describe, expect, test } from "bun:test";
import { SessionLease } from "../src/runtime/session-lease";

describe("SessionLease", () => {
  test("全部持有者释放前 Session 不可逐出，释放操作幂等", async () => {
    const lease = new SessionLease();
    const releaseA = lease.acquire("ephemeral:a");
    const releaseB = lease.acquire("ephemeral:b");
    let idle = false;
    const wait = lease.waitForIdle().then(() => {
      idle = true;
    });

    releaseA();
    releaseA();
    await Promise.resolve();
    expect(lease.canEvict).toBe(false);
    expect(lease.activeCount).toBe(1);
    expect(idle).toBe(false);

    releaseB();
    await wait;
    expect(lease.canEvict).toBe(true);
    expect(lease.snapshot()).toEqual({ activeCount: 0, labels: [] });
  });
});
