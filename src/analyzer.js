import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getClientConfig } from './client-config.js';

const MODEL = () => process.env.ANALYZER_MODEL || 'claude-haiku-4-5-20251001';
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

function buildProfileBlock(profile) {
  return `Candidate Profile\n${JSON.stringify(profile)}`;
}

// `instructions` is the (editable) scoring guidance; the JSON contract below is
// fixed so parsing never breaks regardless of what the user customizes.
function buildJobBlock(job, instructions) {
  return `\nJob Posting
Title: ${job.title || 'N/A'}
Company: ${job.company || 'N/A'}
Location: ${job.location || 'N/A'}
Description: ${(job.description || 'N/A').slice(0, 4000)}

${instructions}

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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL(),
        max_tokens: 1500,
        system: [{ type: 'text', text: prompts.analyzerSystem, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildProfileBlock(profile), cache_control: { type: 'ephemeral' } },
              { type: 'text', text: buildJobBlock(job, prompts.analyzerInstructions) },
            ],
          },
        ],
      });

      // A truncated response can never parse — retrying (this run or the next)
      // fails identically forever and burns 3 API calls per run per job.
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Antwort bei max_tokens abgeschnitten — JSON unvollständig');
      }
      const text = response.content[0]?.text || '';

      // Strip markdown code fences if present
      const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const result = JSON.parse(jsonText);

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
