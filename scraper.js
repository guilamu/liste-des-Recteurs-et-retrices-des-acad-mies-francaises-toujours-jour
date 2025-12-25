const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// --- URLs ---
const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const BASE_URL = "https://www.education.gouv.fr";
const CORSE_FALLBACK_URL = "https://lannuaire.service-public.gouv.fr/navigation/corse/corse-du-sud/rectorat";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');

// Regex pour extraire le nom du recteur
const RECTOR_REGEX = /\b(M\.|Mme)\s+(.+?)(?=,|est nomm)/i;

// --- FONCTION FALLBACK CORSE ---
async function scrapeCorseFallback(browser) {
  console.log(" 🚑 Activation du fallback Corse...");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto(CORSE_FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
          fullName = match[2].trim();

          if (fullName.toLowerCase().includes('académie') || fullName.toLowerCase().includes('recteur')) {
            fullName = null;
          }
        }
      });

      if (fullName) {
        console.log(` ★ Trouvé via Fallback : ${fullName} (${genre})`);
        return { genre, nom: fullName, url: page.url() };
      } else {
        console.log(" ⚠️ Échec extraction nom après 'Recteur'.");
      }
    } else {
      console.log(" ⚠️ Lien 'Rectorat' introuvable.");
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
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`🔍 Navigation vers l'index : ${INDEX_URL}`);

    // Attendre le chargement complet du JavaScript
    await page.goto(INDEX_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    // Attendre que le JavaScript s'exécute (remplace page.waitForTimeout)
    console.log("⏳ Attente du chargement JavaScript...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Extraire tous les liens vers les académies après le rendu JS
    const linksToVisit = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/academie-"]'));
      return links
        .map(link => ({
          name: link.textContent.trim().replace(/\s+/g, ' '),
          url: link.href
        }))
        .filter((item, index, self) => 
          item.url && 
          item.name && 
          // Éliminer les doublons
          index === self.findIndex(t => t.url === item.url)
        );
    });

    console.log(`✅ ${linksToVisit.length} académies trouvées.`);

    if (linksToVisit.length === 0) {
      console.log("⚠️ Aucune académie détectée. Tentative alternative...");

      // Alternative : chercher dans les select/option
      const selectOptions = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select option[value*="/academie-"]'));
        return selects.map(opt => ({
          name: opt.textContent.trim(),
          url: opt.value.startsWith('http') ? opt.value : 'https://www.education.gouv.fr' + opt.value
        }));
      });

      console.log(`✅ ${selectOptions.length} académies trouvées via select.`);
      linksToVisit.push(...selectOptions);
    }

    // Parcourir chaque académie
    for (const item of linksToVisit) {
      console.log(`➳ Visite : ${item.name}`);
      let found = false;

      // --- ESSAI 1 : METHODE STANDARD ---
      try {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1500));
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        const pageHtml = await page.content();
        const $page = cheerio.load(pageHtml);
        const textContent = $page('body').text().replace(/\s+/g, ' ');

        const match = textContent.match(RECTOR_REGEX);

        if (match) {
          const genre = match[1];
          const nom = match[2].trim();
          console.log(` ★ Trouvé : ${genre} ${nom}`);

          results.push({
            academie: item.name,
            genre: genre,
            nom: nom,
            url: item.url,
            updated_at: new Date().toISOString()
          });
          found = true;
        }
      } catch (e) {
        console.error(` ❌ Erreur page standard: ${e.message}`);
      }

      // --- ESSAI 2 : FALLBACK CORSE ---
      if (!found && item.name.toLowerCase().includes('corse')) {
        const fallbackResult = await scrapeCorseFallback(browser);
        if (fallbackResult) {
          results.push({
            academie: item.name,
            genre: fallbackResult.genre,
            nom: fallbackResult.nom,
            url: fallbackResult.url,
            updated_at: new Date().toISOString()
          });
          found = true;
        }
      }

      // --- ECHEC TOTAL ---
      if (!found) {
        console.log(` ⚠️ Aucun recteur trouvé pour ${item.name}.`);
        results.push({
          academie: item.name,
          error: "Non trouvé",
          url: item.url,
          updated_at: new Date().toISOString()
        });
      }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n💾 Sauvegardé dans ${OUTPUT_FILE}`);
    console.log(`\n📊 Résumé : ${results.filter(r => !r.error).length}/${results.length} recteurs trouvés`);

  } catch (error) {
    console.error("🚨 Erreur globale:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrape();
