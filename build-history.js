/**
 * build-history.js
 * Fetches all historical versions of recteurs.json from GitHub commits,
 * compares them chronologically, and builds a history.json file
 * containing per-academy change logs.
 *
 * Usage: node build-history.js
 *
 * Output: history.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = 'guilamu';
const REPO = 'liste-des-Recteurs-et-retrices-des-acad-mies-francaises-toujours-jour';
const HISTORY_FILE = path.join(__dirname, 'history.json');

// ---------- Name canonicalization & validation ----------

/**
 * Returns true if the name looks like a sentence / scraping artifact
 * (too long, or contains typical webpage noise keywords, or too few words).
 */
function isBadName(nom) {
  if (!nom || nom.trim() === '') return true;
  if (nom.length > 60) return true; // sentences are always longer than 60 chars
  const lower = nom.toLowerCase();
  const noise = ['est nommé', 'est vice-rect', 'pour aller plus loin', 'annuaire',
                 'est recteur', 'est rectrice', 'est chef du', 'coordonnées',
                 'académie de', 'page à consulter', 'en hiver', 'en été',
                 'en automne', 'en printemps'];
  if (noise.some(kw => lower.includes(kw))) return true;
  // Must have at least 2 word-like tokens (first name + last name)
  const words = nom.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) return true;
  return false;
}

/**
 * Simple Levenshtein edit distance between two strings (case-insensitive).
 * Returns Infinity if strings are clearly too different (avoids full computation).
 */
function editDistance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return Infinity; // quick reject
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns true if two names are considered the same person,
 * either by canonical equality or by near-duplicate (edit distance ≤ 2).
 */
function samePersonName(a, b) {
  if (canonicalName(a) === canonicalName(b)) return true;
  return editDistance(a, b) <= 2;
}

/**
 * Returns a canonical (comparison-only) key from a rector name:
 * lowercase, trimmed, extra spaces collapsed.
 * This means "Rémi DECOUT-PAOLINI" and "Rémi Decout-Paolini" map to
 * the same key and won't create a false "change" entry.
 */
function canonicalName(nom) {
  return (nom || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize legacy academy names that were renamed between early commits
 * and current ones.
 */
const ACADEMY_ALIASES = {
  // Legacy names from early scraper versions → current canonical names
  'Saint-Pierre et Miquelon (Services de l\'EN)': 'Saint-Pierre-et-Miquelon',
  'Polynésie Française': 'Polynésie française',
  'Wallis et Futuna': 'Wallis-et-Futuna',
  'Guadeloupe (Région académique)': 'Guadeloupe',
  'La Martinique': 'Martinique',
};

function normalizeAcademy(acad) {
  return ACADEMY_ALIASES[acad] || acad;
}

// ---------- HTTP helpers ----------

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'build-history-script',
        'Accept': 'application/vnd.github+json',
        ...headers
      }
    };
    https.get(url, options, (res) => {
      // Follow redirects (GitHub raw content redirects)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchJSON(url) {
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  return JSON.parse(body);
}

async function fetchRaw(url) {
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  return body;
}

// ---------- GitHub helpers ----------

const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}`;

/**
 * Returns all commits that touched recteurs.json, oldest first.
 */
async function getAllCommits() {
  const commits = [];
  let page = 1;
  while (true) {
    const url = `${API_BASE}/commits?path=recteurs.json&per_page=100&page=${page}`;
    console.log(`  Fetching commit page ${page}...`);
    const data = await fetchJSON(url);
    if (!Array.isArray(data) || data.length === 0) break;
    commits.push(...data);
    if (data.length < 100) break;
    page++;
  }
  // Reverse to get chronological order (oldest first)
  commits.reverse();
  return commits;
}

/**
 * Fetch the recteurs.json content at a given commit SHA.
 */
async function getRectorsAtCommit(sha) {
  const url = `${RAW_BASE}/${sha}/recteurs.json`;
  const raw = await fetchRaw(url);
  return JSON.parse(raw);
}

// ---------- History builder ----------

/**
 * Loads existing history.json or returns an empty object.
 */
function loadExistingHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Merges a snapshot (array of rector objects) at a given date
 * into the history map.
 *
 * history shape:
 * {
 *   "Aix-Marseille": [
 *     { "nom": "...", "genre": "...", "since": "YYYY-MM-DD" },
 *     ...
 *   ]
 * }
 *
 * Rules:
 *  - Skip entries with empty or sentence-like names (scraping noise).
 *  - Compare names case-insensitively so ALLCAPS → TitleCase reformats
 *    don't register as a rector change.
 *  - Store the latest (presumably best-formatted) version of the name.
 */
function mergeSnapshot(history, rectors, dateStr) {
  for (const rector of rectors) {
    const acadRaw = rector.academie;
    if (!acadRaw) continue;

    const acad = normalizeAcademy(acadRaw);
    const nom   = (rector.nom   || '').trim();
    const genre = (rector.genre || '').trim();

    // Skip scraping artifacts / empty results
    if (isBadName(nom)) continue;

    if (!history[acad]) {
      history[acad] = [];
    }

    const entries = history[acad];
    const last = entries[entries.length - 1];

    if (!last || !samePersonName(last.nom, nom)) {
      // Genuinely new person — add an entry
      entries.push({ nom, genre, since: dateStr });
    } else if (last.nom !== nom) {
      // Same person, better-formatted name (e.g., ALLCAPS → TitleCase, minor typo corrected)
      last.nom   = nom;
      last.genre = genre;
    }
  }
}

// ---------- Main ----------

async function main() {
  console.log('=== build-history.js ===\n');

  // 1. Load existing history so we can do incremental updates
  const history = loadExistingHistory();
  const alreadyProcessed = new Set(
    // Keep a small aux file to avoid re-fetching processed commits
    (() => {
      const auxFile = path.join(__dirname, '.history-commits.json');
      if (fs.existsSync(auxFile)) {
        try { return JSON.parse(fs.readFileSync(auxFile, 'utf8')); } catch { return []; }
      }
      return [];
    })()
  );

  console.log('Fetching commit list from GitHub API...');
  const commits = await getAllCommits();
  console.log(`Found ${commits.length} commits total.\n`);

  const newShas = [];
  let processed = 0;
  let skipped = 0;

  for (const commit of commits) {
    const sha = commit.sha;
    const dateRaw = commit.commit?.committer?.date || commit.commit?.author?.date || '';
    const dateStr = dateRaw ? dateRaw.slice(0, 10) : 'unknown';

    if (alreadyProcessed.has(sha)) {
      skipped++;
      continue;
    }

    process.stdout.write(`  [${dateStr}] ${sha.slice(0, 7)} ... `);
    try {
      const rectors = await getRectorsAtCommit(sha);
      mergeSnapshot(history, rectors, dateStr);
      newShas.push(sha);
      processed++;
      console.log(`OK (${rectors.length} académies)`);
    } catch (err) {
      console.log(`SKIP (${err.message})`);
    }

    // Be polite to the GitHub API — short pause between requests
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. Processed: ${processed}, Skipped (already done): ${skipped}`);

  // Post-process: collapse entries that represent the same person,
  // either exact canonical match or near-duplicate (edit distance ≤ 2).
  // This handles: ALLCAPS → TitleCase reformats, single-char typos (e.g. "Bisagni-Faurer"),
  // and brief scraping glitches that are corrected within the same day.
  for (const acad of Object.keys(history)) {
    const entries = history[acad];
    const cleaned = [];
    for (const entry of entries) {
      const existing = cleaned.find(e => samePersonName(e.nom, entry.nom));
      if (existing) {
        // Same person reappeared — keep earliest `since`, update to latest nom/genre
        existing.nom   = entry.nom;
        existing.genre = entry.genre;
      } else {
        cleaned.push({ ...entry });
      }
    }
    history[acad] = cleaned;
  }

  // Save updated history
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ history.json written (${Object.keys(history).length} académies).`);

  // Save processed commit list
  const auxFile = path.join(__dirname, '.history-commits.json');
  const allProcessed = [...alreadyProcessed, ...newShas];
  fs.writeFileSync(auxFile, JSON.stringify(allProcessed, null, 2), 'utf8');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
