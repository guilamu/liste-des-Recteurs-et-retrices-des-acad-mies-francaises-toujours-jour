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

const ACADEMIES = [
    "Aix-Marseille", "Amiens", "Besançon", "Bordeaux", "Clermont-Ferrand", 
    "Corse", "Créteil", "Dijon", "Grenoble", "Guadeloupe", "Guyane", 
    "La Réunion", "Lille", "Limoges", "Lyon", "Martinique", "Mayotte", 
    "Montpellier", "Nancy-Metz", "Nantes", "Nice", "Normandie", 
    "Nouvelle-Calédonie", "Orléans-Tours", "Paris", "Poitiers", 
    "Polynésie Française", "Reims", "Rennes", 
    "Saint-Pierre et Miquelon (Services de l’EN)", "Strasbourg", 
    "Toulouse", "Versailles", "Wallis et Futuna"
];

// Regex standard
const RECTOR_REGEX = /\b(M\.|Mme)\s+(.+?)(?=,|est nomm)/i;

// --- FONCTION FALLBACK CORSE CORRIGÉE ---
async function scrapeCorseFallback(browser) {
    console.log("   🚑 Activation du fallback Corse...");
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    try {
        // 1. Aller sur la page annuaire
        await page.goto(CORSE_FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // 2. Chercher le lien contenant le texte "Rectorat - Académie de Corse"
        // CORRECTION: On utilise page.$$eval ou une boucle sur les éléments car $x est obsolète
        const linkElement = await page.evaluateHandle(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links.find(a => a.textContent.includes('Rectorat - Académie de Corse'));
        });

        if (linkElement && (await linkElement.jsonValue()) !== undefined) {
            console.log("   -> Lien annuaire trouvé, clic...");
            
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                linkElement.click()
            ]);
            
            // 3. Sur la page finale, extraction
            const content = await page.content();
            const $ = cheerio.load(content);
            const text = $('body').text().replace(/\s+/g, ' ');
            
            // Regex spécifique pour service-public.fr : cherche Nom avant "Recteur d'académie"
            // Ex: "M. Jean DUPONT, Recteur d'académie..."
            const fallbackRegex = /([A-Z][a-zA-ZÀ-ÿ\s-]+?),\s*Recteur d'académie/i;
            const match = text.match(fallbackRegex);

            if (match) {
                let fullName = match[1].trim();
                let genre = "M./Mme"; 
                
                if (fullName.startsWith("M. ")) { genre = "M."; fullName = fullName.replace("M. ", ""); }
                if (fullName.startsWith("Mme ")) { genre = "Mme"; fullName = fullName.replace("Mme ", ""); }

                console.log(`   ★ Trouvé via Fallback : ${fullName}`);
                return { genre, nom: fullName, url: page.url() };
            } else {
                 console.log("   ⚠️ Regex fallback échouée sur la page finale.");
            }
        } else {
            console.log("   ⚠️ Lien 'Rectorat - Académie de Corse' introuvable.");
        }
        return null;

    } catch (e) {
        console.error(`   ❌ Erreur Fallback Corse: ${e.message}`);
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
        await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const indexHtml = await page.content();
        const $ = cheerio.load(indexHtml);

        const linksToVisit = [];
        $('a').each((i, link) => {
            const text = $(link).text().trim().replace(/\s+/g, ' ');
            if (ACADEMIES.includes(text)) {
                let href = $(link).attr('href');
                if (href) {
                    if (!href.startsWith('http')) href = BASE_URL + href;
                    linksToVisit.push({ name: text, url: href });
                }
            }
        });

        console.log(`✅ ${linksToVisit.length} académies trouvées.`);

        for (const item of linksToVisit) {
            console.log(`➳ Visite : ${item.name}`);
            let found = false;
            
            // --- ESSAI 1 : METHODE STANDARD ---
            try {
                // Petit délai humain
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
                
                await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                
                const pageHtml = await page.content();
                const $page = cheerio.load(pageHtml);
                const textContent = $page('body').text().replace(/\s+/g, ' ');

                const match = textContent.match(RECTOR_REGEX);
                
                if (match) {
                    const genre = match[1];
                    const nom = match[2].trim();
                    console.log(`   ★ Trouvé : ${genre} ${nom}`);
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
                console.error(`   ❌ Erreur page standard: ${e.message}`);
            }

            // --- ESSAI 2 : FALLBACK CORSE ---
            if (!found && item.name === "Corse") {
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
                 console.log(`   ⚠️ Aucun recteur trouvé pour ${item.name}.`);
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

    } catch (error) {
        console.error("🚨 Erreur globale:", error);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

scrape();
