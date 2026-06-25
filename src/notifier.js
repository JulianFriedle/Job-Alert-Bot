import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { fileURLToPath } from 'url';

const NOTIFICATION_DELAY_MS = 1000;

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
  const reasons = (analysis.reasons || []).map(r => `• ${escapeMarkdown(r)}`).join('\n') || '• N/A';
  const concerns = (analysis.concerns || []).map(c => `• ${escapeMarkdown(c)}`).join('\n') || '• None';

  return [
    `🆕 *New Job Match\\!*`,
    ``,
    `💼 ${escapeMarkdown(job.title || 'N/A')}`,
    `🏢 ${escapeMarkdown(job.company || 'N/A')}`,
    `📍 ${escapeMarkdown(job.location || 'N/A')}`,
    `⭐ Match Score: *${analysis.score}/10*`,
    ``,
    `✅ *Why it fits:*`,
    reasons,
    ``,
    `⚠️ *Concerns:*`,
    concerns,
    ``,
    `💬 ${escapeMarkdown(analysis.summary || '')}`,
    ``,
    `🔗 [Apply here](${job.url})`,
    ``,
    `🆔 ID: \`${job.id}\``,
  ].join('\n');
}

// Escape special MarkdownV2 characters
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
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
    `🔗 [Zum Stellenangebot](${job.url})`,
  ].join('\n');
  await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  log(`Expired notification: ${job.title} @ ${job.source}`);
}

export async function notifyBatch(jobAnalysisPairs, client) {
  if (!isTelegramEnabled(client)) {
    if (jobAnalysisPairs.length) log(`Telegram disabled — skipping ${jobAnalysisPairs.length} notification(s).`);
    return 0;
  }
  let sent = 0;
  for (const { job, analysis } of jobAnalysisPairs) {
    try {
      await notify(job, analysis, client);
      sent++;
      if (sent < jobAnalysisPairs.length) {
        await sleep(NOTIFICATION_DELAY_MS);
      }
    } catch (err) {
      log(`Failed to notify for "${job.title}": ${err.message}`);
    }
  }
  return sent;
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
