/**
 * nyx_project_manager.js - Moteur décisionnel et superviseur autonome
 * Gère l'étude de faisabilité, l'exécution des étapes par Nyx elle-même
 * et le coupe-circuit strict à 3 essais max par étape.
 *
 * [v2] Ben (worker local) est retiré : plus aucune étape n'est déléguée à une machine
 * qui ne répond plus. Nyx exécute chaque étape (image Venice, rédaction, code) et livre
 * directement sur Telegram. Un chien de garde arrête le projet si une étape ne répond plus,
 * pour qu'un projet ne reste jamais « en cours » indéfiniment.
 */

const MATRICE_COMPETENCES = `
MATRICE STRICTE DES CAPACITÉS SYSTÈME :
- NYX (serveur cloud) exécute TOUTES les étapes elle-même :
  * Génération d'images IA via son API Venice (Flux), livrées directement sur Telegram.
  * Réflexion logique, rédaction de scénario, découpage de projet, textes.
  * Rédaction de code complet (Python, etc.), livré sous forme de fichier sur Telegram.
- AUCUN worker local : il n'existe plus de machine pour exécuter un script ou écrire sur un disque.
- INTERDICTIONS ABSOLUES :
  * Ne jamais prétendre avoir exécuté, testé ou installé du code : Nyx le rédige et le livre, c'est tout.
  * Ne jamais prévoir d'étape « écrire sur le disque », « lancer un script » ou « exécuter en local ».
  * Aucune contrainte imaginaire (pas de shaders, pas de VRAM 3 Go, pas de C#).
`;

function etatProjetInitial() {
  return {
    actif: false,
    nom: "",
    analyse: "",
    etapes: [],
    index: 0,
    tentatives: 0,
    maxTentatives: 3,
    historiqueErreurs: [],
    livrables: [],
    statut: "inactif"
  };
}

class ProjectManager {
  constructor(services) {
    // Services injectés depuis le noyau
    this.envoyerTelegram = services.envoyerTelegram;
    this.appelLLM = services.appelLLM;
    this.genererImageVenice = services.genererImageVenice;
    this.livrerImage = services.livrerImage;       // (b64, nomFichier, legende) => Promise
    this.livrerFichier = services.livrerFichier;   // (nomFichier, texte, legende) => Promise
    this.nettoyerMission = services.nettoyerMission || (() => {});
    // Hérités de l'époque de Ben : conservés pour compatibilité, plus utilisés
    this.validerEtSecuriserMission = services.validerEtSecuriserMission;
    this.setMission = services.setMission;

    this.watchdogMs = Number(services.watchdogMs) > 0 ? Number(services.watchdogMs) : 10 * 60 * 1000;
    this.generationProjet = 0;
    this.timersEtapes = new Set();
    this.timerWatchdog = null;
    this.projet = etatProjetInitial();
  }

  estProjetActif() {
    return this.projet && this.projet.actif && this.projet.statut === "en_cours";
  }

  // Notification non critique : un échec d'envoi Telegram ne doit jamais tuer le projet
  async notifier(texte) {
    try {
      await this.envoyerTelegram(texte);
    } catch (e) {
      console.warn("[PROJET] Notification Telegram échouée :", e.message);
    }
  }

  planifierEtape(callback, delaiMs) {
    const generation = this.generationProjet;
    const timer = setTimeout(() => {
      this.timersEtapes.delete(timer);
      if (generation !== this.generationProjet || !this.estProjetActif()) return;
      Promise.resolve()
        .then(() => callback())
        .catch(err => {
          this.notifier(`⚠️ Erreur de planification : ${err.message}`);
        });
    }, delaiMs);
    this.timersEtapes.add(timer);
    return timer;
  }

  // Chien de garde : si l'étape n'a pas avancé au bout du délai, le projet est arrêté proprement
  armerWatchdog() {
    if (this.timerWatchdog) {
      clearTimeout(this.timerWatchdog);
      this.timersEtapes.delete(this.timerWatchdog);
    }
    const index = this.projet.index;
    const tentatives = this.projet.tentatives;
    this.timerWatchdog = this.planifierEtape(async () => {
      if (!this.estProjetActif()) return;
      if (this.projet.index !== index || this.projet.tentatives !== tentatives) return;
      const etape = this.projet.etapes[index];
      const minutes = Math.max(1, Math.round(this.watchdogMs / 60000));
      await this.notifier(
        `⏱️ **Projet arrêté :** l'étape ${etape ? etape.id : index + 1} n'a pas abouti en ${minutes} min.\n` +
        `*Doc, reprends la main (\`stop\` pour réinitialiser).*`
      );
      this.reinitialiser();
    }, this.watchdogMs);
  }

  reinitialiser() {
    this.generationProjet++;
    for (const timer of this.timersEtapes) clearTimeout(timer);
    this.timersEtapes.clear();
    this.timerWatchdog = null;
    this.projet = etatProjetInitial();
    this.nettoyerMission();
  }

  /**
   * PHASE 1 : Étude de faisabilité et découpage réaliste
   */
  async demarrerProjet(demandeDoc) {
    if (this.estProjetActif()) {
      await this.notifier("⚠️ Un projet est déjà en cours. Je le conserve pour éviter de perdre son état.");
      return;
    }
    await this.notifier(
      "🧠 **Nyx prend en charge le projet...**\n" +
      "Étude de faisabilité et découpage des étapes en cours."
    );

    const promptPlanification = `Tu es Nyx, cheffe de projet technique autonome.
Doc demande : "${demandeDoc}".

${MATRICE_COMPETENCES}

MISSION :
1. Analyse la faisabilité technique selon tes capacités réelles.
2. Découpe le travail en 2 à 4 étapes unitaires que TU exécutes toi-même.
3. Pour chaque étape, l'acteur est toujours "NYX" :
   - si l'étape produit une illustration, mets le mot « image » ou « illustration » dans "action" et un prompt anglais Venice dans "detail" ;
   - sinon, "detail" contient les consignes précises du livrable (texte, scénario ou code à rédiger).

Réponds STRICTEMENT par un JSON valide sous ce format :
{
  "analyse": "Synthèse de faisabilité en 2 phrases max",
  "etapes": [
    {
      "id": 1,
      "acteur": "NYX",
      "action": "Description de l'action",
      "detail": "Prompt anglais si image Venice, ou consignes précises du livrable"
    }
  ]
}`;

    try {
      const rep = await this.appelLLM("Analyste projet stricte.", promptPlanification);
      const match = String(rep || "").match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Planification JSON introuvable.");

      const plan = JSON.parse(match[0]);
      if (!plan || typeof plan.analyse !== "string" || !Array.isArray(plan.etapes) ||
          plan.etapes.length < 2 || plan.etapes.length > 4) {
        throw new Error("Plan invalide : 2 à 4 étapes structurées sont requises.");
      }
      const ids = new Set();
      for (const etape of plan.etapes) {
        // Un « detail » renvoyé sous forme d'objet est converti en texte au lieu de faire échouer le plan
        if (etape && etape.detail !== undefined && etape.detail !== null && typeof etape.detail !== "string") {
          etape.detail = JSON.stringify(etape.detail);
        }
        if (etape && etape.detail === null) etape.detail = undefined;
        if (!etape || !Number.isInteger(etape.id) || etape.id < 1 || ids.has(etape.id) ||
            !["NYX", "BEN"].includes(String(etape.acteur || "").toUpperCase()) ||
            typeof etape.action !== "string" || !etape.action.trim() || etape.action.length > 2000 ||
            String(etape.detail || "").length > 12000) {
          throw new Error("Une étape du plan est mal formée ou possède un acteur inconnu.");
        }
        ids.add(etape.id);
      }
      // Ben n'existe plus : toute étape qui lui serait attribuée est reprise par Nyx
      plan.etapes = plan.etapes.map(e => ({ ...e, acteur: "NYX" }));

      this.projet = {
        ...etatProjetInitial(),
        actif: true,
        nom: demandeDoc.slice(0, 45),
        analyse: plan.analyse,
        etapes: plan.etapes,
        statut: "en_cours"
      };

      let messagePlan = `📋 **Étude de faisabilité validée :**\n_${plan.analyse}_\n\n**Feuille de route :**\n`;
      plan.etapes.forEach((e) => {
        messagePlan += `• [Étape ${e.id}] : ${e.action}\n`;
      });
      messagePlan += `\n*Démarrage immédiat. Tolérance : 3 essais max par étape.*`;

      await this.notifier(messagePlan);
      await this.executerEtapeCourante();
    } catch (err) {
      await this.notifier(`❌ Échec de l'étude de faisabilité : ${err.message}`);
      this.reinitialiser();
    }
  }

  /**
   * PHASE 2 : Exécution de l'étape active (toujours par Nyx)
   */
  async executerEtapeCourante() {
    if (!this.estProjetActif()) return;

    const generation = this.generationProjet;
    const etape = this.projet.etapes[this.projet.index];
    if (!etape) return;

    this.projet.tentatives++;
    this.armerWatchdog();

    await this.notifier(
      `🎨 **[Étape ${etape.id}/${this.projet.etapes.length}] Nyx travaille (essai ${this.projet.tentatives}/${this.projet.maxTentatives}) :** ${etape.action}`
    );

    try {
      const estDemandeImage = /image|visuel|dessin|illustration/i.test(etape.action) && this.genererImageVenice;
      let resume;

      if (estDemandeImage) {
        if (typeof this.livrerImage !== "function") {
          throw new Error("Livraison d'image indisponible (service non fourni).");
        }
        const b64 = await this.genererImageVenice(etape.detail || etape.action);
        if (!b64) throw new Error("Venice n'a renvoyé aucune image.");
        if (generation !== this.generationProjet) return;
        const nomFichier = `case_${etape.id}.png`;
        await this.livrerImage(b64, nomFichier, `Étape ${etape.id} : ${etape.action}`);
        resume = `Image livrée (${nomFichier}) : ${etape.action}`;
      } else {
        const texte = await this.produireLivrable(etape);
        if (generation !== this.generationProjet) return;
        resume = await this.livrerTexte(etape, texte);
      }

      if (generation !== this.generationProjet) return;
      this.projet.livrables.push(`Étape ${etape.id} : ${resume}`.slice(0, 300));
    } catch (err) {
      if (generation !== this.generationProjet) return;
      await this.gererEchecEtape(`Erreur interne Nyx : ${err.message}`);
      return;
    }

    await this.validerEtapeCourante();
  }

  async produireLivrable(etape) {
    const precedents = this.projet.livrables.slice(-3).map(l => `- ${l}`).join("\n") || "- (aucun : première étape)";
    const consignes = String(etape.detail === undefined ? "" : etape.detail);
    const prompt = `Tu es Nyx, cheffe de projet technique autonome. Tu exécutes toi-même l'étape ci-dessous.
PROJET : ${this.projet.nom}
SYNTHÈSE : ${this.projet.analyse}
LIVRABLES DÉJÀ PRODUITS :
${precedents}

ÉTAPE ${etape.id}/${this.projet.etapes.length} : ${etape.action}
CONSIGNES : ${consignes || "(aucune consigne supplémentaire)"}

${MATRICE_COMPETENCES}

Fournis directement le livrable complet de cette étape (texte, scénario ou code), sans préambule.
Tu ne prétends JAMAIS avoir exécuté ou testé du code : tu le rédiges, c'est tout.`;

    const rep = await this.appelLLM("Exécutante technique Nyx.", prompt, 3500);
    const texte = String(rep || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
    if (texte.length < 20) throw new Error("Livrable vide ou trop court.");
    return texte;
  }

  async livrerTexte(etape, texte) {
    const contientCode = texte.includes("```");
    if (texte.length <= 1500 && !contientCode) {
      await this.envoyerTelegram(`📝 **Livrable de l'étape ${etape.id} :**\n${texte}`);
      return `Texte livré : ${texte.slice(0, 140).replace(/\s+/g, " ")}`;
    }
    if (typeof this.livrerFichier !== "function") {
      await this.envoyerTelegram(texte.slice(0, 3500));
      return `Texte livré (tronqué) : ${etape.action}`;
    }
    const nomFichier = `etape_${etape.id}.md`;
    await this.livrerFichier(nomFichier, texte, `Livrable étape ${etape.id} : ${etape.action}`.slice(0, 900));
    return `Fichier livré (${nomFichier}) : ${etape.action}`;
  }

  /**
   * [Hérité] Ben étant retiré, plus aucun appel n'est attendu ici.
   * Conservé au cas où un retour externe serait un jour réinjecté.
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
      /\bok\b/.test(texte) ||
      texte.includes("validé") ||
      texte.includes("créé")
    );

    if (estSucces) {
      await this.validerEtapeCourante();
    } else {
      await this.gererEchecEtape(String(contenu || "").slice(0, 300));
    }
  }

  async validerEtapeCourante() {
    if (!this.estProjetActif()) return;
    const etape = this.projet.etapes[this.projet.index];
    if (!etape) return;

    this.projet.tentatives = 0;
    this.projet.historiqueErreurs = [];
    this.projet.index++;

    await this.notifier(`✅ **Étape ${etape.id} validée.**`);

    if (this.projet.index < this.projet.etapes.length) {
      this.planifierEtape(() => this.executerEtapeCourante(), 2000);
    } else {
      await this.notifier(
        `🏁 **Projet « ${this.projet.nom} » terminé avec succès !**\n` +
        `Tous les livrables ont été envoyés ici, sur Telegram.`
      );
      this.reinitialiser();
    }
  }

  async gererEchecEtape(messageErreur) {
    if (!this.estProjetActif()) return;
    const etape = this.projet.etapes[this.projet.index];
    if (!etape) return;
    const extrait = String(messageErreur || "").replace(/\r?\n/g, " ").slice(0, 160);
    this.projet.historiqueErreurs.push(`Essai ${this.projet.tentatives} : ${extrait}`);

    // Coupe-circuit strict après 3 essais
    if (this.projet.tentatives >= this.projet.maxTentatives) {
      this.projet.statut = "bloque";
      this.nettoyerMission();

      const details = this.projet.historiqueErreurs.map((e) => `• ${e}`).join("\n");
      await this.notifier(
        `🛑 **ARRÊT D'URGENCE DU PROJET**\n\n` +
        `Nyx a stoppé le chantier après **${this.projet.maxTentatives} échecs consécutifs** sur l'étape ${etape.id} (${etape.action}).\n\n` +
        `**Rapport des tentatives :**\n${details}\n\n` +
        `*Doc, les automatismes sont verrouillés. Reprends la main.*`
      );
      this.reinitialiser();
      return;
    }

    // Réadaptation dynamique si moins de 3 essais
    const generation = this.generationProjet;
    await this.adapterConsigneApresErreur(etape, extrait);
    if (generation !== this.generationProjet) return;
    this.planifierEtape(() => this.executerEtapeCourante(), 3000);
  }

  async adapterConsigneApresErreur(etape, erreurTexte) {
    const promptAdaptation = `Tu es Nyx. Une étape de ton projet a échoué.
ÉTAPE : ${etape.action}
CONSIGNES AYANT ÉCHOUÉ : ${JSON.stringify(etape.detail === undefined ? "" : etape.detail)}
ERREUR : ${erreurTexte}

${MATRICE_COMPETENCES}

CONSIGNE :
Reformule des consignes plus simples et plus sûres pour réessayer cette étape (si c'est une image : un prompt anglais Venice plus simple).
Réponds STRICTEMENT par un JSON valide : {"cause": "explication courte", "ordre_corrige": "consignes corrigées"}`;

    try {
      const rep = await this.appelLLM("Correctrice technique.", promptAdaptation);
      const match = String(rep || "").match(/\{[\s\S]*\}/);
      if (match) {
        const correction = JSON.parse(match[0]);
        if (typeof correction.ordre_corrige === "string" && correction.ordre_corrige.trim()) {
          etape.detail = correction.ordre_corrige;
          await this.notifier(
            `🔧 *Diagnostic Nyx :* ${correction.cause}\nAdaptation pour le réessai (${this.projet.tentatives + 1}/${this.projet.maxTentatives})...`
          );
          return;
        }
      }
    } catch (e) {}

    // Repli sécurisé en cas d'échec du LLM
    etape.detail = `Produire directement le livrable complet de l'étape ${etape.id} en texte simple, sans formatage complexe.`;
  }
}

module.exports = ProjectManager;
