import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPrompts } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, '..', 'config', 'profile.json');
const MODEL = process.env.ANALYZER_MODEL || 'claude-haiku-4-5-20251001';
const MIN_RELEVANCE_SCORE = Number(process.env.MIN_RELEVANCE_SCORE) || 4;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [analyzer] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let _profile = null;
async function getProfile() {
  if (!_profile) {
    _profile = JSON.parse(await readFile(PROFILE_PATH, 'utf-8'));
  }
  return _profile;
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

export async function analyzeJob(job) {
  const profile = await getProfile();
  const client = getClient();
  const prompts = loadPrompts();   // read fresh so GUI edits apply without restart

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 800,
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

      const text = response.content[0]?.text || '';

      // Strip markdown code fences if present
      const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const result = JSON.parse(jsonText);

      return {
        relevant: result.relevant === true && Number(result.score) >= MIN_RELEVANCE_SCORE,
        score: result.score,
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

export async function analyzeJobs(jobs) {
  const results = [];
  for (const job of jobs) {
    log(`Analyzing: ${job.title} @ ${job.company || 'unknown'}`);
    const analysis = await analyzeJob(job);
    results.push({ job, analysis });
    // Small delay to avoid API rate limits
    await sleep(500);
  }
  return results;
}
