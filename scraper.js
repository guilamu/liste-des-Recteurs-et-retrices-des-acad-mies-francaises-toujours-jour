const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const BASE_URL = "https://www.education.gouv.fr";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');
const RECTOR_REGEX = /\b(M\.|Mme)\s+(.+?)(?=,|est nomm)/i;

// Mapping manuel des académies (basé sur les URLs connues)
const ACADEMIE_URLS = {
  'aix-marseille': 'https://www.education.gouv.fr/academie-d-aix-marseille-100064',
  'amiens': 'https://www.education.gouv.fr/academie-d-amiens-100055',
  'besancon': 'https://www.education.gouv.fr/academie-de-besancon-100088',
  'bordeaux': 'https://www.education.gouv.fr/academie-de-bordeaux-100079',
  'clermont-ferrand': 'https://www.education.gouv.fr/academie-de-clermont-ferrand-100085',
  'corse': 'https://www.education.gouv.fr/academie-de-corse-100091',
  'creteil': 'https://www.education.gouv.fr/academie-de-creteil-100043',
  'dijon': 'https://www.education.gouv.fr/academie-de-dijon-100073',
  'grenoble': 'https://www.education.gouv.fr/academie-de-grenoble-100082',
  'guadeloupe': 'https://www.education.gouv.fr/academie-de-guadeloupe-100103',
  'guyane': 'https://www.education.gouv.fr/academie-de-guyane-100106',
  'la-reunion': 'https://www.education.gouv.fr/academie-de-la-reunion-100109',
  'lille': 'https://www.education.gouv.fr/academie-de-lille-100034',
  'limoges': 'https://www.education.gouv.fr/academie-de-limoges-100076',
  'lyon': 'https://www.education.gouv.fr/academie-de-lyon-100067',
  'martinique': 'https://www.education.gouv.fr/academie-de-martinique-100112',
  'mayotte': 'https://www.education.gouv.fr/academie-de-mayotte-100115',
  'montpellier': 'https://www.education.gouv.fr/academie-de-montpellier-100094',
  'nancy-metz': 'https://www.education.gouv.fr/academie-de-nancy-metz-100058',
  'nantes': 'https://www.education.gouv.fr/academie-de-nantes-100037',
  'nice': 'https://www.education.gouv.fr/academie-de-nice-100100',
  'normandie': 'https://www.education.gouv.fr/academie-de-normandie-100040',
  'nouvelle-caledonie': 'https://www.education.gouv.fr/vice-rectorat-de-nouvelle-caledonie-100118',
  'orleans-tours': 'https://www.education.gouv.fr/academie-d-orleans-tours-100070',
  'paris': 'https://www.education.gouv.fr/academie-de-paris-100049',
  'poitiers': 'https://www.education.gouv.fr/academie-de-poitiers-100052',
  'polnesie-francaise': 'https://www.education.gouv.fr/vice-rectorat-de-polynesie-francaise-100121',
  'reims': 'https://www.education.gouv.fr/academie-de-reims-100061',
  'rennes': 'https://www.education.gouv.fr/academie-de-rennes-100046',
  'saint-pierre-et-miquelon': 'https://www.education.gouv.fr/services-de-l-education-nationale-de-saint-pierre-et-miquelon-100124',
  'strasbourg': 'https://www.education.gouv.fr/academie-de-strasbourg-100061',
  'toulouse': 'https://www.education.gouv.fr/academie-de-toulouse-100097',
  'versailles': 'https://www.education.gouv.fr/academie-de-versailles-100028',
  'wallis-et-futuna': 'https://www.education.gouv.fr/services-de-l-education-nationale-de-wallis-et-futuna-100127'
};

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

    // Extraire les slugs depuis le select
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

    // Pour chaque académie
    for (const academie of academies) {
      const url = ACADEMIE_URLS[academie.slug];

      if (!url) {
        console.log(`⚠️ ${academie.name} : URL inconnue pour slug "${academie.slug}"`);
        results.push({
          academie: academie.name,
          error: "URL inconnue",
          slug: academie.slug,
          updated_at: new Date().toISOString()
        });
        continue;
      }

      console.log(`➳ Visite : ${academie.name}`);
      let found = false;

      try {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1500));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

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
            url: url,
            updated_at: new Date().toISOString()
          });
          found = true;
        }
      } catch (e) {
        console.error(` ❌ Erreur : ${e.message}`);
      }

      if (!found) {
        console.log(` ⚠️ Aucun recteur trouvé pour ${academie.name}.`);
        results.push({
          academie: academie.name,
          error: "Non trouvé",
          url: url,
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
