// Telegram inbound routing with fake update objects and a fake bot.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-tg-')), 'test.db');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/database.js');
const { _test } = await import('../src/telegram-bot.js');

const CHAT = '555001';

// The default client is the known chat.
db.updateClient('default', { telegram_chat_id: CHAT, telegram_notifications: 'on' });

function fakeBot() {
  const sent = [];
  let nextId = 1000;
  return {
    sent,
    async sendMessage(chatId, text, opts) {
      sent.push({ chatId, text, opts });
      return { message_id: nextId++ };
    },
    async answerCallbackQuery() { return true; },
  };
}

function seedJob(id, title) {
  db.saveJob('default', { id, title, company: 'ACME', url: `https://x/${id}`, platform: 'stepstone', easyApply: 1 });
}

test('emoji reaction on a job notification sets the status', async () => {
  seedJob('tg-job-1', 'Testjob');
  db.recordTelegramMessage(CHAT, 7001, 'default', 'tg-job-1', 'notification');
  const bot = fakeBot();

  await _test.handleReaction(bot, {
    chat: { id: CHAT }, message_id: 7001,
    new_reaction: [{ type: 'emoji', emoji: '👍' }], old_reaction: [],
  });
  assert.equal(db.getJobById('default', 'tg-job-1').status, 'applied');

  await _test.handleReaction(bot, {
    chat: { id: CHAT }, message_id: 7001,
    new_reaction: [{ type: 'emoji', emoji: '👎' }], old_reaction: [],
  });
  assert.equal(db.getJobById('default', 'tg-job-1').status, 'rejected');
  assert.equal(bot.sent.length, 2, 'confirmation message per status change');
});

test('reaction on an unknown message is ignored', async () => {
  const bot = fakeBot();
  await _test.handleReaction(bot, {
    chat: { id: CHAT }, message_id: 9999,
    new_reaction: [{ type: 'emoji', emoji: '👍' }],
  });
  assert.equal(bot.sent.length, 0);
});

test('text reply "absage" on a job notification sets rejected', async () => {
  seedJob('tg-job-2', 'Zweiter Job');
  db.recordTelegramMessage(CHAT, 7002, 'default', 'tg-job-2', 'notification');
  const bot = fakeBot();

  await _test.handleMessage(bot, {
    chat: { id: Number(CHAT) }, text: 'Absage',
    reply_to_message: { message_id: 7002 },
  });
  assert.equal(db.getJobById('default', 'tg-job-2').status, 'rejected');
});

test('unknown chat is ignored entirely', async () => {
  const bot = fakeBot();
  await _test.handleMessage(bot, { chat: { id: 424242 }, text: 'beworben', reply_to_message: { message_id: 1 } });
  assert.equal(bot.sent.length, 0);
});

test('question reply flow: answer lands on the application, last answer → ready_for_review', async () => {
  seedJob('tg-job-3', 'Fragen-Job');
  const app = db.createApplication('default', 'tg-job-3', 'stepstone');
  const questions = [
    { id: 'q1', label: 'Gehalt?', type: 'text', options: null, required: true, answer: null, answeredVia: null },
    { id: 'q2', label: 'Start?', type: 'select', options: ['sofort', 'in 3 Monaten'], required: true, answer: null, answeredVia: null },
  ];
  db.updateApplication(app.id, { questions_json: JSON.stringify(questions) });
  db.claimApplication(app.id, 'queued', 'preparing');
  db.claimApplication(app.id, 'preparing', 'awaiting_answers');
  db.recordTelegramPrompt(CHAT, 8001, app.id, 'q1');

  const bot = fakeBot();

  // Answer q1 by replying to its prompt → q2 goes out next.
  await _test.handleMessage(bot, {
    chat: { id: Number(CHAT) }, text: '55000',
    reply_to_message: { message_id: 8001 },
  });
  let row = db.getApplicationById(app.id);
  let qs = JSON.parse(row.questions_json);
  assert.equal(qs[0].answer, '55000');
  assert.equal(qs[0].answeredVia, 'telegram');
  assert.equal(row.state, 'awaiting_answers');
  assert.ok(bot.sent.length >= 1, 'next question was sent');

  // Invalid select answer → re-prompt, nothing stored.
  const prompts = db.getOpenTelegramPrompts(CHAT);
  assert.equal(prompts.length, 1);
  const q2Prompt = prompts[0];
  const beforeCount = bot.sent.length;
  await _test.handleMessage(bot, {
    chat: { id: Number(CHAT) }, text: 'irgendwann',
    reply_to_message: { message_id: q2Prompt.message_id },
  });
  qs = JSON.parse(db.getApplicationById(app.id).questions_json);
  assert.equal(qs[1].answer, null);
  assert.ok(bot.sent.length > beforeCount, 'hint with valid options sent');

  // The invalid reply must NOT consume the prompt: it stays open, and replying
  // to the SAME prompt with a valid option works without any re-send.
  assert.equal(db.getOpenTelegramPrompts(CHAT).length, 1, 'prompt still open after invalid answer');
  await _test.handleMessage(bot, {
    chat: { id: Number(CHAT) }, text: 'sofort',
    reply_to_message: { message_id: q2Prompt.message_id },
  });
  row = db.getApplicationById(app.id);
  qs = JSON.parse(row.questions_json);
  assert.equal(qs[1].answer, 'sofort');
  assert.equal(row.state, 'ready_for_review', 'all required answered → ready for review');
});

test('callback ✅ approves only from ready_for_review; second tap is a no-op', async () => {
  seedJob('tg-job-4', 'Approve-Job');
  const app = db.createApplication('default', 'tg-job-4', 'stepstone');
  db.claimApplication(app.id, 'queued', 'preparing');
  db.claimApplication(app.id, 'preparing', 'ready_for_review');
  const bot = fakeBot();

  await _test.handleCallback(bot, {
    id: 'cb1', data: `app:${app.id}:ok`,
    message: { chat: { id: Number(CHAT) } },
  });
  assert.equal(db.getApplicationById(app.id).state, 'approved');

  await _test.handleCallback(bot, {
    id: 'cb2', data: `app:${app.id}:ok`,
    message: { chat: { id: Number(CHAT) } },
  });
  assert.equal(db.getApplicationById(app.id).state, 'approved', 'second tap does not double-approve');
});

test('callback ❌ discards and closes prompts', async () => {
  seedJob('tg-job-5', 'Discard-Job');
  const app = db.createApplication('default', 'tg-job-5', 'stepstone');
  db.recordTelegramPrompt(CHAT, 8100, app.id, 'q1');
  const bot = fakeBot();
  await _test.handleCallback(bot, {
    id: 'cb3', data: `app:${app.id}:no`,
    message: { chat: { id: Number(CHAT) } },
  });
  assert.equal(db.getApplicationById(app.id).state, 'discarded');
  assert.equal(db.getOpenTelegramPrompts(CHAT).filter(p => p.application_id === app.id).length, 0);
});

test('callback from a foreign chat is rejected', async () => {
  seedJob('tg-job-6', 'Fremd-Job');
  const app = db.createApplication('default', 'tg-job-6', 'stepstone');
  db.claimApplication(app.id, 'queued', 'preparing');
  db.claimApplication(app.id, 'preparing', 'ready_for_review');
  const bot = fakeBot();
  await _test.handleCallback(bot, {
    id: 'cb4', data: `app:${app.id}:ok`,
    message: { chat: { id: 999999 } },
  });
  assert.equal(db.getApplicationById(app.id).state, 'ready_for_review', 'not approved from unknown chat');
});
