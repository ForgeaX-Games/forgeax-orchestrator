/**
 * Minimal MCP server protocol shared by orchestrator's plain-Node stdio assets.
 *
 * Transport and JSON-RPC dispatch live here; individual servers only describe
 * their tools and business behavior. The API intentionally matches the protocol
 * shape used by the standalone game plugin without importing a parent workspace
 * package (the orchestrator repository must remain independently buildable).
 */

const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function textResult(text, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: String(text) }],
  };
}

export function toToolResult(out) {
  if (out && typeof out === 'object' && Array.isArray(out.content)) return out;
  if (typeof out === 'string') return textResult(out);
  if (out === undefined) return textResult('');
  return textResult(JSON.stringify(out));
}

export function defaultNotFound(name, tools) {
  const availableTools = tools.map((tool) => tool.name).sort();
  const hint = availableTools.length
    ? `Available tools: ${availableTools.join(', ')}.`
    : 'This server exposes no tools right now.';
  return {
    isError: true,
    content: [{ type: 'text', text: `not_found: tool ${JSON.stringify(name)} is not exposed. ${hint}` }],
    structuredContent: { code: 'not_found', tool: name, availableTools },
  };
}

async function currentTools(spec) {
  const tools = typeof spec.tools === 'function' ? await spec.tools() : spec.tools;
  return Array.isArray(tools) ? tools : [];
}

/**
 * Create a pure async dispatcher. Returns a response object, or null for
 * notifications and response frames that must not be answered.
 */
export function createMcpDispatcher(spec) {
  return async (msg) => {
    const { id, method, params } = msg ?? {};

    if (id == null) return null;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: FALLBACK_PROTOCOL_VERSION,
          capabilities: spec.capabilities ?? { tools: {} },
          serverInfo: spec.serverInfo,
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        },
      };
    }

    if (method?.startsWith('notifications/')) return null;
    if (typeof method !== 'string') return null;

    try {
      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'tools/list') {
        const tools = await currentTools(spec);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map(({ name, description = '', inputSchema = { type: 'object' } }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        };
      }
      if (method === 'tools/call') {
        const tools = await currentTools(spec);
        const name = typeof params?.name === 'string' ? params.name : '';
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          const result = spec.onUnknownTool
            ? await spec.onUnknownTool(name, tools)
            : defaultNotFound(name, tools);
          return { jsonrpc: '2.0', id, result };
        }
        try {
          const out = await tool.run(params?.arguments ?? {});
          return { jsonrpc: '2.0', id, result: toToolResult(out) };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          return {
            jsonrpc: '2.0',
            id,
            result: textResult(`error: ${error instanceof Error ? error.message : String(error)}`, true),
          };
        }
      }
      throw new RpcError(-32601, `method not found: ${method}`);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
}

/**
 * Run a newline-framed JSON-RPC dispatcher over stdio.
 *
 * The returned promise resolves only after stdin closes AND every request
 * already read from it has completed and written its response. This prevents
 * pipelined requests from being lost when a client writes several frames and
 * immediately closes stdin.
 */
export function serveStdio(dispatch, { input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';
  const inFlight = new Set();
  let inputClosed = false;
  let resolveDrained;
  const drained = new Promise((resolve) => {
    resolveDrained = resolve;
  });
  const finishIfDrained = () => {
    if (inputClosed && inFlight.size === 0) resolveDrained();
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const task = Promise.resolve(dispatch(message))
        .then(async (response) => {
          if (response) {
            await new Promise((resolve, reject) => {
              output.write(`${JSON.stringify(response)}\n`, (error) => {
                if (error) reject(error);
                else resolve();
              });
            });
          }
        })
        .catch(async (error) => {
          if (message?.id != null) {
            await new Promise((resolve) => {
              output.write(`${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              })}\n`, resolve);
            });
          }
        })
        .finally(() => {
          inFlight.delete(task);
          finishIfDrained();
        });
      inFlight.add(task);
    }
  });
  const onInputClosed = () => {
    inputClosed = true;
    finishIfDrained();
  };
  input.once('end', onInputClosed);
  input.once('close', onInputClosed);
  return drained;
}
