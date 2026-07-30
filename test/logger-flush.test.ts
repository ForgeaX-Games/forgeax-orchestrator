/**
 * Logger.flush() 排序保证单测。
 *
 * 背景:`flush()` 此前只等 `writableNeedDrain === false`,但该标志只证明用户态
 * high-water mark 没超过,不证明此前排队的 write() 已经真正落到 fd。改用一次空
 * write(cb) —— 其回调保证排在所有先前 write 之后。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/core/logger";

function makeLogger() {
  const dir = mkdtempSync(join(tmpdir(), "logger-flush-test-"));
  const logger = new Logger({
    debugLogPath: join(dir, "debug.log"),
    latestLogPath: join(dir, "latest.log"),
  });
  return { dir, logger };
}

describe("Logger.flush()", () => {
  test("resolve 后,此前所有 write 已经落盘(debug.log + latest.log)", async () => {
    const { dir, logger } = makeLogger();
    try {
      for (let i = 0; i < 200; i++) logger.info("agent", i, `line-${i}`);
      await logger.flush();
      const debugContent = readFileSync(join(dir, "debug.log"), "utf8");
      const latestContent = readFileSync(join(dir, "latest.log"), "utf8");
      expect(debugContent).toContain("line-0");
      expect(debugContent).toContain("line-199");
      expect(latestContent).toContain("line-0");
      expect(latestContent).toContain("line-199");
    } finally {
      await logger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无 latestLogPath 时 flush() 仍正常 resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "logger-flush-test-"));
    const logger = new Logger({ debugLogPath: join(dir, "debug.log") });
    try {
      logger.debug("agent", undefined, "hi");
      await expect(logger.flush()).resolves.toBeUndefined();
    } finally {
      await logger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close() 之后再 flush() 不因 destroyed stream 而挂起或抛错", async () => {
    const { dir, logger } = makeLogger();
    await logger.close();
    await expect(logger.flush()).resolves.toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
