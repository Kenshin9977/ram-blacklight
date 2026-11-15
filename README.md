# Blacklight de la RAM

Combien de mémoire vive coûtent les 1 000 sites les plus visités en France, et **qui** la consomme ?

Cet outil ouvre chaque site dans un vrai Chromium, accepte puis refuse les cookies, laisse la page au repos 60 secondes et mesure la mémoire de chaque processus de la page. Il attribue ensuite cette mémoire au site lui-même ou à ses tiers (publicité, mesure d'audience, vidéo…).

- **Résultats, méthode et limites** : [REPORT.md](REPORT.md)
- **Données** : [`results/2026-11/`](results/2026-11/) (`summary.json` par site × choix de cookies, `table.txt`, `stats.json`)
- **Présentation grand public** : le site statique de [`site/`](site/), construit par `scripts/build-site.js`

Premiers résultats (novembre 2026) : la page médiane occupe 154 Mo une fois les cookies acceptés, 104 sites dépassent 1 Go, et un site de médias passe de 132 Mo à 1,1 Go quand on accepte les cookies.

## Principes

- **Navigateur standard et déclaré.** Chromium 134 figé, agent utilisateur Chrome standard suivi du jeton `RAMBlacklight/0.1`. Aucune technique furtive : un site qui bloque le robot est noté « non mesurable » et n'est plus visité.
- **Consentement réel.** Les bannières sont acceptées ou refusées par les règles [autoconsent](https://github.com/duckduckgo/autoconsent) de DuckDuckGo, et le choix enregistré est vérifié par le standard TCF quand le site le suit.
- **Répétition.** 3 à 5 mesures par site et par choix, médiane publiée avec l'intervalle.
- **Outils existants.** Traçage memory-infra de Chrome via le protocole DevTools, [third-party-web](https://github.com/patrickhulce/third-party-web) pour identifier les tiers, [tldts](https://github.com/remusao/tldts) pour les domaines.

## Lancer une campagne

L'environnement de référence est une image Docker figée (Playwright 1.51.1 / Chromium 134, Linux). Les chiffres absolus ne sont comparables que d'une campagne à l'autre dans cet environnement.

```
docker compose build
./campaign.sh                  # campagne du mois courant (results/AAAA-MM), reprend où elle s'était arrêtée
./campaign.sh 2026-12          # campagne nommée
CONCURRENCY=2 STOP_AT=07:30 ./campaign.sh
```

Il faut compter ~2 jours pour 1 000 sites sur une petite machine (4 threads, 3 mesures en parallèle). À la fin, `campaign.sh` agrège les résultats dans `results/<campagne>/summary.json` et `results/<campagne>.table.txt`.

Sans Docker : `npm ci`, puis `node src/run.js --out results/test --sites sites.json` (Chromium installé par `npx playwright-core install chromium`).

| Chemin | Contenu |
|---|---|
| `raw/` | un JSON par mesure (traces mémoire, frames, réseau) |
| `consent/` | choix de cookies obtenu par site × mode, réutilisé par toutes les mesures |
| `shots/` | captures d'écran |
| `campaign.json` | environnement et paramètres |
| `summary.json` | statistiques par site × mode |

Les fichiers bruts et les captures ne sont pas publiés ici (taille, et droits sur le contenu des sites).

### Options de `src/run.js`

| Option | Défaut | Rôle |
|---|---|---|
| `--sites` | `sites.json` | liste des sites |
| `--modes` | `accept,refuse` | choix de cookies |
| `--min-runs` / `--max-runs` / `--cv` | 3 / 5 / 0,05 | mesures supplémentaires tant que la variation dépasse le seuil |
| `--idle` | 60 | repos après défilement, en s (justifié dans REPORT.md §3.2) |
| `--concurrency` | 2 | mesures simultanées au maximum |
| `--min-free-gb` | 3 | une mesure ne démarre que si la mémoire libre (hôte et cgroup) le permet |
| `--stagger` | 20 | délai minimal entre deux démarrages, en s |
| `--consent-tries` | 3 | tentatives de la visite de consentement jusqu'au résultat attendu |
| `--stop-at` | — | heure locale après laquelle aucune nouvelle mesure ne démarre |
| `--only` | — | sous-ensemble de sites |
| `--baseline` | 3 | mesures de référence sur `about:blank` |

## Construire la liste et le site

| Commande | Rôle |
|---|---|
| `node scripts/build-sites.js` | liste des 1 000 sites depuis le top CrUX France ([zakird/crux-top-lists](https://github.com/zakird/crux-top-lists), fichier `data/crux-fr-AAAAMM.csv.gz` à télécharger) |
| `data/site-categories.json` | type de chaque site, attribué à la main |
| `node src/aggregate.js results/<campagne>` | statistiques |
| `node scripts/build-site.js results/<campagne>/summary.json --campaign AAAA-MM` | le site statique dans `site/` |
| `node scripts/preview-site.js` | captures du site (clair, sombre, mobile) |
| `node test/validate.js 3 full` | validation de l'attribution sur une page de test aux valeurs connues |
| `node test/timeout-closes-browser.js` | une mesure abandonnée ferme bien son navigateur |
| `node scripts/idle-curve.js` | étude de stabilisation de la mémoire pendant le repos |
| `node scripts/probe-block.js URL…` | accessibilité des sites (blocage anti-robot) |

## Licences

Code sous licence [MIT](LICENSE). Données de `results/` et `data/site-categories.json` sous licence [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fr).
