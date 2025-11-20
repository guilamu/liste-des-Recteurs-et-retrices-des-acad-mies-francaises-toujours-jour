const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const BASE_URL = "https://www.education.gouv.fr";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');

// Liste des académies cibles
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

// Regex améliorée pour capturer le nom
const RECTOR_REGEX = /\b(M\.|Mme)\s+([^,]+),/;

// Configuration HTTP pour ressembler à un navigateur
const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
    },
    timeout: 30000 // 30 secondes timeout
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrape() {
    console.log(`🔍 Démarrage du scraping sur : ${INDEX_URL}`);
    const results = [];
    let linksToVisit = [];

    // 1. Récupération de la page Index
    try {
        const { data: indexHtml } = await axios.get(INDEX_URL, AXIOS_CONFIG);
        const $ = cheerio.load(indexHtml);
        
        $('a').each((i, link) => {
            const text = $(link).text().trim().replace(/\s+/g, ' ');
            if (ACADEMIES.includes(text)) {
                let href = $(link).attr('href');
                if (href) {
                    if (!href.startsWith('http')) {
                        href = BASE_URL + href;
                    }
                    linksToVisit.push({ name: text, url: href });
                }
            }
        });
        console.log(`✅ Index récupéré : ${linksToVisit.length} liens trouvés.`);
    } catch (err) {
        console.error(`❌ Erreur fatale lors de la lecture de l'index : ${err.message}`);
        if (err.response) console.error(`Status: ${err.response.status}`);
        // On arrête ici si on ne peut même pas lire l'index
        process.exit(1);
    }

    // 2. Visite des pages détaillées
    // On traite les liens un par un pour éviter de se faire bannir trop vite
    for (const item of linksToVisit) {
        console.log(`➳ Traitement de : ${item.name}...`);
        
        try {
            // Pause aléatoire entre 2 et 5 secondes pour être discret
            const pause = Math.floor(Math.random() * 3000) + 2000;
            await delay(pause);

            const { data: pageHtml } = await axios.get(item.url, AXIOS_CONFIG);
            const $page = cheerio.load(pageHtml);
            const pageText = $page('body').text().replace(/\s+/g, ' '); 
            
            const match = pageText.match(RECTOR_REGEX);
            
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
                console.log(`   ⚠️ Nom introuvable (Regex échouée).`);
                results.push({ 
                    academie: item.name, 
                    error: "Non trouvé", 
                    url: item.url,
                    updated_at: new Date().toISOString()
                });
            }

        } catch (err) {
            console.error(`   ❌ Erreur sur ${item.name}: ${err.message}`);
            results.push({ 
                academie: item.name, 
                error: `Erreur accès (${err.message})`, 
                url: item.url 
            });
        }
    }

    // 3. Sauvegarde quoi qu'il arrive
    try {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
        console.log(`\n💾 Terminé ! Données écrites dans ${OUTPUT_FILE}`);
    } catch (err) {
        console.error("Erreur lors de l'écriture du fichier JSON", err);
        process.exit(1);
    }
}

scrape();
