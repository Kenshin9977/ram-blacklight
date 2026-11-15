# Blacklight de la RAM : la mémoire des sites français, et qui la consomme

Campagne de novembre 2026 (13 au 15/11) : les **1 000 sites les plus visités en France** (CrUX), cookies acceptés puis refusés, 3 à 5 runs par site et par choix. 4 262 runs mesurés, 5 erreurs.
Données : [`results/2026-11/`](results/2026-11/) (`summary.json` par site × choix, `table.txt`, `stats.json`). Présentation grand public : le site construit par `scripts/build-site.js`.

Une première étude de faisabilité sur 20 sites (12/11/2026, sous Windows) a validé la méthode ; ses résultats sont résumés en annexe. Les chiffres absolus des deux campagnes ne sont pas comparables (plateformes différentes).

## TL;DR

- **La page médiane occupe 154 Mo de RAM** une fois les cookies acceptés ; 171 sites dépassent 500 Mo et **104 dépassent 1 Go**, jusqu'à 3,3 Go (tameteo.com). Un onglet vide en occupe 28.
- **Accepter les cookies coûte cher sur les sites financés par la pub.** Sur les 479 sites où les deux choix ont été appliqués et vérifiés : 262 Mo en acceptant contre 135 Mo en refusant (médianes). Le rapport médian n'est que de ×1,5, mais il dépasse ×4,6 pour un quart des sites et ×10 pour un sur dix.
- **Les médias sont à part : 1,1 Go en acceptant contre 132 Mo en refusant (×8)**, dont 85 % pour des tiers. Viennent ensuite le sport et les paris (×4,4) et les sites pratiques et de loisirs (×4,5). L'administration, la santé et l'éducation ne bougent pas (×1,1).
- **Les régies publicitaires dominent la consommation tierce.** Google/Doubleclick Ads cumule 21,5 Go sur 337 sites ; 9 des 10 tiers les plus coûteux sont des régies ou des places de marché d'enchères.
- **La mesure est fiable sur la plupart des sites, bruitée sur les pages publicitaires.** Variation médiane entre runs : 2 %. Mais 28 % des couples site × choix varient de plus de 5 %, et 108 de plus de 20 %.
- **17 % des sites n'ont pas pu être mesurés** : ils bloquent un robot qui se déclare (refus 403 surtout). Nous ne contournons pas ces protections.

## 1. Protocole et environnement

| | |
|---|---|
| Liste | Top CrUX France d'octobre 2026 ([zakird/crux-top-lists](https://github.com/zakird/crux-top-lists)), une origine par domaine enregistrable (www ou apex de préférence), sans les origines techniques (connexion, API, mail…) ni les domaines adultes ou malveillants (résolveur familial de Cloudflare), sans les 11 sites connus pour bloquer lors de l'étude de faisabilité. 20 sites choisis à la main + 980 sites CrUX. `scripts/build-sites.js`, `sites-1000.json` |
| Catégories | 14 types de sites, attribués à la main d'après le domaine et le titre de la page (`data/site-categories.json`) |
| Navigateur | Chromium 134.0.6998.35 figé (playwright-core 1.51.1, image Docker `mcr.microsoft.com/playwright:v1.51.1-noble`), headless « new », `--site-per-process`, renderer de réserve désactivé, lazy-loading des iframes réactivé |
| User-Agent | UA Chrome 134 desktop standard + jeton déclaré `RAMBlacklight/0.1`, comme HTTP Archive. Pas de patch furtif. Les captchas et blocages sont signalés, jamais contournés |
| Contexte | fr-FR, Europe/Paris, géolocalisation émulée Paris, viewport 1366×768, connexion résidentielle française |
| Machine | Un NAS domestique sous Linux (Intel Core i3-6100, 2 cœurs / 4 threads), conteneur limité à 3 CPU et 9 Go, 3 runs en parallèle. ~49 h pour la campagne |
| Consentement | Visite 1 : [DuckDuckGo autoconsent](https://github.com/duckduckgo/autoconsent) 18.3.0 (opt-in / opt-out) + règles maison au même format (`rules/custom-rules.json`), rejouée jusqu'à 3 fois tant que le résultat attendu n'est pas obtenu. On garde cookies et localStorage. Visite 2 (mesurée) : navigateur neuf, sans outil injecté. Choix vérifié via `__tcfapi` quand le site suit le TCF. Sans bannière en mode accepter, le mode refuser n'est pas mesuré (même page) |
| Séquence | chargement → défilement jusqu'en bas → **60 s d'inactivité** → 2 dumps memory-infra (avant / après GC) → profils JS |
| Mesures | `private_footprint` par processus et allocateurs (memory-infra), association frame → processus (`TracingStartedInBrowser`), profileur de tas par échantillonnage par URL de script, octets réseau par domaine |
| Répétitions | 3 runs minimum ; jusqu'à 5 tant que le coefficient de variation dépasse 5 %. Les runs d'un même site sont espacés (un passage complet de la liste entre deux) |
| Classification des tiers | [third-party-web](https://github.com/patrickhulce/third-party-web) (entités, catégories) + eTLD+1 (tldts) + alias first-party par site |

Le **total page** est la somme des empreintes privées des renderers qui hébergent ses frames. Les processus navigateur et GPU (~130 Mo, partagés) sont exclus.

## 2. Résultats

### 2.1 Couverture

| | Sites |
|---|---|
| Dans la liste | 1 000 |
| Mesurés (au moins un choix valide) | 827 |
| Non mesurables (blocage) | 173 : 133 refus 403, 27 captchas, 5 pages de blocage, 4 vérifications anti-robot, 2 « trop de requêtes », 2 « service indisponible » |
| Sans bannière de cookies | 205 (un seul choix mesuré) |
| Les deux choix appliqués et vérifiés | 479 |

### 2.2 Par type de site

Mémoire médiane de la page. « Acceptés (tous) » porte sur tous les sites mesurés du type, avec ou sans bannière ; les colonnes « paires » ne retiennent que les sites où l'acceptation et le refus ont tous deux été appliqués.

| Type | Mesurés / listés | Acceptés (tous) | 90 % sous | Paires | Acceptés | Refusés | Rapport | Part des tiers |
|---|---|---|---|---|---|---|---|---|
| Médias | 132 / 141 | 1 051 Mo | 1 597 Mo | 113 | 1 098 Mo | 132 Mo | ×8,3 | 85 % |
| Sport, paris | 50 / 53 | 428 Mo | 1 616 Mo | 36 | 840 Mo | 192 Mo | ×4,4 | 70 % |
| Loisirs, pratique | 44 / 55 | 249 Mo | 1 391 Mo | 29 | 533 Mo | 119 Mo | ×4,5 | 53 % |
| E-commerce | 175 / 251 | 183 Mo | 448 Mo | 118 | 217 Mo | 147 Mo | ×1,5 | 22 % |
| Voyage, transport | 55 / 70 | 178 Mo | 394 Mo | 37 | 232 Mo | 145 Mo | ×1,6 | 37 % |
| Divertissement | 77 / 98 | 133 Mo | 458 Mo | 41 | 187 Mo | 156 Mo | ×1,2 | 17 % |
| Services (télécom, énergie, mail) | 35 / 41 | 106 Mo | 607 Mo | 20 | 135 Mo | 105 Mo | ×1,3 | 19 % |
| Annonces, emploi, immobilier | 26 / 35 | 103 Mo | 279 Mo | 16 | 138 Mo | 114 Mo | ×1,2 | 8 % |
| Banque, assurance | 27 / 31 | 94 Mo | 557 Mo | 12 | 208 Mo | 100 Mo | ×2,1 | 9 % |
| Réseaux sociaux, forums | 56 / 60 | 82 Mo | 257 Mo | 22 | 177 Mo | 109 Mo | ×1,6 | 9 % |
| Éducation, santé | 38 / 40 | 61 Mo | 111 Mo | 5 | 91 Mo | 83 Mo | ×1,1 | 0 % |
| Outils, tech | 55 / 64 | 59 Mo | 302 Mo | 17 | 168 Mo | 126 Mo | ×1,3 | 2 % |
| Administration | 36 / 37 | 57 Mo | 90 Mo | 12 | 70 Mo | 66 Mo | ×1,1 | 0 % |
| Autre | 21 / 24 | 42 Mo | 160 Mo | 1 | | | | 0 % |

L'e-commerce est le type le moins bien couvert (175 sites mesurés sur 251) : les grandes enseignes bloquent davantage les robots.

### 2.3 Les pages les plus lourdes (cookies acceptés)

| Site | Accepter | Refuser | Part des tiers |
|---|---|---|---|
| tameteo.com | 3 381 Mo | 412 Mo | 88 % |
| programme-tv.net | 3 051 Mo | 81 Mo | 94 % |
| programme-television.org | 2 774 Mo | 386 Mo | 90 % |
| motorsport.com | 2 759 Mo | 389 Mo | 73 % |
| ozap.com | 2 749 Mo | 177 Mo | 96 % |
| magicmaman.com | 2 608 Mo | 415 Mo | 95 % |
| dexerto.fr | 2 605 Mo | non vérifié (refus non enregistré) | 93 % |
| purepeople.com | 2 349 Mo | 136 Mo | 94 % |
| lexpress.fr | 2 226 Mo | 287 Mo | 92 % |
| laposte.net | 2 180 Mo | 98 Mo | 94 % |
| orange.fr | 2 145 Mo | 135 Mo | 92 % |

### 2.4 Qui consomme

Somme des médianes par entité, sur les sites où elle apparaît, cookies acceptés :

| Entité | Catégorie | Somme | Sites |
|---|---|---|---|
| Google/Doubleclick Ads | pub | 21,5 Go | 337 |
| Other Google APIs/SDKs | utilitaire | 8,2 Go | 256 |
| Pubmatic | pub | 8,0 Go | 160 |
| Index Exchange | pub | 5,5 Go | 127 |
| Rubicon Project | pub | 5,2 Go | 148 |
| Criteo | pub | 5,0 Go | 197 |
| OpenX | pub | 4,8 Go | 153 |
| Smart AdServer | pub | 4,6 Go | 129 |
| OneTag | pub | 4,3 Go | 131 |
| Amazon Ads | pub | 4,3 Go | 153 |
| Improve Digital | pub | 3,6 Go | 113 |
| adtrafficquality.google | non classé | 2,7 Go | 120 |
| Seedtag | pub | 2,5 Go | 67 |
| presage.io (Ogury) | non classé | 2,4 Go | 74 |
| TripleLift | pub | 2,3 Go | 78 |

Le coût d'une iframe publicitaire est dominé par **le processus lui-même** : chaque iframe d'un site tiers différent ouvre un renderer d'au moins ~20 Mo, même pour un pixel de synchronisation de cookies. C'est un coût réel pour l'utilisateur de Chrome, qui isole les sites, mais il dépend de la politique d'isolation du navigateur (moins forte sur Android, par exemple).

## 3. Fiabilité

### 3.1 Les métriques

| Métrique | Fiabilité | Éléments de preuve |
|---|---|---|
| Empreinte privée par processus (memory-infra) | **Élevée** | Page de test : 262–265 Mo dans les 3 configurations d'outillage, donc surcoût négligeable. Variation médiane entre runs de 1,2 % sur les sites sans bannière |
| Association frame → processus → site | **Élevée, exacte** | Avec `--site-per-process`, chaque processus OOPIF héberge un seul site, attribué en entier à son entité |
| Tas JS vivant par URL de script (processus principal) | **Bonne** | Page de test : attribution à ±5 % de la valeur attendue ; couverture réelle 64–90 % du tas utilisé |
| Mémoire après GC forcé | Peu utile | ~100 % du total avant GC : V8 ne rend pas la mémoire engagée. On publie l'empreinte avant GC |
| Octets réseau par domaine | Complément | Ne prédit pas la RAM (images décodées, processus) |

### 3.2 Variance entre runs

| | Coefficient de variation médian |
|---|---|
| Sans bannière | 1,2 % |
| Cookies refusés | 2,0 % |
| Cookies acceptés | 3,4 % |
| Tous les couples site × choix (1 446) | 2,0 % ; 407 au-dessus de 5 %, 108 au-dessus de 20 % |

La variance vient des enchères publicitaires : selon le run, une page média ouvre 9 à 33 processus. Après 3 runs, 30 % des couples dépassaient encore 5 % de variation ; la plupart y restent après 5. Pour ces pages, la médiane est indicative et l'intervalle min–max est publié (`table.txt`). Au niveau d'une entité, c'est plus bruité qu'au niveau de la page : on ne classe pas les entités sur un seul site.

**Durée d'inactivité : 60 s est justifié.** Étude dédiée (`scripts/idle-curve.js`) : 12 sites en mode accepter × 2 runs, relevé toutes les 5 s pendant 120 s après le défilement.

| Temps après défilement | 0 s | 10 s | 20 s | 30 s | 45 s | 60 s | 90 s | 120 s |
|---|---|---|---|---|---|---|---|---|
| Médiane en % de la valeur à 60 s | 110 | 114 | 105 | 103 | 102 | 100 | 98 | 98 |
| Runs à ±5 % de la valeur à 60 s | 1/24 | 1/24 | 8/24 | 14/24 | 16/24 | 24/24 | | |

La mémoire culmine juste après le défilement puis se stabilise ; entre 60 et 120 s l'écart médian n'est que de −2 %. Mesurer à 30 s décalerait 10 runs sur 24 de plus de 5 %.

### 3.3 Le choix des cookies

| Vérification TCF du choix enregistré | Accepter | Refuser |
|---|---|---|
| Choix confirmé | 253 | 228 |
| Le site ne suit pas le TCF | 544 | 338 |
| Aucun choix enregistré | 28 | 68 |
| Choix contraire au choix demandé | 9 | 11 |

- Les couples dont le choix enregistré contredit le choix demandé sont **exclus des comparaisons** accepter / refuser.
- Les 11 refus contredits enregistrent un consentement (jusqu'à 949 partenaires) après une visite de refus. Deux causes possibles : le site ignore le refus, ou l'heuristique d'autoconsent a cliqué le mauvais bouton (cas observé sur lemonde lors de l'étude de faisabilité). Une vérification manuelle est nécessaire avant toute conclusion site par site.
- En mode accepter, 101 visites ont détecté une bannière sans réussir à cliquer : la page est alors mesurée sans choix. Elles sont signalées et exclues des comparaisons.
- Sans TCF, on se fie au résultat de la bannière.

## 4. Granularité atteignable

1. **Iframes tierces : par site (eTLD+1), exactement.** C'est l'essentiel du coût tiers sur les médias.
2. **Processus principal : seul le tas JS est attribuable, par script.** Il ne pèse que 11–26 % de ce processus ; DOM, images, styles et buffers n'ont pas d'auteur dans les dumps. Le **non attribué** est donc faible sur les médias en mode accepter (où les tiers sont en iframe) mais majoritaire sur l'e-commerce et l'administration (où tout se passe dans la page principale). On attribue bien le coût **des tiers en iframe**, mal celui **des scripts tiers dans la page** (seulement leur JS).
3. **La mémoire est attribuée au lieu d'allocation** : une bibliothèque qui alloue pour le code du site se voit attribuer cette mémoire.
4. **Angles morts** : `ArrayBuffer` hors du tas V8, workers comptés en bloc, processus navigateur et GPU exclus.
5. **third-party-web a des trous** : adtrafficquality.google, presage.io (Ogury), pbstck.com (Pubstack)… restent « non classés ». Une correspondance maison est à ajouter.

## 5. Limites

1. **Blocage anti-robot : 17 % des sites.** Le grand e-commerce et quelques médias (lepoint, ebay, sncf, canva, blablacar, monoprix…) sont absents. Ils sont publiés comme « non mesurables par un robot déclaré ». Un site qui bloque est visité une seule fois puis ignoré, pour ménager la réputation de l'adresse IP.
2. **Une seule configuration** : Chromium 134 sans affichage sous Linux, écran 1366×768, connexion française. Les chiffres absolus sont propres à cette configuration (l'étude Windows donnait un onglet vide à 20 Mo contre 28 ici) ; les comparaisons entre sites, types et choix sont le résultat robuste.
3. **Murs « accepter ou s'abonner »** (lemonde, 20minutes, lefigaro…) : refuser mène à une page d'abonnement. Le mode refuser mesure la page derrière le mur, réaliste pour l'utilisateur mais pas un « vrai » refus.
4. **Tiers chargés malgré le refus** : 152 sites gardent plus de 40 % de mémoire tierce après un refus appliqué (ouest-france 50 %, tameteo 68 %). À qualifier (intérêt légitime, publicité contextuelle, outils non publicitaires ?) avant toute mise en cause.
5. **Catégories attribuées à la main**, d'après le titre et le domaine : quelques cas limites (voir l'historique de `data/site-categories.json`).

## 6. Suite

1. Correspondance d'entités maison pour compléter third-party-web.
2. Mieux attribuer le processus principal : snapshot de tas pour relier DOM et `ArrayBuffer` aux scripts, ou « ablation » (rejouer la page en bloquant une entité et mesurer le delta).
3. Mesure mensuelle sur la même liste (tâche planifiée le 1er de chaque mois) pour suivre l'évolution ; renouvellement de la liste CrUX une fois par an pour garder les séries comparables.

## Annexe : étude de faisabilité (20 sites, Windows, 12/11/2026)

20 sites × 2 choix × 5 runs, 203 runs, 0 erreur. Médianes : médias 758 Mo en acceptant contre 164 Mo en refusant (75 % de tiers), e-commerce 342 / 211 Mo, administration 62 / 61 Mo. Elle a établi la méthode et ses corrections :

- l'UA « HeadlessChrome » d'origine faisait bloquer 14 sites sur 30 et servait des pages dégradées (marmiton sans bannière ni publicité) : d'où l'UA standard déclaré ;
- l'heuristique d'autoconsent a une fois cliqué « accepter » en annonçant « refusé » (lemonde) : d'où la vérification TCF systématique et une règle dédiée ;
- la bannière n'était pas détectée sur une partie des runs : d'où la visite de consentement rejouée jusqu'au résultat attendu et mise en cache par site ;
- les pages de maintenance nocturne (CAF) étaient mesurées comme des pages normales : elles sont désormais détectées.

Données : `results/feasibility-2026-11/`.

## Reproduire

```
docker compose build
./campaign.sh 2026-11                                 # campagne complète (reprend où elle en était)
node src/aggregate.js results/2026-11                 # statistiques -> summary.json
node scripts/build-site.js results/2026-11/summary.json --campaign 2026-11
node test/validate.js 3 full                          # attribution sur la page de test (valeurs connues)
```

- `src/measure.js` : un run. `src/consent.js` : autoconsent et TCF. `src/attribute.js` : attribution (fonction pure, rejouable sur les fichiers bruts). `src/aggregate.js` : statistiques. `src/run.js` : la campagne (reprise, runs adaptatifs, mémoire surveillée).
- `scripts/build-sites.js` : la liste depuis CrUX. `scripts/site-stats.js` et `scripts/build-site.js` : les chiffres et le site.
