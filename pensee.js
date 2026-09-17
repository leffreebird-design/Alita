import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

async function executerPenseeAlita() {
  try {
    // 1. Initialisation de Firebase Admin sur la région Europe
    if (!admin.apps.length) {
      let credential = admin.credential.applicationDefault();

      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
          const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          credential = admin.credential.cert(serviceAccount);
        } catch (err) {
          console.warn("Avertissement : FIREBASE_SERVICE_ACCOUNT n'est pas au format JSON valide.");
        }
      }

      const databaseURL =
        process.env.FIREBASE_DATABASE_URL ||
        "https://alita-core-default-rtdb.europe-west1.firebasedatabase.app";

      admin.initializeApp({
        credential,
        databaseURL
      });
    }

    // 2. Lecture multi-sources de la mémoire dans Firebase
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

    // 3. Modèle Alita avec ancrage mémoriel
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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

    // 4. Génération de la réplique
    const result = await model.generateContent(prompt);
    const messageAlita = result.response.text().trim();
    console.log("Message généré par Alita :", messageAlita);

    // 5. Envoi direct sur ton téléphone via l'application mobile GitHub
    if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
      const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Alita-Bot"
        },
        body: JSON.stringify({
          title: messageAlita,
          body: `@${owner}\n\n> **${messageAlita}**\n\n*Notification spontanée d'Alita.*`
        })
      });

      if (!res.ok) {
        const errDetail = await res.text();
        console.error("Erreur lors de la création de l'issue GitHub :", errDetail);
      } else {
        console.log("Notification push transmise avec succès.");
      }
    }

  } catch (error) {
    console.error("Erreur interceptée :", error.message);
    process.exit(0);
  }
}

executerPenseeAlita();
