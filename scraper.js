const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Active le mode furtif pour tromper Cloudflare
puppeteer.use(StealthPlugin());

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const BASE_URL = "https://www.education.gouv.fr";
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

const RECTOR_REGEX = /\b(M\.|Mme)\s+([^,]+),/;

async function scrape() {
    console.log("🚀 Lancement du navigateur (Mode Stealth)...");
    
    const browser = await puppeteer.launch({
        headless: "new", // Mode sans interface graphique
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Nécessaire pour Docker/GitHub Actions
    });

    const results = [];
    
    try {
        const page = await browser.newPage();
        // Définir une taille d'écran réaliste
        await page.setViewport({ width: 1280, height: 800 });

        console.log(`🔍 Navigation vers l'index : ${INDEX_URL}`);
        // waitUntil: 'networkidle2' attend que la page ait fini de charger (plus de requêtes réseau)
        await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // On récupère le HTML et on le passe à Cheerio
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

        // Boucle sur les pages
        for (const item of linksToVisit) {
            console.log(`➳ Visite : ${item.name}`);
            
            try {
                // Délai aléatoire entre 1s et 3s (comportement humain)
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

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
                } else {
                    console.log(`   ⚠️ Pas de correspondance regex.`);
                    results.push({ academie: item.name, error: "Regex non trouvée", url: item.url });
                }

            } catch (e) {
                console.error(`   ❌ Erreur page: ${e.message}`);
                results.push({ academie: item.name, error: "Erreur chargement", url: item.url });
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
