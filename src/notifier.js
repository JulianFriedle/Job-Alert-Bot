import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { fileURLToPath } from 'url';

const NOTIFICATION_DELAY_MS = 1000;
const TELEGRAM_MAX_LEN = 4096;

// Trim a plain (un-escaped) string to `max` chars with an ellipsis. Done before
// escaping so the added backslashes can't be split mid-sequence.
function truncate(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [notifier] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let _bot = null;
function getBot() {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    _bot = new TelegramBot(token);
  }
  return _bot;
}

// Telegram is optional and resolved per client. It is "enabled" only when the
// operator's shared bot token is configured AND this client hasn't switched
// notifications off AND has a chat id. When disabled the pipeline silently skips
// sending — relevant jobs are still saved and visible in the web GUI.
export function isTelegramEnabled(client) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  if (!client) return false;
  if (String(client.telegram_notifications || '').trim().toLowerCase() === 'off') return false;
  return Boolean(client.telegram_chat_id);
}

function formatMessage(job, analysis) {
  // Bound the variable-length AI fields so a verbose analysis can't blow past
  // Telegram's 4096-char limit; the bullet list is capped too.
  const bullet = (items, max, fallback) =>
    (items || []).slice(0, 6).map(x => `• ${escapeMarkdown(truncate(x, max))}`).join('\n') || fallback;
  const reasons = bullet(analysis.reasons, 200, '• N/A');
  const concerns = bullet(analysis.concerns, 200, '• None');

  const message = [
    `🆕 *New Job Match\\!*`,
    ``,
    `💼 ${escapeMarkdown(truncate(job.title || 'N/A', 200))}`,
    `🏢 ${escapeMarkdown(truncate(job.company || 'N/A', 120))}`,
    `📍 ${escapeMarkdown(truncate(job.location || 'N/A', 120))}`,
    `⭐ Match Score: *${analysis.score}/10*`,
    ``,
    `✅ *Why it fits:*`,
    reasons,
    ``,
    `⚠️ *Concerns:*`,
    concerns,
    ``,
    `💬 ${escapeMarkdown(truncate(analysis.summary || '', 600))}`,
    ``,
    `🔗 [Apply here](${escapeMarkdownUrl(job.url)})`,
    ``,
    `🆔 ID: \`${job.id}\``,
  ].join('\n');

  return clampToTelegramLimit(message);
}

// Last-resort guard: if a message is still over the limit, drop whole trailing
// lines (each line is self-contained markdown, so this can't break a span) until
// it fits. Keeps the structural header intact even in pathological cases.
function clampToTelegramLimit(message) {
  if (message.length <= TELEGRAM_MAX_LEN) return message;
  const lines = message.split('\n');
  while (lines.length > 1 && lines.join('\n').length > TELEGRAM_MAX_LEN) lines.pop();
  return lines.join('\n');
}

// Escape special MarkdownV2 characters
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Inside a MarkdownV2 link destination `[text](url)` only ')' and '\' are
// special and must be escaped — escaping the others would corrupt the URL.
function escapeMarkdownUrl(url) {
  return String(url).replace(/[)\\]/g, '\\$&');
}

export async function notify(job, analysis, client) {
  const chatId = client?.telegram_chat_id;
  if (!chatId) throw new Error('telegram_chat_id is not set for this client');

  const bot = getBot();
  const message = formatMessage(job, analysis);

  await bot.sendMessage(chatId, message, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: false,
  });

  log(`Notified ${client.name}: ${job.title} @ ${job.company || 'unknown'} (score ${analysis.score})`);
}

// Send a one-off test message to a chat id using the shared bot token. Used by
// the client management UI to verify a client's Telegram chat id.
export async function sendTelegramTest(chatId) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN ist nicht gesetzt (globale Einstellung).');
  if (!chatId) throw new Error('Keine Telegram Chat-ID angegeben.');
  const bot = getBot();
  await bot.sendMessage(chatId, '✅ Job\\-Alert Test: Benachrichtigungen funktionieren\\.', { parse_mode: 'MarkdownV2' });
}

export async function notifyExpired(job, client) {
  if (!isTelegramEnabled(client)) return false;
  const chatId = client.telegram_chat_id;
  const bot = getBot();
  const message = [
    `❌ *Stelle nicht mehr ausgeschrieben*`,
    ``,
    `💼 ${escapeMarkdown(job.title || 'N/A')}`,
    `🏢 ${escapeMarkdown(job.source || 'N/A')}`,
    `📍 ${escapeMarkdown(job.location || '')}`,
    `⭐ Score war: *${job.score ?? '?'}/10*`,
    ``,
    `🔗 [Zum Stellenangebot](${escapeMarkdownUrl(job.url)})`,
  ].join('\n');
  await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  log(`Expired notification: ${job.title} @ ${job.source}`);
}

// Returns the jobs that were actually sent, so the caller only marks those as
// notified — a failed send stays unnotified and is retried on the next run.
export async function notifyBatch(jobAnalysisPairs, client) {
  if (!isTelegramEnabled(client)) {
    if (jobAnalysisPairs.length) log(`Telegram disabled — skipping ${jobAnalysisPairs.length} notification(s).`);
    return [];
  }
  const sentJobs = [];
  for (let i = 0; i < jobAnalysisPairs.length; i++) {
    const { job, analysis } = jobAnalysisPairs[i];
    try {
      await notify(job, analysis, client);
      sentJobs.push(job);
    } catch (err) {
      log(`Failed to notify for "${job.title}": ${err.message}`);
    }
    if (i < jobAnalysisPairs.length - 1) await sleep(NOTIFICATION_DELAY_MS);
  }
  return sentJobs;
}

// Allow direct execution for testing
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--test')) {
  const testJob = {
    title: 'Senior Software Engineer',
    company: 'Acme Corp',
    location: 'Stuttgart / Remote',
    url: 'https://example.com/jobs/123',
  };
  const testAnalysis = {
    score: 9,
    reasons: ['Strong JavaScript/Node.js match', 'Remote-friendly position'],
    concerns: ['Requires 7+ years experience'],
    summary: 'Excellent match for your skills and location preferences.',
  };

  // For the CLI smoke test, target the chat id from the env (operator's own chat).
  const testClient = { name: 'CLI-Test', telegram_chat_id: process.env.TELEGRAM_CHAT_ID };
  console.log('Sending test notification...');
  try {
    await notify(testJob, testAnalysis, testClient);
    console.log('Test notification sent successfully!');
  } catch (err) {
    console.error('Failed to send test notification:', err.message);
    process.exit(1);
  }
}
