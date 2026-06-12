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

// Telegram is optional. It is "enabled" only when not explicitly switched off AND
// both credentials are present. When disabled, the pipeline silently skips sending
// — relevant jobs are still saved and visible in the web GUI.
export function isTelegramEnabled() {
  if (String(process.env.TELEGRAM_NOTIFICATIONS || '').trim().toLowerCase() === 'off') return false;
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
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

export async function notify(job, analysis) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set');

  const bot = getBot();
  const message = formatMessage(job, analysis);

  await bot.sendMessage(chatId, message, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: false,
  });

  log(`Notified: ${job.title} @ ${job.company || 'unknown'} (score ${analysis.score})`);
}

export async function notifyExpired(job) {
  if (!isTelegramEnabled()) return false;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set');
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

export async function notifyBatch(jobAnalysisPairs) {
  if (!isTelegramEnabled()) {
    if (jobAnalysisPairs.length) log(`Telegram disabled — skipping ${jobAnalysisPairs.length} notification(s).`);
    return 0;
  }
  let sent = 0;
  for (const { job, analysis } of jobAnalysisPairs) {
    try {
      await notify(job, analysis);
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

  console.log('Sending test notification...');
  try {
    await notify(testJob, testAnalysis);
    console.log('Test notification sent successfully!');
  } catch (err) {
    console.error('Failed to send test notification:', err.message);
    process.exit(1);
  }
}
