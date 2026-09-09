# Cloud version — Livrables de conception (exécution du plan sans code)

> Issue du plan de travail §11 de « Blueprint de la version cloud ». Les 12 livrables ci-dessous sont des documents de conception prêts pour wireframe, spécifications et implémentation.

 Aucun code source n'est encore modifié.



## 1. Identité de marque et direction visuelle

| Attribut | Proposition | Alternatives à trancher |
| --- | --- | --- |
| Nom | **Aurora Works** (travail orienté production) | Synara Cloud, Orbit.dev, Forge |
| Domaine | `auroraworks.dev` | `tryaurora.dev`, `aurora.works` |
| Proposition | « Le workspace cloud pour construire avec des agents de programmation » | « L’atelier cloud des agents » |
| Logo | Icône assemblage de panneaux (conversation + terminal + diff) dans un carré arrondi sombre | Marque initiale « A » stylisée |
| Palette | Fond `#0B0F14`, surfaces `#121820`, accent `#6E8CFF` (blue electrique), succès `#3ECF8E`, danger `#E5484D` | Accent violet `#8B7CF6` |
| Typographie | Titres : « JetBrains Mono » / « Geist »; texte : « Inter »; code : « JetBrains Mono » | — |
| Ton éditorial | Direct, technique, confiant; français en priorité, anglais en secondaire. | — |

Direction visuelle : interface sombre, héritée de Synara, mais **identité propriétaire distincte** (logo, palette, iconographie, captures et tonalité) pour ne jamais être confondu avec un simple éditeur de code en ligne.



## 2. Wireframe de la landing page

```text
┌─────────────────────────────────────────────────────────────┐
│ Logo AurorA · Produit · Cloud · Desktop · Sécurité        │ Login · Signup
│  Prix · Docs                                             │  ───────── │
├─────────────────────────────────────────────────────────────┤
│  HÉRO                                                  │
│  « Créer, exécuter et revoir du code avec des agents    │
│    dans un seul workspace »                              │
│  Connectez votre dépôt, créez un environnement isolé,    │
│  travaillez avec un agent — conversation, code,         │
│  terminal et revue réunis.                              │
│  [Commencer gratuitement]  [Voir la plateforme]       │
│  [⬇ Télécharger le desktop]                              │
│  ┌────────────────────────────────────────────────────┐   │
│  │ Capture : conversation + éditeur + terminal + diff │   │
│  └────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│ Workflow : Connecter un dépôt → Donner un objectif →        │
│            Inspecter le travail → Ouvrir une pull request    │
├─────────────────────────────────────────────────────────────┤
│ Interface : Conversation · Éditeur · Terminal · Diff        │
├─────────────────────────────────────────────────────────────┤
│ Cloud & desktop : continuité cloud · travail local          │
├─────────────────────────────────────────────────────────────┤
│ GitHub : connexion sécurisée, branches et PR              │
├─────────────────────────────────────────────────────────────┤
│ Agents : providers supportés (sans promesse de parité)  │
├─────────────────────────────────────────────────────────────┤
│ Sécurité : isolation, permissions, secrets, rétention  │
├─────────────────────────────────────────────────────────────┤
│ Automations : tâches récurrentes et notifications          │
├─────────────────────────────────────────────────────────────┤
│ Social proof : à ajouter seulement avec références réelles    │
├─────────────────────────────────────────────────────────────┤
│ CTA final : [Créer un workspace]  [Télécharger desktop]  │
├─────────────────────────────────────────────────────────────┤
│ Footer : Produit · Entreprise · Légal · Statut · Social      │
└─────────────────────────────────────────────────────────────┘
```

Sections (du blueprint §3) : Héro, Workflow, Interface, Cloud/desktop, GitHub, Agents, Sécurité, Automations, Social proof (conditionnel), CTA final.



## 3. Plan des routes publiques et privées

### Publiques (non authentifié)

| Route | Objectif |
| --- | --- |
| `/` | Landing page |
| `/product` | Workspace agent, éditeur, terminal, Git |
| `/cloud` | Fonctionnement des workspaces cloud |
| `/desktop` | Application installable |
| `/security` | Isolation, secrets, permissions, rétention |
| `/pricing` | Plans, quotas, limites |
| `/docs` | Documentation et démarrage |
| `/login` | Connexion |
| `/signup` | Création de compte |

### Privées (authentifié)

| Route | Objectif | Accès |
| --- | --- | --- |
| `/app` | Accueil et liste des workspaces | Tous rôles |
| `/app/workspaces/new` | Création d’un workspace | Member+ |
| `/app/workspaces/:id` | Vue principale du workspace | Member+ |
| `/app/workspaces/:id/repository` | Dépôt, branches, état Git | Member+ |
| `/app/workspaces/:id/task/:taskId` | Conversation et exécution | Member+ |
| `/app/settings` | Compte, organisation, providers, secrets | Tous |
| `/app/settings/integrations` | GitHub et intégrations | Admin+ (selon politic) |
| `/app/settings/team` | Membres, rôles, invitations | Admin+ |
| `/app/billing` | Plan, consommation, facturation | Owner |

Guards : non authentifié → `/login`; authentifié sans organisation → assistant d’organisation; sans dépôt → assistant GitHub; permissions insuffisantes → 403 page dédiée. (`Voir §4 blueprint`)





## 4. User flow inscription → GitHub → workspace

```text
1. Landing page → CTA [Commencer gratuitement]
2. → `/signup` : email + mot de passe OU OAuth (Google/GitHub)
3. → acceptation conditions + politique de confidentialité
4. → création organisation personnelle (assistant)
5. → choix : [Connecter un dépôt] ou [Explorer un workspace de démonstration]
6. → (si nécessaire) connexion GitHub (OAuth, périmètre minimal)
7. → sélection dépôt + branche (+ région si dispo)
8. → création du workspace cloud isolé (avec progression annulable sans perte)
9. → clone du dépôt dans le workspace + commit de départ affiché
10. → vue principale du workspace + invitation à démarrer une tâche
```

Échecs gérés : session expirée → brouillon local préservé + redirection login; provider indisponible → explication + autre provider ou config ultérieure. (`§4 blueprint`)



## 5. Spécification des écrans d’authentification

### `/login`
- Email + mot de passe OU boutons OAuth (Google, GitHub);
- « Continuer avec GitHub » pré-rempli le flux d’organisation;
- Lien « Créer un compte »;
- Gestion des erreurs : email inconnu, mot de passe erroné, provider indisponible, compte désactivé;

### `/signup`
- Email + mot de passe (8+ caractères, indicateur de force);
- OAuth; case à cocher conditions + confidentialité (obligatoire);
- Vérification d’email obligatoire avant première connexion complète.


### Session et rôles
| État | Comportement |
| --- | --- |
| Authentifié, sans organisation | Assistant de création d’organisation |
| Authentifié, sans dépôt | Assistant de connexion GitHub ou import manuel |
| Session expirée | Préserver le brouillon local, rediriger vers `/login`, retour sans perte |
| Rôle insuffisant | Page 403 + demande d’accès au propriétaire |



## 6. Spécification des permissions et organisations

### Modèle d’organisation
| Élément | Définition |
| --- | --- |
| Organisation | Conteneur de facturation, membres, intégrations et politiques |
| Membre | Utilisateur rattaché à une organisation avec un rôle |
| Invitation | Email, rôle cible, expiration (7 jours par défaut), révocation |

### Rôles initiaux (`§4 blueprint`)
| Rôle | Capacités |
| --- | --- |
| Owner | Facturation, suppression organisation, intégrations, membres |
| Admin | Gestion membres, dépôts, workspaces, politiques |
| Member | Création et utilisation des workspaces autorisés |
| Viewer | Lecture conversations, fichiers, résultats selon permissions |

### Matrice permissions (résumé)
| Action | Owner | Admin | Member | Viewer |
| --- | --- | --- | --- | --- |
| Voir workspace | ✔ | ✔ | ✔ | ✔ |
| Créer/supprimer workspace | ✔ | ✔ | ✔/* | ✘ |
| Lancer une tâche | ✔ | ✔ | ✔ | ✘ |
| Configurer intégrations/secrets | ✔ | ✔ | ✘ | ✘ |
| Gérer les membres | ✔ | ✔ | ✘ | ✘ |
| Facturation | ✔ | ✘ | ✘ | ✘ |
| Supprimer l’organisation | ✔ | ✘ | ✘ | ✘ |

*selon politique d’organisation (quotas, restriction par dépôt).



## 7. Contrat conceptuel du workspace cloud

```ts
type WorkspaceCloud = {
  id: string;
  organizationId: string;
  name: string;
  status: "provisioning" | "ready" | "suspended" | "destroyed";
  region: Region;
  repository?: { owner: string; repo: string; branch: string; headSha: string };
  checkout: { path: string; commit: string };
  quotas: { cpu: number; memoryMb: number; storageGb: number; network: "isolated" | "restricted" };
  lifecycle: { createdAt: iso; lastActiveAt: iso; expiresAt: iso; destroyAt: iso };
  isolation: "container-hardened" | "microvm";
};

type TaskCloud = {
  id: string; workspaceId: string;
  title: string;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  turn: number;
  providerSessionId?: string;
};

type CloudEvent = {
  id: string; workspaceId: string; taskId?: string;
  type: "task.update" | "git.update" | "runtime.update" | "quota.warning" | "session.expiring";
  at: iso; payload: unknown;
};
```

Invariants : un workspace possède un checkout Git unique; une tâche appartient à un workspace; un événement est immuable et append-only; destruction garantie à `destroyAt`.



## 8. Séparation control plane / execution plane

### Control plane (données durables + produit)
| Domaine | Responsabilité |
| --- | --- |
| Identité | Utilisateurs, sessions, organisations, rôles |
| Dépôts | Connexions GitHub,(credentials chiffrés, révocables) |
| Workspaces | Métadonnées, quotas, lifecycle |
| Tâches | Conversations, tours, événements, projections |
| Intégrations | Secrets, providers, notifications |
| Observabilité | Audit, logs, rétention |

### Execution plane (code + agents)
| Domaine | Responsabilité |
| --- | --- |
| Runtime | Workspace isolé par tâche/projet |
| Git | Checkout, branches, worktrees |
| Surfaces | Terminal, navigateur, fichiers |
| Limites | CPU, mémoire, processus, réseau |
| Cycle de vie | Suspension, reprise, destruction garantie |

### Contrat d’interfaces (esquisse`
| Interface | Direction | Charge |
| --- | --- | --- |
| `ControlPlane.ProvisionWorkspace(wsId)` → runner | Réserve quota, crée volume, clone dépôt, renvoie endpoint |
| `Runner.Heartbeat(wsId, usage)` → control plane | Met à jour quotas/dernière activité; déclenche avertissements |
| `Runner.StreamEvents(wsId)` → control plane | Événements runtime normalisés vers projection/audit |
| `ControlPlane.Terminate(wsId, reason)` → runner | Suspension/destruction avec nettoyage déterministe |

Stockage logique (`§7 blueprint`) : identité/organisations → base relationnelle partagée; événements → base relationnelle partitionnée; fichiers/artefacts → stockage objet; workspace actif → volume éphémère/persistant selon plan; secrets → secret manager; logs → observabilité rétentionnée; files → queue durable.



## 9. Inventaire des composants réutilisables

| Composant existant | Emplacement | Réutilisation cloud |
| --- | --- | --- |
| Interface shell et surfaces | `apps/web` | Réutilisé tel quel, routage adapté aux comptes/workspaces |
| Navigation/tabs/tâches | `apps/web/src/components` | Réutilisé (sidebar, pickers, split views) |
| Transport WebSocket typé | `apps/web/src/wsTransport.ts`, `wsNativeApi.ts` | Réutilisé avec auth de session +
| Orchestration événements/projections | `apps/server/src/orchestration` | Modèle conservé, rendu multi-tenant et distribuable |
| Adapter provider | `ProviderAdapter`, `ProviderAdapterRegistry` | Interface conservée; processus locaux remplacés par workers cloud |
| Contrats partagés | `packages/contracts` | Étendus (identité, organisation, workspace distant, lifecycle) |
| Utilitaires cross-runtime | `packages/shared` | Réutilisés (subpath exports, pas de barrel) |
| Git/worktrees | `apps/server/src/git` | Logique conservée, exécution déplacée dans le workspace runner |
| Terminal | `apps/server/src/terminal` | Conservé, sandboxé dans le runtime cloud |
| Desktop | `apps/desktop` | Conservé comme hôte installable/client cloud |



## 10. Composants qui devront être adaptés

| Composant | Adaptation requise |
| --- | --- |
| Routage web | Ajout comptes, organisations, workspaces distants, gardes d’accès |
| Authentification | Remplacement du pairing local par sessions web sécurisées + OAuth |
| Persistance | SQLite réservé au local/tests; base relationnelle multi-tenant pour identité/organisations |
| Orchestration | Multi-tenant, séquencement par organisation, partitionnement logique |
| Providers | Nouveau mode « worker cloud » à côté des processus locaux |
| Processus/sessions | Gestion à distance (workers), pas de processus enfants locaux |
| Stockage de fichiers | Local → stockage objet (pièces jointes, artefacts, checkpoints) |
| Secrets | Coffre local → secret manager chiffré avec rotation |
| Quotas/consommation | Nouvelles métriques (CPU, mémoire, durée, stockage, réseau) |
| Notifications | Métriques runtime, expirations, événements Git, fin de tâche |
| Audit/rétention | Journalisation centralisée avec politiques de rétention par org |
| Desktop | Client du cloud ou runtime local isolé (pas de double vérité) |



## 11. Matrice de risques sécurité

| # | Risque | Gravité | Probabilité | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | Évasion de conteneur d’un code agent != fiable | Critique | Moyenne | MicroVM pour code non fiable; seccomp/AppArmour, noyau renforcé, drop capabilities |
| 2 | Fuite de secrets/credentials (GitHub, provider) | Critique | Moyenne | Secret manager, chiffrement au repos, rotation, jamais dans argv/logs |
| 3 | Exfiltration de code/données par le runtime | Élevée | Moyenne | Réseau isolé par défaut; egress contrôlé et journalisé; approbations |
| 4 | Rélancement de workspace après expiration/cancel | Élevée | Basse | Destruction garantie, garçon de vie sur tous les workers, audit |
| 5 | Accès inter-tenant (org A lit org B) | Critique | Basse | Partitionnement logique strict, tests d’isolation automatisés, RBAC enforcer côté serveur |
| 6 | Vol de session/token | Élevée | Moyenne | Sessions courtes + refresh rotation, MFA optionnelle, révocation |
| 7 | Malware/actions destructives dans le dépôt (push force, secrets commité) | Élevée | Moyenne | Branches de travail protégées, confirmations, checkpoints, push restreint aux branches préfixées |
| 8 | DoS sur quota (CPU/mémoire infinie) | Élevée | Moyenne | Quotas durs, suspension, metering, file d’attente bornée |
| 9 | Frlins açus kabuk | Moyenne | Moyenne | Hotfixes orchestrés, tests de variabilité, versions pinées |
| 10 | Escalade de privilèges côté API | Critique | Basse | RBAC serveur, clés API scopées, audit des accès |
| 11 | Provider hosté compromis (clé utilisateur sur notre infra) | Élevée | Basse | Modèle hybride: clés côté utilisateur lorsqu’elles existent; coffre scellé sinon |
| 12 | Perte de données (conversations, artefacts, snapshot) | Élevée | Basse | Snapshots, backup cross-région, rétention documentée |

Priorités : traiter 1, 2, 5, et 10 avant tout lancement public; 3, 7 et  ̄8 avant la bêta élargie.



## 12. Plan de migration du runtime local vers le cloud

| Phase | Durée indic. | Contenu |
| --- | --- | --- |
| **0. Cadrage** | Sem. 1 | Décisions de marque, modèle économique, providers, isolation, persistance, collaboration (
    `§10 blueprint`);
| **1. Squelette contrôle** | Sem. 2–3 | Identité + organisations + RBAC; schémas étendus dans `packages/contracts`; routes `/login` `/signup` `/app` |
| **2. Connecteur GitHub** | Sem. 4 | OAuth, credentials chiffrés, sélection dépôt/branche, clone distant |
| **3. Workspace runner (POQ)** | Sem.  ̄5–6 | Worker cloud isolé (container renforcé), provision/destruction, quotas de base, terminal + fichiers |
| **4. Conversation + Git** | Sem.  ̄7–9 | Tâches via workers, diff, branche de travail, commit/push, PR |
| **5. Persistance et reprise** | Sem.  ̄10–12 | Base relationnelle multi-tenant, stockage objet, suspension/reprise, snapshots |
| **6. Durcissement** | Sem.  ̄13–14 | Matrice risque §11 (isolation, secrets, RBAC, réseau), audit/rétention |
| **7. Bêta** | Sem.  ̄15–16 | Quotas, logs, suppression workspace, instrumentation, itération utilisateurs |
| **Post-lancement** | — | Navigateur intégré, automations complexes, handoffs multi-provider, MCP externe (hors périmètre v1, `§9 blueprint`) |



## Récapitulatif des 12 livrables

| # | Livrable | Fichier/Section |
| --- | --- | --- |
| 1 | Identité de marque et direction visuelle | §1 |
| 2 | Wireframe de la landing page | §2 |
| 3 | Plan des routes publiques/privées | §3 |
| 4 | User flow inscription → GitHub → workspace | §4 |
| 5 | Spécification écrans d’authentification | §5 |
| 6 | Spécification permissions/organisations | §6 |
| 7 | Contrat conceptuel du workspace cloud | §7 |
| 8 | Séparation control plane / execution plane | §8 |
| 9 | Inventaire des composants réutilisables | §9 |
| 10 | Composants à adapter | §10 |
| 11 | Matrice de risques sécurité | §11 |
| 12 | Plan de migration local → cloud | §12 |

> Prochaine étape suggérée : transformer le §7 (contrat conceptuel) en contrats `packages/contracts` et le §8 en architecture de services — une fois les décisions séminales (§10 du blueprint) arbitrées.