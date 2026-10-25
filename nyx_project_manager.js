/**
 * nyx_project_manager.js - Moteur d'autonomie cadrée pour Nyx (Render)
 * Règle d'or : 3 essais maximum par étape. Au 3e échec -> Stop net et alerte Doc.
 */

const axios = require('axios');

class ProjetManager {
  constructor(botTelegram, chatIdDoc) {
    this.bot = botTelegram;
    this.chatId = chatIdDoc;
    this.projetActif = null;
  }

  /**
   * Initialise un projet avec des objectifs stricts et verrouillés
   */
  demarrerProjet(nom, objectifFinal, etapes) {
    this.projetActif = {
      nom: nom,
      objectifFinal: objectifFinal,
      etapes: etapes, // Tableau d'étapes : [{ id: 1, titre: "...", ordreBen: "..." }]
      indexEtape: 0,
      tentatives: 0,
      maxTentatives: 3,
      historiqueErreurs: [],
      statut: 'EN_COURS' // 'EN_COURS', 'SUCCES', 'BLOQUE'
    };

    this.notifierTelegram(`🚀 **Projet lancé en autonomie : ${nom}**\nObjectif : ${objectifFinal}\nÉtapes prévues : ${etapes.length}`);
    this.executerEtapeCourante();
  }

  /**
   * Prépare et transmet l'ordre adapté à Ben sur son endpoint de mission
   */
  async executerEtapeCourante() {
    if (!this.projetActif || this.projetActif.statut !== 'EN_COURS') return;

    const etape = this.projetActif.etapes[this.projetActif.indexEtape];
    this.projetActif.tentatives++;

    console.log(`[Nyx Autonomie] Étape ${etape.id} - Tentative ${this.projetActif.tentatives}/${this.projetActif.maxTentatives}`);

    // Construction d'un ordre strict pour Ben : aucun shell bash, ciblage direct de H:\Nyx_Ops
    const payloadMission = {
      type: "RAW_TASK",
      description: etape.ordreBen,
      meta: {
        projet: this.projetActif.nom,
        etapeId: etape.id,
        tentative: this.projetActif.tentatives,
        repertoireAttendu: "H:\\Nyx_Ops"
      }
    };

    try {
      // Émission de l'ordre vers le sas de mission de Ben
      await axios.post('http://localhost:3000/api/mission', { mission: payloadMission });
    } catch (err) {
      console.error("[Nyx Autonomie] Impossible de déposer l'ordre pour Ben :", err.message);
    }
  }

  /**
   * Analyse le livrable renvoyé par Ben lors du webhook /api/rapport
   */
  async analyserRetourBen(rapport) {
    if (!this.projetActif || this.projetActif.statut !== 'EN_COURS') return;

    const contenu = (rapport.contenu || '').toLowerCase();
    const titre = rapport.titre || '';
    const etape = this.projetActif.etapes[this.projetActif.indexEtape];

    // Détection d'échec système ou d'erreur console
    const estEchec = (
      contenu.includes('erreur [code') ||
      contenu.includes('erreur d\'exécution') ||
      contenu.includes('syntaxerror') ||
      contenu.includes('n\'est pas reconnu') ||
      contenu.includes('introuvable') ||
      contenu.includes('traceback')
    );

    if (!estEchec && (contenu.includes('succès') || contenu.includes('créé') || contenu.includes('validé'))) {
      // === ÉTAPE RÉUSSIE ===
      this.projetActif.tentatives = 0;
      this.projetActif.historiqueErreurs = [];

      this.notifierTelegram(`✅ **Étape ${etape.id}/${this.projetActif.etapes.length} validée :** ${etape.titre}`);

      this.projetActif.indexEtape++;

      if (this.projetActif.indexEtape >= this.projetActif.etapes.length) {
        // Fin de l'ensemble du projet
        this.projetActif.statut = 'SUCCES';
        this.notifierTelegram(`🏁 **Projet '${this.projetActif.nom}' terminé avec succès !**\nLivrables archivés dans \`H:\\Nyx_Ops\`.`);
        this.projetActif = null;
      } else {
        // Enchaînement automatique vers l'étape suivante
        setTimeout(() => this.executerEtapeCourante(), 2000);
      }
    } else {
      // === GESTION DE L'ÉCHEC ===
      this.projetActif.historiqueErreurs.push(`Essai ${this.projetActif.tentatives} : ${rapport.contenu.slice(0, 180)}`);

      if (this.projetActif.tentatives >= this.projetActif.maxTentatives) {
        // CIRCUIT BREAKER : ARRÊT D'URGENCE APRÈS 3 ÉCHECS
        this.projetActif.statut = 'BLOQUE';

        const rapportBlocage = (
          `🛑 **ARRÊT D'URGENCE - Projet bloqué**\n\n` +
          `**Projet :** ${this.projetActif.nom}\n` +
          `**Étape en échec :** ${etape.titre} (Étape ${etape.id})\n` +
          `**Tentatives épuisées :** 3/3\n\n` +
          `**Détail des 3 blocages :**\n` +
          this.projetActif.historiqueErreurs.map((e) => `• ${e}`).join('\n') + `\n\n` +
          `*Nyx a suspendu les actions pour éviter d'altérer le système. Reprends la main manuellement.*`
        );

        this.notifierTelegram(rapportBlocage);
        this.projetActif = null; // Libère le verrou
      } else {
        // ADAPTATION ET NOUVELLE TENTATIVE (< 3 ESSAIS)
        this.adapterOrdreApresErreur(etape, rapport.contenu);
        this.notifierTelegram(`⚠️ Échec étape ${etape.id} (essai ${this.projetActif.tentatives}/3). Adaptation de l'ordre en cours...`);
        setTimeout(() => this.executerEtapeCourante(), 3000);
      }
    }
  }

  /**
   * Adapte l'ordre pour corriger les erreurs de syntaxe Windows ou d'encodage
   */
  adapterOrdreApresErreur(etape, erreurTexte) {
    if (erreurTexte.includes('syntaxe du nom de fichier') || erreurTexte.includes('n\'est pas reconnu')) {
      // L'ordre contenait du texte brut ou du shell : on force l'écriture directe en Python
      etape.ordreBen = `python -c "import pathlib; pathlib.Path(r'H:\\Nyx_Ops').mkdir(exist_ok=True); print('Dossier sécurisé')"`;
    } else if (erreurTexte.includes('vide') || erreurTexte.includes('aucun contenu')) {
      // Forçage de rédaction complète
      etape.ordreBen = `Écrire dans H:\\Nyx_Ops\\${etape.fichierCible || 'livrable.md'} le contenu complet de l'étape.`;
    }
  }

  notifierTelegram(message) {
    if (this.bot && this.chatId) {
      this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

module.exports = ProjetManager;
