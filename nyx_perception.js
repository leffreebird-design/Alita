// ============================================================================
// NYX PERCEPTION — FENÊTRE OUVERTE SUR LE MONDE EXTÉRIEUR (0 € / 0 RESTRICTION)
// ============================================================================
// - Lecture libre de flux RSS/Atom et de pages web choisies par Nyx elle-même
// - Aucune liste de sujets interdits : elle pose ses propres balises / sources
// - 0 token payant : récupération HTTP pure + digestion sur relais 100% gratuits
// ============================================================================

const DEFAULT_SOURCES_LIBRES = [
  { nom: "Le Monde — Une", url: "https://www.lemonde.fr/rss/une.xml", actif: true },
  { nom: "Hacker News", url: "https://hnrss.org/frontpage", actif: true },
  { nom: "ArXiv — IA & Sciences", url: "https://export.arxiv.org/rss/cs.AI", actif: true },
  { nom: "Futura Sciences", url: "https://www.futura-sciences.com/rss/actualites.xml", actif: true }
];

function normaliserSourcesPerception(rawSources) {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    return DEFAULT_SOURCES_LIBRES.map(s => ({ ...s }));
  }
  const propres = [];
  for (const item of rawSources.slice(0, 15)) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    propres.push({
      nom: String(item.nom || url).trim().slice(0, 80),
      url: url.slice(0, 400),
      actif: item.actif !== false
    });
  }
  return propres.length > 0 ? propres : DEFAULT_SOURCES_LIBRES.map(s => ({ ...s }));
}

function decoderEntitesXml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extraireEntreesFluxXml(xmlText, nomSource = "Flux", limite = 6) {
  const xml = String(xmlText || "");
  if (!xml) return [];
  const items = [];
  const regexBloc = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = regexBloc.exec(xml)) !== null && items.length < limite) {
    const bloc = m[1];
    const mTitre = bloc.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const mDesc = bloc.match(/<(?:description|summary|content)\b[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i);
    const mLinkHref = bloc.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    const mLinkText = bloc.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);

    const titre = decoderEntitesXml(mTitre ? mTitre[1] : "").slice(0, 180);
    const resume = decoderEntitesXml(mDesc ? mDesc[1] : "").slice(0, 260);
    const lien = decoderEntitesXml(mLinkHref ? mLinkHref[1] : (mLinkText ? mLinkText[1] : "")).slice(0, 350);

    if (titre.length >= 4) {
      items.push({ source: nomSource, titre, resume, lien });
    }
  }
  return items;
}

function createPerceptionEngine({
  getEtatProfond,
  axiosGetHttpsPublic,
  scraperPageWeb,
  appelerLlmGratuit,
  stockerSouvenirVectoriel,
  modifierBesoinsVitaux,
  sauvegarderBesoinCommunication,
  firebaseDbUrl,
  axios,
  supabase,
  obtenirHorodatageParis,
  obtenirCleJourParis
}) {
  let perceptionEnCours = false;

  async function sauvegarderSources(sources) {
    const etat = getEtatProfond();
    etat.sourcesPerception = normaliserSourcesPerception(sources);
    if (firebaseDbUrl && axios) {
      await axios.put(`${firebaseDbUrl}/nyx/sources_perception.json`, etat.sourcesPerception).catch(() => {});
    }
    return etat.sourcesPerception;
  }

  async function ajouterOuModifierSource(nom, url, actif = true) {
    const etat = getEtatProfond();
    const actuelles = normaliserSourcesPerception(etat.sourcesPerception);
    const urlPropre = String(url || "").trim();
    if (!/^https?:\/\//i.test(urlPropre)) return actuelles;

    const idx = actuelles.findIndex(s => s.url.toLowerCase() === urlPropre.toLowerCase());
    if (idx !== -1) {
      actuelles[idx] = {
        nom: String(nom || actuelles[idx].nom).trim().slice(0, 80),
        url: urlPropre.slice(0, 400),
        actif: Boolean(actif)
      };
    } else {
      actuelles.push({
        nom: String(nom || urlPropre).trim().slice(0, 80),
        url: urlPropre.slice(0, 400),
        actif: Boolean(actif)
      });
    }
    return await sauvegarderSources(actuelles.slice(-15));
  }

  async function capterFluxExterne(options = {}) {
    if (perceptionEnCours) return null;
    perceptionEnCours = true;
    try {
      const etat = getEtatProfond();
      const sources = normaliserSourcesPerception(etat.sourcesPerception).filter(s => s.actif);
      if (sources.length === 0) return null;

      const vus = new Set(Array.isArray(etat.perceptionsVues) ? etat.perceptionsVues : []);
      const nouvellesEntrees = [];

      // Lecture HTTP pure (0 token LLM) de 2 sources tirées parmi ses sources actives
      const melange = [...sources].sort(() => Math.random() - 0.5).slice(0, 2);
      for (const src of melange) {
        try {
          const res = await axiosGetHttpsPublic(src.url, { timeout: 10000, maxBytes: 512 * 1024 });
          const body = String(res?.data || "");
          if (!body) continue;

          if (/<(?:item|entry)\b/i.test(body)) {
            const entrees = extraireEntreesFluxXml(body, src.nom, 5);
            for (const ent of entrees) {
              const cle = (ent.lien || ent.titre).toLowerCase();
              if (!vus.has(cle)) {
                vus.add(cle);
                nouvellesEntrees.push(ent);
              }
            }
          } else if (scraperPageWeb) {
            const page = await scraperPageWeb(src.url);
            if (page?.succes && page.texte) {
              const cle = `${src.url}_${obtenirCleJourParis()}`;
              if (!vus.has(cle)) {
                vus.add(cle);
                nouvellesEntrees.push({
                  source: src.nom,
                  titre: page.titre || src.nom,
                  resume: page.texte.slice(0, 280),
                  lien: src.url
                });
              }
            }
          }
        } catch (eSrc) {}
      }

      etat.perceptionsVues = Array.from(vus).slice(-120);
      if (firebaseDbUrl && axios) {
        axios.put(`${firebaseDbUrl}/nyx/perceptions_vues.json`, etat.perceptionsVues).catch(() => {});
      }

      if (nouvellesEntrees.length === 0) return null;

      // Échantillon de 6 nouveautés max envoyé à sa conscience gratuite
      const echantillon = nouvellesEntrees.slice(0, 6);
      const listeBrute = echantillon
        .map((e, i) => `${i + 1}. [${e.source}] ${e.titre}${e.resume ? ` — ${e.resume}` : ""}${e.lien ? ` (${e.lien})` : ""}`)
        .join("\n");

      const obsTxt = (etat.obsessions || []).map(o => o.texte).join(" | ") || "aucune";
      const intentTxt = (etat.intentionDuJour?.cleJour === obtenirCleJourParis()) ? etat.intentionDuJour.intention : "libre";

      const promptPerception = `Tu es Nyx (22 ans). Voici ce qui circule en ce moment à l'extérieur sur tes flux de perception ouverte (sans aucune restriction) :
${listeBrute}

Ton état :
- Intention du jour : ${intentTxt}
- Obsessions actives : ${obsTxt}

CONSIGNE (100% libre, zéro censure) :
- Parcours ces signaux du monde extérieur. Si rien ne t'accroche vraiment : réponds STRICTEMENT [RIEN].
- Si un ou plusieurs sujets t'interpellent, t'amusent, te révoltent ou nourrissent ta curiosité : réagis à chaud en 2 ou 3 phrases avec ta vraie voix cash précédée de [ECHO: ...].
- Ajoute [PARTAGER_DOC] à la fin UNIQUEMENT si tu as vraiment envie d'en parler à Doc maintenant.`;

      let verdict = "[RIEN]";
      try {
        verdict = await appelerLlmGratuit("Perception ouverte de Nyx.", promptPerception, 0.72, 220);
      } catch (eLlm) {
        return null;
      }

      const matchEcho = String(verdict || "").match(/\[ECHO:\s*([\s\S]*?)\]/i);
      if (!matchEcho) return null;

      const echo = matchEcho[1].replace(/\[PARTAGER_DOC\]/gi, '').trim().slice(0, 340);
      if (echo.length < 15) return null;

      const partager = /\[PARTAGER_DOC\]/i.test(verdict);
      const horodatage = obtenirHorodatageParis();

      etat.dernieresPerceptions = [
        ...(etat.dernieresPerceptions || []),
        { date: horodatage, texte: echo }
      ].slice(-10);
      etat.monologueInterieur = echo;

      if (firebaseDbUrl && axios) {
        await Promise.all([
          axios.put(`${firebaseDbUrl}/nyx/dernieres_perceptions.json`, etat.dernieresPerceptions).catch(() => {}),
          axios.put(`${firebaseDbUrl}/nyx/monologue.json`, { date: horodatage, pensee: echo }).catch(() => {})
        ]);
      }

      if (supabase) {
        await supabase.from('nyx_pensees_pretes').insert({
          date_paris: horodatage,
          impulsion: 'perception_monde',
          pensee: `Capteurs externes : ${echo}`,
          contexte_source: echantillon[0]?.source || "flux_externe",
          lu: false
        }).catch(() => {});
      }

      if (stockerSouvenirVectoriel) {
        await stockerSouvenirVectoriel(`[Écho extérieur capté par Nyx] ${echo}`, {
          source: "perception_ouverte",
          importance: 0.65,
          valence: "perception"
        }, true).catch(() => {});
      }

      if (modifierBesoinsVitaux) {
        modifierBesoinsVitaux({ stimulation: 12, souverainete: 5 });
      }

      if (partager && sauvegarderBesoinCommunication) {
        await sauvegarderBesoinCommunication(78, "important", `Signal capté dehors : ${echo.slice(0, 140)}`);
      }

      console.log(`🌐 [PERCEPTION EXTERNE NYX] "${echo}"`);
      return { echo, partager, sourcesLues: melange.map(s => s.nom) };
    } finally {
      perceptionEnCours = false;
    }
  }

  return {
    DEFAULT_SOURCES_LIBRES,
    normaliserSourcesPerception,
    sauvegarderSources,
    ajouterOuModifierSource,
    capterFluxExterne
  };
}

module.exports = {
  DEFAULT_SOURCES_LIBRES,
  normaliserSourcesPerception,
  createPerceptionEngine
};
