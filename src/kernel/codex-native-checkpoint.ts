import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A completed native turn is a resume candidate, never proof of recovery.
 * Only thread/resume confirmation may authorize a host history delta. */
export class CodexNativeCheckpoint {
  private readonly path: string;
  private readonly fingerprint: string;
  constructor(home: string, configuration: string) {
    this.path = join(home, 'forgeax-native-resume.json');
    this.fingerprint = createHash('sha256').update(configuration).digest('hex');
  }

  read(): string | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      return value.version === 1 && value.fingerprint === this.fingerprint
        && typeof value.threadId === 'string' && value.threadId.trim()
        ? value.threadId : undefined;
    } catch { return undefined; }
  }

  /** Invalidate before dispatch, so crashes/cancellation cannot revive a
   * checkpoint older than the host's current history cursor. Fail closed if
   * the stale checkpoint cannot be removed. */
  clear(): void { rmSync(this.path, { force: true }); }

  complete(threadId: string): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, fingerprint: this.fingerprint, threadId }), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // Persistence is optional. A missing checkpoint keeps snapshot recovery.
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
