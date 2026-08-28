/**
 * news-scan.js — Daily Denmark research news scan for Elsevier's
 * competitive/business interests specifically (not general science news).
 *
 * Two stages:
 * 1. Free discovery: queries Google News RSS per institution/category,
 *    keyword-filtered against tracked SEED_INSTITUTIONS, with query terms
 *    scoped to research-information/scholarly-publishing/AI-for-research
 *    topics rather than any AI or funding mention. A fourth category runs
 *    the same discovery per named LeapSpace competitor (TRACKED_COMPETITORS)
 *    instead of per institution, surfacing competitor product launches,
 *    partnerships, and rollouts. Runs server-side
 *    (GitHub Actions) since a browser can't fetch news.google.com directly
 *    (CORS) without a proxy.
 * 2. Relevance filter: keyword matching alone still lets through stories
 *    that are topically AI/funding but irrelevant to Elsevier's business
 *    (e.g. an AI model for gambling-harm prediction, a childhood-cancer
 *    treatment grant) — a single batched Claude Haiku call judges each
 *    freshly-discovered candidate against Elsevier's actual business
 *    (scholarly publishing, research information, AI research tools,
 *    library/database subscriptions) and drops anything irrelevant, tagging
 *    keepers with a one-line "why it matters" note. Requires
 *    ANTHROPIC_API_KEY; skipped (keyword matches kept as-is) if unset, same
 *    fallback pattern as competitor-scan.js.
 *
 * Run: node scripts/news-scan.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DATA_FILE = 'data/news.json';
const STATE_FILE = 'data/news-scan-state.json';
const MAX_STORED_ARTICLES = 300;
const MAX_AGE_DAYS = 14;
const REQUEST_DELAY_MS = 350;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RELEVANCE_MODEL = 'claude-haiku-4-5';
const MAX_RELEVANCE_BATCH = 60;

const ELSEVIER_CONTEXT = `Elsevier is a scholarly research information and analytics company: ScienceDirect (full-text journal platform), Scopus (abstract/citation database), and LeapSpace (Elsevier's new AI-assisted research workspace — literature search, author search, funding discovery, writing coach, claim-checking, deep research reports, reading assistant, paper comparison). Its business depends on universities, medical centres, and research institutes subscribing to and using these tools, and on staying ahead of competitors like Clarivate/Web of Science, Digital Science/Dimensions, Springer Nature, Wiley, OpenAlex, Google Scholar, Semantic Scholar, and AI research-assistant tools (Elicit, scite, Consensus, SciSpace).`;

// Keep in sync with SEED_INSTITUTIONS in index.html
const DK_UNIVERSITIES = [
  'University of Copenhagen', 'Aarhus University',
  'Technical University of Denmark', 'University of Southern Denmark',
  'Aalborg University', 'Copenhagen Business School', 'Roskilde University',
  'IT University of Copenhagen',
];
const DK_MEDICAL = [
  'Rigshospitalet (Copenhagen University Hospital)',
  'Aarhus University Hospital', 'Odense University Hospital',
  'Copenhagen University Hospital – Herlev and Gentofte',
  'Aalborg University Hospital',
  'Copenhagen University Hospital – Bispebjerg and Frederiksberg',
  'Copenhagen University Hospital – Amager and Hvidovre',
  'Zealand University Hospital', 'Steno Diabetes Center Copenhagen',
  'Steno Diabetes Center Aarhus',
];
const DK_RESEARCH = [
  'Statens Serum Institut', 'Niels Bohr Institute',
  'Royal Danish Academy of Sciences and Letters',
  'Danish Meteorological Institute',
  'Geological Survey of Denmark and Greenland', 'Alexandra Institute',
  'Danish Technological Institute',
  'Novo Nordisk Foundation Center for Protein Research',
  'Novo Nordisk Foundation Center for Basic Metabolic Research',
  'Novo Nordisk Foundation Center for Stem Cell Medicine (reNEW)',
  'Interdisciplinary Nanoscience Center',
  'DTU Space – National Space Institute',
  'Danish Institute for International Studies',
  'VIVE – The Danish Center for Social Science Research',
  'Danish Institute for Advanced Study',
  'Novo Nordisk Foundation Center for Biosustainability',
  'National Institute of Public Health',
  'Aarhus Institute of Advanced Studies',
  'Pioneer Centre for Artificial Intelligence',
  'Rockwool Foundation Research Unit', 'BioInnovation Institute',
  'Novo Nordisk Foundation', 'Lundbeck Foundation', 'Carlsberg Foundation',
  'Villum Foundation', 'Danish Cancer Society',
  'Danish National Research Foundation',
];
const ALL_INSTITUTIONS = [...DK_UNIVERSITIES, ...DK_MEDICAL, ...DK_RESEARCH];

// Named LeapSpace competitors tracked on the Competitor Insights page —
// kept in sync manually with data/leapspace-competitors.json's company names.
const TRACKED_COMPETITORS = [
  'Clarivate', 'Digital Science', 'Springer Nature', 'Wiley', 'Elicit',
  'scite', 'Consensus', 'SciSpace', 'Paperguide',
  'IGI Global Scientific Publishing', 'IEEE', 'Allen Institute for AI',
  'Google', 'OpenAI', 'Anthropic',
];

const CATEGORIES = [
  {
    key: 'ai_adoption',
    label: 'AI Development & Adoption',
    perInstitution: true,
    // Scoped to AI *for research/publishing* specifically — not any AI story
    // that happens to mention a tracked institution (e.g. an AI model for
    // an unrelated domain built by one of its researchers).
    queryFor: (inst) => `"${inst}" (AI OR "artificial intelligence" OR "machine learning") (research OR literature OR "scientific discovery" OR publishing OR library OR database OR "research assistant")`,
  },
  {
    key: 'funding',
    label: 'Funding Received',
    perInstitution: true,
    // Scoped to funding for research infrastructure/information/AI tools —
    // not any grant (e.g. a clinical treatment trial has nothing to do with
    // Elsevier's business even though it's "funding" and "research").
    queryFor: (inst) => `"${inst}" (funding OR grant OR investment) ("research infrastructure" OR library OR database OR subscription OR "open access" OR "research information" OR "AI tools" OR bibliometric OR CRIS)`,
  },
  {
    key: 'policy',
    label: 'Denmark Research Policy',
    perInstitution: false,
    queries: [
      'Denmark research funding policy Uddannelses- og Forskningsministeriet',
      'Denmark universities "open access" OR "open science" policy',
      'Denmark research assessment reform',
      'Denmark library Scopus OR "Web of Science" OR subscription cancellation',
    ],
  },
  {
    key: 'competitor_announcements',
    label: 'Competitor Announcements',
    perInstitution: true,
    entities: TRACKED_COMPETITORS,
    // Company-level news from named LeapSpace competitors — new products,
    // partnerships, rollouts, expansions — not general company news.
    queryFor: (co) => `"${co}" (launches OR unveils OR announces OR partnership OR collaborat* OR "rolls out" OR expands OR acquisition OR "new tool" OR "new feature") (research OR publishing OR AI OR "scientific literature" OR database OR scholarly OR "research assistant")`,
  },
];

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) { hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0; }
  return 'news-' + Math.abs(hash).toString(36);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function stripCdata(s) {
  const m = String(s || '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return decodeEntities(m ? m[1] : s);
}

// Minimal RSS 2.0 <item> parser via regex — Google News RSS is well-formed
// enough that a full XML parser isn't worth the extra dependency.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = stripCdata((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = stripCdata((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const pubDate = stripCdata((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const source = stripCdata((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
    const description = stripCdata((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (title && link) items.push({ title, link, pubDate, source, description });
  }
  return items;
}

async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=DK&ceid=DK:da`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NL-CRM-NewsBot/1.0; +mailto:venturino.dino@gmail.com)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssItems(xml);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`  ! RSS fetch failed for "${query}": ${e.message}`);
    return [];
  }
}

function isRecent(pubDate) {
  if (!pubDate) return true; // don't drop items Google didn't date
  const d = new Date(pubDate);
  if (isNaN(d)) return true;
  return (Date.now() - d.getTime()) / 86400000 <= MAX_AGE_DAYS;
}

function toISODate(pubDate) {
  const d = new Date(pubDate);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function filterRelevance(candidates) {
  if (!candidates.length) return candidates;
  if (!ANTHROPIC_API_KEY) {
    console.log('[news-scan] ANTHROPIC_API_KEY not set — skipping Elsevier-relevance filter, keeping all keyword matches.');
    return candidates;
  }

  const batch = candidates.slice(0, MAX_RELEVANCE_BATCH);
  const overflow = candidates.length - batch.length;
  if (overflow > 0) {
    console.log(`[news-scan] ${overflow} candidate(s) beyond the relevance-filter batch cap deferred to a future run.`);
  }

  const prompt = `${ELSEVIER_CONTEXT}

For each numbered article below, decide whether it is genuinely relevant to Elsevier's business and competitive interests as described above — i.e. about scholarly publishing, research information infrastructure, AI research/discovery tools, library or database subscriptions, bibliometrics, or funding/policy specifically tied to those areas. Mark irrelevant anything that is just general research findings, medical/scientific results, or an AI application unrelated to research infrastructure — even if it mentions a tracked institution, "AI", or "funding".

${batch.map((c, i) => `${i + 1}. [${c.categoryLabel}] "${c.title}" — ${c.description || '(no description)'}`).join('\n')}

Respond with ONLY a JSON array, one object per article in the same order, each exactly: {"relevant": true|false, "reason": "one short sentence explaining why it matters to Elsevier, only if relevant — omit or empty string if not relevant"}`;

  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: RELEVANCE_MODEL, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.warn(`[news-scan] Relevance filter request failed (${e.message}) — keeping all keyword matches unfiltered.`);
    return candidates;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.warn(`[news-scan] Relevance filter API call failed (HTTP ${res.status}) — keeping all keyword matches unfiltered.`);
    return candidates;
  }

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  let verdicts;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    verdicts = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.warn('[news-scan] Could not parse relevance filter response — keeping all keyword matches unfiltered.');
    return candidates;
  }

  const kept = [];
  batch.forEach((c, i) => {
    const v = verdicts[i];
    if (v && v.relevant) {
      kept.push({ ...c, elsevierRelevance: String(v.reason || '').slice(0, 200) });
    } else {
      console.log(`  - filtered out (not Elsevier-relevant): ${c.title}`);
    }
  });
  return kept;
}

async function main() {
  const articles = readJSON(DATA_FILE, []);
  const existingUrls = new Set(articles.map(a => a.url));
  const candidateCounts = {};
  const freshCandidates = [];

  for (const category of CATEGORIES) {
    console.log(`[news-scan] Searching: ${category.label}...`);
    let categoryCandidates = 0;

    const jobs = category.perInstitution
      ? (category.entities || ALL_INSTITUTIONS).map(inst => ({ inst, query: category.queryFor(inst) }))
      : category.queries.map(q => ({ inst: null, query: q }));

    for (const job of jobs) {
      const items = await fetchGoogleNewsRss(job.query);
      await sleep(REQUEST_DELAY_MS);
      categoryCandidates += items.length;

      for (const item of items) {
        if (!isRecent(item.pubDate)) continue;
        if (existingUrls.has(item.link)) continue;
        // For per-institution queries, require the institution name to actually
        // appear in the title/description — Google News RSS relevance ranking is loose.
        if (job.inst && !new RegExp(job.inst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.title + ' ' + item.description)) {
          continue;
        }

        freshCandidates.push({
          id: makeId(item.link),
          title: String(item.title).slice(0, 200),
          description: String(item.description || '').replace(/<[^>]*>/g, '').slice(0, 400),
          institution: job.inst,
          category: category.key,
          categoryLabel: category.label,
          url: String(item.link).slice(0, 500),
          sourceName: String(item.source || '').slice(0, 150),
          publishedDate: toISODate(item.pubDate),
          foundDate: new Date().toISOString().slice(0, 10),
          autoDiscovered: true,
        });
        existingUrls.add(item.link);
        console.log(`  + [${category.key}] ${item.title}`);
      }
    }
    candidateCounts[category.key] = categoryCandidates;
  }

  console.log(`[news-scan] ${freshCandidates.length} keyword-matched candidate(s) found — running Elsevier-relevance filter...`);
  const relevant = await filterRelevance(freshCandidates);
  for (const article of relevant) articles.unshift(article);
  const totalAdded = relevant.length;

  const trimmed = articles.slice(0, MAX_STORED_ARTICLES);
  if (totalAdded > 0) saveJSON(DATA_FILE, trimmed);

  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: totalAdded,
    lastCandidateCount: freshCandidates.length,
    candidateCounts,
    source: ANTHROPIC_API_KEY
      ? 'Google News RSS (discovery) + Claude Haiku (Elsevier-relevance filter)'
      : 'Google News RSS (free, no API key — relevance filter skipped)',
  });
  console.log(`[news-scan] Done — ${totalAdded} new article(s) added (${freshCandidates.length} candidates found).`);
}

main().catch(e => {
  console.error('[news-scan] Failed:', e.message);
  try {
    saveJSON(STATE_FILE, { lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message });
  } catch { /* ignore */ }
  process.exit(1);
});
