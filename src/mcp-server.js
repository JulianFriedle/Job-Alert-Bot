// MCP server (stdio) — lets Claude Desktop / Claude Code drive the Job-Alert-Bot.
//   node src/mcp-server.js            (desktop app: ELECTRON_RUN_AS_NODE=1 <app binary> src/mcp-server.js)
//
// stdout carries ONLY protocol messages (one JSON object per line); everything
// else goes to stderr. The process talks to the running GUI over HTTP and never
// opens the database itself — see src/mcp-tools.js and the README section
// "KI-Assistent (MCP)".
import './env.js';
import readline from 'readline';
import { readFileSync } from 'fs';
import path from 'path';
import { APP_ROOT } from './paths.js';
import { createMcpHandler, parseLine } from './mcp-protocol.js';
import { createToolkit, createHttpApi } from './mcp-tools.js';

// A stray console.log would corrupt the protocol stream.
console.log = (...args) => console.error(...args);

const logErr = (msg) => process.stderr.write(`[${new Date().toISOString()}] [mcp] ${msg}\n`);

const version = (() => {
  try { return JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

const { tools, prompts } = createToolkit({ api: createHttpApi() });
const { handleMessage } = createMcpHandler({
  tools, prompts, serverInfo: { name: 'job-alert-bot', version }, log: logErr,
});

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const parsed = parseLine(line);
  if (parsed.skip) return;
  if (parsed.error) { send(parsed.error); return; }
  const work = handleMessage(parsed.message)
    .then(res => { if (res) send(res); })
    .catch(err => logErr(`Unerwarteter Fehler: ${err.message}`))
    .finally(() => pending.delete(work));
  pending.add(work);
});

// Client closed stdin → finish in-flight calls, then exit.
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});

logErr(`Job-Alert-MCP ${version} bereit (stdio)`);
