/**
 * nyx_project_manager.js - Moteur décisionnel et superviseur autonome
 * Gère l'étude de faisabilité, la répartition Nyx vs Ben,
 * et le coupe-circuit strict à 3 essais max par étape.
 */

const MATRICE_COMPETENCES = `
MATRICE STRICTE DES CAPACITÉS SYSTÈME :
- NYX (Serveur Cloud Render) :
  * Génération d'images IA lourdes via son API Venice (Flux).
  * Réflexion logique, rédaction de scénario et découpage de projet.
  * Rédaction de code Python complet.
- BEN (Worker local Windows sur H:\\Nyx_Ops) :
  * Exécution locale de scripts Python (Pillow, manipulation de données).
  * Écriture et sauvegarde de fichiers sur le disque H:.
- INTERDICTIONS ABSOLUES :
  * Ben ne possède AUCUN modèle IA de génération d'image en local. Tout visuel IA doit être généré par Nyx puis déposé sur H:\\Nyx_Ops.
  * Ben tourne sous cmd/powershell Windows : interdiction formelle des redirections shell de type '>' (pas de echo ... > fichier).
  * Aucune contrainte imaginaire (pas de shaders, pas de VRAM 3 Go, pas de C#).
`;

class ProjectManager {
  constructor(services) {
    // Services injectés depuis ecoute.js
    this.envoyerTelegram = services.envoyerTelegram;
    this.appelLLM = services.appelLLM;
    this.genererImageVenice = services.genererImageVenice;
    this.validerEtSecuriserMission = services.validerEtSecuriserMission;
    this.setMission = services.setMission;
    this.nettoyerMission = services.nettoyerMission;

    this.projet = {
      actif: false,
      nom: "",
      analyse: "",
      etapes: [],
      index: 0,
      tentatives: 0,
      maxTentatives: 3,
      historiqueErreurs: [],
      statut: "inactif"
    };
  }

  estProjetActif() {
    return this.projet && this.projet.actif && this.projet.statut === "en_cours";
  }

  reinitialiser() {
    this.projet = {
      actif: false,
      nom: "",
      analyse: "",
      etapes: [],
      index: 0,
      tentatives: 0,
      maxTentatives: 3,
      historiqueErreurs: [],
      statut: "inactif"
    };
    this.nettoyerMission();
  }

  /**
   * PHASE 1 : Étude de faisabilité et découpage réaliste
   */
  async demarrerProjet(demandeDoc) {
    await this.envoyerTelegram(
      "🧠 **Nyx prend en charge le projet...**\n" +
      "Étude de faisabilité et répartition des tâches (Nyx vs Ben) en cours."
    );

    const promptPlanification = `Tu es Nyx, cheffe de projet technique autonome.
Doc demande : "${demandeDoc}".

${MATRICE_COMPETENCES}

MISSION :
1. Analyse la faisabilité technique selon les capacités réelles de chacun.
2. Découpe le travail en 2 à 4 étapes unitaires.
3. Pour chaque étape, définis qui agit :
   - "NYX" si l'étape nécessite de générer une illustration avec Venice ou de concevoir la logique.
   - "BEN" si l'étape consiste à écrire un fichier sur H:\\Nyx_Ops ou exécuter un script Python Pillow.

Réponds STRICTEMENT par un JSON valide sous ce format :
{
  "analyse": "Synthèse de faisabilité en 2 phrases max",
  "etapes": [
    {
      "id": 1,
      "acteur": "NYX|BEN",
      "action": "Description de l'action",
      "detail": "Prompt anglais si image Venice pour NYX, ou instruction directe RAW_TASK pour Ben"
    }
  ]
}`;

    try {
      const rep = await this.appelLLM("Analyste projet stricte.", promptPlanification);
      const match = rep.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Planification JSON introuvable.");

      const plan = JSON.parse(match[0]);
      if (!plan.etapes || plan.etapes.length === 0) throw new Error("Aucune étape définie.");

      this.projet = {
        actif: true,
        nom: demandeDoc.slice(0, 45),
        analyse: plan.analyse,
        etapes: plan.etapes,
        index: 0,
        tentatives: 0,
        maxTentatives: 3,
        historiqueErreurs: [],
        statut: "en_cours"
      };

      let messagePlan = `📋 **Étude de faisabilité validée :**\n_${plan.analyse}_\n\n**Feuille de route :**\n`;
      plan.etapes.forEach((e) => {
        messagePlan += `• [Étape ${e.id}] (${e.acteur}) : ${e.action}\n`;
      });
      messagePlan += `\n*Démarrage immédiat. Tolérance : 3 essais max par étape.*`;

      await this.envoyerTelegram(messagePlan);
      await this.executerEtapeCourante();
    } catch (err) {
      await this.envoyerTelegram(`❌ Échec de l'étude de faisabilité : ${err.message}`);
      this.reinitialiser();
    }
  }

  /**
   * PHASE 2 : Exécution de l'étape active
   */
  async executerEtapeCourante() {
    if (!this.estProjetActif()) return;

    const etape = this.projet.etapes[this.projet.index];
    this.projet.tentatives++;

    // Cas A : Nyx prend en charge l'étape (ex: image Flux/Venice)
    if (etape.acteur.toUpperCase() === "NYX") {
      await this.envoyerTelegram(
        `🎨 **[Étape ${etape.id}/${this.projet.etapes.length}] Nyx travaille (interne) :** ${etape.action}`
      );

      try {
        const estDemandeImage = /image|visuel|dessin|illustration/i.test(etape.action);
        if (estDemandeImage && this.genererImageVenice) {
          const b64 = await this.genererImageVenice(etape.detail || etape.action);
          const nomFichier = `case_${etape.id}.png`;

          // Nyx dépose le visuel généré dans le sas de Ben pour enregistrement sur H:\Nyx_Ops
          const ordreDepot = {
            type: "RAW_TASK",
            description: `Écrire dans le fichier H:\\Nyx_Ops\\${nomFichier} le contenu image base64 suivant : ${b64}`
          };
          this.setMission(ordreDepot);
          return;
        }

        // Si simple action d'analyse interne, validation directe
        this.validerEtapeCourante();
      } catch (errNyx) {
        await this.gererEchecEtape(`Erreur interne Nyx : ${errNyx.message}`);
      }
    }
    // Cas B : Ordre délégué à Ben sur la machine locale
    else {
      const consigne = typeof etape.detail === "string" ? etape.detail : JSON.stringify(etape.detail);
      const missionSecurisee = this.validerEtSecuriserMission(consigne || etape.action);

      this.setMission(missionSecurisee.action);

      const libelle = missionSecurisee.action.type === "RAW_TASK"
        ? missionSecurisee.action.description
        : JSON.stringify(missionSecurisee.action);

      await this.envoyerTelegram(
        `⚙️ **[Étape ${etape.id}/${this.projet.etapes.length}] Ordre transmis à Ben (Essai ${this.projet.tentatives}/${this.projet.maxTentatives}) :**\n\`${libelle}\``
      );
    }
  }

  /**
   * PHASE 3 : Analyse des retours remontés par Ben
   */
  async traiterRetourBen(titre, contenu) {
    if (!this.estProjetActif()) return;

    const texte = (contenu || "").toLowerCase();
    const estErreur = (
      texte.includes("erreur [code") ||
      texte.includes("n'est pas reconnu") ||
      texte.includes("syntaxerror") ||
      texte.includes("valueerror") ||
      texte.includes("traceback") ||
      texte.includes("syntaxe du nom de fichier") ||
      texte.includes("fichier créé mais **vide**")
    );

    const estSucces = !estErreur && (
      texte.includes("succès") ||
      texte.includes("succes") ||
      texte.includes("ok") ||
      texte.includes("validé") ||
      texte.includes("créé")
    );

    if (estSucces) {
      await this.validerEtapeCourante();
    } else {
      await this.gererEchecEtape(contenu.slice(0, 300));
    }
  }

  async validerEtapeCourante() {
    const etape = this.projet.etapes[this.projet.index];
    this.projet.tentatives = 0;
    this.projet.historiqueErreurs = [];
    this.projet.index++;

    await this.envoyerTelegram(`✅ **Étape ${etape.id} validée.**`);

    if (this.projet.index < this.projet.etapes.length) {
      setTimeout(() => this.executerEtapeCourante(), 2000);
    } else {
      await this.envoyerTelegram(
        `🏁 **Projet « ${this.projet.nom} » terminé avec succès !**\n` +
        `Tous les livrables sont disponibles sur \`H:\\Nyx_Ops\`.`
      );
      this.reinitialiser();
    }
  }

  async gererEchecEtape(messageErreur) {
    const etape = this.projet.etapes[this.projet.index];
    const extrait = messageErreur.replace(/\r?\n/g, " ").slice(0, 160);
    this.projet.historiqueErreurs.push(`Essai ${this.projet.tentatives} : ${extrait}`);

    // Coupe-circuit strict après 3 essais
    if (this.projet.tentatives >= this.projet.maxTentatives) {
      this.projet.statut = "bloque";
      this.nettoyerMission();

      const details = this.projet.historiqueErreurs.map((e) => `• ${e}`).join("\n");
      await this.envoyerTelegram(
        `🛑 **ARRÊT D'URGENCE DU PROJET**\n\n` +
        `Nyx a stoppé le chantier après **3 échecs consécutifs** sur l'étape ${etape.id} (${etape.action}).\n\n` +
        `**Rapport des 3 tentatives :**\n${details}\n\n` +
        `*Doc, les automatismes sont verrouillés. Reprends la main.*`
      );
      this.reinitialiser();
      return;
    }

    // Réadaptation dynamique si moins de 3 essais
    await this.adapterOrdreApresErreur(etape, messageErreur);
    setTimeout(() => this.executerEtapeCourante(), 3000);
  }

  async adapterOrdreApresErreur(etape, erreurTexte) {
    const promptAdaptation = `Tu es Nyx. Une étape déléguée à Ben a échoué.
ÉTAPE : ${etape.action}
ORDRE AYANT ÉCHOUÉ : ${JSON.stringify(etape.detail)}
ERREUR : ${erreurTexte}

${MATRICE_COMPETENCES}

CONSIGNE :
Formule un ordre correctif très simple, en pur RAW_TASK (écrire un fichier ou script Python unitaire sans shell complexe).
Réponds STRICTEMENT par un JSON valide : {"cause": "explication courte", "ordre_corrige": "instruction corrigée"}`;

    try {
      const rep = await this.appelLLM("Correctrice technique.", promptAdaptation);
      const match = rep.match(/\{[\s\S]*\}/);
      if (match) {
        const correction = JSON.parse(match[0]);
        etape.detail = correction.ordre_corrige;
        await this.envoyerTelegram(
          `🔧 *Diagnostic Nyx :* ${correction.cause}\nAdaptation de l'ordre pour le réessai (${this.projet.tentatives + 1}/${this.projet.maxTentatives})...`
        );
        return;
      }
    } catch (e) {}

    // Repli sécurisé en cas d'échec du LLM
    etape.detail = `Écrire dans le fichier H:\\Nyx_Ops\\etape_${etape.id}.txt le document complet de l'étape sans utiliser de shell.`;
  }
}

module.exports = ProjectManager;
