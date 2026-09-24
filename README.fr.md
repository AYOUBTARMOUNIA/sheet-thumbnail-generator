# Sheet Thumbnail Generator pour Qlik Sense Enterprise on Windows

Générez automatiquement de vraies vignettes de feuilles dans Qlik Sense Enterprise on Windows. Fini les aperçus gris et les captures d'écran manuelles.

🇬🇧 [English version](README.md)

<!-- Ajoutez votre GIF de démonstration dans docs/demo.gif, puis retirez les marqueurs de commentaire ci-dessous. -->
<!-- ![Démonstration](docs/demo.gif) -->

## Pourquoi

Depuis sa mise à jour de novembre 2025, Qlik Cloud génère automatiquement les vignettes des feuilles à partir de leur contenu réel. Sur Qlik Sense Enterprise on Windows (QSEoW), la méthode officielle reste de faire une capture d'écran et de l'ajouter à la main à chaque feuille via la bibliothèque de médias.

Cette extension apporte le fonctionnement automatique à QSEoW : on la pose sur une feuille, on clique une fois, et chaque feuille de l'app reçoit une vignette fidèle à sa mise en page réelle.

## Fonctionnalités

- Génération de la vignette de la feuille courante, ou de toutes les feuilles en une seule fois.
- Capture du rendu réel de chaque feuille : thème, graphiques, tableaux, KPI.
- Attente que la feuille soit entièrement prête avant la capture. Les objets doivent être calculés par le moteur, les indicateurs de chargement disparus, les graphiques canvas dessinés et le rendu stable (animations comprises).
- Images enregistrées dans la bibliothèque de médias de l'app, exactement comme un import manuel.
- Feuilles non modifiables ignorées et signalées dans un journal de progression.
- Remplacement de ses propres vignettes et suppression des anciens fichiers, avec des noms horodatés pour éviter les problèmes de cache navigateur.
- Compatible avec les préfixes de proxy virtuel.
- Aucun accès Internet nécessaire : html2canvas est inclus.

## Fonctionnement

1. La feuille est affichée dans le client Qlik Sense.
2. L'extension vérifie que la feuille est prête :
   - chaque objet de la feuille a fini son calcul (`GetLayout` côté moteur) ;
   - aucun indicateur de chargement n'est visible et toutes les images sont chargées ;
   - chaque graphique canvas contient un dessin ;
   - l'empreinte visuelle de la feuille, pixels des canvas compris, ne change plus pendant environ 1,2 s.
3. La feuille est capturée dans le navigateur avec [html2canvas](https://html2canvas.hertzen.com).
4. Le PNG est déposé dans le contenu de l'app via l'API Qlik Repository Service (`POST /qrs/appcontent/{appId}/uploadfile`).
5. La propriété `thumbnail` de la feuille est mise à jour et l'app est enregistrée.

## Prérequis

- Qlik Sense Enterprise on Windows. Qlik Sense Desktop n'est pas pris en charge (pas de Repository Service).
- Un navigateur récent (Chrome, Edge ou Firefox).
- Une app non publiée, ou une copie de travail d'une app publiée.
- Le droit de déposer des images dans la bibliothèque de médias de l'app (mêmes droits qu'un import manuel).

## Installation

1. Téléchargez `SheetThumbnailGenerator-v1.1.0.zip` depuis la page [Releases](https://github.com/AYOUBTARMOUNIA/sheet-thumbnail-generator/releases).
2. Dans la QMC, ouvrez **Extensions** et cliquez sur **Importer**.
3. Sélectionnez le fichier zip.

Pour mettre à jour : supprimez l'ancienne version dans la QMC, importez le nouveau zip, puis rechargez le navigateur avec Ctrl+F5.

## Utilisation

1. Ouvrez une app non publiée (ou une copie de travail).
2. Créez une feuille « Outils » et ajoutez-y l'objet **Sheet Thumbnail Generator**.
3. Quittez le mode édition : les boutons ne sont actifs qu'en mode analyse.
4. Cliquez sur l'un des deux boutons :
   - **Générer pour cette feuille** génère la vignette de la feuille affichée.
   - **Générer pour toutes les feuilles** parcourt chaque feuille, la capture et met à jour sa vignette. Un panneau de progression avec un bouton Arrêter s'affiche en bas à droite, et vous revenez à la feuille de départ à la fin.
5. Supprimez la feuille « Outils » si vous le souhaitez, puis publiez ou remplacez l'app.

Pendant un traitement en lot, gardez l'onglet du navigateur au premier plan : un onglet en arrière-plan ralentit le rendu.

## Paramètres

Disponibles dans le panneau des propriétés, section « Vignettes ».

| Paramètre | Défaut | Rôle |
|---|---|---|
| Largeur de la vignette (px) | 800 | Largeur de l'image générée. La hauteur est proportionnelle. |
| Temps d'attente minimal par feuille (ms) | 2500 | Délai plancher avant capture en mode lot, en plus de la vérification du rendu. |
| Temps d'attente maximal par feuille (s) | 30 | Au-delà, la feuille est considérée comme non prête. Augmentez-le pour les apps lourdes. |
| Si une feuille n'est pas prête à temps | Capturer quand même | Capture avec avertissement dans le journal, ou feuille ignorée. |
| Remplacer les vignettes existantes | Oui | Si décoché, les feuilles qui ont déjà une vignette sont ignorées. |
| Exclure la feuille qui contient cet objet | Oui | Évite de générer la vignette de la feuille « Outils ». |
| Sélecteur CSS de la zone à capturer | vide | Détection automatique si vide. À renseigner seulement si la capture est vide ou mal cadrée. |

## Droits

Les feuilles de base d'une app publiée et les feuilles approuvées ne sont pas modifiables. L'extension les ignore et le signale dans le journal.

Le dépôt dans le contenu de l'app demande les mêmes droits qu'un import manuel dans la bibliothèque de médias. Le propriétaire d'une app non publiée les a avec les règles de sécurité par défaut. Une erreur `QRS 403` indique un problème de règle de sécurité.

## Limites connues

- **Contenu externe** : un fond de carte ou une image servie par un autre domaine sans en-têtes CORS peut bloquer la capture de la feuille. Un message d'erreur explicite s'affiche.
- **Feuilles étendues ou défilantes** : seule la zone visible est capturée.
- **Fidélité du rendu** : html2canvas reproduit fidèlement la plupart des objets, mais certains effets CSS avancés peuvent différer légèrement. Pour une vignette, le résultat est largement suffisant.
- **DOM du client** : les classes CSS du client Qlik Sense ne sont pas une API officielle et peuvent changer d'une version à l'autre. Si la détection automatique échoue après une mise à jour, inspectez la page (F12) et renseignez le sélecteur de la zone à capturer dans les propriétés.
- **Feuilles masquées** par une condition d'affichage : ignorées en mode lot si la navigation vers elles échoue.
- **Objets qui ne finissent jamais de charger** (par exemple une extension avec une animation permanente) : la feuille atteint le délai maximal, puis elle est capturée avec avertissement ou ignorée selon le réglage.

## Dépannage

| Symptôme | Solution |
|---|---|
| Vignette vide ou mal cadrée | Renseignez le sélecteur CSS de la zone à capturer (repérez le conteneur de la feuille avec F12). |
| Graphiques absents sur certaines vignettes | Augmentez les temps d'attente minimal et maximal. |
| `QRS 403` | Vérifiez les règles de sécurité sur le contenu de l'app dans la QMC. |
| `QRS 404` sur `/qrs` | Votre proxy virtuel ne transmet peut-être pas les appels au Repository Service. |
| L'ancienne vignette s'affiche encore | Rechargez le navigateur avec Ctrl+F5. |

## Contribuer

Les issues et pull requests sont les bienvenues. Pour signaler un bug, indiquez votre version de Qlik Sense, votre navigateur et l'erreur éventuelle affichée dans la console du navigateur (F12).

## Licence

[MIT](LICENSE). Ce projet inclut html2canvas 1.4.1 (MIT), voir [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Avertissement

Projet communautaire indépendant, sans lien avec Qlik, ni approuvé ni supporté par Qlik. Qlik et Qlik Sense sont des marques de QlikTech International AB.
