/**
 * competitor-scan.js — Daily LeapSpace competitor scan
 * Calls the Claude API (web search tool) to research new AI solutions that
 * compete with Elsevier LeapSpace, and appends genuinely new findings to
 * data/leapspace-competitors.json. Entries are marked autoDiscovered: true
 * so the UI can flag them as not yet manually reviewed.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 * Run: node scripts/competitor-scan.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DATA_FILE = 'data/leapspace-competitors.json';
const STATE_FILE = 'data/competitor-scan-state.json';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';

const VALID_ELEMENTS = new Set([
  'literatureSearch', 'authorSearch', 'fundingDiscovery', 'writingCoach',
  'trustClaimRadar', 'deepResearchReports', 'readingAssistant', 'compareFeature',
]);

const LEAPSPACE_CONTEXT = `LeapSpace is Elsevier's AI-assisted research workspace (launched Nov 2025), combining agentic AI, generative AI and retrieval-augmented generation over ScienceDirect/Scopus content. It has 8 named tabs/features:
1. Literature Search & Discovery — AI search returning structured, referenced answers
2. Author Search — finds collaborators, mentors, topic contributors
3. Funding Discovery — active/recurring funding opportunities from government/private funders
4. Writing Coach — private drafting workspace that pressure-tests claims and arguments
5. Trust Cards & Claim Radar — checks how a claim aligns with its sources and the wider research landscape
6. Deep Research Reports — longer-form analyses surfacing patterns, contradictions and evidence gaps
7. Reading Assistant — conversational Q&A grounded in one specific article or book chapter
8. Compare — side-by-side tables breaking down papers by goals, methods and results`;

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(company, product) {
  const slug = (company + '-' + product).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return 'auto-' + slug;
}
function extractText(response) {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function parseJSONL(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { items.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
  }
  return items;
}

async function callClaude(existingProducts) {
  const prompt = `${LEAPSPACE_CONTEXT}

Search the web for AI-powered research tools/products (launched, updated, or newly relevant in roughly the last 30 days) that compete with one or more of LeapSpace's tabs above. Real competitors only — established companies or credible new launches, not speculative or unrelated tools.

Already-tracked products (do not repeat these unless reporting a significant new feature under a distinct product name):
${existingProducts.map(p => `- ${p.company}: ${p.product}`).join('\n') || '(none yet)'}

For each new competing solution you find, respond with one JSON object per line (JSONL), each with exactly these fields:
{"company": "...", "product": "...", "elements": ["literatureSearch"|"authorSearch"|"fundingDiscovery"|"writingCoach"|"trustClaimRadar"|"deepResearchReports"|"readingAssistant"|"compareFeature", ...], "howItCompetes": "2-4 factual sentences on what it does and which LeapSpace tab(s) it challenges", "sourceUrl": "...", "sourceName": "..."}

If you find nothing genuinely new and relevant, output nothing at all. Only report what your search actually surfaces with a verifiable source URL — never invent a product or a source.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  if (!API_KEY) {
    // Not configured yet — log clearly but don't fail the workflow run over it.
    console.log('[competitor-scan] ANTHROPIC_API_KEY not set — skipping scan until it is configured.');
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: 'missing_api_key' });
    return;
  }

  const competitors = readJSON(DATA_FILE, []);
  const existingIds = new Set(competitors.map(c => c.id));

  console.log('[competitor-scan] Calling Claude with web search...');
  const response = await callClaude(competitors);

  if (response.stop_reason === 'refusal') {
    console.log('[competitor-scan] Request was declined by safety classifiers — no results this run.');
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, refused: true });
    return;
  }

  const text = extractText(response);
  const found = parseJSONL(text);
  console.log(`[competitor-scan] Model returned ${found.length} candidate(s).`);

  let added = 0;
  for (const item of found) {
    if (!item.company || !item.product || !item.sourceUrl) continue;
    const id = makeId(item.company, item.product);
    if (existingIds.has(id)) continue;
    const elements = Array.isArray(item.elements) ? item.elements.filter(e => VALID_ELEMENTS.has(e)) : [];
    competitors.push({
      id,
      company: String(item.company).slice(0, 120),
      product: String(item.product).slice(0, 200),
      addedDate: new Date().toISOString().slice(0, 10),
      elements,
      howItCompetes: String(item.howItCompetes || '').slice(0, 800),
      sourceUrl: String(item.sourceUrl).slice(0, 500),
      sourceName: String(item.sourceName || item.company).slice(0, 150),
      autoDiscovered: true,
    });
    existingIds.add(id);
    added++;
    console.log(`  + ${item.company}: ${item.product}`);
  }

  if (added > 0) saveJSON(DATA_FILE, competitors);

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: added,
    lastCandidateCount: found.length,
  });
  console.log(`[competitor-scan] Done — ${added} new competitor(s) added.`);
}

main().catch(e => {
  console.error('[competitor-scan] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message });
  } catch { /* ignore */ }
  process.exit(1);
});
