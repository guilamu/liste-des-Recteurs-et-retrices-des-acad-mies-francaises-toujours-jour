const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";

async function debugSelect() {
  console.log("🚀 Lancement du navigateur...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`🔍 Navigation vers : ${INDEX_URL}`);
    await page.goto(INDEX_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    // Extraire les options avec leur valeur exacte
    const selectData = await page.evaluate(() => {
      const select = document.querySelector('.svg-select, select');
      if (!select) return { found: false };

      const options = Array.from(select.querySelectorAll('option'));
      return {
        found: true,
        selectHTML: select.outerHTML.substring(0, 500),
        options: options.map((opt, i) => ({
          index: i,
          text: opt.textContent.trim(),
          value: opt.value,
          hasValue: !!opt.value,
          attributes: {
            'data-url': opt.getAttribute('data-url'),
            'data-link': opt.getAttribute('data-link'),
            'data-href': opt.getAttribute('data-href'),
          }
        }))
      };
    });

    if (!selectData.found) {
      console.log("❌ Select non trouvé !");
    } else {
      console.log("\n📝 HTML du select :");
      console.log(selectData.selectHTML);

      console.log("\n📋 Contenu des options :");
      selectData.options.forEach(opt => {
        if (opt.text && opt.text !== 'Choisir une académie') {
          console.log(`\n${opt.index}. "${opt.text}"`);
          console.log(`   value="${opt.value}"`);
          console.log(`   data-url="${opt.attributes['data-url']}"`);
          console.log(`   data-link="${opt.attributes['data-link']}"`);
          console.log(`   data-href="${opt.attributes['data-href']}"`);
        }
      });
    }

    // Chercher où sont stockées les vraies URLs
    console.log("\n\n🔍 Recherche des URLs d'académies...");
    const urlsFound = await page.evaluate(() => {
      // Chercher dans les data attributes du div parent
      const svgBlock = document.querySelector('.svg-block');
      const dataApiUrl = svgBlock ? svgBlock.getAttribute('data-api-url') : null;

      // Chercher dans window/JavaScript
      const windowData = {
        hasAcademiesData: typeof window.academies !== 'undefined',
        hasMapData: typeof window.mapData !== 'undefined',
      };

      // Chercher tous les éléments avec des data-url
      const elementsWithDataUrl = Array.from(document.querySelectorAll('[data-url]'));

      return {
        dataApiUrl,
        windowData,
        dataUrlElements: elementsWithDataUrl.length,
        sampleDataUrls: elementsWithDataUrl.slice(0, 5).map(el => ({
          tag: el.tagName,
          url: el.getAttribute('data-url')
        }))
      };
    });

    console.log("\nData API URL :", urlsFound.dataApiUrl);
    console.log("Window data :", JSON.stringify(urlsFound.windowData));
    console.log("Éléments avec data-url :", urlsFound.dataUrlElements);
    console.log("Exemples :", JSON.stringify(urlsFound.sampleDataUrls, null, 2));

  } catch (error) {
    console.error("🚨 Erreur:", error);
  } finally {
    await browser.close();
  }
}

debugSelect();
