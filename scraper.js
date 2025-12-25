const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";

async function findUrls() {
  console.log("🚀 Lancement du navigateur...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const academieUrls = {};

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`🔍 Navigation vers l'index : ${INDEX_URL}`);
    await page.goto(INDEX_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Récupérer la liste des académies
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

    // Pour chaque académie, simuler la sélection et capturer l'URL
    for (let i = 0; i < academies.length; i++) {
      const academie = academies[i];
      console.log(`${i + 1}/${academies.length} - Test de ${academie.name}...`);

      try {
        // Recharger la page pour chaque test
        await page.goto(INDEX_URL, { 
          waitUntil: 'networkidle2', 
          timeout: 60000 
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        // Sélectionner l'académie dans le select
        await page.select('.svg-select', academie.slug);

        // Attendre un peu pour voir si quelque chose se passe
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Cliquer sur le bouton de soumission
        const buttonClicked = await page.evaluate(() => {
          const button = document.querySelector('.svg-submit, button[type="submit"]');
          if (button) {
            button.click();
            return true;
          }
          return false;
        });

        if (buttonClicked) {
          // Attendre la navigation ou un changement
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Vérifier si on a été redirigé
          const currentUrl = page.url();
          if (currentUrl !== INDEX_URL) {
            console.log(`  ✓ Redirigé vers : ${currentUrl}`);
            academieUrls[academie.slug] = currentUrl;
          } else {
            // Peut-être un popup ou un panneau qui s'ouvre ?
            const popupUrl = await page.evaluate(() => {
              // Chercher un lien dans un popup
              const popup = document.querySelector('.svg-block-popup, .popup');
              if (popup) {
                const link = popup.querySelector('a[href*="academie"]');
                return link ? link.href : null;
              }
              return null;
            });

            if (popupUrl) {
              console.log(`  ✓ URL dans popup : ${popupUrl}`);
              academieUrls[academie.slug] = popupUrl;
            } else {
              console.log(`  ⚠️ Pas de redirection détectée`);
            }
          }
        } else {
          console.log(`  ⚠️ Bouton non trouvé`);
        }

      } catch (e) {
        console.error(`  ❌ Erreur : ${e.message}`);
      }

      // Limiter aux 5 premières pour le test
      if (i >= 4) {
        console.log("\n⏸️ Arrêt après 5 tests (pour debug)");
        break;
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📋 URLs trouvées :");
    console.log("=".repeat(60));
    Object.entries(academieUrls).forEach(([slug, url]) => {
      console.log(`'${slug}': '${url}',`);
    });

    // Sauvegarder
    fs.writeFileSync('academie_urls.json', JSON.stringify(academieUrls, null, 2));
    console.log("\n💾 Sauvegardé dans academie_urls.json");

  } catch (error) {
    console.error("🚨 Erreur globale:", error);
  } finally {
    await browser.close();
  }
}

findUrls();
