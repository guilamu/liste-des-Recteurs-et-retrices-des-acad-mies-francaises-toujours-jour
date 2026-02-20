const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const CORSE_FALLBACK_URL = "https://lannuaire.service-public.gouv.fr/navigation/corse/corse-du-sud/rectorat";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

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

async function scrapeCorseFallback(browser) {
  console.log(" 🚑 Activation du fallback Corse...");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto(CORSE_FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: 5000 });

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
  // Launch in headless mode for CI environment
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`🔍 Navigation vers l'index : ${INDEX_URL}`);
    await page.goto(INDEX_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait 10 seconds for initial loading/Cloudflare checks
    console.log("⏳ Attente de 10s pour chargement initial...");
    await new Promise(resolve => setTimeout(resolve, 10000));

    // DEBUG: Sauvegarder le HTML pour analyse
    const htmlContent = await page.content();
    fs.writeFileSync(path.join(__dirname, 'debug_page.html'), htmlContent);
    console.log("📄 HTML de la page sauvegardé dans debug_page.html");

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

    if (academies.length === 0) {
      console.error("🚨 ERREUR CRITIQUE : Aucune académie trouvée dans le sélecteur !");
      console.error("Le site a probablement bloqué le scraping (Cloudflare/WAF).");
      console.error("URL testée :", INDEX_URL);
      process.exit(1);
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

        // 2a. Découvrir l'URL via la carte interactive ou le menu déroulant
        try {
          console.log(" 🔍 Découverte de l'URL...");

          // On retourne sur l'index si on n'y est pas
          if (!page.url().includes('les-regions-academiques')) {
            console.log(" 🔙 Retour à la carte...");
            await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(resolve => setTimeout(resolve, 2000));
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

          // Petite pause pour laisser Cloudflare tranquille
          await new Promise(resolve => setTimeout(resolve, 2000));

          const currentUrl = page.url();
          if (currentUrl !== INDEX_URL) {
            academieUrl = currentUrl;
            console.log(` ✓ URL trouvée: ${academieUrl}`);
          }

        } catch (e) {
          console.error(` ❌ Erreur découverte URL: ${e.message}`);
        }

        if (!academieUrl) {
          console.log(` ⚠️ URL non trouvée pour ${academie.name}`);
          results.push({
            academie: academie.name,
            error: "URL non trouvée",
            updated_at: new Date().toISOString()
          });
          continue;
        }

        // 2b. Extraire le recteur depuis cette URL
        let found = false;

        try {
          console.log(" 📄 Extraction du recteur...");

          await page.goto(academieUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

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
          console.error(` ❌ Erreur extraction: ${e.message}`);
        }

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

          // DEBUG: Sauvegarder la page en cas d'échec
          const failedHtml = await page.content();
          fs.writeFileSync(path.join(__dirname, `debug_failed_${academie.slug}.html`), failedHtml);
          console.log(` 📄 HTML sauvegardé dans debug_failed_${academie.slug}.html`);

          results.push({
            academie: academie.name,
            error: "Non trouvé",
            url: academieUrl,
            updated_at: new Date().toISOString()
          });
        }

      } catch (globalError) {
        // Catch-all par académie : une erreur ne tue pas le reste du scraping
        console.error(` 💥 Erreur fatale pour ${academie.name}: ${globalError.message}`);
        results.push({
          academie: academie.name,
          error: `Erreur fatale: ${globalError.message}`,
          updated_at: new Date().toISOString()
        });
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
      console.error(`\n⚠️  ${errorsCount} académie(s) en échec :`);
      failedAcademies.forEach(name => console.error(`   - ${name}`));

      // Créer un fichier d'erreur pour GitHub Actions
      fs.writeFileSync(
        path.join(__dirname, 'scraper-errors.json'),
        JSON.stringify({
          count: errorsCount,
          academies: failedAcademies,
          timestamp: new Date().toISOString()
        }, null, 2)
      );

      // Faire échouer le process pour déclencher les notifications
      process.exit(1);
    }

  } catch (error) {
    console.error("🚨 Erreur globale:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrape();
