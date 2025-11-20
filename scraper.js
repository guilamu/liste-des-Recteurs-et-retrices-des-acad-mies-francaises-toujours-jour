const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const INDEX_URL = "https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557";
const BASE_URL = "https://www.education.gouv.fr";
const OUTPUT_FILE = path.join(__dirname, 'recteurs.json');

// Liste des académies à surveiller
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

// Regex: Cherche "M." ou "Mme", suivi d'espaces, suivi du nom, jusqu'à une virgule
const RECTOR_REGEX = /\b(M\.|Mme)\s+([^,]+),/;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrape() {
    console.log(`🔍 Lecture de l'index : ${INDEX_URL}`);
    const results = [];

    try {
        const { data: indexHtml } = await axios.get(INDEX_URL);
        const $ = cheerio.load(indexHtml);
        
        // 1. Trouver les liens pour chaque académie
        const linksToVisit = [];
        $('a').each((i, link) => {
            const text = $(link).text().trim().replace(/\s+/g, ' '); // Nettoie les espaces
            if (ACADEMIES.includes(text)) {
                let href = $(link).attr('href');
                if (href && !href.startsWith('http')) {
                    href = BASE_URL + href;
                }
                linksToVisit.push({ name: text, url: href });
            }
        });

        console.log(`✅ ${linksToVisit.length} liens d'académies trouvés.`);

        // 2. Visiter chaque page
        for (const item of linksToVisit) {
            console.log(`➳ Traitement de : ${item.name}...`);
            
            try {
                const { data: pageHtml } = await axios.get(item.url);
                const $page = cheerio.load(pageHtml);
                const pageText = $page('body').text().replace(/\s+/g, ' '); // Texte brut nettoyé
                
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
                    console.log(`   ⚠️ Nom introuvable sur la page.`);
                    results.push({ academie: item.name, error: "Non trouvé", url: item.url });
                }

            } catch (err) {
                console.error(`   ❌ Erreur sur ${item.url}: ${err.message}`);
            }
            
            // Petite pause pour être gentil avec le serveur
            await delay(500);
        }

        // 3. Sauvegarde
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
        console.log(`\n💾 Terminé ! Données écrites dans ${OUTPUT_FILE}`);

    } catch (error) {
        console.error("Erreur critique:", error);
        process.exit(1);
    }
}

scrape();
