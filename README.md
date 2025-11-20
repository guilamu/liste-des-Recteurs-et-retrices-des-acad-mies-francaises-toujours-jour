# Liste des Recteurs et Rectrices des Académies Françaises 🇫🇷

[![Accéder à la liste](https://guilamu.github.io/liste-des-Recteurs-et-retrices-des-acad-mies-francaises-toujours-jour/)

Une liste actualisée quotidiennement des recteurs et rectrices des académies françaises, générée automatiquement depuis le site du Ministère de l'Éducation nationale.

## 📋 À propos

Ce projet maintient une liste à jour de tous les recteurs et rectrices d'académie en France. Les données sont automatiquement extraites et mises à jour chaque jour via GitHub Actions, garantissant que les informations sont toujours actuelles.

Les recteurs d'académie sont des hauts fonctionnaires nommés par décret du Président de la République, responsables de la mise en œuvre de la politique éducative dans leur académie, de la maternelle à l'enseignement supérieur.

## 🎯 Utilisation

### Format JSON

Les données sont disponibles au format JSON dans le fichier [`recteurs.json`](./recteurs.json).

**Structure des données :**
```
{
"academie": "Aix-Marseille",
"genre": "M.",
"nom": "Benoît Delaunay",
"url": "https://www.education.gouv.fr/academie-d-aix-marseille-100103",
"updated_at": "2025-11-20T12:46:39.758Z"
}
```
### Accès direct

**URL du fichier JSON :**

https://raw.githubusercontent.com/guilamu/liste-des-Recteurs-et-retrices-des-acad-mies-francaises-toujours-jour/main/recteurs.json

## 🔄 Mise à jour automatique

Les données sont automatiquement mises à jour **tous les jours** grâce à GitHub Actions:

- **Fréquence :** Quotidienne (chaque jour à midi UTC)
- **Source :** Pages officielles du Ministère de l'Éducation nationale
- **Processus :** Scraping automatisé avec vérification des changements

## 📂 Structure du projet

```
├── recteurs.json # Liste des recteurs au format JSON
├── index.html # Tableau HTML des recteurs
├── scraper.js # Script de scraping Node.js
├── .github/
│ └── workflows/
│ └── update.yml # Configuration GitHub Actions
├── package.json # Dépendances Node.js
└── README.md # Documentation
```

## 📊 Données disponibles

Pour chaque académie, les informations suivantes sont disponibles[web:31][web:35]:

- **Académie** : Nom de l'académie
- **Genre** : Civilité (M. ou Mme)
- **Nom** : Nom complet du recteur ou de la rectrice
- **URL** : Lien vers la page officielle de l'académie
- **Date de mise à jour** : Timestamp de la dernière vérification

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à :

- Signaler des erreurs via les [Issues](https://github.com/guilamu/liste-des-Recteurs-et-retrices-des-acad-mies-francaises-toujours-jour/issues)
- Proposer des améliorations via des Pull Requests
- Suggérer de nouvelles fonctionnalités

## 🔗 Ressources

- [Site officiel du Ministère de l'Éducation nationale](https://www.education.gouv.fr/)
- [Liste des académies françaises](https://www.education.gouv.fr/les-regions-academiques-academies-et-services-departementaux-de-l-education-nationale-6557)
- [Documentation GitHub Actions](https://docs.github.com/actions)

## 📧 Contact

Pour toute question ou suggestion, n'hésitez pas à ouvrir une issue sur ce dépôt.
