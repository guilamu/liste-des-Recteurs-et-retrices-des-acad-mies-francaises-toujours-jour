const { connect } = require('puppeteer-real-browser');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const CORSE_FALLBACK_URL = "https://lannuaire.service-public.gouv.fr/navigation/corse/corse-du-sud/rectorat";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Le site est protégé par un "managed challenge" Cloudflare : la première
// navigation renvoie un interstitiel ("Just a moment...") qui ne contient
// aucun contenu utile. Il faut laisser au challenge le temps de se résoudre
// avant de lire le DOM — d'où les attentes conditionnelles ci-dessous.
const CHALLENGE_TIMEOUT = 60000;   // attente max sur l'index (challenge inclus)
const PAGE_READY_TIMEOUT = 30000;  // attente max sur une page académie

// ---------- History helpers ----------

function canonicalName(nom) {
  return (nom || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function editDistanceHistory(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
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

function samePersonName(a, b) {
  if (canonicalName(a) === canonicalName(b)) return true;
  return editDistanceHistory(a, b) <= 2;
}

/**
 * Loads history.json or returns an empty object.
 */
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

/**
 * Compares new rector data against the history and records changes.
 * Returns the updated history map (does NOT write to disk).
 */
function updateHistory(history, newRectors) {
  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;

  for (const rector of newRectors) {
    if (rector.error || !rector.nom) continue;

    const acad = rector.academie;
    const nom = (rector.nom || '').trim();
    const genre = (rector.genre || '').trim();

    if (!history[acad]) history[acad] = [];

    const entries = history[acad];
    const last = entries[entries.length - 1];

    if (!last) {
      entries.push({ nom, genre, since: today });
      changed++;
    } else if (!samePersonName(last.nom, nom)) {
      console.log(`\n📜 Changement détecté pour ${acad}:`);
      console.log(`   ${last.genre} ${last.nom} → ${genre} ${nom}`);
      entries.push({ nom, genre, since: today });
      changed++;
    } else if (last.nom !== nom) {
      // Same person, name reformatted (e.g., normalization) — update in-place
      last.nom = nom;
      last.genre = genre;
    }
  }

  if (changed > 0) {
    console.log(`\n📜 ${changed} changement(s) enregistré(s) dans l'historique.`);
  } else {
    console.log('\n📜 Aucun changement de recteur détecté.');
  }

  return history;
}


// Regex pour extraire le nom du recteur
const RECTOR_REGEX = /\b(M\.|Mme)\s+(.+?)(?=\s+est\s+(?:recteur|rectrice|nomm)|,)/i;

// Fallback regex quand M./Mme est absent - capture le nom avant un titre professionnel
const RECTOR_FALLBACK_REGEX = /([A-ZÀ-ÿ][a-zA-ZÀ-ÿ\-]+(?:\s+[A-ZÀ-ÿ][a-zA-ZÀ-ÿ\-]+)+)\s*,\s*(?:administrateur|administratrice|conseiller|conseillère|recteur|rectrice|maître|maîtresse|professeur|professeure|chancelier|chancelière|inspecteur|inspectrice)/i;

// Regex pour extraire la date de nomination après "Décret du"
const DECREE_DATE_REGEX = /Décret du\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i;

// Conversion des mois français en numéros
const FRENCH_MONTHS = {
  'janvier': '01', 'février': '02', 'mars': '03', 'avril': '04',
  'mai': '05', 'juin': '06', 'juillet': '07', 'août': '08',
  'septembre': '09', 'octobre': '10', 'novembre': '11', 'décembre': '12'
};

/**
 * Extrait et formate la date de nomination depuis le texte
 * @param {string} text - Le texte à analyser
 * @returns {string} - Date au format DD/MM/YYYY ou "Inconnue"
 */
function extractDecreeDate(text) {
  const match = text.match(DECREE_DATE_REGEX);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = FRENCH_MONTHS[match[2].toLowerCase()];
    const year = match[3];
    return `${day}/${month}/${year}`;
  }
  return 'Inconnue';
}

/**
 * Normalise un nom : première lettre de chaque mot en majuscule, reste en minuscule
 * Gère les noms composés avec tirets (ex: DECOUT-PAOLINI -> Decout-Paolini)
 * @param {string} name - Le nom à normaliser
 * @returns {string} - Le nom normalisé
 */
function normalizeName(name) {
  return name
    .split(/(\s+|-)/) // Sépare par espaces ou tirets, garde les séparateurs
    .map(part => {
      if (part.match(/^[\s-]+$/)) return part; // Garde les séparateurs tels quels
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Renvoie un état de diagnostic de la page courante.
 * Sert à distinguer un blocage Cloudflare d'un changement de structure du site.
 */
async function inspectPage(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      challenge: /just a moment|un instant|attention required|verifying you are human/i.test(document.title)
        || !!document.querySelector('#challenge-form, #challenge-running, [name="cf-turnstile-response"]'),
      textLength: (document.body && document.body.innerText || '').length
    }));
  } catch (e) {
    return { title: '?', url: '?', challenge: false, textLength: 0, error: e.message };
  }
}

/**
 * Attend que la page réellement voulue soit rendue (et non l'interstitiel Cloudflare).
 * Remplace les `setTimeout` fixes : on attend une condition, pas une durée.
 *
 * @param {import('rebrowser-puppeteer-core').Page} page
 * @param {() => boolean} predicate - exécuté dans le contexte de la page
 * @param {number} timeout
 * @returns {Promise<boolean>} true si la condition est remplie dans les temps
 */
async function waitForRealPage(page, predicate, timeout) {
  try {
    await page.waitForFunction(predicate, { timeout, polling: 500 });
    return true;
  } catch (e) {
    return false;
  }
}

// Prédicat : le sélecteur d'académies est présent ET peuplé.
function indexReadyPredicate() {
  const select = document.querySelector('.svg-select');
  if (!select) return false;
  return Array.from(select.querySelectorAll('option')).some(o => o.value && o.value !== '');
}

// Prédicat : on n'est plus sur un interstitiel Cloudflare et le contenu est rendu.
function contentReadyPredicate() {
  const isChallenge = /just a moment|un instant|attention required|verifying you are human/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running');
  if (isChallenge) return false;
  return !!document.querySelector('main, .fr-container, .fr-highlight, article');
}

async function scrapeCorseFallback(browser) {
  console.log(" 🚑 Activation du fallback Corse...");
  // Pas de setViewport : on garde la taille réelle de la fenêtre (un viewport
  // incohérent avec la fenêtre est un signal de détection). Les pages créées
  // ici sont automatiquement patchées par puppeteer-real-browser
  // (hook `targetcreated`), le challenge y est donc géré aussi.
  const page = await browser.newPage();

  try {
    await page.goto(CORSE_FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT });
    await waitForRealPage(page, contentReadyPredicate, PAGE_READY_TIMEOUT);

    const linkElement = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.find(a => a.textContent.includes('Rectorat - Académie de Corse'));
    });

    if (linkElement && (await linkElement.jsonValue()) !== undefined) {
      console.log(" -> Lien annuaire trouvé, clic...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        linkElement.click()
      ]);

      const content = await page.content();
      const $ = cheerio.load(content);

      let genre = null;
      let fullName = null;

      const elementsRecteur = $('*').filter((i, el) => {
        return $(el).text().includes("Recteur d'académie");
      });

      elementsRecteur.each((i, el) => {
        if (fullName) return;

        const parentText = $(el).parent().text().replace(/\s+/g, ' ');
        const regexLigneSuivante = /Recteur d'académie.*?académique\s*(?:(M\.|Mme)\s+)?([A-ZÀ-ÿ][a-zA-ZÀ-ÿ\s-]+?)(?=,)/i;
        const match = parentText.match(regexLigneSuivante);

        if (match) {
          genre = match[1] || "M.";
          fullName = normalizeName(match[2].trim());

          if (fullName.toLowerCase().includes('académie') || fullName.toLowerCase().includes('recteur')) {
            fullName = null;
          }
        }
      });

      if (fullName) {
        console.log(` ★ Trouvé via Fallback : ${fullName} (${genre})`);
        return { genre, nom: fullName, url: page.url() };
      }
    }

    return null;

  } catch (e) {
    console.error(` ❌ Erreur Fallback Corse: ${e.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrape() {
  console.log("🚀 Lancement du navigateur...");
  // Chrome RÉEL en mode headful (sous Xvfb en CI) : le mode headless de
  // Puppeteer est détecté par le managed challenge Cloudflare, quelle que
  // soit l'IP utilisée. puppeteer-real-browser s'appuie sur
  // rebrowser-puppeteer-core (pas de fuite CDP `Runtime.enable`), démarre
  // Xvfb automatiquement sous Linux et résout le Turnstile (`turnstile: true`).
  const proxyUrl = process.env.PUPPETEER_PROXY;
  const proxyArgs = proxyUrl ? [`--proxy-server=${proxyUrl}`] : [];
  if (proxyUrl) console.log(`🌐 Proxy actif : ${proxyUrl}`);
  else console.log('🌐 Mode direct (pas de proxy)');

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyArgs],
    connectOption: { defaultViewport: null }
  });

  const results = [];

  try {
    console.log(`🔍 Navigation vers l'index : ${INDEX_URL}`);
    await page.goto(INDEX_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Attente CONDITIONNELLE (et non plus un setTimeout fixe de 3s) : on attend
    // que le sélecteur d'académies soit réellement peuplé. Un managed challenge
    // Cloudflare met 5 à 15s à se résoudre — l'ancienne attente fixe lisait le
    // DOM de l'interstitiel et concluait à tort « 0 académies ».
    console.log(`⏳ Attente du rendu réel de la page (challenge Cloudflare éventuel, max ${CHALLENGE_TIMEOUT / 1000}s)...`);
    const indexReady = await waitForRealPage(page, indexReadyPredicate, CHALLENGE_TIMEOUT);

    // DEBUG: Sauvegarder le HTML pour analyse
    const htmlContent = await page.content();
    fs.writeFileSync(path.join(__dirname, 'debug_page.html'), htmlContent);
    console.log("📄 HTML de la page sauvegardé dans debug_page.html");

    if (!indexReady) {
      // Diagnostic explicite : distinguer blocage Cloudflare et changement de structure.
      const diag = await inspectPage(page);
      console.error("🚨 ERREUR CRITIQUE : le sélecteur d'académies n'est jamais apparu.");
      console.error(`   Titre de la page : "${diag.title}"`);
      console.error(`   URL finale       : ${diag.url}`);
      console.error(`   Taille du texte  : ${diag.textLength} caractères`);
      if (diag.challenge) {
        console.error("   → Challenge Cloudflare NON résolu (le navigateur est resté sur l'interstitiel).");
        console.error("     Piste : IP du runner blacklistée, ou durcissement de la politique Cloudflare.");
      } else {
        console.error("   → Pas de challenge détecté : la STRUCTURE du site a probablement changé.");
        console.error("     Piste : vérifier que '.svg-select' existe toujours dans debug_page.html.");
      }
      console.error(`   URL testée : ${INDEX_URL}`);
      process.exit(1);
    }
    console.log("✅ Page réelle chargée (challenge franchi).");

    // ÉTAPE 1 : Récupérer la liste des académies depuis le select
    const academies = await page.evaluate(() => {
      const select = document.querySelector('.svg-select');
      if (!select) return [];

      return Array.from(select.querySelectorAll('option'))
        .filter(opt => opt.value && opt.value !== '')
        .map(opt => ({
          name: opt.textContent.trim(),
          slug: opt.value
        }));
    });

    console.log(`✅ ${academies.length} académies trouvées.\n`);

    // Garde-fou : ne devrait plus se déclencher, l'attente conditionnelle
    // ci-dessus garantit déjà un sélecteur peuplé.
    if (academies.length === 0) {
      console.error("🚨 ERREUR CRITIQUE : Aucune académie trouvée dans le sélecteur !");
      console.error("URL testée :", INDEX_URL);
      process.exit(1);
    }

    // ÉTAPE 1b : Récupérer les URLs directement via l'API JSON (méthode principale)
    // L'index contient un attribut data-api-url="/svgmaps/block/716" qui retourne
    // un JSON avec tous les slugs → URLs des pages académies.
    let apiUrlMap = null;
    try {
      apiUrlMap = await page.evaluate(async () => {
        const block = document.querySelector('.svg-block[data-api-url]');
        const apiPath = block ? block.getAttribute('data-api-url') : '/svgmaps/block/716';
        try {
          const resp = await fetch(apiPath);
          const data = await resp.json();
          if (data && data.content) {
            const map = {};
            for (const [slug, info] of Object.entries(data.content)) {
              map[slug] = { title: info.title, link: info.link };
            }
            return map;
          }
        } catch (e) { /* handled below */ }
        return null;
      });

      if (apiUrlMap) {
        console.log(`🔗 ${Object.keys(apiUrlMap).length} URLs récupérées via l'API JSON.`);
      } else {
        console.log("⚠️ API JSON indisponible, fallback sur carte/menu déroulant.");
      }
    } catch (e) {
      console.log(`⚠️ Erreur API JSON (${e.message}), fallback sur carte/menu déroulant.`);
    }

    // CHARGER LES RÉSULTATS EXISTANTS
    let existingResults = [];
    if (fs.existsSync(OUTPUT_FILE)) {
      try {
        existingResults = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        console.log(`📂 Fichiers existants chargés : ${existingResults.length} entrées.`);
      } catch (e) {
        console.error("⚠️ Erreur lecture fichier existant, on repart de zéro.");
      }
    }

    // Helper : chercher une entrée valide existante pour une académie
    function findExistingValid(academieName) {
      return existingResults.find(r => r.academie === academieName && !r.error);
    }

    // On scrape TOUT pour être toujours à jour
    const academiesToScrape = academies;

    console.log(`📋 Traitement de ${academiesToScrape.length} académies (Mode: Mise à jour complète)\n`);

    // ÉTAPE 2 : Pour chaque académie, découvrir l'URL ET extraire le recteur
    for (let i = 0; i < academiesToScrape.length; i++) {
      const academie = academiesToScrape[i];
      let academieUrl = null;
      console.log(`\n[${i + 1}/${academiesToScrape.length}] ${academie.name}`);

      console.log("─".repeat(50));

      try { // ← try/catch global par académie

        // 2a. Découvrir l'URL de la page académie
        try {
          console.log(" 🔍 Découverte de l'URL...");

          // MÉTHODE PRINCIPALE : URL depuis l'API JSON
          if (apiUrlMap && apiUrlMap[academie.slug]) {
            academieUrl = `https://www.education.gouv.fr${apiUrlMap[academie.slug].link}`;
            console.log(` ✓ URL via API : ${academieUrl}`);
          }

          // FAILSAFE : Carte SVG interactive ou menu déroulant (si API indisponible ou slug absent)
          if (!academieUrl) {
            console.log(` ⚠️ Fallback carte/menu pour ${academie.slug}...`);

            // On retourne sur l'index si on n'y est pas
            if (!page.url().includes('les-regions-academiques')) {
              console.log(" 🔙 Retour à la carte...");
              await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await waitForRealPage(page, indexReadyPredicate, CHALLENGE_TIMEOUT);
            }

            let mapClickSuccess = false;

            // TENTATIVE 1 : Via la carte SVG (Sauf pour les DOM-TOM qui peuvent poser problème)
            try {
              const regionSelector = `[data-region="${academie.slug}"]`;
              // Timeout court (2s) pour ne pas perdre de temps si l'élément n'existe pas (ex: DOM-TOM)
              await page.waitForSelector(regionSelector, { timeout: 2000 });

              console.log(` 🖱️ Clic sur la région carte ${academie.slug}...`);
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                page.click(regionSelector)
              ]);
              mapClickSuccess = true;
            } catch (mapError) {
              console.log(` ⚠️ Pas de région cliquable identifiée pour ${academie.slug} (ou timeout), essai via menu déroulant...`);
            }

            // TENTATIVE 2 : Via le menu déroulant (si carte échouée)
            if (!mapClickSuccess) {
              console.log(` 🔽 Sélection via menu déroulant pour ${academie.slug}...`);

              // Sélectionner l'option
              await page.select('.svg-select', academie.slug);

              // Cliquer sur le bouton OK (classe .svg-submit vérifiée)
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                page.click('.svg-submit')
              ]);
            }

            // Attendre le rendu réel plutôt qu'une pause arbitraire
            await waitForRealPage(page, contentReadyPredicate, PAGE_READY_TIMEOUT);

            const currentUrl = page.url();
            if (currentUrl !== INDEX_URL) {
              academieUrl = currentUrl;
              console.log(` ✓ URL trouvée via fallback: ${academieUrl}`);
            }
          }

        } catch (e) {
          console.error(` ❌ Erreur découverte URL: ${e.message}`);
        }

        if (!academieUrl) {
          console.log(` ⚠️ URL non trouvée pour ${academie.name}`);
          const existing = findExistingValid(academie.name);
          if (existing) {
            console.log(` 🔄 Conservation des données existantes pour ${academie.name} (${existing.nom})`);
            results.push(existing);
          } else {
            results.push({
              academie: academie.name,
              error: "URL non trouvée",
              updated_at: new Date().toISOString()
            });
          }
          continue;
        }

        // 2b. Extraire le recteur depuis cette URL (avec retry)
        let found = false;
        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES && !found; attempt++) {
          try {
            if (attempt > 1) {
              console.log(` 🔄 Tentative ${attempt}/${MAX_RETRIES}...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            console.log(" 📄 Extraction du recteur...");

            await page.goto(academieUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Cloudflare peut réintercaler un challenge sur n'importe quelle page :
            // on attend le contenu réel avant de lire le HTML, sinon cheerio
            // analyserait l'interstitiel et conclurait « Nom non trouvé ».
            const contentReady = await waitForRealPage(page, contentReadyPredicate, PAGE_READY_TIMEOUT);
            if (!contentReady) {
              const diag = await inspectPage(page);
              throw new Error(diag.challenge
                ? `challenge Cloudflare non résolu sur la page académie (titre: "${diag.title}")`
                : `contenu de la page jamais rendu (titre: "${diag.title}")`);
            }

          const pageHtml = await page.content();
          // DEBUG: Sauvegarder le HTML de la page académie
          fs.writeFileSync(path.join(__dirname, `debug_academy_${academie.slug}.html`), pageHtml);
          const $page = cheerio.load(pageHtml);

          let genre = null;
          let nom = null;

          // Définir fullTextContent ici pour qu'il soit accessible partout
          const fullTextContent = $page('body').text().replace(/\s+/g, ' ');

          // 1. Essayer d'extraire depuis .fr-highlight (Nouveau format DSFR)
          // 1. Essayer d'extraire depuis .fr-highlight (Nouveau format DSFR)
          const highlightElement = $page('.fr-highlight');
          if (highlightElement.length > 0) {
            // Stratégie 1A : Chercher un <strong> qui contient souvent le nom propre
            const strongTag = highlightElement.find('strong');
            if (strongTag.length > 0) {
              const strongText = strongTag.text().trim();
              // Vérifier si ça ressemble à un nom (M. X ou juste X)
              let matchStrong = strongText.match(/\b(M\.|Mme)\s+(.+)/i);
              if (matchStrong) {
                genre = matchStrong[1];
                nom = normalizeName(matchStrong[2].trim());
                console.log(` ✓ Trouvé via .fr-highlight > strong : ${genre} ${nom}`);
              } else {
                // Si pas de civilité dans le strong, peut-être juste le nom ?
                // On essaye de voir si c'est un nom propre
                if (strongText.length > 3 && !strongText.toLowerCase().includes('recteur') && !strongText.toLowerCase().includes('vice-')) {
                  genre = "M."; // Par défaut si manque
                  nom = normalizeName(strongText);
                  console.log(` ✓ Trouvé via .fr-highlight > strong (guess): ${genre} ${nom}`);
                }
              }
            }

            // Stratégie 1B : Regex classique sur tout le texte du highlight
            if (!nom) {
              const highlightText = highlightElement.text().replace(/\s+/g, ' ');
              let match = highlightText.match(RECTOR_REGEX);
              if (match) {
                genre = match[1];
                nom = normalizeName(match[2].trim());
                console.log(` ✓ Trouvé via .fr-highlight (regex): ${genre} ${nom}`);
              }
            }
          }

          // Nettoyage post-extraction : Couper " Est " si présent (cas mal gérés par regex)
          if (nom && /\s+est\s+/i.test(nom)) {
            console.log(` 🧹 Nettoyage du nom : "${nom}" contient "est"...`);
            nom = nom.split(/\s+est\s+/i)[0].trim();
            console.log(`   -> Nom nettoyé : "${nom}"`);
          }

          // 2. Fallback sur l'ancienne méthode si non trouvé
          if (!nom) {
            // Extraire le texte uniquement des blockquotes (où se trouvent les nominations)
            const blockquoteText = $page('blockquote').text().replace(/\s+/g, ' ');

            // Utiliser le texte des blockquotes pour l'extraction du nom
            const textForName = blockquoteText || fullTextContent;

            let match = textForName.match(RECTOR_REGEX);

            if (match) {
              genre = match[1];
              nom = normalizeName(match[2].trim());
            } else {
              // Fallback: essayer de trouver un nom sans M./Mme
              const fallbackMatch = textForName.match(RECTOR_FALLBACK_REGEX);
              if (fallbackMatch) {
                genre = 'M.'; // Défaut à M. si pas de préfixe
                nom = normalizeName(fallbackMatch[1].trim());
                console.log(` ℹ️  Fallback regex utilisé (pas de M./Mme détecté)`);
              }
            }
          }

          if (nom) {
            // Extraction des nouvelles données : Adresse, Téléphone, Email via attributs robustes
            const rawAdresse = $page('[data-component-id="tandem_dsfr:adresse"] .coordinate').text().trim().replace(/\s+/g, ' ');
            let adresse = "-";
            if (rawAdresse) {
              const osmUrl = `https://www.openstreetmap.org/search?query=${encodeURIComponent(rawAdresse).replace(/%20/g, '+')}`;
              adresse = `<a href="${osmUrl}" target="_blank">📍</a>`;
            }

            let telephone = $page('[data-component-id="tandem_dsfr:telephone"] .coordinate').text().trim().replace(/\s*\(.*?\)/g, '');
            let email = $page('[data-component-id="tandem_dsfr:email"] .coordinate').text().trim();

            if (!email) email = "-";
            if (!telephone) telephone = "-"; // Au cas où

            let finalUrl = academieUrl;

            // 1. Essayer de récupérer l'URL officielle dans la carte (bouton en bas)
            const cardUrl = $page('.fr-card__end a').attr('href');
            if (cardUrl) {
              finalUrl = cardUrl;
              console.log(` 🔗 URL officielle (carte) : ${finalUrl}`);
            } else if (email && email !== "-" && email.includes('@')) {
              // 2. Fallback via email si pas de bouton
              const domain = email.split('@')[1];
              if (domain) {
                finalUrl = `https://www.${domain}`;
                console.log(` 🔗 URL déduite (email) : ${finalUrl}`);
              }
            }

            console.log(` ★ Trouvé : ${genre} ${nom}`);
            console.log(` 📍 Adresse : ${adresse}`);
            console.log(` 📞 Téléphone : ${telephone}`);
            console.log(` 📧 Email : ${email}`);
            console.log(` 🔗 URL : ${finalUrl}`);

            results.push({
              academie: academie.name,
              genre: genre,
              nom: nom,
              adresse: adresse,
              telephone: telephone,
              email: email,
              url: finalUrl,
              updated_at: new Date().toISOString()
            });
            found = true;
          } else {
            console.log("   ❌ Nom non trouvé dans le contenu extrait.");
          }

        } catch (e) {
          if (attempt < MAX_RETRIES) {
            console.warn(` ⚠️ Erreur extraction (tentative ${attempt}/${MAX_RETRIES}): ${e.message}`);
          } else {
            console.error(` ❌ Erreur extraction après ${MAX_RETRIES} tentatives: ${e.message}`);
          }
        }
        } // fin boucle retry

        // 2c. Fallback pour la Corse
        if (!found && academie.name.toLowerCase().includes('corse')) {
          const fallbackResult = await scrapeCorseFallback(browser);
          if (fallbackResult) {
            results.push({
              academie: academie.name,
              genre: fallbackResult.genre,
              nom: fallbackResult.nom,
              url: fallbackResult.url,
              updated_at: new Date().toISOString()
            });
            found = true;
          }
        }

        // 2d. Si rien trouvé
        if (!found) {
          console.log(` ⚠️ Aucun recteur trouvé`);

          // DEBUG: Sauvegarder la page en cas d'échec (avec timeout pour éviter un blocage
          // si la page est restée dans un état cassé après des timeouts de navigation)
          try {
            const failedHtml = await Promise.race([
              page.content(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('content() timeout')), 5000))
            ]);
            fs.writeFileSync(path.join(__dirname, `debug_failed_${academie.slug}.html`), failedHtml);
            console.log(` 📄 HTML sauvegardé dans debug_failed_${academie.slug}.html`);
          } catch (debugErr) {
            console.log(` ⚠️ Impossible de sauvegarder le HTML de debug (${debugErr.message})`);
          }

          // Réinitialiser la page pour éviter qu'une navigation cassée bloque les académies suivantes
          try { await page.goto('about:blank', { timeout: 5000 }); } catch (_) { /* best effort */ }

          const existing = findExistingValid(academie.name);
          if (existing) {
            console.log(` 🔄 Conservation des données existantes pour ${academie.name} (${existing.nom})`);
            results.push(existing);
          } else {
            results.push({
              academie: academie.name,
              error: "Non trouvé",
              url: academieUrl,
              updated_at: new Date().toISOString()
            });
          }
        }

      } catch (globalError) {
        // Catch-all par académie : une erreur ne tue pas le reste du scraping
        console.error(` 💥 Erreur fatale pour ${academie.name}: ${globalError.message}`);
        const existing = findExistingValid(academie.name);
        if (existing) {
          console.log(` 🔄 Conservation des données existantes pour ${academie.name} (${existing.nom})`);
          results.push(existing);
        } else {
          results.push({
            academie: academie.name,
            error: `Erreur fatale: ${globalError.message}`,
            updated_at: new Date().toISOString()
          });
        }
      } // fin try/catch global par académie
    }

    // ÉTAPE 3 : Sauvegarder les résultats (Fusion avec les existants)
    // On prend les anciens succès + les nouveaux résultats (succès ou échecs)
    // Attention : on doit retirer des anciens résultats ceux qu'on vient de re-traiter (s'ils étaient en erreur avant)

    const newAcademiesNames = new Set(results.map(r => r.academie));
    const finalResults = [
      ...existingResults.filter(r => !newAcademiesNames.has(r.academie)), // Garder les anciens non re-traités
      ...results // Ajouter les nouveaux
    ];

    // Trier par nom d'académie pour la propreté
    finalResults.sort((a, b) => a.academie.localeCompare(b.academie));

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResults, null, 2));
    console.log(`\n${"=".repeat(60)}`);
    console.log(`💾 Sauvegardé dans ${OUTPUT_FILE}`);

    const successCount = finalResults.filter(r => !r.error).length;
    const totalCount = finalResults.length;
    const successRate = totalCount > 0 ? (successCount / totalCount * 100).toFixed(1) : 0;
    console.log(`📊 Résumé Global : ${successCount}/${totalCount} recteurs trouvés (${successRate}%)`);

    if (successCount < totalCount * 0.5) {
      console.error(`🚨 Taux de succès trop bas (${successRate}%) - possible blocage du site`);
      process.exit(1);
    }

    // NOUVEAU : Mise à jour de l'historique des recteurs
    const history = loadHistory();
    const updatedHistory = updateHistory(history, finalResults);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(updatedHistory, null, 2));
    console.log(`📜 Historique mis à jour dans ${HISTORY_FILE}`);

    // NOUVEAU : Compter et signaler les erreurs (sur la totalité ou juste ce run ?)
    // Signalons les erreurs globales pour avoir une vue d'ensemble
    const errorsCount = finalResults.filter(r => r.error).length;
    const failedAcademies = finalResults.filter(r => r.error).map(r => r.academie);


    if (errorsCount > 0) {
      console.warn(`\n⚠️  ${errorsCount} académie(s) en échec (données précédentes conservées) :`);
      failedAcademies.forEach(name => console.warn(`   - ${name}`));

      // Créer un fichier d'erreur pour GitHub Actions (info seulement, ne bloque pas le commit)
      fs.writeFileSync(
        path.join(__dirname, 'scraper-errors.json'),
        JSON.stringify({
          count: errorsCount,
          academies: failedAcademies,
          timestamp: new Date().toISOString()
        }, null, 2)
      );
      // On ne fait PAS process.exit(1) ici : les académies réussies doivent être commitées.
      // Le seuil de <50% (ci-dessus) reste la seule condition de blocage.
    }

  } catch (error) {
    console.error("🚨 Erreur globale:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrape();
