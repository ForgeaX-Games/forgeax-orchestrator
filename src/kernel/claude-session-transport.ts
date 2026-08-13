import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SidecarClient, StartSessionReq } from './sidecar-client';
import type { ClaudeSessionTransport } from './claude-session-pool';

interface DirectOptions {
  cmd: string;
  args: string[];
  cwd: string;
  envOverride?: Record<string, string | undefined>;
}

function mergedEnv(envOverride?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(envOverride ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Direct child transport used when the explicit sidecar escape hatch is off. */
export function createDirectClaudeTransport(options: DirectOptions): ClaudeSessionTransport {
  const child = spawn(options.cmd, options.args, {
    cwd: options.cwd,
    env: mergedEnv(options.envOverride),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const dataCbs = new Set<(stream: 'stdout' | 'stderr', chunk: string) => void>();
  const exitCbs = new Set<(info: { code: number; signal?: string; error?: Error }) => void>();
  let settled = false;
  let spawnError: Error | undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { for (const cb of dataCbs) cb('stdout', chunk); });
  child.stderr.on('data', (chunk: string) => { for (const cb of dataCbs) cb('stderr', chunk); });
  const settle = (code: number, signal?: string) => {
    if (settled) return;
    settled = true;
    const info = { code, ...(signal ? { signal } : {}), ...(spawnError ? { error: spawnError } : {}) };
    for (const cb of exitCbs) cb(info);
  };
  child.once('error', (error) => { spawnError = error; settle(-1); });
  child.once('close', (code, signal) => settle(code ?? -1, signal ?? undefined));

  const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0 && process.platform !== 'win32') {
      try { process.kill(-pid, signal); return; } catch { /* process group already gone */ }
    }
    try { child.kill(signal); } catch { /* already gone */ }
  };

  return {
    pid: child.pid,
    write(data) {
      if (settled || !child.stdin.writable) throw new Error('claude session stdin is closed');
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(data, (error) => error ? reject(error) : resolve());
      });
    },
    onData(cb) { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onExit(cb) {
      exitCbs.add(cb);
      if (settled) queueMicrotask(() => cb({ code: child.exitCode ?? -1, ...(spawnError ? { error: spawnError } : {}) }));
      return () => exitCbs.delete(cb);
    },
    async close() {
      if (!settled) {
        killGroup('SIGTERM');
        await new Promise<void>((resolve) => {
          if (settled) { resolve(); return; }
          const timer = setTimeout(() => { killGroup('SIGKILL'); resolve(); }, 2000);
          timer.unref?.();
          exitCbs.add(() => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}

/** Sidecar transport: agent-host remains the process-group and credential owner. */
export async function createSidecarClaudeTransport(
  client: SidecarClient,
  spec: StartSessionReq,
): Promise<ClaudeSessionTransport> {
  const dataCbs = new Set<(stream: 'stdout' | 'stderr', chunk: string) => void>();
  const exitCbs = new Set<(info: { code: number; signal?: string; error?: Error }) => void>();
  let closed = false;
  const offData = client.onData((data) => {
    if (data.sessionId !== spec.sessionId) return;
    for (const cb of dataCbs) cb(data.stream, data.chunk);
  });
  const offExit = client.onExit((info) => {
    if (info.sessionId !== spec.sessionId) return;
    closed = true;
    for (const cb of exitCbs) cb({ code: info.code ?? -1, ...(info.signal ? { signal: info.signal } : {}) });
  });
  try {
    const grant = await client.startSession(spec);
    return {
      pid: grant.pid,
      write(data) {
        if (closed) return Promise.reject(new Error('sidecar Claude session is closed'));
        return client.write(spec.sessionId, data);
      },
      onData(cb) { dataCbs.add(cb); return () => dataCbs.delete(cb); },
      onExit(cb) {
        exitCbs.add(cb);
        return () => exitCbs.delete(cb);
      },
      async close() {
        if (!closed) {
          try { await client.shutdownSession(spec.sessionId); } finally { closed = true; }
        }
        offData();
        offExit();
      },
    };
  } catch (error) {
    offData();
    offExit();
    throw error;
  }
}
