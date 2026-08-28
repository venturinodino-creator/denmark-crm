/**
 * discover.js — Daily contact discovery scan.
 * Free, zero-Claude-cost: scrapes OpenAlex for researchers at each enabled
 * institution and constructs a plausible institutional email per contact
 * (OpenAlex itself never provides one), flagging it for manual verification.
 * Writes new candidates straight into Supabase's pending_contacts table
 * (requires SUPABASE_SERVICE_ROLE_KEY — RLS restricts inserts to admins,
 * which the service key bypasses). Run: node scripts/discover.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const PENDING_FILE = 'data/pending-contacts.json'; // local audit trail only — the app no longer reads this
const STATE_FILE   = 'data/discovery-state.json';
const CONFIG_FILE  = 'data/scrape-config.json';
const TARGET       = 20;

const SUPA_URL = 'https://cfhljbexesdrabmadpcc.supabase.co';
const SUPA_KEY = 'sb_publishable_PE2Yc0ivOT4F4fE80CXJUw_kbch9TpZ'; // publishable key — read-only here, safe to embed
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // required to write pending_contacts (RLS: insert requires is_admin())

// The admin sets scrape targets from the CRM's "New Contacts" page, which
// writes to this table. Falls back to the local CONFIG_FILE if Supabase is
// unreachable, so a scan never silently fails from a transient network issue.
async function fetchScrapeConfig() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/scrape_config?select=types&region=eq.denmark`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (rows[0] && Array.isArray(rows[0].types) && rows[0].types.length) return rows[0].types;
  } catch (e) {
    console.warn('Could not fetch scrape_config from Supabase, falling back to local file:', e.message);
  }
  return null;
}

// Existing pending_contacts (any status) — used to dedup against what the
// service role key can see. RLS blocks the publishable key from reading this,
// so this always uses the service key.
async function fetchExistingPending() {
  if (!SUPA_SERVICE_KEY) return [];
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts?select=first,last,email&region=eq.denmark`, {
      headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('Could not fetch existing pending_contacts:', e.message);
    return [];
  }
}

async function insertPendingContacts(rows) {
  if (!rows.length) return 0;
  if (!SUPA_SERVICE_KEY) {
    console.warn('SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase insert (add it as a GitHub Actions secret).');
    return 0;
  }
  const res = await fetch(`${SUPA_URL}/rest/v1/pending_contacts`, {
    method: 'POST',
    headers: {
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase insert failed: HTTP ${res.status} ${body}`);
  }
  return rows.length;
}

// ── Institution definitions by type ────────────────────────────────────────
// emailDomain is used to construct a plausible (unverified) email since
// OpenAlex never provides one — flagged in `notes` for the user to confirm.
const INSTITUTIONS = {
  research: [
    { key: 'ssi', name: 'Statens Serum Institut', instId: 'ssi', dept: 'Scientific Research', emailDomain: 'ssi.dk' },
    { key: 'nbi', name: 'Niels Bohr Institute', instId: 'nbi', dept: 'Scientific Research', emailDomain: 'nbi.ku.dk' },
    { key: 'royalacademy', name: 'Royal Danish Academy of Sciences and Letters', instId: 'royalacademy', dept: 'Scientific Research', emailDomain: 'royalacademy.dk' },
    { key: 'dmi', name: 'Danish Meteorological Institute', instId: 'dmi', dept: 'Scientific Research', emailDomain: 'dmi.dk' },
    { key: 'geus', name: 'Geological Survey of Denmark and Greenland', instId: 'geus', dept: 'Scientific Research', emailDomain: 'geus.dk' },
    { key: 'alexandra', name: 'Alexandra Institute', instId: 'alexandra', dept: 'Scientific Research', emailDomain: 'alexandra.dk' },
    { key: 'dti', name: 'Danish Technological Institute', instId: 'dti', dept: 'Scientific Research', emailDomain: 'dti.dk' },
    { key: 'cpr', name: 'Novo Nordisk Foundation Center for Protein Research', instId: 'cpr', dept: 'Scientific Research', emailDomain: 'cpr.ku.dk' },
    { key: 'cbmr', name: 'Novo Nordisk Foundation Center for Basic Metabolic Research', instId: 'cbmr', dept: 'Scientific Research', emailDomain: 'cbmr.ku.dk' },
    { key: 'renew', name: 'Novo Nordisk Foundation Center for Stem Cell Medicine (reNEW)', instId: 'renew', dept: 'Scientific Research', emailDomain: 'renew.ku.dk' },
    { key: 'inano', name: 'Interdisciplinary Nanoscience Center', instId: 'inano', dept: 'Scientific Research', emailDomain: 'inano.au.dk' },
    { key: 'dtuspace', name: 'DTU Space – National Space Institute', instId: 'dtuspace', dept: 'Scientific Research', emailDomain: 'space.dtu.dk' },
    { key: 'diis', name: 'Danish Institute for International Studies', instId: 'diis', dept: 'Scientific Research', emailDomain: 'diis.dk' },
    { key: 'vive', name: 'VIVE – The Danish Center for Social Science Research', instId: 'vive', dept: 'Scientific Research', emailDomain: 'vive.dk' },
    { key: 'dias', name: 'Danish Institute for Advanced Study', instId: 'dias', dept: 'Scientific Research', emailDomain: 'danish-ias.dk' },
    { key: 'biosustain', name: 'Novo Nordisk Foundation Center for Biosustainability', instId: 'biosustain', dept: 'Scientific Research', emailDomain: 'biosustain.dtu.dk' },
    { key: 'niph', name: 'National Institute of Public Health', instId: 'niph', dept: 'Scientific Research', emailDomain: 'sdu.dk' },
    { key: 'aias', name: 'Aarhus Institute of Advanced Studies', instId: 'aias', dept: 'Scientific Research', emailDomain: 'aias.au.dk' },
    { key: 'pioneerai', name: 'Pioneer Centre for Artificial Intelligence', instId: 'pioneerai', dept: 'Scientific Research', emailDomain: 'aicentre.dk' },
    { key: 'rockwoolresearch', name: 'Rockwool Foundation Research Unit', instId: 'rockwoolresearch', dept: 'Scientific Research', emailDomain: 'en.rockwoolfonden.dk' },
    { key: 'bii', name: 'BioInnovation Institute', instId: 'bii', dept: 'Scientific Research', emailDomain: 'bii.dk' },
  ],
  university: [
    { key: 'ku', name: 'University of Copenhagen', instId: 'ku', dept: 'Research', emailDomain: 'ku.dk' },
    { key: 'au', name: 'Aarhus University', instId: 'au', dept: 'Research', emailDomain: 'au.dk' },
    { key: 'dtu', name: 'Technical University of Denmark', instId: 'dtu', dept: 'Research', emailDomain: 'dtu.dk' },
    { key: 'sdu', name: 'University of Southern Denmark', instId: 'sdu', dept: 'Research', emailDomain: 'sdu.dk' },
    { key: 'aau', name: 'Aalborg University', instId: 'aau', dept: 'Research', emailDomain: 'aau.dk' },
    { key: 'cbs', name: 'Copenhagen Business School', instId: 'cbs', dept: 'Research', emailDomain: 'cbs.dk' },
    { key: 'ruc', name: 'Roskilde University', instId: 'ruc', dept: 'Research', emailDomain: 'ruc.dk' },
    { key: 'itu', name: 'IT University of Copenhagen', instId: 'itu', dept: 'Research', emailDomain: 'itu.dk' },
  ],
  medical: [
    { key: 'rigshospitalet', name: 'Rigshospitalet (Copenhagen University Hospital)', instId: 'rigshospitalet', dept: 'Medical Research', emailDomain: 'rigshospitalet.dk' },
    { key: 'auh', name: 'Aarhus University Hospital', instId: 'auh', dept: 'Medical Research', emailDomain: 'auh.dk' },
    { key: 'ouh', name: 'Odense University Hospital', instId: 'ouh', dept: 'Medical Research', emailDomain: 'ouh.dk' },
    { key: 'herlevgentofte', name: 'Copenhagen University Hospital – Herlev and Gentofte', instId: 'herlevgentofte', dept: 'Medical Research', emailDomain: 'herlevhospital.dk' },
    { key: 'aalborguh', name: 'Aalborg University Hospital', instId: 'aalborguh', dept: 'Medical Research', emailDomain: 'aalborguh.rn.dk' },
    { key: 'bispebjergfrederiksberg', name: 'Copenhagen University Hospital – Bispebjerg and Frederiksberg', instId: 'bispebjergfrederiksberg', dept: 'Medical Research', emailDomain: 'bispebjerghospital.dk' },
    { key: 'amagerhvidovre', name: 'Copenhagen University Hospital – Amager and Hvidovre', instId: 'amagerhvidovre', dept: 'Medical Research', emailDomain: 'hvidovrehospital.dk' },
    { key: 'zealanduh', name: 'Zealand University Hospital', instId: 'zealanduh', dept: 'Medical Research', emailDomain: 'regionsjaelland.dk' },
    { key: 'stenocph', name: 'Steno Diabetes Center Copenhagen', instId: 'stenocph', dept: 'Medical Research', emailDomain: 'sdcc.dk' },
    { key: 'stenoaarhus', name: 'Steno Diabetes Center Aarhus', instId: 'stenoaarhus', dept: 'Medical Research', emailDomain: 'stenoaarhus.dk' },
  ],
  ngo: [
    { key: 'novonordiskfoundation', name: 'Novo Nordisk Foundation', instId: 'novonordiskfoundation', dept: 'Research Funding', emailDomain: 'novonordiskfonden.dk' },
    { key: 'lundbeckfoundation', name: 'Lundbeck Foundation', instId: 'lundbeckfoundation', dept: 'Research Funding', emailDomain: 'lundbeckfonden.com' },
    { key: 'carlsbergfoundation', name: 'Carlsberg Foundation', instId: 'carlsbergfoundation', dept: 'Research Funding', emailDomain: 'carlsbergfondet.dk' },
    { key: 'villumfoundation', name: 'Villum Foundation', instId: 'villumfoundation', dept: 'Research Funding', emailDomain: 'villumfonden.dk' },
    { key: 'danishcancersociety', name: 'Danish Cancer Society', instId: 'danishcancersociety', dept: 'Research Funding', emailDomain: 'cancer.dk' },
    { key: 'dnrf', name: 'Danish National Research Foundation', instId: 'dnrf', dept: 'Research Funding', emailDomain: 'dg.dk' },
  ],
};

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJSON(path, data) {
  const dir = path.split('/').slice(0,-1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function makeId(key) {
  return `disc_${key}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
}
function slugifyNamePart(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase().replace(/[^a-z]/g, '');
}
function constructEmail(first, last, domain) {
  const f = slugifyNamePart(first), l = slugifyNamePart(last);
  if (!f || !l || !domain) return '';
  return `${f}.${l}@${domain}`;
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'NL-CRM-Bot/1.0 (mailto:venturino.dino@gmail.com)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function getJSON(url) {
  const r = await get(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

async function getInstId(name) {
  const url = `https://api.openalex.org/institutions?search=${encodeURIComponent(name)}&per_page=1&mailto=venturino.dino@gmail.com`;
  const data = await getJSON(url);
  return data?.results?.[0]?.id || null;
}

async function scrapeOpenAlex(scraped, inst, needed) {
  const contacts = [];
  let oaId = scraped[`${inst.key}_oa_id`];
  if (!oaId) {
    oaId = await getInstId(inst.name);
    if (!oaId) { console.log(`  ⚠ Not found in OpenAlex: ${inst.name}`); return contacts; }
    scraped[`${inst.key}_oa_id`] = oaId;
  }
  const shortId = String(oaId).split('/').pop();
  const done = new Set(scraped[inst.key] || []);
  const page = scraped[`${inst.key}_page`] || 1;
  const cacheKey = `p${page}`;
  if (done.has(cacheKey)) { console.log(`  ↩ ${inst.name} page ${page} already done`); return contacts; }
  const url = `https://api.openalex.org/authors?filter=last_known_institutions.id:${shortId}&per_page=10&page=${page}&mailto=venturino.dino@gmail.com`;
  console.log(`  → ${inst.name} page ${page}`);
  const data = await getJSON(url);
  done.add(cacheKey);
  scraped[inst.key] = [...done];
  if (data?.results?.length) {
    for (const author of data.results) {
      if (contacts.length >= needed) break;
      const full = (author.display_name || '').trim().replace(/\s+/g, ' ');
      const parts = full.split(' ');
      if (parts.length < 2) continue;
      const first = parts[0], last = parts.slice(1).join(' ');
      const orcid = author.orcid ? `ORCID: ${author.orcid}` : '';
      const email = constructEmail(first, last, inst.emailDomain);
      contacts.push({
        first, last, title: 'Researcher', dept: inst.dept, email,
        instId: inst.instId, instName: inst.name, source: author.id || url, research: orcid,
        constructed: !!email,
      });
    }
    scraped[`${inst.key}_page`] = page + 1;
    console.log(`  ✓ ${contacts.length} contacts from ${inst.name}`);
  } else {
    console.log(`  ✗ No results for ${inst.name} page ${page} (resetting)`);
    scraped[`${inst.key}_page`] = 1;
    scraped[inst.key] = [];
  }
  return contacts;
}

async function main() {
  // Read config — Supabase first (set from the CRM UI), local file as fallback
  const remoteTypes = await fetchScrapeConfig();
  const config = remoteTypes ? { types: remoteTypes } : readJSON(CONFIG_FILE, { types: ['research'] });
  console.log(remoteTypes ? 'Using scrape target from Supabase' : 'Using scrape target from local config file');
  const enabledTypes = new Set(Array.isArray(config.types) ? config.types : ['research']);
  console.log('Enabled institution types:', [...enabledTypes].join(', '));

  // Build list of institutions to scrape (deduplicated)
  const seen = new Set();
  const toScrape = [];
  for (const type of ['research','university','medical','ngo']) {
    if (!enabledTypes.has(type)) continue;
    for (const inst of INSTITUTIONS[type] || []) {
      if (!seen.has(inst.key)) { seen.add(inst.key); toScrape.push(inst); }
    }
  }
  console.log(`Scraping ${toScrape.length} institutions: ${toScrape.map(i=>i.key).join(', ')}`);

  const state = readJSON(STATE_FILE, { scraped: {}, lastRun: null });

  const existingPendingRemote = await fetchExistingPending();
  const localPending = readJSON(PENDING_FILE, []);
  const existingEmails = new Set(
    [...existingPendingRemote, ...localPending].map(c=>(c.email||'').toLowerCase().trim()).filter(Boolean)
  );
  const existingNames = new Set(
    [...existingPendingRemote, ...localPending].map(c=>((c.first||'')+' '+(c.last||'')).toLowerCase().trim())
  );

  const scraped = state.scraped || {};
  const contacts = [];

  // Distribute target evenly across institutions
  const perInst = Math.max(3, Math.ceil(TARGET / toScrape.length));

  for (const inst of toScrape) {
    if (contacts.length >= TARGET) break;
    try {
      const newOnes = await scrapeOpenAlex(scraped, inst, perInst);
      contacts.push(...newOnes);
    } catch (e) {
      console.error(`  Error scraping ${inst.name}:`, e.message);
    }
  }

  // Dedup — email required (constructed emails count), matching the app's rule
  // that unverified contacts still need a starting point for outreach.
  const toInsert = [];
  const localPendingOut = [...localPending];
  let skippedNoEmail = 0;
  for (const c of contacts) {
    const el = (c.email||'').toLowerCase().trim();
    const nl = ((c.first||'')+' '+(c.last||'')).toLowerCase().trim();
    if (!el) { skippedNoEmail++; continue; }
    if (existingEmails.has(el)) continue;
    if (existingNames.has(nl)) continue;
    // id is local-only (audit trail): pending_contacts.id is a Postgres uuid
    // column with its own default, and this disc_<key>_<ts>_<rand> format
    // isn't a valid uuid — sending it as the row's id makes every insert
    // fail with 22P02 ("invalid input syntax for type uuid"). Let Postgres
    // generate the real id and keep this one only in the local JSON file.
    const id = makeId(c.instId || 'xx');
    toInsert.push({
      first: c.first, last: c.last, title: c.title, department: c.dept,
      institution_id: c.instId, institution_name: c.instName, email: c.email,
      research: c.research, source_url: c.source,
      notes: c.constructed ? 'Email constructed — please verify' : '',
      status: 'pending',
      region: 'denmark',
    });
    localPendingOut.push({ ...c, id });
    existingEmails.add(el); existingNames.add(nl);
  }
  if (skippedNoEmail) console.log(`Skipped ${skippedNoEmail} contact(s) with no email address`);

  let added = 0;
  let insertFailed = false;
  try {
    added = await insertPendingContacts(toInsert);
  } catch (e) {
    console.error('Supabase insert error:', e.message);
    insertFailed = true;
  }

  state.scraped  = scraped;
  state.lastRun  = new Date().toISOString();
  state.lastTypes = [...enabledTypes];
  state.lastAddedCount = added;

  saveJSON(STATE_FILE, state);
  // Only persist the audit trail if the insert actually succeeded — writing
  // it after a failed insert would make these candidates look "already
  // found" on every future run (existingEmails/existingNames is seeded from
  // this file), permanently blacklisting contacts that were never actually
  // saved to Supabase.
  if (!insertFailed) {
    saveJSON(PENDING_FILE, localPendingOut); // local audit trail only
  } else {
    console.warn(`Skipping local audit-trail write — Supabase insert failed, so these ${toInsert.length} candidate(s) will be retried next run.`);
  }
  console.log(`Done — added ${added} new contacts to Supabase pending_contacts (found ${toInsert.length} candidates)`);
}

main().catch(e => { console.error(e); process.exit(1); });
