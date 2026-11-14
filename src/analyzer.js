import './env.js';
import Anthropic from '@anthropic-ai/sdk';
import { getClientConfig } from './client-config.js';
import { analyzerLanguageLine } from './prompts.js';
import { analyzerModel } from './models.js';

const DEFAULT_MIN_RELEVANCE_SCORE = Number(process.env.MIN_RELEVANCE_SCORE) || 4;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [analyzer] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// The scheduler is a long-lived process: report a missing model once while it
// stays missing, but again after it worked in between or the setting changed.
let reportedMissingModel = null;
function reportMissingModel(model, err) {
  if (reportedMissingModel === model) return;
  reportedMissingModel = model;
  log(`FEHLER: Modell "${model}" ist bei Anthropic nicht verfügbar (${err.message}). ` +
      'Bitte ANALYZER_MODEL unter Einstellungen → KI-Modelle prüfen — bis dahin bleiben alle Stellen unbewertet.');
}
// A 404 from the Messages API means an unknown model. Anything else answering
// 404 (a wrong ANTHROPIC_BASE_URL, a proxy) takes the normal retry path.
const isModelNotFound = (err) => err?.status === 404 && err?.error?.error?.type === 'not_found_error';

function buildProfileBlock(profile) {
  return `Candidate Profile\n${JSON.stringify(profile)}`;
}

// `instructions` is the (editable) scoring guidance; the JSON contract below is
// fixed so parsing never breaks regardless of what the user customizes.
function buildJobBlock(job, instructions, languageLine = '') {
  return `\nJob Posting
Title: ${job.title || 'N/A'}
Company: ${job.company || 'N/A'}
Location: ${job.location || 'N/A'}
Description: ${(job.description || 'N/A').slice(0, 4000)}

${instructions}${languageLine ? `\n\n${languageLine}` : ''}

Task
Respond with this exact JSON structure:
{
  "relevant": true/false,
  "score": 1-10,
  "reasons": ["reason1", "reason2"],
  "concerns": ["concern1"],
  "summary": "One sentence why or why not"
}`;
}

// `cfg` carries the resolved per-client { profile, prompts, minRelevanceScore }.
// When omitted, it is resolved from the job's client_id (single-call convenience).
export async function analyzeJob(job, cfg) {
  if (!cfg) cfg = getClientConfig(job.client_id || 'default');
  const { profile, prompts } = cfg;
  const minScore = cfg.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE;
  const client = getClient();
  const model = analyzerModel();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        // Caps thinking and the JSON answer together. Current models think by
        // default before answering, and a cut-off answer can't be parsed, so
        // leave ample headroom — only the tokens actually produced are billed.
        max_tokens: 4000,
        system: [{ type: 'text', text: prompts.analyzerSystem, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildProfileBlock(profile), cache_control: { type: 'ephemeral' } },
              { type: 'text', text: buildJobBlock(job, prompts.analyzerInstructions, analyzerLanguageLine(profile)) },
            ],
          },
        ],
      });

      // A truncated response can never parse — retrying (this run or the next)
      // fails identically forever and burns 3 API calls per run per job.
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Antwort bei max_tokens abgeschnitten — JSON unvollständig');
      }
      // Never index content[0]: models with thinking enabled put a thinking block
      // first, so [0].text is undefined and the parse below fails on every job.
      const text = response.content.find(b => b.type === 'text')?.text || '';

      // Strip markdown code fences if present
      const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const result = JSON.parse(jsonText);
      reportedMissingModel = null;

      // Normalize the score: the model may emit a float or garbage, and raw
      // values flow into SQL, the GUI and MarkdownV2 messages downstream.
      const score = Number.isFinite(Number(result.score))
        ? Math.min(10, Math.max(0, Math.round(Number(result.score))))
        : null;

      return {
        relevant: result.relevant === true && score != null && score >= minScore,
        score,
        reasons: result.reasons || [],
        concerns: result.concerns || [],
        summary: result.summary || '',
        raw: result,
      };
    } catch (err) {
      // An unknown model ID fails identically for every job and every retry.
      // Say so once, plainly, instead of three cryptic lines per job.
      if (isModelNotFound(err)) {
        reportMissingModel(model, err);
        return null;
      }
      const isRateLimit = err.status === 429 || err.message?.includes('rate_limit');
      log(`Attempt ${attempt}/${MAX_RETRIES} failed for job "${job.title}": ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const wait = isRateLimit ? 60000 : RETRY_DELAY_MS * attempt;
        if (isRateLimit) log(`  Rate limit — waiting 60s before retry...`);
        await sleep(wait);
      } else {
        log(`All retries exhausted for job "${job.title}"`);
        return null;
      }
    }
  }
}
