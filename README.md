# Hotte Surprise 🎁

Petit site pour organiser un Secret Santa, en une seule page sans serveur.

1. Saisis l'événement, le budget, la date et les participants.
2. Ajoute les exclusions éventuelles (couples…).
3. Lance le tirage : personne ne se tire soi-même.
4. Envoie à chacun son lien perso, qui ne révèle que la personne à qui il offre.

Le tirage n'est stocké nulle part : chaque résultat est encodé dans le lien du participant.

## Ajouter une image (Leonardo ou autre)

Dépose une image nommée `hero.jpg` dans le dossier `assets/` : elle s'affiche automatiquement en haut de la page d'accueil et de la page de révélation. Format conseillé : paysage, environ 1600 × 600 px.

## Version avec inscription par email (serveur Google Apps Script)

Le dossier `server/` contient `Code.gs`, un petit serveur gratuit à déployer sur [script.google.com](https://script.google.com) :
inscriptions par email, code secret, exclusions, tirage vérifié côté serveur et envoi des résultats par email.
L'URL du déploiement (`…/exec`) se met dans `API_URL` en haut du script de `index.html`.
