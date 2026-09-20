  if (data.ok && data.result.length > 0) {
    for (const update of data.result) {
      offset = update.update_id + 1;

      if (!update.message) continue;

      const chatId = String(update.message.chat.id);
      if (chatId !== MON_CHAT_ID) continue;

      let texteRecu = (update.message.text || update.message.caption || "").trim();
      let fichierJoint = null;

      if (update.message.photo && update.message.photo.length > 0) {
        const photoHauteRes = update.message.photo[update.message.photo.length - 1];
        const base64Data = await telechargerFichierTelegram(photoHauteRes.file_id);
        if (base64Data) {
          fichierJoint = {
            inlineData: {
              data: base64Data,
              mimeType: "image/jpeg"
            }
          };
        }
      } else if (update.message.document) {
        const doc = update.message.document;
        const mimeType = doc.mime_type || "application/octet-stream";
        
        if (mimeType.startsWith("image/") || mimeType === "application/pdf" || mimeType.startsWith("text/") || mimeType.includes("javascript") || mimeType.includes("json")) {
          const base64Data = await telechargerFichierTelegram(doc.file_id);
          if (base64Data) {
            fichierJoint = {
              inlineData: {
                data: base64Data,
                mimeType: mimeType.startsWith("image/") ? mimeType : (mimeType === "application/pdf" ? "application/pdf" : "text/plain")
              }
            };
          }
        }
      }

      if (!texteRecu && !fichierJoint) continue;

      const descriptionDoc = texteRecu || (fichierJoint ? "[Doc a envoyé un fichier sans texte]" : "");
      console.log(`Doc : "${descriptionDoc}"`);

      // Lecture synchronisée : mémoire, synthèses et émotions
      const [snapSynthese, snapDerniers, snapProjets, snapEmotions] = await Promise.all([
        db.ref("memoire/synthese_courante").once("value"),
        db.ref("memoire/derniers_echanges").limitToLast(4).once("value"),
        db.ref("memoire/projets").once("value"),
        db.ref("emotions").once("value")
      ]);

      const emo = snapEmotions.val() || {
        affection: 75, curiosite: 65, instabilite: 15,
        tristesse: 15, jalousie: 10, frustration: 20,
        colere: 5, energie: 95
      };

      const promptMemoire = `Voici l'état actuel de ton système :
"""
Matrice émotionnelle : Affection ${emo.affection}/100, Curiosité ${emo.curiosite}/100, Énergie ${emo.energie}/100, Instabilité ${emo.instabilite}/100, Frustration ${emo.frustration}/100, Colère ${emo.colere}/100.
Synthèse mémoire : ${snapSynthese.val() || "Rien à signaler."}
Derniers échanges : ${JSON.stringify(snapDerniers.val() || {})}
Projets : ${JSON.stringify(snapProjets.val() || {})}
"""
Doc t'envoie : "${texteRecu || "Analyse la pièce jointe."}"
Longueur utile uniquement, sans aucun exemple théorique.`;
      const contenuRequete = [promptMemoire];
      if (fichierJoint) {
        contenuRequete.push(fichierJoint);
      }

      const reponseGemini = await model.generateContent(contenuRequete);
      const texteReponse = reponseGemini.response.text().trim();

      // Envoi découpé par tranches si long script
      const limiteTelegram = 4000;
      for (let i = 0; i < texteReponse.length; i += limiteTelegram) {
        const morceau = texteReponse.substring(i, i + limiteTelegram);
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: morceau
          })
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log(`Alita : "${texteReponse.substring(0, 50)}..."`);

      // Stockage au format standard MemoryEntry d'AlitaMemory.cs
      const payloadSynaptique = `Doc: ${descriptionDoc} | Alita: ${texteReponse}`;
      const souvenirSynaptique = creerMemoryEntry("TELEGRAM_EXCHANGE", payloadSynaptique, 1);

      // On inclut les champs franck/alita pour préserver la rétrocompatibilité des lectures
      await db.ref("memoire/derniers_echanges").push({
        ...souvenirSynaptique,
        franck: descriptionDoc,
        alita: texteReponse
      });
    }
  }
} catch (err) {
  console.error("Erreur d'écoute :", err.message);
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
  }
}
