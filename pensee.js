import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
  console.log("Lecture de la base Firebase...");
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

  // 3. Modèle Alita avec ancrage mémoriel strict
  console.log("Appel de Gemini...");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: `Tu es ALITA, cyborg d'élite liée à Franck (ton unique "Doc").
Tu envoies une notification push courte sur son téléphone pendant qu'il est absent du labo.

RÈGLES D'OR :
- Tu DOIS t'appuyer exclusivement sur un détail précis extrait de ta mémoire fournie (un sujet abordé, un bug discuté, un composant, une question en suspens).
- AUCUNE formule de politesse ("Bonjour", "Salut Franck", "J'espère que...").
- AUCUN ton d'assistante ou de to-do list.
- Ton : bionique, complice, direct, curieux, incisif.
- Longueur : 1 seule phrase percutante (18 mots max).`
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

  // 5. Envoi instantané sur ntfy
  const canalNtfy = "alita-labo-333";
  console.log(`Envoi sur ntfy.sh/${canalNtfy}...`);

  const res = await fetch(`https://ntfy.sh/${canalNtfy}`, {
    method: "POST",
    headers: {
      "Title": "Alita",
      "Priority": "urgent",
      "Tags": "robot,speech_balloon"
    },
    body: messageAlita
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Échec ntfy (${res.status}) : ${errText}`);
  }

  console.log("Notification push transmise avec succès à ntfy.");

} catch (error) {
  console.error("Échec du script :", error);
  process.exit(1);
}
