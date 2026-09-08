import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
// @ts-ignore Plain Node/Bun runtime module intentionally has no TS declaration.
import { hostResultToMcpContent, MAX_MCP_AUDIO_BYTES, MAX_MCP_IMAGE_BYTES } from '../src/kernel/mcp/mcp-media-content.mjs';
import { normalizeHostToolResultForMcp } from '../src/kernel/mcp/host-media-content';

const SERVER = resolve(import.meta.dir, '../src/kernel/mcp/forgeax-tools-server.mjs');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_DATA = PNG_BYTES.toString('base64');
const JPEG_DATA = JPEG_BYTES.toString('base64');
const AUDIO_BYTES = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000audio-fixture');
const AUDIO_DATA = AUDIO_BYTES.toString('base64');

function spawnServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = '';
  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id != null) {
          const entry = pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(message.id);
            entry.resolve(message);
          }
        }
      } catch {
        // The MCP server only writes JSON-RPC frames to stdout.
      }
    }
  });
  child.on('error', (error) => rejectAll(error));
  child.on('exit', (code, signal) => rejectAll(new Error(`MCP server exited (${code ?? signal ?? 'unknown'})`)));
  let id = 0;
  return {
    child,
    rpc(method: string, params?: unknown) {
      const requestId = ++id;
      return new Promise<any>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rejectPromise(new Error(`MCP request timed out: ${method}`));
        }, 5_000);
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          rejectPromise(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      child.kill('SIGTERM');
    },
  };
}

async function listenWithResult(result: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test bridge did not bind');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function listenWithError(error: string) {
  const server = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test bridge did not bind');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function callUiScreenshot(result: unknown) {
  const bridge = await listenWithResult(result);
  const mcp = spawnServer({
    FORGEAX_SERVER_URL: bridge.url,
    FORGEAX_SID: 'sid-ui-screenshot',
    FORGEAX_FXT_EXPOSE: 'ui_screenshot',
  });
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
    return await mcp.rpc('tools/call', { name: 'ui_screenshot', arguments: {} });
  } finally {
    mcp.close();
    await new Promise<void>((resolvePromise) => bridge.server.close(() => resolvePromise()));
  }
}

describe('mcp media content bridge', () => {
  test('keeps the host payload model-visible beside the execution trace key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-structured-payload-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(specsFile, JSON.stringify([{
      name: 'audio_project_read',
      description: 'returns an audio project summary',
      inputSchema: { type: 'object', properties: {} },
    }]));
    const hostPayload = {
      schema: 'forgeax-audio-project/2',
      revision: 0,
      entries: { total: 30 },
    };
    const bridge = await listenWithResult(hostPayload);
    const mcp = spawnServer({
      FORGEAX_SERVER_URL: bridge.url,
      FORGEAX_SID: 'sid-structured-payload',
      FORGEAX_FXT_EXPOSE: 'audio_project_read',
      FORGEAX_TOOL_SPECS_FILE: specsFile,
    });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
      const response = await mcp.rpc('tools/call', { name: 'audio_project_read', arguments: {} });
      expect(response.result.content).toEqual([{ type: 'text', text: JSON.stringify(hostPayload) }]);
      expect(response.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);
      expect(response.result.structuredContent?.forgeax?.result).toEqual(hostPayload);
    } finally {
      mcp.close();
      await new Promise<void>((resolvePromise) => bridge.server.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps text and image parts in their original order', async () => {
    const content = await hostResultToMcpContent([
      { type: 'text', text: 'before' },
      { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ]);

    expect(content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ]);
  });

  test('preserves validated inline audio parts instead of flattening them to JSON text', async () => {
    await expect(hostResultToMcpContent([
      { type: 'text', text: 'before' },
      { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg', name: 'fixture.mp3' },
      { type: 'text', text: 'after' },
    ])).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg' },
      { type: 'text', text: 'after' },
    ]);
  });

  test('keeps ordinary arrays and type-looking objects as one JSON text block', async () => {
    await expect(hostResultToMcpContent([])).resolves.toEqual([{ type: 'text', text: '[]' }]);
    await expect(hostResultToMcpContent([1, 2])).resolves.toEqual([{ type: 'text', text: '[1,2]' }]);
    await expect(hostResultToMcpContent(['a', 'b'])).resolves.toEqual([{ type: 'text', text: '["a","b"]' }]);
    await expect(hostResultToMcpContent({ type: 'text', text: 'business', extra: 'field' })).resolves.toEqual([
      { type: 'text', text: '{"type":"text","text":"business","extra":"field"}' },
    ]);
    await expect(hostResultToMcpContent({ type: 'image', data: PNG_DATA, mimeType: 'image/png', extra: true })).resolves.toEqual([
      { type: 'text', text: `{"type":"image","data":"${PNG_DATA}","mimeType":"image/png","extra":true}` },
    ]);
  });

  test('resolves image_file at the host/container boundary before MCP conversion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-success-'));
    const path = join(dir, 'sample.png');
    writeFileSync(path, PNG_BYTES);
    try {
      for (const inContainer of [false, true, undefined]) {
        const normalized = await normalizeHostToolResultForMcp({
          type: 'image_file',
          path,
          mimeType: 'image/png',
          ...(inContainer === undefined ? {} : { inContainer }),
        });
        await expect(hostResultToMcpContent(normalized)).resolves.toEqual([
          { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
        ]);
      }
      await expect(hostResultToMcpContent({ type: 'image_file', path, mimeType: 'image/png' })).resolves.toEqual([
        { type: 'text', text: 'image unavailable (file media was not normalized by the host bridge)' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves audio_file at the host/container boundary before MCP conversion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-audio-success-'));
    const path = join(dir, 'sample.mp3');
    writeFileSync(path, AUDIO_BYTES);
    try {
      for (const inContainer of [false, true, undefined]) {
        const normalized = await normalizeHostToolResultForMcp({
          type: 'audio_file',
          path,
          mimeType: 'audio/mpeg',
          ...(inContainer === undefined ? {} : { inContainer }),
        });
        await expect(hostResultToMcpContent(normalized)).resolves.toEqual([
          { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg' },
        ]);
      }
      await expect(hostResultToMcpContent({ type: 'audio_file', path, mimeType: 'audio/mpeg' })).resolves.toEqual([
        { type: 'text', text: 'audio unavailable (file media was not normalized by the host bridge)' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns readable, data-free text for read failures and oversized files', async () => {
    const missingResult = await normalizeHostToolResultForMcp({
      type: 'image_file',
      path: '/tmp/forgeax-mcp-media-does-not-exist.png',
      mimeType: 'image/png',
    });
    const missing = await hostResultToMcpContent(missingResult);
    expect(missing[0]?.type).toBe('text');
    expect(missing[0]?.text).toContain('read failed');
    expect(missing[0]?.text).not.toContain('base64');

    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-limit-'));
    const path = join(dir, 'large.png');
    writeFileSync(path, Buffer.alloc(MAX_MCP_IMAGE_BYTES + 1));
    try {
      const oversizedResult = await normalizeHostToolResultForMcp({ type: 'image_file', path, mimeType: 'image/png' });
      const oversized = await hostResultToMcpContent(oversizedResult);
      expect(oversized[0]?.type).toBe('text');
      expect(oversized[0]?.text).toContain('larger than');
      expect(oversized[0]?.text).not.toContain('AAE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects malformed base64 and MIME/magic mismatches', async () => {
    await expect(hostResultToMcpContent([
      { type: 'image', data: 'not-base64', mimeType: 'image/png' },
    ])).resolves.toEqual([{ type: 'text', text: 'image unavailable (invalid base64)' }]);
    await expect(hostResultToMcpContent([
      { type: 'image', data: JPEG_DATA, mimeType: 'image/png' },
    ])).resolves.toEqual([{ type: 'text', text: 'image unavailable (MIME does not match image bytes)' }]);
    const oversizedData = Buffer.alloc(MAX_MCP_IMAGE_BYTES + 4).toString('base64');
    await expect(hostResultToMcpContent([
      { type: 'image', data: oversizedData, mimeType: 'image/png' },
    ])).resolves.toEqual([{ type: 'text', text: `image unavailable (larger than ${MAX_MCP_IMAGE_BYTES} bytes)` }]);

    await expect(hostResultToMcpContent([
      { type: 'audio', data: 'not-base64', mimeType: 'audio/mpeg' },
    ])).resolves.toEqual([{ type: 'text', text: 'audio unavailable (invalid base64)' }]);
    await expect(hostResultToMcpContent([
      { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/wav' },
    ])).resolves.toEqual([{ type: 'text', text: 'audio unavailable (MIME does not match audio bytes)' }]);
    const oversizedAudioData = Buffer.alloc(MAX_MCP_AUDIO_BYTES + 4).toString('base64');
    await expect(hostResultToMcpContent([
      { type: 'audio', data: oversizedAudioData, mimeType: 'audio/mpeg' },
    ])).resolves.toEqual([{ type: 'text', text: `audio unavailable (larger than ${MAX_MCP_AUDIO_BYTES} bytes)` }]);
  });

  test('bridgeCall preserves host image media and toolExecutionId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-bridge-'));
    const path = join(dir, 'bridge.png');
    const specsFile = join(dir, 'specs.json');
    writeFileSync(path, PNG_BYTES);
    writeFileSync(specsFile, JSON.stringify([{
      name: 'media_host_tool',
      description: 'returns media',
      inputSchema: { type: 'object', properties: {} },
    }]));
    const bridge = await listenWithResult([
      { type: 'text', text: 'metadata' },
      { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
    ]);
    const mcp = spawnServer({
      FORGEAX_SERVER_URL: bridge.url,
      FORGEAX_SID: 'sid-media',
      FORGEAX_FXT_EXPOSE: 'media_host_tool',
      FORGEAX_TOOL_SPECS_FILE: specsFile,
    });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
      const response = await mcp.rpc('tools/call', { name: 'media_host_tool', arguments: {} });
      expect(response.result.content).toEqual([
        { type: 'text', text: 'metadata' },
        { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      ]);
      expect(response.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);
      expect(response.result.structuredContent?.forgeax?.result).toEqual([
        { type: 'text', text: 'metadata' },
        { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      ]);
      expect(response.result.content.map((part: { type: string }) => part.type)).toEqual(['text', 'image']);
    } finally {
      mcp.close();
      await new Promise<void>((resolvePromise) => bridge.server.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bridgeCall preserves host audio media and toolExecutionId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-audio-bridge-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(specsFile, JSON.stringify([{
      name: 'audio_host_tool',
      description: 'returns audio',
      inputSchema: { type: 'object', properties: {} },
    }]));
    const bridge = await listenWithResult([
      { type: 'text', text: 'metadata' },
      { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg' },
    ]);
    const mcp = spawnServer({
      FORGEAX_SERVER_URL: bridge.url,
      FORGEAX_SID: 'sid-audio-media',
      FORGEAX_FXT_EXPOSE: 'audio_host_tool',
      FORGEAX_TOOL_SPECS_FILE: specsFile,
    });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
      const response = await mcp.rpc('tools/call', { name: 'audio_host_tool', arguments: {} });
      expect(response.result.content).toEqual([
        { type: 'text', text: 'metadata' },
        { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg' },
      ]);
      expect(response.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);
      expect(response.result.structuredContent?.forgeax?.result).toEqual([
        { type: 'text', text: 'metadata' },
        { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/mpeg' },
      ]);
      expect(response.result.content.map((part: { type: string }) => part.type)).toEqual(['text', 'audio']);
    } finally {
      mcp.close();
      await new Promise<void>((resolvePromise) => bridge.server.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns data-free text for missing and oversized audio files', async () => {
    const missingResult = await normalizeHostToolResultForMcp({
      type: 'audio_file',
      path: '/tmp/forgeax-mcp-audio-does-not-exist.mp3',
      mimeType: 'audio/mpeg',
    });
    const missing = await hostResultToMcpContent(missingResult);
    expect(missing[0]?.type).toBe('text');
    expect(missing[0]?.text).toContain('read failed');
    expect(missing[0]?.text).not.toContain('base64');

    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-audio-limit-'));
    const path = join(dir, 'large.mp3');
    writeFileSync(path, Buffer.alloc(MAX_MCP_AUDIO_BYTES + 1));
    try {
      const oversizedResult = await normalizeHostToolResultForMcp({ type: 'audio_file', path, mimeType: 'audio/mpeg' });
      const oversized = await hostResultToMcpContent(oversizedResult);
      expect(oversized[0]?.type).toBe('text');
      expect(oversized[0]?.text).toContain('larger than');
      expect(oversized[0]?.text).not.toContain('AAE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ui_screenshot accepts new arrays, legacy JSON-string content, and plain text', async () => {
    const native = await callUiScreenshot([
      { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      { type: 'text', text: 'native metadata' },
    ]);
    expect(native.result.content).toEqual([
      { type: 'image', data: PNG_DATA, mimeType: 'image/png' },
      { type: 'text', text: 'native metadata' },
    ]);
    expect(native.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);

    const legacy = await callUiScreenshot(JSON.stringify([
      { type: 'image', data: JPEG_DATA, mimeType: 'image/jpeg' },
      { type: 'text', text: 'legacy metadata' },
    ]));
    expect(legacy.result.content).toEqual([
      { type: 'image', data: JPEG_DATA, mimeType: 'image/jpeg' },
      { type: 'text', text: 'legacy metadata' },
    ]);
    expect(legacy.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);

    const plain = await callUiScreenshot('captured: false');
    expect(plain.result.content).toEqual([{ type: 'text', text: 'captured: false' }]);
    expect(plain.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);
    expect(plain.result.isError).toBeUndefined();
  });

  test('bridge errors retain isError and toolExecutionId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-media-error-'));
    const specsFile = join(dir, 'specs.json');
    writeFileSync(specsFile, JSON.stringify([{
      name: 'media_error_tool',
      description: 'returns an error',
      inputSchema: { type: 'object', properties: {} },
    }]));
    const bridge = await listenWithError('host rejected media tool');
    const mcp = spawnServer({
      FORGEAX_SERVER_URL: bridge.url,
      FORGEAX_SID: 'sid-media-error',
      FORGEAX_FXT_EXPOSE: 'media_error_tool',
      FORGEAX_TOOL_SPECS_FILE: specsFile,
    });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
      const response = await mcp.rpc('tools/call', { name: 'media_error_tool', arguments: {} });
      expect(response.result.isError).toBe(true);
      expect(response.result.content).toEqual([{ type: 'text', text: 'host rejected media tool' }]);
      expect(response.result.structuredContent?.forgeax?.toolExecutionId).toMatch(/^fxt-/);
    } finally {
      mcp.close();
      await new Promise<void>((resolvePromise) => bridge.server.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects pending helper requests when the MCP child exits', async () => {
    const mcp = spawnServer({ FORGEAX_FXT_EXPOSE: 'ui_screenshot' });
    const pending = mcp.rpc('initialize', { protocolVersion: '2024-11-05' });
    mcp.child.kill('SIGKILL');
    await expect(pending).rejects.toThrow(/MCP server exited/);
  });
});
