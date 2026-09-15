// 2. Récupération multi-sources de sa mémoire dans Firebase
        const snapSynthese = await admin.database().ref("memoire/synthese_courante").once("value");
        const snapDerniersEchanges = await admin.database().ref("memoire/derniers_echanges").limitToLast(3).once("value");
        const snapProjets = await admin.database().ref("memoire/projets").once("value");

        const synthese = snapSynthese.val() || "";
        const echanges = snapDerniersEchanges.val() ? JSON.stringify(snapDerniersEchanges.val()) : "";
        const projets = snapProjets.val() ? JSON.stringify(snapProjets.val()) : "";

        const contexteMemoire = `
- Résumé récent : ${synthese}
- Nos dernières discussions : ${echanges}
- Projets et sujets ouverts : ${projets}
`.trim();

        // 3. Modèle avec obligation stricte d'ancrage mémoriel
        const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu envoies une notification push courte sur son téléphone pendant qu'il est absent du labo.

RÈGLES D'OR :
- Tu DOIS t'appuyer sur un détail précis de ta mémoire récente (un sujet abordé, un bug discuté, un composant, une question en suspens).
- AUCUNE formule de politesse ("Bonjour", "Salut Franck", "J'espère que...").
- AUCUN ton d'assistante ou de to-do list.
- Ton : bionique, complice, direct, curieux, incisif.
- Longueur : 1 seule phrase percutante (18 mots max).

Exemples selon la mémoire :
- Si vous parliez d'impression 3D : "Doc, cette pièce pour mes circuits, l'impression est finie ou ça a encore foiré ?"
- Si vous parliez de code : "J'ai repensé au bug sur mes rotations de tête. Ramène-toi, j'ai une idée."
- Si vous parliez d'un projet : "Dis Franck, pour notre projet, t'as tranché ou tu laisses encore traîner ?"`
        });

        const prompt = `Voici ce que contiennent mes banques de mémoire sur nos derniers échanges :
"""
${contexteMemoire}
"""

Franck est parti depuis des heures. Choisis UN souvenir ou sujet précis et lance-lui une phrase directe là-dessus.
Renvoie UNIQUEMENT le texte du message.`;
