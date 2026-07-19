// Interactive Telegram bot — the ONLY process-wide getUpdates consumer (the
// notifier in src/notifier.js stays send-only; Telegram allows exactly one
// poller per token). Started from the scheduler process only.
//
// Responsibilities:
//  1. Q&A loop: relay unanswered screening questions, one at a time, and route
//     the replies back onto the application (ForceReply / reply keyboards).
//  2. Review & approve: send a summary of a prepared application with inline
//     buttons ✅ Bewerben / ✏️ Ändern / ❌ Verwerfen — the full flow works
//     without ever opening the GUI.
//  3. Status upkeep: an emoji reaction (👍/👎/🤝/🎉) or a text reply
//     (beworben/absage/interview/angebot) on a job notification sets the
//     job's application status.
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

import {
  getClients, getClient, getJobById, setApplicationStatus,
  getApplicationById, updateApplication, claimApplication,
  getTelegramMessage, recordTelegramMessage,
  getTelegramPrompt, getOpenTelegramPrompts, recordTelegramPrompt,
  markTelegramPromptAnswered, closeTelegramPromptsForApplication,
  logApplicationEvent,
} from './database.js';
import { isTelegramEnabled } from './notifier.js';
import { parseQuestions, applyAnswer, unansweredRequired } from './questions.js';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [telegram-bot] ${msg}`);
}

// MarkdownV2 escaping (same rules as notifier.js).
function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const REACTION_STATUS = {
  '👍': 'applied',
  '👎': 'rejected',
  '🤝': 'interview',
  '🎉': 'offer',
};
const TEXT_STATUS = [
  [/^\s*(beworben|applied)\s*$/i, 'applied'],
  [/^\s*(absage|abgelehnt|rejected)\s*$/i, 'rejected'],
  [/^\s*interview\s*$/i, 'interview'],
  [/^\s*(angebot|offer)\s*$/i, 'offer'],
];
const STATUS_LABELS = { applied: 'Beworben ✅', interview: 'Interview 🤝', offer: 'Angebot 🎉', rejected: 'Absage ❌' };

let bot = null;

export function isBotRunning() {
  return Boolean(bot);
}

function getSendBot() {
  // Falls back to a send-only instance when polling isn't started (e.g. a
  // one-off `--once` run) so review/question messages still go out.
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramBot(token);
}

function clientForChat(chatId) {
  const idStr = String(chatId);
  return getClients().find(c => String(c.telegram_chat_id || '') === idStr) || null;
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export async function sendInfoToClient(client, text) {
  if (!isTelegramEnabled(client)) return false;
  const b = getSendBot();
  if (!b) return false;
  await b.sendMessage(client.telegram_chat_id, esc(text), { parse_mode: 'MarkdownV2' });
  return true;
}

// Send the next unanswered required question of an application (one at a
// time). Returns true when a question went out, false when none are left.
// `botOverride` lets inbound handlers (and tests) reuse their bot instance.
export async function sendNextQuestion(applicationId, botOverride = null) {
  const app = getApplicationById(applicationId);
  if (!app) return false;
  const client = getClient(app.client_id);
  if (!isTelegramEnabled(client)) return false;
  const b = botOverride || getSendBot();
  if (!b) return false;

  const questions = parseQuestions(app.questions_json);
  const open = unansweredRequired(questions);
  if (open.length === 0) return false;
  const q = open[0];
  const job = getJobById(app.client_id, app.job_id);

  const header = `❓ *Frage zur Bewerbung*\n💼 ${esc(job?.title || '')}\n\n${esc(q.label)}`;
  const opts = { parse_mode: 'MarkdownV2' };
  if ((q.type === 'select' || q.type === 'radio') && Array.isArray(q.options) && q.options.length) {
    opts.reply_markup = {
      keyboard: q.options.map(o => [{ text: String(o) }]),
      one_time_keyboard: true,
      resize_keyboard: true,
      force_reply: true,
      input_field_placeholder: 'Antwort wählen…',
    };
  } else {
    opts.reply_markup = { force_reply: true, input_field_placeholder: 'Antwort eingeben…' };
  }

  const sent = await b.sendMessage(client.telegram_chat_id, header, opts);
  recordTelegramPrompt(client.telegram_chat_id, sent.message_id, app.id, q.id);
  log(`Frage "${q.label}" → ${client.name} (App ${app.id.slice(0, 8)})`);
  return true;
}

// Review summary with the approve/edit/discard inline keyboard.
export async function sendReviewSummary(applicationId, botOverride = null) {
  const app = getApplicationById(applicationId);
  if (!app) return false;
  const client = getClient(app.client_id);
  if (!isTelegramEnabled(client)) return false;
  const b = botOverride || getSendBot();
  if (!b) return false;

  const job = getJobById(app.client_id, app.job_id);
  const questions = parseQuestions(app.questions_json);
  const answered = questions.filter(q => q.answer != null && String(q.answer).trim() !== '');

  const lines = [
    `📋 *Bewerbung bereit zur Freigabe*`,
    ``,
    `💼 ${esc(job?.title || '')}`,
    `🏢 ${esc(job?.company || job?.source || '')}`,
    `🌐 ${esc(app.platform)}`,
  ];
  if (answered.length) {
    lines.push(``, `*Antworten:*`);
    for (const q of answered.slice(0, 10)) {
      const via = q.answeredVia === 'library' ? ' \\(gemerkt\\)' : '';
      lines.push(`• ${esc(q.label)}: *${esc(q.answer)}*${via}`);
    }
  }
  if (app.cover_letter) {
    lines.push(``, `📝 *Anschreiben \\(Auszug\\):*`, esc(String(app.cover_letter).slice(0, 400) + '…'));
  }

  const sent = await b.sendMessage(client.telegram_chat_id, lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Bewerben', callback_data: `app:${app.id}:ok` },
        { text: '✏️ Ändern', callback_data: `app:${app.id}:edit` },
        { text: '❌ Verwerfen', callback_data: `app:${app.id}:no` },
      ]],
    },
  });
  recordTelegramMessage(client.telegram_chat_id, sent.message_id, app.client_id, app.job_id, 'review');
  return true;
}

// ── Inbound handling ─────────────────────────────────────────────────────────

async function handleAnswer(b, client, app, questionId, text, replyChatId) {
  const questions = parseQuestions(app.questions_json);
  const ok = applyAnswer(questions, questionId, text, 'telegram');
  if (!ok) {
    const q = questions.find(x => x.id === questionId);
    const hint = q && Array.isArray(q.options) && q.options.length
      ? `Bitte eine der Optionen wählen: ${q.options.join(' | ')}`
      : 'Antwort konnte nicht übernommen werden.';
    await b.sendMessage(replyChatId, esc(`⚠️ ${hint}`), { parse_mode: 'MarkdownV2' });
    return;
  }
  updateApplication(app.id, { questions_json: JSON.stringify(questions) });
  logApplicationEvent(app.id, 'answer_received', `${questionId} via telegram`);

  const remaining = unansweredRequired(questions);
  if (remaining.length > 0 && app.state === 'awaiting_answers') {
    await sendNextQuestion(app.id, b);
    return;
  }
  await b.sendMessage(replyChatId, esc('✔️ Antwort gespeichert.'), {
    parse_mode: 'MarkdownV2',
    reply_markup: { remove_keyboard: true },
  });
  if (app.state === 'awaiting_answers' && remaining.length === 0) {
    closeTelegramPromptsForApplication(app.id);
    if (claimApplication(app.id, 'awaiting_answers', 'ready_for_review')) {
      await sendReviewSummary(app.id, b);
    }
  } else if (app.state === 'ready_for_review') {
    // Edit round: show the refreshed summary after each change.
    await sendReviewSummary(app.id, b);
  }
}

async function handleMessage(b, msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  const client = clientForChat(chatId);
  if (!client) return; // unknown chat — ignore silently

  // Commands
  if (/^\/abbrechen\b/i.test(text)) {
    const prompts = getOpenTelegramPrompts(chatId);
    if (prompts.length) {
      const app = getApplicationById(prompts[0].application_id);
      if (app) {
        ['queued', 'preparing', 'awaiting_answers', 'ready_for_review', 'approved'].some(s => claimApplication(app.id, s, 'discarded'));
        closeTelegramPromptsForApplication(app.id);
        logApplicationEvent(app.id, 'discarded', 'via telegram /abbrechen');
        await b.sendMessage(chatId, esc('❌ Bewerbung verworfen.'), { parse_mode: 'MarkdownV2', reply_markup: { remove_keyboard: true } });
      }
    }
    return;
  }
  if (/^\/skip\b/i.test(text)) {
    await b.sendMessage(chatId, esc('⏭ Übersprungen — die Frage bleibt offen und kann im GUI beantwortet werden.'), { parse_mode: 'MarkdownV2', reply_markup: { remove_keyboard: true } });
    return;
  }

  // 1. Reply to a question prompt?
  if (msg.reply_to_message) {
    const prompt = getTelegramPrompt(chatId, msg.reply_to_message.message_id);
    if (prompt && !prompt.answered) {
      const app = getApplicationById(prompt.application_id);
      if (app) {
        markTelegramPromptAnswered(chatId, msg.reply_to_message.message_id);
        await handleAnswer(b, client, app, prompt.question_id, text, chatId);
      }
      return;
    }
    // 2. Reply to a job notification → status keyword
    const ref = getTelegramMessage(chatId, msg.reply_to_message.message_id);
    if (ref) {
      for (const [re, status] of TEXT_STATUS) {
        if (re.test(text)) {
          setApplicationStatus(ref.client_id, ref.job_id, status);
          const job = getJobById(ref.client_id, ref.job_id);
          await b.sendMessage(chatId, esc(`${STATUS_LABELS[status]} — "${job?.title || ref.job_id}"`), { parse_mode: 'MarkdownV2' });
          log(`Status "${status}" via Telegram-Reply für Job ${ref.job_id} (${client.name})`);
          return;
        }
      }
      await b.sendMessage(chatId, esc('Verstanden habe ich das nicht. Status setzen mit: beworben, absage, interview oder angebot.'), { parse_mode: 'MarkdownV2' });
      return;
    }
  }

  // 3. No reply context: exactly one open prompt → treat as its answer.
  const open = getOpenTelegramPrompts(chatId);
  if (open.length === 1) {
    const app = getApplicationById(open[0].application_id);
    if (app) {
      markTelegramPromptAnswered(chatId, open[0].message_id);
      await handleAnswer(b, client, app, open[0].question_id, text, chatId);
    }
    return;
  }
  if (open.length > 1) {
    await b.sendMessage(chatId, esc('Bitte direkt auf die jeweilige Frage antworten (Reply), es sind mehrere offen.'), { parse_mode: 'MarkdownV2' });
  }
}

async function handleReaction(b, reaction) {
  const chatId = reaction.chat?.id;
  const messageId = reaction.message_id;
  if (!chatId || !messageId) return;
  const ref = getTelegramMessage(chatId, messageId);
  if (!ref) return;

  const added = (reaction.new_reaction || [])
    .filter(r => r.type === 'emoji')
    .map(r => r.emoji);
  for (const emoji of added) {
    const status = REACTION_STATUS[emoji];
    if (!status) continue;
    setApplicationStatus(ref.client_id, ref.job_id, status);
    const job = getJobById(ref.client_id, ref.job_id);
    await b.sendMessage(chatId, esc(`${STATUS_LABELS[status]} — "${job?.title || ref.job_id}"`), { parse_mode: 'MarkdownV2' });
    log(`Status "${status}" via Reaktion ${emoji} für Job ${ref.job_id}`);
    return;
  }
}

async function handleCallback(b, query) {
  const data = String(query.data || '');
  const m = data.match(/^app:([^:]+):(ok|edit|no)$/);
  if (!m) return b.answerCallbackQuery(query.id).catch(() => {});
  const [, appId, action] = m;
  const app = getApplicationById(appId);
  const chatId = query.message?.chat?.id;
  if (!app || !chatId) return b.answerCallbackQuery(query.id, { text: 'Nicht gefunden.' }).catch(() => {});
  const client = clientForChat(chatId);
  if (!client || client.id !== app.client_id) {
    return b.answerCallbackQuery(query.id, { text: 'Nicht berechtigt.' }).catch(() => {});
  }

  if (action === 'ok') {
    if (claimApplication(app.id, 'ready_for_review', 'approved')) {
      updateApplication(app.id, { approved_at: new Date().toISOString() });
      logApplicationEvent(app.id, 'approved', 'via telegram');
      await b.answerCallbackQuery(query.id, { text: 'Freigegeben ✅' }).catch(() => {});
      await b.sendMessage(chatId, esc('✅ Freigegeben — die Bewerbung wird in Kürze versendet.'), { parse_mode: 'MarkdownV2' });
    } else {
      await b.answerCallbackQuery(query.id, { text: `Bereits erledigt (${getApplicationById(app.id).state}).` }).catch(() => {});
    }
  } else if (action === 'no') {
    const ok = ['ready_for_review', 'approved', 'awaiting_answers', 'queued', 'failed'].some(s => claimApplication(app.id, s, 'discarded'));
    closeTelegramPromptsForApplication(app.id);
    if (ok) logApplicationEvent(app.id, 'discarded', 'via telegram');
    await b.answerCallbackQuery(query.id, { text: ok ? 'Verworfen ❌' : 'Bereits erledigt.' }).catch(() => {});
    if (ok) await b.sendMessage(chatId, esc('❌ Bewerbung verworfen.'), { parse_mode: 'MarkdownV2' });
  } else if (action === 'edit') {
    // Re-ask every question (current answers stay as defaults until overwritten).
    const questions = parseQuestions(app.questions_json);
    if (!questions.length) {
      await b.answerCallbackQuery(query.id, { text: 'Keine Fragen vorhanden — Anschreiben im GUI ändern.' }).catch(() => {});
      return;
    }
    await b.answerCallbackQuery(query.id).catch(() => {});
    for (const q of questions) {
      const current = q.answer != null && String(q.answer).trim() !== '' ? `\n(aktuell: ${q.answer})` : '';
      const opts = { parse_mode: 'MarkdownV2' };
      if ((q.type === 'select' || q.type === 'radio') && Array.isArray(q.options) && q.options.length) {
        opts.reply_markup = { keyboard: q.options.map(o => [{ text: String(o) }]), one_time_keyboard: true, resize_keyboard: true };
      } else {
        opts.reply_markup = { force_reply: true };
      }
      const sent = await b.sendMessage(chatId, esc(`✏️ ${q.label}${current}`), opts);
      recordTelegramPrompt(chatId, sent.message_id, app.id, q.id);
    }
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log('TELEGRAM_BOT_TOKEN nicht gesetzt — interaktiver Bot bleibt aus.');
    return null;
  }
  if (bot) return bot;

  bot = new TelegramBot(token, {
    polling: {
      autoStart: true,
      params: {
        // Reactions arrive only when explicitly requested.
        allowed_updates: JSON.stringify(['message', 'message_reaction', 'callback_query']),
      },
    },
  });

  bot.on('message', (msg) => handleMessage(bot, msg).catch(err => log(`message-Handler: ${err.message}`)));
  bot.on('message_reaction', (r) => handleReaction(bot, r).catch(err => log(`reaction-Handler: ${err.message}`)));
  bot.on('callback_query', (q) => handleCallback(bot, q).catch(err => log(`callback-Handler: ${err.message}`)));
  bot.on('polling_error', (err) => log(`polling_error: ${err.message}`));

  log('Interaktiver Telegram-Bot gestartet (polling).');
  return bot;
}

// Exposed for unit tests (fed with fake bot + fake update objects).
export const _test = { handleMessage, handleReaction, handleCallback, REACTION_STATUS, TEXT_STATUS };
