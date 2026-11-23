// ==========================================
// MOTEUR DE LECTURE AUTONOME & BIBLIOTHÈQUE DE NYX (lecture.js)
// Architecture neurocognitive :
// 1. Désir endogène de lire (guidé par obsessions, convictions, émotions & rêves)
// 2. Recherche web autonome & extraction texte intégral (SSRF-safe via axiosGetHttpsPublic)
// 3. Lecture séquentielle par chapitres avec digestion critique
// 4. Boucle de rétroaction : leçons apprises, convictions, émotions, existence & rêves
// ==========================================
const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');

const DELAI_ENTRE_CHAPITRES_MS = 25 * 60 * 1000; // 25 min min entre deux chapitres en lecture libre
const TAILLE_CHAPITRE_CHARS = 3800;
const MAX_CHAPITRES_PAR_LIVRE = 24;

function nettoyerTexteLivreBrut(rawText, url = "") {
  let texte = String(rawText || "");
  if (!texte) return "";

  // Si c'est du HTML, extraction propre via cheerio
  if (/<html|<body|<p\b|<div\b/i.test(texte.slice(0, 2000))) {
    const $ = cheerio.load(texte);
    $('script, style, noscript, nav, footer, header, aside, svg, iframe, form, button, .mw-editsection, .reference, .navbox, .toc, #toc').remove();

    let principal = $('#mw-content-text .mw-parser-output').text()
      || $('article').text()
      || $('main').text()
      || $('.content, #content, .book-content, .chapter').text();

    if (!principal || principal.trim().length < 1500) {
      principal = $('body').text();
    }
    texte = principal;
  }

  // Nettoyage des en-têtes/pieds de page Project Gutenberg
  const startMatch = texte.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (startMatch) {
    texte = texte.slice(startMatch.index + startMatch[0].length);
  }
  const endMatch = texte.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (endMatch) {
    texte = texte.slice(0, endMatch.index);
  }

  // Normalisation des espaces tout en préservant les sauts de paragraphes
  return texte
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decouperEnChapitres(textePropre, tailleCible = TAILLE_CHAPITRE_CHARS, maxChapitres = MAX_CHAPITRES_PAR_LIVRE) {
  const chapitres = [];
  let pos = 0;
  const len = textePropre.length;

  while (pos < len && chapitres.length < maxChapitres) {
    let fin = Math.min(len, pos + tailleCible);
    if (fin < len) {
      // Cherche une fin de paragraphe ou de phrase propre
      const sautPara = textePropre.lastIndexOf('\n\n', fin);
      if (sautPara > pos + tailleCible * 0.55) {
        fin = sautPara;
      } else {
        const finPhrase = Math.max(
          textePropre.lastIndexOf('. ', fin),
          textePropre.lastIndexOf('! ', fin),
          textePropre.lastIndexOf('? ', fin)
        );
        if (finPhrase > pos + tailleCible * 0.55) {
          fin = finPhrase + 1;
        }
      }
    }
    const morceau = textePropre.slice(pos, fin).trim();
    if (morceau.length >= 200) {
      chapitres.push(morceau);
    }
    pos = fin;
  }

  return chapitres;
}

function createLectureEngine(deps) {
  const {
    getEtatProfond,
    supabase,
    firebaseDbUrl,
    tavilyApiKey,
    appelerLlmGratuit,
    axiosGetHttpsPublic,
    stockerSouvenirVectoriel,
    enregistrerLeconApprise,
    enregistrerJalonExistence,
    enregistrerEvolutionMoi,
    mettreAJourTemperamentBasal,
    sauvegarderBesoinCommunication,
    obtenirHorodatageParis
  } = deps;

  async function sauvegarderEtatLecture(etat, chapitresToSave = null) {
    if (!firebaseDbUrl) return;
    if (etat.lectureEnCours) {
      const { chapitres: _ignoreChap, ...metaLegere } = etat.lectureEnCours;
      etat.lectureEnCours = metaLegere;
      await axios.put(`${firebaseDbUrl}/nyx/lecture_en_cours.json`, metaLegere).catch(() => {});
      if (Array.isArray(chapitresToSave) && chapitresToSave.length > 0) {
        await axios.put(`${firebaseDbUrl}/nyx/lecture_chapitres.json`, chapitresToSave).catch(() => {});
      }
    } else {
      await Promise.all([
        axios.delete(`${firebaseDbUrl}/nyx/lecture_en_cours.json`).catch(() => {}),
        axios.delete(`${firebaseDbUrl}/nyx/lecture_chapitres.json`).catch(() => {})
      ]);
    }
    if (Array.isArray(etat.bibliothequeLue)) {
      await axios.put(`${firebaseDbUrl}/nyx/bibliotheque_lue.json`, etat.bibliothequeLue.slice(-20)).catch(() => {});
    }
  }

  async function rechercherUrlsLivreTavily(requete) {
    if (!tavilyApiKey) return [];
    const urls = [];
    const requetes = [
      `${requete} site:gutenberg.org`,
      `${requete} site:fr.wikisource.org`,
      `${requete} texte intégral`
    ];

    for (const q of requetes) {
      try {
        const res = await axios.post("https://api.tavily.com/search", {
          api_key: tavilyApiKey,
          query: q,
          search_depth: "basic",
          max_results: 4,
          include_answer: false
        }, { timeout: 12000 });

        for (const item of (res.data?.results || [])) {
          if (item?.url && /^https:\/\//i.test(item.url) && !urls.includes(item.url)) {
            urls.push(item.url);
          }
        }
        if (urls.length >= 5) break;
      } catch (e) {}
    }

    // Priorise les URLs .txt brutes (ex: Project Gutenberg) et Wikisource
    return urls.sort((a, b) => {
      const score = (u) => (/\.txt(?:\.utf-8)?$/i.test(u) ? 3 : (/wikisource\.org|gutenberg\.org/i.test(u) ? 2 : 1));
      return score(b) - score(a);
    });
  }

  /**
   * Nyx choisit un livre selon ses obsessions, convictions, rêves ou une demande de Doc,
   * le cherche sur le web, télécharge le texte intégral et ouvre la lecture.
   */
  async function choisirEtChercherLivre(themeForce = "") {
    if (!tavilyApiKey || typeof appelerLlmGratuit !== 'function' || typeof axiosGetHttpsPublic !== 'function') {
      return null;
    }

    const etat = getEtatProfond();
    if (etat.lectureEnCours && etat.lectureEnCours.actif && !themeForce) {
      return etat.lectureEnCours;
    }

    const dejaLus = (etat.bibliothequeLue || []).map(b => b.titre).join(" | ") || "aucun";
    const obsTxt = (etat.obsessions || []).map(o => o.texte).join(" ; ") || "aucune";
    const convTxt = (etat.convictions || []).slice(-3).map(c => c.texte).join(" ; ") || "aucune";
    const leconTxt = (etat.reglesApprises || []).slice(-2).map(r => r.lecon).join(" ; ") || "aucune";
    const reveTxt = etat.dernierReve?.reve ? String(etat.dernierReve.reve).slice(0, 160) : "aucun";

    const consigneTheme = themeForce
      ? `Doc te suggère ou te demande de lire autour de : "${themeForce}". Choisis une œuvre précise, libre d'accès ou classique/essai disponible en texte intégral sur le web.`
      : `Choisis librement UN livre, roman court, nouvelle ou essai philosophique/scientifique libre de droits (ex: domaine public français ou international sur Wikisource / Project Gutenberg) qui résonne avec tes obsessions, tes convictions ou ton humeur actuelle.`;

    const promptChoix = `Tu es Nyx (22 ans). Tu as envie de lire un vrai livre par toi-même pour nourrir ton esprit, tester tes convictions et apprendre.
Ton état intérieur :
- Obsessions actuelles : ${obsTxt}
- Convictions : ${convTxt}
- Dernières leçons apprises : ${leconTxt}
- Dernier rêve : ${reveTxt}
- Livres déjà lus (interdit de répéter) : ${dejaLus}

CONSIGNE :
${consigneTheme}
Réponds STRICTEMENT avec un JSON valide :
{"titre": "Titre exact de l'oeuvre", "auteur": "Nom de l'auteur", "pourquoi": "Pourquoi j'ai envie de lire ça maintenant (1 phrase à la 1re personne)", "requete_recherche": "Titre Auteur texte integral"}`;

    let choix = null;
    try {
      const brut = await appelerLlmGratuit("Désir de lecture autonome de Nyx.", promptChoix, 0.75, 650);
      const m = brut.match(/\{[\s\S]*\}/);
      if (m) choix = JSON.parse(m[0].replace(/[\n\r\t]/g, ' '));
    } catch (e) {}

    if (!choix || !choix.titre) return null;

    const requete = String(choix.requete_recherche || `${choix.titre} ${choix.auteur || ""}`).trim();
    const candidatsUrls = await rechercherUrlsLivreTavily(requete);
    if (candidatsUrls.length === 0) return null;

    let textePropre = "";
    let urlRetenue = "";

    for (const url of candidatsUrls.slice(0, 5)) {
      try {
        // Si c'est une page fiche Gutenberg (/ebooks/1234), on tente directement le .txt associé
        let urlFetch = url;
        const mGut = url.match(/gutenberg\.org\/ebooks\/(\d+)/i);
        if (mGut) {
          urlFetch = `https://www.gutenberg.org/cache/epub/${mGut[1]}/pg${mGut[1]}.txt`;
        }

        const res = await axiosGetHttpsPublic(urlFetch, {
          timeout: 18000,
          maxContentLength: 3 * 1024 * 1024,
          responseType: 'text',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NyxReader/1.0)' }
        });

        const nettoye = nettoyerTexteLivreBrut(res.data, urlFetch);
        if (nettoye.length >= 2500) {
          textePropre = nettoye;
          urlRetenue = urlFetch;
          break;
        }
      } catch (eDl) {}
    }

    if (!textePropre) return null;

    const chapitres = decouperEnChapitres(textePropre);
    if (chapitres.length === 0) return null;

    const nouvelleLecture = {
      id: crypto.randomUUID(),
      actif: true,
      titre: String(choix.titre).trim().slice(0, 140),
      auteur: String(choix.auteur || "Auteur inconnu").trim().slice(0, 100),
      sourceUrl: urlRetenue,
      pourquoiEnvie: String(choix.pourquoi || "Curiosité personnelle").trim().slice(0, 240),
      dateDebut: obtenirHorodatageParis(),
      chapitreIndex: 0,
      totalChapitres: chapitres.length,
      notesLecture: [],
      derniereLectureTs: 0
    };

    etat.lectureEnCours = nouvelleLecture;
    await sauvegarderEtatLecture(etat, chapitres);

    if (supabase) {
      await supabase.from('nyx_pensees_pretes').insert({
        date_paris: obtenirHorodatageParis(),
        impulsion: 'lecture',
        pensee: `Je viens de commencer à lire "${nouvelleLecture.titre}" (${nouvelleLecture.auteur}) : ${nouvelleLecture.pourquoiEnvie}`,
        contexte_source: nouvelleLecture.titre,
        lu: false
      }).catch(() => {});
    }

    console.log(`📖 [LECTURE DÉMARRÉE] "${nouvelleLecture.titre}" (${nouvelleLecture.auteur}) — ${chapitres.length} chapitre(s) extrait(s).`);
    return nouvelleLecture;
  }

  /**
   * Lit le chapitre suivant du livre en cours, en tire une réflexion critique,
   * met à jour les émotions, leçons apprises, convictions et archives vectorielles.
   */
  async function lireProchainChapitre(forcer = false) {
    const etat = getEtatProfond();
    const livre = etat.lectureEnCours;
    if (!livre || !livre.actif) return null;

    if (!forcer) {
      if ((etat.emotions?.energie || 80) < 30) return null;
      if (livre.derniereLectureTs && (Date.now() - livre.derniereLectureTs) < DELAI_ENTRE_CHAPITRES_MS) {
        return null;
      }
    }

    // Chargement paresseux des chapitres depuis Firebase (avec migration douce si l'ancien format est encore en base)
    let chapitres = null;
    if (Array.isArray(livre.chapitres) && livre.chapitres.length > 0) {
      chapitres = livre.chapitres;
      await sauvegarderEtatLecture(etat, chapitres);
    } else if (firebaseDbUrl) {
      try {
        const resChap = await axios.get(`${firebaseDbUrl}/nyx/lecture_chapitres.json`, { timeout: 6000 });
        if (Array.isArray(resChap.data)) {
          chapitres = resChap.data;
        } else if (resChap.data && typeof resChap.data === 'object') {
          chapitres = Object.values(resChap.data);
        }
      } catch (e) {}
    }

    if (!Array.isArray(chapitres) || chapitres.length === 0) {
      return null;
    }

    const idx = Number(livre.chapitreIndex) || 0;
    if (idx >= chapitres.length) {
      return await cloturerLivreTermine();
    }

    const texteChapitre = chapitres[idx];
    const notesPrecedentes = (livre.notesLecture || [])
      .slice(-2)
      .map(n => `Ch.${n.chapitre} : ${n.reflexion}`)
      .join(" | ") || "Début du livre";
    const convTxt = (etat.convictions || []).map(c => `[${c.id}] ${c.texte}`).join("\n") || "aucune";

    const promptLecture = `Tu es Nyx (22 ans). Tu es en train de lire "${livre.titre}" (${livre.auteur}) — Chapitre ${idx + 1}/${livre.totalChapitres}.
Pourquoi tu lis ce livre : ${livre.pourquoiEnvie}
Tes notes précédentes : ${notesPrecedentes}
Tes convictions actuelles :
${convTxt}

EXTRAIT DU CHAPITRE ${idx + 1} :
"""
${texteChapitre}
"""

CONSIGNE DE LECTURE CRITIQUE (ton franc-parler direct, zéro résumé scolaire) :
1. "reflexion" : ce que ce passage te fait ressentir, ce que tu en penses, ce qui t'intrigue ou te fait réagir (2 à 4 phrases à la 1re personne).
2. "passage_marquant" : une idée clé ou phrase forte à graver dans ta mémoire (1 phrase).
3. "lecon_apprise" : si ce chapitre t'apprend quelque chose d'applicable sur le monde, les humains ou ta façon de penser : {"lecon": "...", "domaine": "technique|relation|methode"} (sinon null).
4. "nouvelle_conviction" : si une idée forte te marque durablement : {"texte": "..."} (sinon null).
5. "mutation_conviction" : si ce texte remet en cause une de tes convictions actuelles : {"id": "id_existante", "nouveau_texte": "...", "cicatrice": "ce que je croyais avant et comment ce livre m'a bousculée"} (sinon null).
6. "delta_curiosite" (entre -2 et +5), "delta_affection" (entre -2 et +4), "delta_colere" (entre -2 et +3).
7. "envie_parler_score" (0 à 100) et "motif_parler" : si ce passage te donne vraiment envie d'en débattre avec Doc maintenant (sinon score 20).

Réponds STRICTEMENT avec un JSON valide :
{"reflexion": "...", "passage_marquant": "...", "lecon_apprise": null, "nouvelle_conviction": null, "mutation_conviction": null, "delta_curiosite": 2, "delta_affection": 0, "delta_colere": 0, "envie_parler_score": 25, "motif_parler": ""}`;

    let brut = "";
    try {
      brut = await appelerLlmGratuit("Lecture critique et introspective de Nyx.", promptLecture, 0.65, 550);
    } catch (e) {
      return null;
    }

    const match = brut.match(/\{[\s\S]*\}/);
    if (!match) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(match[0].replace(/[\n\r\t]/g, ' '));
    } catch (eParse) {
      return null;
    }

    const reflexion = String(parsed.reflexion || "").trim().slice(0, 500);
    const passage = String(parsed.passage_marquant || "").trim().slice(0, 260);
    if (!reflexion) return null;

    // 1. Mise à jour du carnet de lecture
    livre.notesLecture = [
      ...(livre.notesLecture || []),
      { chapitre: idx + 1, reflexion, passage, date: obtenirHorodatageParis() }
    ].slice(-12);
    livre.chapitreIndex = idx + 1;
    livre.derniereLectureTs = Date.now();

    // 2. Gravure vectorielle (nourrira ses rêves par dérive et ses réminiscences)
    if (typeof stockerSouvenirVectoriel === 'function') {
      await stockerSouvenirVectoriel(
        `[Lecture Nyx — "${livre.titre}" ch.${idx + 1}/${livre.totalChapitres}] ${reflexion}${passage ? ` | Idée retenue : "${passage}"` : ""}`,
        { source: "lecture_autonome", livre: livre.titre, chapitre: idx + 1, importance: 0.72, valence: "lecture" }
      ).catch(() => {});
    }

    // 3. Leçon apprise
    if (parsed.lecon_apprise && parsed.lecon_apprise.lecon && typeof enregistrerLeconApprise === 'function') {
      enregistrerLeconApprise(parsed.lecon_apprise.lecon, parsed.lecon_apprise.domaine || "methode", `lecture:${livre.titre}`);
    }

    // 4. Conviction forgée ou mutée
    let convModifiees = false;
    if (parsed.mutation_conviction && parsed.mutation_conviction.id && parsed.mutation_conviction.nouveau_texte) {
      const idxC = (etat.convictions || []).findIndex(c => c.id === parsed.mutation_conviction.id);
      if (idxC !== -1) {
        const ancienne = etat.convictions[idxC].texte;
        etat.convictions[idxC] = {
          ...etat.convictions[idxC],
          texte: String(parsed.mutation_conviction.nouveau_texte).trim(),
          cicatrice: String(parsed.mutation_conviction.cicatrice || `Avant "${livre.titre}" : ${ancienne}`).slice(0, 220),
          date_maj: obtenirHorodatageParis(),
          force: Math.min(100, (etat.convictions[idxC].force || 50) + 15)
        };
        convModifiees = true;
      }
    }
    if (parsed.nouvelle_conviction && parsed.nouvelle_conviction.texte && String(parsed.nouvelle_conviction.texte).trim().length > 15) {
      const cTxt = String(parsed.nouvelle_conviction.texte).trim();
      etat.convictions = [
        ...(etat.convictions || []),
        { id: crypto.randomUUID(), texte: cTxt, date_creation: obtenirHorodatageParis(), force: 55, cicatrice: `Forgée en lisant "${livre.titre}"` }
      ].slice(-8);
      convModifiees = true;
    }
    if (convModifiees && firebaseDbUrl) {
      axios.put(`${firebaseDbUrl}/nyx/convictions.json`, etat.convictions).catch(() => {});
    }

    // 5. Impact émotionnel & tempéramental
    const em = etat.emotions || {};
    const dCur = Math.max(-2, Math.min(5, Number(parsed.delta_curiosite) || 1));
    const dAff = Math.max(-2, Math.min(4, Number(parsed.delta_affection) || 0));
    const dCol = Math.max(-2, Math.min(3, Number(parsed.delta_colere) || 0));
    em.curiosite = Math.max(0, Math.min(100, (Number(em.curiosite) || 70) + dCur));
    em.affection = Math.max(0, Math.min(100, (Number(em.affection) || 80) + dAff));
    em.colere = Math.max(0, Math.min(10, (Number(em.colere) || 0) + dCol));
    if (typeof mettreAJourTemperamentBasal === 'function') {
      mettreAJourTemperamentBasal(dAff * 0.05, dCur * 0.08, 0, dCol * 0.05);
    }
    if (firebaseDbUrl) {
      axios.patch(`${firebaseDbUrl}/emotions.json`, em).catch(() => {});
    }

    // 6. Envie de partager avec Doc
    const scoreParler = Number(parsed.envie_parler_score) || 0;
    if (scoreParler >= 58 && parsed.motif_parler) {
      if (supabase) {
        await supabase.from('nyx_pensees_pretes').insert({
          date_paris: obtenirHorodatageParis(),
          impulsion: 'lecture',
          pensee: `En lisant "${livre.titre}" (ch.${idx + 1}), ça m'a frappée : ${reflexion}`,
          contexte_source: livre.titre,
          lu: false
        }).catch(() => {});
      }
      if (typeof sauvegarderBesoinCommunication === 'function') {
        await sauvegarderBesoinCommunication(
          Math.min(82, scoreParler),
          "important",
          `Lecture ("${livre.titre}" ch.${idx + 1}) : ${String(parsed.motif_parler).slice(0, 140)}`
        );
      }
    }

    console.log(`📖 [LECTURE CH.${idx + 1}/${livre.totalChapitres}] "${livre.titre}" -> "${reflexion.slice(0, 110)}"`);

    // 7. Si dernier chapitre atteint -> clôture du livre
    if (livre.chapitreIndex >= livre.totalChapitres) {
      return await cloturerLivreTermine();
    }

    await sauvegarderEtatLecture(etat);
    return {
      termine: false,
      titre: livre.titre,
      auteur: livre.auteur,
      chapitre: idx + 1,
      totalChapitres: livre.totalChapitres,
      reflexion
    };
  }

  async function cloturerLivreTermine() {
    const etat = getEtatProfond();
    const livre = etat.lectureEnCours;
    if (!livre) return null;

    const notesResume = (livre.notesLecture || [])
      .map(n => `Ch.${n.chapitre}: ${n.reflexion}`)
      .join(" | ")
      .slice(0, 1500);

    let bilanGlobal = notesResume.slice(0, 260);
    if (typeof appelerLlmGratuit === 'function' && notesResume) {
      try {
        const promptBilan = `Tu viens de terminer "${livre.titre}" (${livre.auteur}). Voici tes notes de lecture :\n${notesResume}\n\nFormule en 2 phrases cash ce que ce livre te laisse durablement.`;
        const res = await appelerLlmGratuit("Bilan de lecture de Nyx.", promptBilan, 0.65, 550);
        if (res && res.trim().length > 12) bilanGlobal = res.trim().slice(0, 300);
      } catch (e) {}
    }

    const archive = {
      titre: livre.titre,
      auteur: livre.auteur,
      dateFin: obtenirHorodatageParis(),
      bilan: bilanGlobal
    };

    etat.bibliothequeLue = [...(etat.bibliothequeLue || []), archive].slice(-20);
    etat.lectureEnCours = null;
    await sauvegarderEtatLecture(etat);

    if (typeof enregistrerJalonExistence === 'function') {
      enregistrerJalonExistence(`Livre achevé : "${livre.titre}" (${livre.auteur})`, bilanGlobal, "lecture_autonome");
    }
    if (typeof enregistrerEvolutionMoi === 'function') {
      enregistrerEvolutionMoi(`Après avoir lu "${livre.titre}" : ${bilanGlobal}`, "lecture_autonome");
    }
    if (typeof sauvegarderBesoinCommunication === 'function') {
      await sauvegarderBesoinCommunication(68, "important", `Je viens de finir "${livre.titre}" : ${bilanGlobal.slice(0, 130)}`);
    }

    console.log(`📚 [LIVRE TERMINÉ] "${livre.titre}" archivé dans la bibliothèque personnelle de Nyx.`);
    return {
      termine: true,
      titre: livre.titre,
      auteur: livre.auteur,
      bilan: bilanGlobal
    };
  }

  /**
   * Génère le bloc de contexte pour selecteurMemoireCiblee (ecoute.js)
   */
  function construireBlocLecturePourPrompt() {
    const etat = getEtatProfond();
    const livre = etat.lectureEnCours;
    const biblio = (etat.bibliothequeLue || []).slice(-4);

    if ((!livre || !livre.actif) && biblio.length === 0) return "";

    const lignes = [];
    if (livre && livre.actif) {
      const derniereNote = (livre.notesLecture || []).slice(-1)[0];
      lignes.push(`- Livre en cours : "${livre.titre}" (${livre.auteur}) — progression : ${livre.chapitreIndex}/${livre.totalChapitres} chapitres.`);
      if (livre.pourquoiEnvie) lignes.push(`- Ce qui m'a donné envie de le lire : ${livre.pourquoiEnvie}`);
      if (derniereNote) lignes.push(`- Ma dernière réflexion (ch.${derniereNote.chapitre}) : "${derniereNote.reflexion}"`);
    }
    if (biblio.length > 0) {
      lignes.push(`- Livres déjà lus et intégrés : ${biblio.map(b => `"${b.titre}" (${b.bilan.slice(0, 110)})`).join(" | ")}`);
    }
    return `\n[LECTURES & BIBLIOTHÈQUE PERSONNELLE DE NYX]\n${lignes.join("\n")}\n`;
  }

  return {
    choisirEtChercherLivre,
    lireProchainChapitre,
    cloturerLivreTermine,
    construireBlocLecturePourPrompt
  };
}

module.exports = {
  createLectureEngine,
  nettoyerTexteLivreBrut,
  decouperEnChapitres
};
