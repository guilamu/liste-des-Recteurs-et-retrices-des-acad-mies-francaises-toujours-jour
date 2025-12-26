const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const CORSE_FALLBACK_URL = "https://lannuaire.service-public.gouv.fr/navigation/corse/corse-du-sud/rectorat";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');

// Regex pour extraire le nom du recteur
const RECTOR_REGEX = /\b(M\.|Mme)\s+(.+?)(?=,|est nomm)/i;

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

    await new Promise(resolve => setTimeout(resolve, 3000));

    // ÉTAPE 1 : Récupérer la liste des académies
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

    // ÉTAPE 2 : Pour chaque académie, découvrir l'URL ET extraire le recteur
    for (let i = 0; i < academies.length; i++) {
      const academie = academies[i];
      console.log(`\n[${i + 1}/${academies.length}] ${academie.name}`);
      console.log("─".repeat(50));

      let academieUrl = null;

      // 2a. Découvrir l'URL via la carte interactive
      try {
        console.log(" 🔍 Découverte de l'URL...");
        await page.goto(INDEX_URL, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });

        await new Promise(resolve => setTimeout(resolve, 1500));
        await page.select('.svg-select', academie.slug);
        await new Promise(resolve => setTimeout(resolve, 800));

        await page.evaluate(() => {
          const button = document.querySelector('.svg-submit, button[type="submit"]');
          if (button) button.click();
        });

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
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.goto(academieUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        const pageHtml = await page.content();
        const $page = cheerio.load(pageHtml);
        const textContent = $page('body').text().replace(/\s+/g, ' ');

        const match = textContent.match(RECTOR_REGEX);

        if (match) {
          const genre = match[1];
          const nom = match[2].trim();
          console.log(` ★ Trouvé : ${genre} ${nom}`);

          results.push({
            academie: academie.name,
            genre: genre,
            nom: nom,
            url: academieUrl,
            updated_at: new Date().toISOString()
          });
          found = true;
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
        results.push({
          academie: academie.name,
          error: "Non trouvé",
          url: academieUrl,
          updated_at: new Date().toISOString()
        });
      }
    }

    // ÉTAPE 3 : Sauvegarder les résultats
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n${"=".repeat(60)}`);
    console.log(`💾 Sauvegardé dans ${OUTPUT_FILE}`);
    console.log(`📊 Résumé : ${results.filter(r => !r.error).length}/${results.length} recteurs trouvés`);

    // NOUVEAU : Compter et signaler les erreurs
    const errorsCount = results.filter(r => r.error).length;
    const failedAcademies = results.filter(r => r.error).map(r => r.academie);

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
