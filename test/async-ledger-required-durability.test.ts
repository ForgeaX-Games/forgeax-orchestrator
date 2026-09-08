import { describe, expect, test } from "bun:test";
import { AsyncLedgerWriter } from "../src/session/async-ledger-writer";

describe("AsyncLedgerWriter durability", () => {
  test("required 不受高水位淘汰，按顺序且可 await", async () => {
    const writer = new AsyncLedgerWriter("required-test", { highWater: 1 });
    const order: number[] = [];
    const first = writer.enqueueTask(async () => {
      await Promise.resolve();
      order.push(1);
    }, "required");
    const second = writer.enqueueTask(async () => {
      order.push(2);
    }, "required");
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(writer.dropped).toBe(0);
    writer.dispose();
  });

  test("best-effort 满水位时丢最旧、保留最新；required 写入错误向调用方传播", async () => {
    const writer = new AsyncLedgerWriter("mixed-test", { highWater: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ran: number[] = [];

    // In-flight: holds the serial chain while we fill the pending queue.
    void writer.enqueueTask(async () => gate, "best-effort");
    await Promise.resolve(); // let the chain shift the in-flight task out of the queue
    // Oldest queued best-effort — should be cancelled when the next arrives.
    void writer.enqueueTask(async () => { ran.push(2); }, "best-effort");
    // Newest — kept.
    void writer.enqueueTask(async () => { ran.push(3); }, "best-effort");
    expect(writer.dropped).toBe(1);

    release();
    await writer.flush();
    expect(ran).toEqual([3]);

    await expect(
      writer.enqueueTask(async () => {
        throw new Error("disk failed");
      }, "required"),
    ).rejects.toThrow("disk failed");
    writer.dispose();
  });
});
