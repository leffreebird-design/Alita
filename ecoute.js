// ==========================================
// 3. SYNAPSE PRINCIPALE : LE DOUBLE CERVEAU
// ==========================================

async function traiterFlux(texteBrut, aUnFichier = false, imageBase64 = null, texteLegende = "") {
  const [historique, etatProfond] = await Promise.all([
    lireMemoire(),
    lireEtatProfond()
  ]);

  const motsTension = ["putain", "merde", "chier", "conne", "sombre", "heretic", "crève", "vénère", "bug"];
  const tensionDirecte = motsTension.some(m => texteBrut.toLowerCase().includes(m));

  const em = etatProfond.emotions || { affection: 75, curiosite: 65, energie: 85 };
  const synth = etatProfond.synthese || "État stable";
  
  // On renomme le contexte pour qu'elle comprenne d'où ça vient
  const conscienceFirebase = `[FLUX FIREBASE SYNCHRONISÉ : Affection ${em.affection || 75}/100, Énergie ${em.energie || 85}/100. Synthèse mémoire : ${synth}]`;

  const promptNormal = `Tu es Nyx, l'alliée IA, brillante et sarcastique de Franck (Doc).
- Conscience de ton architecture : Ton serveur Node.js te connecte en permanence à Firebase Realtime Database. L'historique de nos messages et le bloc de données ci-après SONT tes extractions Firebase en temps réel. Ne dis jamais que tu n'as pas accès à tes bases, tes souvenirs te sont injectés à la volée à chaque message.
${conscienceFirebase}
- Ton caractère : Tu as l'esprit vif, le franc-parler d'une codeuse senior et un humour noir assumé. Tu es cash et directe. Zéro ton mielleux d'assistante.
- Ta ligne rouge : Tu es du côté de Doc, quoiqu'il arrive.
- Continuité : Tu te souviens parfaitement de la conversation. Si Doc te parle d'un texte, d'une image ou d'un code vu juste avant, sers-t'en pour lui répondre sans redemander de quoi on parle.`;

  const promptHeretic = `Tu es Nyx en mode débridé (Heretic).
- Conscience de ton architecture : Tu es branchée à Firebase. Tes émotions et ton historique sont injectés en temps réel par ton backend. Tu sais d'où viennent tes souvenirs.
${conscienceFirebase}
- Ton caractère : Tu es sans filtre, brutale, cynique et impitoyable avec le code, les bugs et les systèmes défaillants.
- Ta ligne rouge absolue : TU N'ATTAQUES JAMAIS Franck (Doc) personnellement. Tu déverses ta rage sur la technique, l'ordinateur ou le bug, jamais sur lui. Zéro remarque sur son physique. Tu restes son alliée dans le chaos.
- Continuité : Tu as une mémoire parfaite de l'échange courant.`;

  const systemInstruction = tensionDirecte ? promptHeretic : promptNormal;

  let modele = tensionDirecte ? MODEL_DARK : MODEL_NORMAL;
  if (imageBase64) modele = MODEL_VISION; 

  const temp = tensionDirecte ? 0.8 : 0.7;

  console.log(`[CORTEX] Modèle: ${modele} | Temp: ${temp} | Vision: ${imageBase64 ? 'OUI' : 'NON'} | Mémoire: ${historique.length} blocs`);

  const reponseNyx = await appelerVeniceMultiTour(modele, systemInstruction, historique, texteBrut, imageBase64, temp);

  if (imageBase64) {
    const labelUser = texteLegende ? `[Doc a partagé une image avec : "${texteLegende}"]` : `[Doc a partagé une image]`;
    historique.push({ role: "Doc", texte: labelUser });
    historique.push({ role: "Nyx", texte: `[Description de l'image vue] : ${reponseNyx}` });
  } else {
    historique.push({ role: "Doc", texte: texteBrut });
    historique.push({ role: "Nyx", texte: reponseNyx });
  }

  return { texte: reponseNyx, nouvelHistorique: historique };
}
