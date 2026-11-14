// ── Minimal MCP (Model Context Protocol) message handler ────────────────────
// JSON-RPC 2.0, hand-rolled so the project needs no SDK dependency. Pure: no
// stdio, no network — src/mcp-server.js wires it to stdin/stdout, tests call
// handleMessage() directly.
//
// Supported: initialize, notifications/initialized, ping, tools/list,
// tools/call, prompts/list, prompts/get. Notifications (no id) never get a
// response. Tool failures are results with isError:true, not JSON-RPC errors.

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// Parse one line of the stdio stream. Returns { message } or { error: <response> }.
export function parseLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return { skip: true };
  try {
    return { message: JSON.parse(text) };
  } catch {
    return { error: rpcError(null, ERR.PARSE, 'Parse error') };
  }
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// tools:   [{ name, description, inputSchema, handler(args) → string | object }]
// prompts: [{ name, description, arguments?, get(args) → string | { description?, text } }]
export function createMcpHandler({ tools = [], prompts = [], serverInfo = { name: 'job-alert-bot', version: '0.0.0' }, log = () => {} } = {}) {
  const toolByName = new Map(tools.map(t => [t.name, t]));
  const promptByName = new Map(prompts.map(p => [p.name, p]));

  async function dispatch(method, params, id) {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST_VERSION,
          capabilities: { tools: {}, prompts: {} },
          serverInfo,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = toolByName.get(params?.name);
        if (!tool) return rpcResult(id, textResult(`Unbekanntes Werkzeug: ${params?.name}`, true));
        try {
          const out = await tool.handler(params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
          return rpcResult(id, textResult(typeof out === 'string' ? out : JSON.stringify(out, null, 2)));
        } catch (err) {
          log(`Werkzeug ${tool.name} fehlgeschlagen: ${err.message}`);
          return rpcResult(id, textResult(err.message || String(err), true));
        }
      }
      case 'prompts/list':
        return rpcResult(id, {
          prompts: prompts.map(({ name, description, arguments: args }) => ({ name, description, ...(args ? { arguments: args } : {}) })),
        });
      case 'prompts/get': {
        const prompt = promptByName.get(params?.name);
        if (!prompt) return rpcError(id, ERR.INVALID_PARAMS, `Unbekannter Prompt: ${params?.name}`);
        const out = await prompt.get(params.arguments || {});
        const text = typeof out === 'string' ? out : out.text;
        return rpcResult(id, {
          description: (typeof out === 'object' && out.description) || prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text } }],
        });
      }
      default:
        return rpcError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // obj → response object, or null when none is due (notifications).
  async function handleMessage(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.method !== 'string') {
      // A response or garbage from the client: nothing to answer unless it had an id.
      return (obj && typeof obj === 'object' && 'id' in obj && !('method' in obj)) ? null
        : rpcError(obj?.id, ERR.INVALID_REQUEST, 'Invalid Request');
    }
    const isNotification = !('id' in obj) || obj.id === undefined;
    try {
      const response = await dispatch(obj.method, obj.params, obj.id);
      return isNotification ? null : response;
    } catch (err) {
      log(`Interner Fehler bei ${obj.method}: ${err.message}`);
      return isNotification ? null : rpcError(obj.id, ERR.INTERNAL, err.message);
    }
  }

  return { handleMessage };
}
