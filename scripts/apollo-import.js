/**
 * apollo-import.js — Pull decision-makers for every tracked institution from
 * Apollo.io into the pending_contacts review queue.
 *
 * How it works. For each institution with a known email domain (the same
 * data/staff-sources.json hints the staff and role scans use, with the CRM
 * website as a fallback) it runs Apollo's People Search — free of credits —
 * filtered to the titles the CRM sells through: rectors and deans, library
 * and collections leads, research support and grants, CIO / CISO / DPO,
 * procurement, research integrity and doctoral schools, AI and digital
 * strategy, research support librarians and advisors. The search returns
 * only an id, first name, obfuscated last name and title, so every person
 * whose title matches a role family and who Apollo says has an email is then
 * enriched in batches of ten (Bulk People Enrichment, one credit per person
 * found). Enriched people are deduplicated against the CRM and the queue by
 * email and by name, and inserted as pending contacts with the role family
 * as department, Apollo's email status in the notes, and the LinkedIn
 * profile (or the Apollo record) as the source.
 *
 * Credits. Search is free; enrichment is not. --max-credits caps how many
 * people are enriched per run (default 400), highest-value titles first.
 * Apollo ids already enriched are remembered in data/apollo-import-state.json
 * so a rerun never pays twice for the same person. A --dry-run does the free
 * search only and prints what it would enrich, so the volume is known before
 * anything is spent.
 *
 * Requires APOLLO_API_KEY and SUPABASE_SERVICE_ROLE_KEY.
 * Run: node scripts/apollo-import.js
 *   --dry-run          search only, spend nothing, insert nothing
 *   --max-credits N    enrich at most N people this run (default 400)
 *   --inst IDS         only these institution ids, comma-separated
 *   --max-per-inst N   at most N people per institution (default 60)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const REGION = 'denmark';
const COUNTRY = 'Denmark';
const STATE_FILE = 'data/apollo-import-state.json';
const AUDIT_FILE = 'data/apollo-imported-contacts.json'; // local audit trail of what was queued
const SOURCES_FILE = 'data/staff-sources.json';
const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const APOLLO = 'https://api.apollo.io/api/v1';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const DRY_RUN = args.includes('--dry-run');
const MAX_CREDITS = Math.max(0, parseInt(flag('--max-credits', '400'), 10) || 0);
const MAX_PER_INST = Math.max(1, parseInt(flag('--max-per-inst', '60'), 10) || 60);
const ONLY_INST = flag('--inst', '').split(',').map(s => s.trim()).filter(Boolean);
const SEARCH_PAGES_MAX = 5; // 100 per page; more than 500 title matches at one institution is noise

// Titles sent to Apollo's search (OR-ed, similar titles included) and, in the
// same order of value to the CRM, the regex that assigns a role family to a
// title. A person whose title matches nothing is not enriched.
const ROLE_FAMILIES = [
  ['Vice-Rector / Pro-Rector Research', /\b(vice[- ]?rector|pro[- ]?rector|prorektor|vice[- ]president (for|of) research|pro[- ]vice[- ]chancellor)\b/i],
  ['Rector / President', /\b(rector|rektor|president|chief executive|ceo|director[- ]general|managing director|administrerende direkt[øo]r)\b/i],
  ['Dean / Research Group Lead', /\b(dean|dekan|prodekan|head of (department|institute|faculty|school)|institutleder|institute director|department head|department chair)\b/i],
  ['Research Director / Head of Research', /\b(research director|director of research|head of research|chief scientific officer|scientific director|forskningschef|forskningsdirekt[øo]r|forskningsleder)\b/i],
  ['Library Director', /\b(library director|director of (the )?librar(y|ies)|head of (the )?library|university librarian|chief librarian|bibliotekschef|bibliotekar|biblioteksdirekt[øo]r|library services)\b/i],
  ['E-resources / Collections', /\b(e-?resources|electronic resources|collections? (manager|librarian|lead|development)|acquisitions|licens(ing|es)|samlings)\b/i],
  ['Research Support / Grants Office', /\b(research support|research services|grants?( office| manager| adviser| advisor)?|funding (office|manager|adviser|advisor)|research funding|pre-?award|post-?award|research office|research administration|forskningsst[øo]tte|fundraising)\b/i],
  ['CIO', /\b(cio|chief information officer|it[- ]director|head of it|director of it|chief digital officer|cdo|it-?chef|it-?direkt[øo]r)\b/i],
  ['CISO / Information Security', /\b(ciso|information security|informationssikkerhed|it[- ]security|security officer)\b/i],
  ['DPO / Legal Counsel', /\b(data protection|dpo|privacy officer|general counsel|legal counsel|head of legal|chief legal|databeskyttelse|juridisk chef|jurist)\b/i],
  ['Procurement', /\b(procurement|purchasing|sourcing|indk[øo]b|category manager|contract manager)\b/i],
  ['Research Integrity / Doctoral School', /\b(research integrity|doctoral school|graduate school|phd school|ombuds|research ethics|forskerskole|ph\.?d\.?-?skole)\b/i],
  ['AI Taskforce / Digital Strategy', /\b(artificial intelligence|\bai\b|machine learning|digital strategy|digitali[sz]ation|digital transformation|data science|digitaliseringschef|innovation)\b/i],
  ['Research Support Librarian / Research Advisor', /\b(research librarian|liaison librarian|subject librarian|information specialist|research adviser|research advisor|research data|open science|open access|bibliometric|scholarly communication|research analyst|informationsspecialist)\b/i],
];
const SEARCH_TITLES = [
  'Vice-Rector', 'Pro-Rector', 'Prorektor', 'Rector', 'Rektor', 'President', 'Chief Executive Officer', 'Director General',
  'Dean', 'Dekan', 'Prodekan', 'Head of Department', 'Institutleder', 'Institute Director',
  'Research Director', 'Head of Research', 'Chief Scientific Officer', 'Scientific Director', 'Forskningschef',
  'Library Director', 'Head of Library', 'University Librarian', 'Bibliotekschef', 'Collections Manager', 'Electronic Resources',
  'Head of Research Support', 'Research Support', 'Grants Manager', 'Research Funding', 'Funding Adviser', 'Research Office',
  'Chief Information Officer', 'IT Director', 'Head of IT', 'Chief Digital Officer', 'IT-chef',
  'Chief Information Security Officer', 'Information Security Officer',
  'Data Protection Officer', 'General Counsel', 'Legal Counsel',
  'Head of Procurement', 'Procurement Manager', 'Purchasing Manager', 'Indkøbschef',
  'Research Integrity', 'Head of Doctoral School', 'Graduate School Director',
  'Head of AI', 'Digital Strategy', 'Head of Digitalisation', 'Digitaliseringschef', 'Head of Data Science',
  'Research Librarian', 'Information Specialist', 'Research Adviser', 'Research Data Manager', 'Open Science', 'Bibliometrics',
];

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function domainFromWebsite(website) {
  try { return new URL(website.startsWith('http') ? website : 'https://' + website).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}
function familyOf(title) {
  const t = String(title || '');
  for (const [name, re] of ROLE_FAMILIES) if (re.test(t)) return name;
  return null;
}
const familyRank = name => ROLE_FAMILIES.findIndex(([n]) => n === name);
// A PA carries the boss's title in theirs; keep the boss, not the assistant.
const ASSISTANT_RE = /\b(assistant to|personal assistant|secretary|sekret[æa]r|pa to|executive assistant|student|intern|trainee|phd (student|fellow|candidate)|postdoc)\b/i;

// ── Supabase ─────────────────────────────────────────────────────────────
const supaHeaders = () => ({ apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` });
async function supaAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
      headers: { ...supaHeaders(), Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function supaInsert(rows) {
  if (!rows.length) return 0;
  const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return rows.length;
}

// ── Apollo ───────────────────────────────────────────────────────────────
// One retry on 429 honouring retry-after; anything else throws with the body.
async function apollo(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${APOLLO}/${path}`, {
      method: 'POST',
      headers: { 'x-api-key': APOLLO_KEY, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(120, parseInt(res.headers.get('retry-after') || '30', 10) || 30);
      console.warn(`  Apollo rate limit — waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Apollo ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res.json();
  }
}
// Free: ids, first names, obfuscated last names, titles, has_email.
async function searchPeople(domain) {
  const people = [];
  for (let page = 1; page <= SEARCH_PAGES_MAX; page++) {
    const data = await apollo('mixed_people/api_search', {
      q_organization_domains_list: [domain],
      person_titles: SEARCH_TITLES,
      include_similar_titles: true,
      page, per_page: 100,
    });
    const batch = data.people || [];
    people.push(...batch);
    const total = data.pagination && data.pagination.total_entries;
    if (batch.length < 100 || (total && people.length >= total)) break;
    await sleep(1500);
  }
  return people;
}
// One credit per person found. Ten ids per call.
async function enrichByIds(ids) {
  const data = await apollo('people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false', {
    details: ids.map(id => ({ id })),
  });
  return { matches: data.matches || [], credits: data.credits_consumed || 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[apollo-import] ${new Date().toISOString().slice(0, 16)} starting (${COUNTRY})${DRY_RUN ? ' — dry run' : ''}; enrichment cap ${MAX_CREDITS} people`);
  const state = readJSON(STATE_FILE, {});
  const missing = [!APOLLO_KEY && 'APOLLO_API_KEY', !SUPA_SERVICE_KEY && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean);
  if (missing.length) {
    console.log(`[apollo-import] ${missing.join(', ')} not set — skipping.`);
    if (!DRY_RUN) saveJSON(STATE_FILE, { ...state, lastRun: new Date().toISOString(), lastAddedCount: 0, error: `missing ${missing.join(', ')}` });
    return;
  }

  const insts = await supaAll(`crm_institutions?select=id,name,short,type,city,website&region=eq.${REGION}&order=name.asc`);
  const domainHints = {};
  for (const s of readJSON(SOURCES_FILE, { sources: [] }).sources || []) if (s.instId && s.emailDomain) domainHints[s.instId] = s.emailDomain;
  let targets = insts.map(i => ({ ...i, domain: domainHints[i.id] || domainFromWebsite(i.website || '') })).filter(i => i.domain);
  if (ONLY_INST.length) targets = targets.filter(i => ONLY_INST.includes(i.id));
  console.log(`[apollo-import] ${targets.length} institution(s) with a domain${ONLY_INST.length ? ` (of ${ONLY_INST.length} requested)` : ''}.`);

  // Dedup lists: everything queued or in the CRM for this region, plus the
  // Apollo ids already paid for on earlier runs.
  const pending = await supaAll(`pending_contacts?select=first,last,email,institution_id&region=eq.${REGION}`);
  const contacts = await supaAll(`crm_contacts?select=first,last,email,inst_id&region=eq.${REGION}`);
  const seenEmail = new Set([...pending, ...contacts].map(r => (r.email || '').toLowerCase()).filter(Boolean));
  const seenName = new Set([...pending, ...contacts].map(r => `${r.first || ''} ${r.last || ''}`.toLowerCase().trim()).filter(s => s.length > 3));
  const enrichedIds = new Set(Object.keys(state.enriched || {}));
  console.log(`[apollo-import] Dedup: ${pending.length} queued, ${contacts.length} in the CRM, ${enrichedIds.size} Apollo id(s) already enriched.`);

  // Free pass: search every institution and shortlist people to enrich.
  const shortlist = []; // { inst, id, first, lastHint, title, family }
  const perInst = {};
  let planError = null; // Apollo refuses the endpoint for this plan: no point asking 79 times
  for (const inst of targets) {
    if (planError) break;
    try {
      const people = await searchPeople(inst.domain);
      let matched = 0, withEmail = 0;
      const rows = [];
      for (const p of people) {
        const family = familyOf(p.title);
        if (!family || ASSISTANT_RE.test(p.title || '')) continue;
        matched++;
        if (!p.has_email) continue;
        withEmail++;
        if (enrichedIds.has(p.id)) continue;
        rows.push({ inst, id: p.id, first: p.first_name || '', lastHint: p.last_name_obfuscated || '', title: p.title || '', family, rank: familyRank(family) });
      }
      rows.sort((a, b) => a.rank - b.rank);
      const kept = rows.slice(0, MAX_PER_INST);
      shortlist.push(...kept);
      perInst[inst.id] = { domain: inst.domain, found: people.length, matched, withEmail, shortlisted: kept.length };
      console.log(`  ${inst.name} (${inst.domain}): ${people.length} in Apollo, ${matched} in a role family, ${withEmail} with an email, ${kept.length} to enrich`);
    } catch (e) {
      perInst[inst.id] = { domain: inst.domain, error: e.message.slice(0, 200) };
      console.warn(`  ${inst.name} (${inst.domain}): search failed — ${e.message.slice(0, 160)}`);
      if (/not included in your .* plan|not accessible/i.test(e.message)) {
        planError = e.message.replace(/^Apollo [^:]+: HTTP \d+ /, '').slice(0, 220);
        console.error(`[apollo-import] Apollo refused the People Search API for this plan — stopping. ${planError}`);
        if (process.env.GITHUB_ACTIONS) console.log('::error::Apollo People Search is not included in the current Apollo plan; the importer needs a plan with API access (Basic or above).');
      }
    }
    await sleep(1500);
  }
  shortlist.sort((a, b) => a.rank - b.rank);
  const toEnrich = shortlist.slice(0, MAX_CREDITS);
  console.log(`[apollo-import] ${shortlist.length} person(s) worth enriching; this run enriches ${toEnrich.length} (cap ${MAX_CREDITS}).`);
  if (DRY_RUN) {
    const byFamily = {};
    shortlist.forEach(r => { byFamily[r.family] = (byFamily[r.family] || 0) + 1; });
    Object.entries(byFamily).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`    ${String(n).padStart(4)}  ${f}`));
    // A dry run writes only its own summary, so the dashboard card can show
    // it and the workflow's commit step has a file to commit; the enriched-id
    // list and last real-run counts are left as they were.
    saveJSON(STATE_FILE, {
      ...state,
      lastDryRun: new Date().toISOString(),
      lastDryRunShortlist: shortlist.length,
      lastDryRunByFamily: byFamily,
      perInstitution: perInst,
      error: planError || undefined,
    });
    console.log('[apollo-import] Dry run — nothing enriched, no contacts written.');
    if (planError) process.exit(2);
    return;
  }

  // Paid pass: enrich in tens, dedup, build the queue rows.
  const enriched = { ...(state.enriched || {}) };
  const candidates = [];
  let creditsUsed = 0, skippedKnown = 0, noEmail = 0, failed = 0;
  for (let i = 0; i < toEnrich.length; i += 10) {
    const chunk = toEnrich.slice(i, i + 10);
    let result;
    try { result = await enrichByIds(chunk.map(r => r.id)); }
    catch (e) { failed += chunk.length; console.warn(`  enrichment failed for a batch of ${chunk.length}: ${e.message.slice(0, 160)}`); await sleep(3000); continue; }
    creditsUsed += result.credits || 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const r of chunk) {
      const m = result.matches.find(x => x && x.id === r.id);
      enriched[r.id] = { at: today, inst: r.inst.id, ok: !!(m && m.email) };
      if (!m || !m.email) { noEmail++; continue; }
      const first = String(m.first_name || r.first).trim(), last = String(m.last_name || '').trim();
      if (!first || !last) { noEmail++; continue; }
      const el = m.email.toLowerCase(), nl = `${first} ${last}`.toLowerCase();
      if (seenEmail.has(el) || seenName.has(nl)) { skippedKnown++; continue; }
      seenEmail.add(el); seenName.add(nl);
      candidates.push({
        first, last, title: String(m.title || r.title).slice(0, 150), department: r.family,
        institution_id: r.inst.id, institution_name: r.inst.name, email: m.email,
        research: '', source_url: m.linkedin_url || `https://app.apollo.io/#/people/${r.id}`,
        notes: `Found via Apollo (email ${m.email_status || 'status unknown'}${m.city ? ', ' + m.city : ''}).`,
        status: 'pending', region: REGION,
      });
    }
    await sleep(1200);
  }

  console.log(`[apollo-import] Enriched ${toEnrich.length - failed} person(s) for ${creditsUsed} credit(s): ${candidates.length} new, ${skippedKnown} already known, ${noEmail} without an email or full name, ${failed} failed.`);
  for (const c of candidates) console.log(`  + ${(c.first + ' ' + c.last).padEnd(28)} ${c.department.padEnd(42)} ${c.title.slice(0, 40).padEnd(42)} ${c.email}`);

  let added = 0;
  if (candidates.length) {
    try { added = await supaInsert(candidates); }
    catch (e) { console.error('[apollo-import] Supabase insert error:', e.message); }
  }
  const audit = readJSON(AUDIT_FILE, []);
  audit.unshift(...candidates.map(c => ({ ...c, queuedAt: new Date().toISOString() })));
  saveJSON(AUDIT_FILE, audit.slice(0, 5000));
  saveJSON(STATE_FILE, {
    lastRun: new Date().toISOString(),
    lastAddedCount: added,
    lastEnriched: toEnrich.length - failed,
    lastCreditsUsed: creditsUsed,
    lastShortlist: shortlist.length,
    remaining: Math.max(0, shortlist.length - toEnrich.length),
    perInstitution: perInst,
    enriched,
    error: planError || undefined,
  });
  console.log(`[apollo-import] Done — ${added} contact(s) queued for review; ${Math.max(0, shortlist.length - toEnrich.length)} more remain for the next run.`);
}

main().catch(e => {
  console.error('[apollo-import] Failed:', e.message);
  try { const s = readJSON(STATE_FILE, {}); saveJSON(STATE_FILE, { ...s, lastRun: new Date().toISOString(), lastAddedCount: 0, error: e.message }); } catch { /* ignore */ }
  process.exit(1);
});
