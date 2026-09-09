# Blueprint de la version cloud

## 1. Décision produit

La version cloud doit reprendre l’expérience visuelle et les concepts de Synara, tout en les faisant évoluer vers une plateforme SaaS sous une nouvelle marque. Le produit ne doit pas être présenté comme un simple éditeur de code en ligne. Sa proposition de valeur est un **workspace cloud pour développer avec des agents**, réunissant dépôt Git, conversation, terminal, fichiers, diff, navigateur, automatisations et pull requests.

Le produit doit conserver deux modes compatibles :

| Mode | Positionnement | Exécution |
| --- | --- | --- |
| Cloud | Workspace accessible depuis le navigateur, collaboratif et persistant | Runtime isolé dans le cloud |
| Desktop | Application installable pour travailler localement ou rejoindre un workspace cloud | Runtime local ou distant selon le projet |

Cette séparation permet de réutiliser l’expérience existante tout en évitant de forcer tous les utilisateurs à envoyer leur code dans le cloud.

## 2. Architecture de navigation proposée

### Pages publiques

| Route conceptuelle | Objectif |
| --- | --- |
| `/` | Landing page et présentation de la plateforme |
| `/product` | Décrire le workspace agent, l’éditeur, le terminal et Git |
| `/cloud` | Expliquer le fonctionnement des workspaces cloud |
| `/desktop` | Présenter l’application installable |
| `/security` | Décrire isolation, secrets, permissions et rétention |
| `/pricing` | Présenter les plans, quotas et limites |
| `/docs` | Documentation et démarrage |
| `/login` | Connexion |
| `/signup` | Création de compte |

### Pages authentifiées

| Route conceptuelle | Objectif |
| --- | --- |
| `/app` | Accueil et liste des workspaces |
| `/app/workspaces/new` | Création d’un workspace |
| `/app/workspaces/:id` | Vue principale du workspace |
| `/app/workspaces/:id/repository` | Dépôt, branches et état Git |
| `/app/workspaces/:id/task/:taskId` | Conversation et exécution d’une tâche |
| `/app/settings` | Compte, organisation, providers, secrets et préférences |
| `/app/settings/integrations` | GitHub et intégrations externes |
| `/app/settings/team` | Membres, rôles et invitations |
| `/app/billing` | Plan, consommation et facturation |

## 3. Évolution de la landing page

La landing page existante peut servir de référence visuelle et structurelle. Elle doit évoluer pour vendre clairement le produit cloud et éviter de communiquer uniquement sur l’application locale.

### Section héro

**Message recommandé :**

> Le workspace cloud pour construire avec des agents de programmation.

Le sous-texte doit expliquer que l’utilisateur connecte son dépôt, crée un environnement isolé et travaille avec un agent depuis une interface réunissant conversation, code, terminal et revue.

Les appels à l’action principaux sont :

- **Commencer gratuitement** ;
- **Voir la plateforme** ;
- **Télécharger l’application desktop**.

### Sections recommandées

| Section | Message |
| --- | --- |
| Héro | Créer, exécuter et revoir du code avec des agents dans un seul workspace. |
| Workflow | Connecter un dépôt, donner un objectif, inspecter le travail, ouvrir une pull request. |
| Interface | Montrer conversation, éditeur, terminal et diff dans la même surface. |
| Cloud et desktop | Présenter le cloud pour la continuité et le desktop pour le travail local. |
| GitHub | Expliquer la connexion sécurisée aux dépôts et la création de branches. |
| Agents | Présenter les providers supportés sans promettre une disponibilité identique pour chacun. |
| Sécurité | Présenter isolation des workspaces, permissions, secrets et rétention. |
| Automations | Décrire les tâches récurrentes et les notifications. |
| Social proof | À ajouter seulement avec des références réelles et vérifiables. |
| CTA final | Créer un workspace ou télécharger le desktop. |

La direction visuelle peut rester proche du dépôt : interface sombre, typographie technique, panneaux de travail, terminal et diff. Elle doit néanmoins obtenir une identité propriétaire distincte : couleurs, logo, iconographie, noms de composants, captures et tonalité éditoriale.

## 4. Parcours d’inscription et d’authentification

### Premier parcours

1. L’utilisateur arrive sur la landing page.
2. Il sélectionne **Commencer gratuitement**.
3. Il crée un compte par email ou via un fournisseur OAuth.
4. Il accepte les conditions et la politique de confidentialité.
5. Il crée ou rejoint une organisation personnelle.
6. Il choisit **Connecter un dépôt** ou **Explorer un workspace de démonstration**.
7. Le produit lui demande de connecter GitHub si nécessaire.
8. Il sélectionne un dépôt et une branche.
9. Le système crée un workspace cloud isolé.
10. L’utilisateur arrive sur la vue principale du projet.

### États à prévoir

| État | Comportement |
| --- | --- |
| Non authentifié | Accès aux pages publiques uniquement. |
| Authentifié sans organisation | Assistant de création d’organisation. |
| Authentifié sans dépôt | Assistant de connexion GitHub ou import manuel. |
| Dépôt connecté, workspace en préparation | Afficher la progression et permettre de quitter sans perdre la demande. |
| Workspace prêt | Ouvrir la tâche initiale ou la vue projet. |
| Session expirée | Préserver le brouillon local et rediriger vers la connexion. |
| Provider indisponible | Afficher une explication et proposer un autre provider ou une configuration ultérieure. |

### Authentification cible

L’authentification cloud doit inclure une identité utilisateur, des sessions sécurisées, des organisations et des rôles. Le pairing local existant peut rester utilisé pour certaines fonctions desktop, mais il ne doit pas devenir le modèle principal du SaaS.

Les rôles initiaux peuvent être :

| Rôle | Capacités |
| --- | --- |
| Owner | Facturation, suppression de l’organisation, intégrations et membres. |
| Admin | Gestion des membres, dépôts, workspaces et politiques. |
| Member | Création et utilisation des workspaces autorisés. |
| Viewer | Lecture des conversations, fichiers et résultats selon les permissions. |

## 5. Connexion à GitHub

### Parcours utilisateur

1. L’utilisateur sélectionne **Connecter GitHub**.
2. Il est redirigé vers GitHub OAuth ou l’application GitHub officielle.
3. Il autorise uniquement les organisations et dépôts sélectionnés.
4. Le produit enregistre un credential chiffré et limité.
5. Il récupère la liste des dépôts accessibles.
6. L’utilisateur choisit un dépôt, une branche et une région si ce choix existe.
7. Le produit crée un workspace isolé.
8. Le dépôt est cloné ou importé dans ce workspace.
9. Le produit affiche l’état du clone et le commit de départ.
10. L’utilisateur peut démarrer une tâche.

### Opérations Git initiales

Le premier périmètre doit inclure :

- clone du dépôt ;
- sélection de branche ;
- création de branche de travail ;
- lecture du statut ;
- diff ;
- commit ;
- push ;
- création de pull request ;
- synchronisation avec la branche distante.

Les opérations destructives ou susceptibles de perdre du travail doivent être protégées par des confirmations et des checkpoints. Les credentials GitHub doivent être courts, révocables et absents des arguments de processus et des journaux.

## 6. Workspace principal

La vue principale doit reprendre les surfaces existantes, mais les organiser autour du workspace cloud.

```text
┌──────────────────────────────────────────────────────────────┐
│ Marque · Organisation · Workspace · branche · état runtime   │
├─────────────┬───────────────────────────────┬───────────────┤
│ Navigation  │ Conversation / éditeur        │ Inspecteur    │
│ projets     │ tâche active                   │ fichiers      │
│ tâches      │ messages · outils · plans     │ diff · Git     │
├─────────────┴───────────────────────────────┴───────────────┤
│ Terminal · logs · prévisualisation · événements · contrôles  │
└──────────────────────────────────────────────────────────────┘
```

Les concepts existants de projet, tâche, tour, session provider et environnement peuvent devenir les concepts centraux du cloud. Le terme **workspace** doit représenter l’environnement cloud complet ; le terme **task** doit représenter une unité de travail ; le terme **turn** doit représenter une instruction et son exécution.

## 7. Architecture cloud cible

### Control plane

Le control plane gère les données durables et les opérations de produit :

- utilisateurs et sessions ;
- organisations et rôles ;
- dépôts connectés ;
- workspaces ;
- tâches et conversations ;
- événements et projections ;
- plans, quotas et consommation ;
- secrets et intégrations ;
- notifications ;
- audit et rétention.

### Execution plane

Le execution plane exécute le code et les agents :

- un workspace isolé par tâche ou projet ;
- un checkout Git ;
- un runtime provider ;
- un terminal ;
- un navigateur si nécessaire ;
- un stockage temporaire ;
- des limites de CPU, mémoire, processus et réseau ;
- un mécanisme de suspension et reprise ;
- une destruction garantie à l’expiration.

### Stockage logique

| Donnée | Stockage cible |
| --- | --- |
| Identité, organisations et permissions | Base relationnelle partagée |
| Événements et projections | Base relationnelle avec partition logique par organisation |
| Fichiers, pièces jointes et artefacts | Stockage objet |
| Workspace actif | Volume éphémère ou persistant selon le plan |
| Secrets | Secret manager ou coffre chiffré |
| Logs et traces | Système d’observabilité avec rétention contrôlée |
| Files d’exécution | Queue ou broker durable |

## 8. Correspondance avec le dépôt existant

| Élément existant | Direction de réutilisation |
| --- | --- |
| `apps/web` | Réutiliser l’interface et faire évoluer le routage vers les comptes et workspaces cloud. |
| `apps/desktop` | Conserver comme application installable et client du cloud ou runtime local. |
| `apps/server` | Séparer le control plane des services d’exécution locale. |
| `packages/contracts` | Étendre les contrats avec identité, organisation, workspace distant et lifecycle. |
| `packages/shared` | Réutiliser les types et utilitaires réellement indépendants du système local. |
| Orchestration | Conserver le modèle événements/projections en le rendant multi-tenant et distribuable. |
| Providers | Garder l’interface d’adaptateur, remplacer progressivement les processus locaux par des workers cloud. |
| Git/worktrees | Déplacer l’exécution dans le workspace runner. |
| SQLite | Réserver au mode local ou aux tests ; ne pas en faire la base centrale SaaS. |
| Pairing local | Garder pour le desktop local, compléter par une authentification web standard. |
| Assets et marketing | Réutiliser la structure, remplacer totalement la marque et les références propriétaires. |

## 9. Périmètre recommandé du premier produit cloud

Le premier lancement ne doit pas essayer de reproduire toutes les capacités du desktop. Le périmètre initial recommandé est :

1. création de compte ;
2. organisation personnelle ;
3. connexion GitHub ;
4. sélection d’un dépôt ;
5. création d’un workspace cloud isolé ;
6. conversation avec un provider cloud ;
7. lecture et édition des fichiers ;
8. terminal limité ;
9. diff et branche de travail ;
10. commit et pull request ;
11. reprise d’une session ;
12. quotas, logs et suppression du workspace.

Le navigateur intégré, les automations complexes, les handoffs multi-provider et les intégrations MCP externes peuvent venir après la stabilisation du runtime cloud.

## 10. Décisions à prendre avant le développement

| Décision | Choix à clarifier |
| --- | --- |
| Marque | Nom, domaine, logo, palette et ton éditorial. |
| Modèle économique | Gratuit, crédits, abonnement, équipe ou consommation. |
| Providers | Providers hébergés par la plateforme, clés utilisateur ou modèle hybride. |
| Dépôts | GitHub uniquement au départ ou GitLab/Bitbucket également. |
| Hébergement | Région, fournisseur cloud, exigences de résidence des données. |
| Isolation | Container renforcé, microVM ou infrastructure spécialisée. |
| Persistance | Workspace éphémère, suspendu ou toujours disponible. |
| Collaboration | Solo au départ ou équipe dès la première version. |
| Desktop | Local uniquement, cloud uniquement ou mode hybride. |
| Données | Rétention des conversations, fichiers, logs et snapshots. |

## 11. Plan de travail sans code

La préparation peut commencer sans modifier le dépôt source. Les livrables de conception sont :

1. identité de marque et direction visuelle ;
2. wireframe de la landing page ;
3. plan des routes publiques et privées ;
4. user flow inscription → GitHub → workspace ;
5. spécification des écrans d’authentification ;
6. spécification des permissions et organisations ;
7. contrat conceptuel du workspace cloud ;
8. séparation control plane / execution plane ;
9. inventaire des composants réutilisables ;
10. liste des composants qui devront être adaptés ;
11. matrice de risques sécurité ;
12. plan de migration du runtime local vers le cloud.

## Conclusion

La version cloud est réalisable en utilisant le dépôt existant comme fondation. La bonne approche consiste à **réutiliser l’expérience et les contrats**, puis à créer une couche cloud explicite autour d’un workspace d’exécution isolé. La landing page, l’authentification, la connexion GitHub et le workspace peuvent être conçus dès maintenant sans modifier le code. Le changement le plus important ne sera pas visuel : ce sera le passage d’un serveur local possédant la machine de l’utilisateur à un runtime cloud isolé, multi-tenant et exploitable en production.
