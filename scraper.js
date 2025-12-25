const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";

async function debug() {
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

    console.log("⏳ Attente 5 secondes...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Sauvegarder le HTML complet après JS
    const html = await page.content();
    fs.writeFileSync('page_after_js.html', html);
    console.log("✅ HTML sauvegardé dans page_after_js.html");

    // Debug : compter les différents types d'éléments
    const debugInfo = await page.evaluate(() => {
      return {
        totalLinks: document.querySelectorAll('a').length,
        linksWithAcademie: document.querySelectorAll('a[href*="academie"]').length,
        linksWithSlashAcademie: document.querySelectorAll('a[href*="/academie-"]').length,
        allSelects: document.querySelectorAll('select').length,
        selectOptions: document.querySelectorAll('select option').length,
        svgElements: document.querySelectorAll('svg').length,
        svgLinks: document.querySelectorAll('svg a').length,
        divWithDataUrl: document.querySelectorAll('div[data-api-url]').length,

        // Chercher des patterns spécifiques
        regionsAcademiques: document.querySelectorAll('[class*="region"], [class*="academie"]').length,

        // Extraire quelques exemples de liens
        sampleLinks: Array.from(document.querySelectorAll('a'))
          .slice(0, 20)
          .map(a => ({
            text: a.textContent.trim().substring(0, 50),
            href: a.href.substring(0, 100)
          }))
      };
    });

    console.log("\n📊 Analyse de la page :");
    console.log("========================");
    console.log(`Total de liens <a> : ${debugInfo.totalLinks}`);
    console.log(`Liens contenant "academie" : ${debugInfo.linksWithAcademie}`);
    console.log(`Liens contenant "/academie-" : ${debugInfo.linksWithSlashAcademie}`);
    console.log(`Éléments <select> : ${debugInfo.allSelects}`);
    console.log(`Éléments <option> : ${debugInfo.selectOptions}`);
    console.log(`Éléments SVG : ${debugInfo.svgElements}`);
    console.log(`Liens dans SVG : ${debugInfo.svgLinks}`);
    console.log(`Div avec data-api-url : ${debugInfo.divWithDataUrl}`);
    console.log(`Éléments région/académie : ${debugInfo.regionsAcademiques}`);

    console.log("\n📝 Exemples de liens trouvés :");
    debugInfo.sampleLinks.forEach((link, i) => {
      console.log(`  ${i + 1}. [${link.text}] -> ${link.href}`);
    });

    // Chercher spécifiquement les académies dans le texte
    const academieTexts = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const academies = [
        "Paris", "Versailles", "Créteil", "Lyon", "Grenoble", "Clermont-Ferrand",
        "Toulouse", "Montpellier", "Bordeaux", "Nantes", "Rennes", "Lille",
        "Amiens", "Reims", "Nancy-Metz", "Strasbourg", "Dijon", "Besançon"
      ];

      return academies.filter(name => bodyText.includes(name));
    });

    console.log("\n🎯 Académies mentionnées dans la page :");
    console.log(academieTexts.join(", "));

    // Chercher les divs de carte SVG
    const svgMapInfo = await page.evaluate(() => {
      const svgMaps = Array.from(document.querySelectorAll('.svg-map, [class*="svg"], [class*="carte"]'));
      return svgMaps.map(el => ({
        class: el.className,
        hasChildren: el.children.length,
        html: el.innerHTML.substring(0, 200)
      }));
    });

    console.log("\n🗺️ Éléments de carte trouvés :");
    svgMapInfo.forEach((map, i) => {
      console.log(`  ${i + 1}. class="${map.class}", children=${map.hasChildren}`);
    });

  } catch (error) {
    console.error("🚨 Erreur:", error);
  } finally {
    await browser.close();
  }
}

debug();
