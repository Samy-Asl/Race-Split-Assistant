# Race Split Assistant

Race Split Assistant est une WebApp/PWA mobile-first pour préparer une stratégie de course, découper une course en checkpoints, puis suivre son chrono pendant l’effort.

L’application fonctionne sans GPS, sans capteurs de mouvement, sans API externe, sans librairie externe et sans framework. Elle reste gratuite, offline après un premier chargement, et stocke les données dans `localStorage`.

## Logo et icônes

Le fichier PWA principal est dans `assets/` :

- `assets/logo.png`

Ce logo est référencé par le manifest, Safari iPhone et le favicon navigateur.

## Principe

1. Créez une course avec une distance et un objectif chrono.
2. Dessinez le parcours maintenant ou plus tard.
3. Ajoutez vos temps de passage : ravitos, repères, zones difficiles, finish.
4. Lancez le mode live.
5. Appuyez sur `Point passé` à chaque ravito ou repère.
6. L’application calcule votre avance, votre retard, la distance restante, le temps restant et l’allure nécessaire.

L’application ne crée plus de course d’exemple automatiquement. Une première installation démarre vide pour laisser l’utilisateur construire ses propres stratégies.

Si le premier checkpoint est `Départ` à `0 km` et `00:00:00`, il est validé automatiquement. Le premier point manuel devient donc le premier vrai checkpoint après le départ.

## Distance sans GPS

Race Split Assistant ne mesure pas automatiquement la distance.

La distance actuelle est estimée de deux façons :

- automatiquement à chaque checkpoint validé ;
- manuellement avec les boutons `+0.1 km`, `+0.5 km`, `Modifier` ou `Recaler`.

Les capteurs du téléphone ne sont pas utilisés, car ils sont trop imprécis pour une stratégie fiable en course. La distance manuelle sert seulement à améliorer les calculs entre deux checkpoints.

## Mode live

Le mode live affiche :

- chrono global très lisible ;
- statut : avance, dans le rythme, retard léger, gros retard ;
- checkpoint à valider ;
- distance restante ;
- temps objectif restant ;
- prochain point et distance jusqu’à ce point ;
- allure nécessaire restante ;
- conseil du segment ;
- dernier passage validé.

Le chrono est calculé avec `Date.now()`. Il reste donc cohérent si le téléphone est verrouillé, si l’application passe en arrière-plan ou si l’écran se rafraîchit moins souvent.

## Pause et reprise

Quand vous mettez en pause, l’application sauvegarde l’heure de début de pause. À la reprise, la durée de pause est retirée du chrono.

Si l’application est fermée pendant une pause, elle rouvre toujours dans l’état pause, sans faire avancer le chrono.

## Reprise après fermeture

Une course active sauvegarde :

- course active ;
- état live ;
- timestamp réel du départ ;
- durée de pause cumulée ;
- checkpoint à valider ;
- dernier checkpoint validé ;
- distance actuelle estimée ;
- historique des passages ;
- temps réels enregistrés.

Au redémarrage, un écran `Course en cours détectée` permet de reprendre ou d’abandonner. Abandonner supprime seulement la session active, pas les courses sauvegardées.

## Créer une course

Depuis l’accueil, utilisez `Créer ma première course` ou `Nouvelle course`.

Champs principaux :

- nom ;
- distance totale, par exemple `19.7` ;
- objectif chrono avec des champs séparés heures, minutes et secondes ;
- type de course ;
- notes personnelles ;
- choix du moment pour dessiner le parcours : maintenant ou plus tard.

## Dessiner le parcours

Depuis le tableau de bord d’une course, utilisez `Dessiner le parcours`.

L’éditeur SVG permet de :

- choisir un segment en ligne droite ou en courbe ;
- cliquer dans la zone pour placer des points ;
- déplacer les points au doigt ou à la souris ;
- annuler le dernier point ;
- réinitialiser le dessin avec confirmation ;
- sauvegarder le parcours dans la course.

Le premier point est identifié comme départ, le dernier comme arrivée. Les modifications non sauvegardées sont signalées dans l’éditeur.

## Créer des temps de passage

Dans l’écran `Passages`, ajoutez les temps de passage.

Chaque temps de passage contient :

- nom ;
- distance cumulée depuis le départ ;
- temps cible cumulé avec des champs heures, minutes et secondes ;
- type de zone ;
- stratégie ;
- conseil personnel ;
- temps ravito max si nécessaire.

Les temps de passage sont triés par distance. Les distances et temps cibles doivent rester strictement croissants. Un avertissement apparaît si le dernier point ne correspond pas à la distance totale.

## Exporter et importer

Les fonctions JSON existent dans le code pour la sauvegarde technique, mais les boutons d’import/export sont masqués dans l’interface de cette version.

## Installation PWA

### Android Chrome

1. Ouvrez l’application depuis HTTPS ou `localhost`.
2. Ouvrez le menu Chrome.
3. Choisissez `Installer l’application` ou `Ajouter à l’écran d’accueil`.

Si le navigateur supporte l’installation PWA, le bouton `Installer l’application` apparaît directement sur l’accueil.

### iPhone Safari

1. Ouvrez l’application dans Safari.
2. Touchez le bouton de partage.
3. Choisissez `Sur l’écran d’accueil`.

Sur iPhone, le bouton d’installation automatique n’existe pas. L’application affiche donc les étapes à suivre dans Safari.

## Lancer en local

Depuis le dossier du projet :

```bash
python -m http.server 8080
```

Puis ouvrez `http://localhost:8080`.

## Publier sur GitHub Pages

Le projet est un site statique. Publiez simplement ces fichiers à la racine du dépôt :

- `index.html`
- `style.css`
- `app.js`
- `manifest.json`
- `service-worker.js`
- `README.md`

Dans GitHub, activez `Settings > Pages`, choisissez la branche à publier, puis ouvrez l’URL GitHub Pages fournie. Les chemins sont relatifs, donc l’application fonctionne aussi dans un sous-dossier de dépôt.

## Offline

Le service worker met en cache :

- `index.html`
- `style.css`
- `app.js`
- `manifest.json`

Après un premier chargement, l’application peut fonctionner hors ligne.

## Arrière-plan et chrono

Une PWA ne peut pas garantir une exécution continue en arrière-plan comme une application native.

Race Split Assistant ne tente donc pas de faire tourner un compteur en arrière-plan. Le chrono reste fiable grâce à `Date.now()` :

- l’heure réelle de départ est sauvegardée ;
- les pauses sont sauvegardées ;
- le checkpoint actuel, l’historique et la distance estimée sont sauvegardés ;
- quand vous revenez dans l’application, le temps réel est recalculé correctement.

Pendant le mode live, l’application essaie d’utiliser Screen Wake Lock si le navigateur le permet. Si ce n’est pas disponible, aucune erreur n’est affichée et le chrono reste correct à la reprise.

## Limites

- Pas de GPS.
- Pas de détection automatique de distance.
- Pas d’API externe.
- La précision dépend des checkpoints validés et des ajustements manuels.
- Les données restent dans le navigateur utilisé.
