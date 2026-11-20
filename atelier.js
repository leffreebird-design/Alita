// ==========================================
// 4. ÉTABLI CAO 3D, PLANS SVG, ARCHIVES & INGESTION DOCS (atelier.js)
// ==========================================
const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const {
  TELEGRAM_BOT_TOKEN,
  FIREBASE_DB_URL,
  LIMITE_DECOMPRESSION_OCTETS,
  supabase,
  obtenirHorodatageParis,
  slugifierNom,
  axiosGetHttpsPublic
} = require('./nyx_config');
const {
  getEtatProfond,
  stockerSouvenirVectoriel
} = require('./nyx_etat');
const {
  appelerCascadeCode,
  appelerCascadeDiscussion,
  genererImageVenice
} = require('./nyx_llm');

const BUCKET_ATELIER = "nyx-atelier";
let bucketAtelierPret = false;

async function initialiserAtelierStorage() {
  if (!supabase || bucketAtelierPret) return bucketAtelierPret;
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (!error && Array.isArray(buckets)) {
      const existe = buckets.some(b => b.name === BUCKET_ATELIER);
      if (!existe) {
        await supabase.storage.createBucket(BUCKET_ATELIER, { public: false }).catch(() => {});
      }
      bucketAtelierPret = true;
    }
  } catch (e) {
    console.warn("[ATELIER STORAGE INIT]", e.message);
  }
  return bucketAtelierPret;
}

async function archiverArtefactAtelier({ projet = "general", type = "fichier", nomFichier, buffer, mimeType = "application/octet-stream", resume = "", chatId = null }) {
  const projetSlug = slugifierNom(projet, "atelier");
  const nomPropre = nomFichier.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `piece_${Date.now()}.bin`;
  const storagePath = `${projetSlug}/${Date.now()}_${nomPropre}`;
  let signedUrl = "";

  if (supabase && buffer) {
    try {
      await initialiserAtelierStorage();
  if (FIREBASE_DB_URL) axios.delete(`${FIREBASE_DB_URL}/nyx/mission.json`).catch(() => {});
      const { error: upErr } = await supabase.storage
        .from(BUCKET_ATELIER)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
      if (!upErr) {
        const { data: urlData } = await supabase.storage
          .from(BUCKET_ATELIER)
          .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
        signedUrl = urlData?.signedUrl || "";
      } else {
        console.warn("[ATELIER STORAGE UPLOAD KO]", upErr.message);
      }
    } catch (e) {
      console.warn("[ATELIER STORAGE ERREUR]", e.message);
    }
  }

  const entree = {
    id: crypto.randomUUID(),
    date: obtenirHorodatageParis(),
    projet: projetSlug,
    type,
    nom: nomPropre,
    resume: String(resume || nomPropre).slice(0, 220),
    storagePath: signedUrl ? storagePath : "",
    signedUrl
  };

  getEtatProfond().artefacts = [...(getEtatProfond().artefacts || []), entree].slice(-30);
  if (FIREBASE_DB_URL) {
    axios.put(`${FIREBASE_DB_URL}/nyx/artefacts.json`, getEtatProfond().artefacts).catch(() => {});
  }

  // Indexation vectorielle pour rappel long terme
  stockerSouvenirVectoriel(
    `[Artefact Atelier Nyx - Projet ${projetSlug}] Fichier "${nomPropre}" (${type}) : ${entree.resume}`,
    { source: "atelier_artefact", projet: projetSlug, type, fichier: nomPropre, importance: 0.7 }
  ).catch(() => {});

  // Worker local Ben désactivé : 100 % des artefacts restent archivés dans Supabase Storage + livrés sur Telegram.

  return entree;
}

// --- MOTEUR CAO PUR JS : TRIANGULATION & COMPILATEUR STL BINAIRE ---
function triangulerPolygone2D(points) {
  const pts = points.map(p => [Number(p[0]) || 0, Number(p[1]) || 0]);
  if (pts.length < 3) return [];
  // Aire signée pour garantir le sens anti-horaire (CCW)
  let aire = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    aire += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  if (aire < 0) pts.reverse();

  const indices = pts.map((_, i) => i);
  const tris = [];
  const cross2D = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const dansTriangle = (p, a, b, c) => {
    const c1 = cross2D(a, b, p), c2 = cross2D(b, c, p), c3 = cross2D(c, a, p);
    return c1 >= -1e-6 && c2 >= -1e-6 && c3 >= -1e-6;
  };

  let guard = 0;
  while (indices.length > 3 && guard < 500) {
    guard++;
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i - 1 + indices.length) % indices.length];
      const curr = indices[i];
      const next = indices[(i + 1) % indices.length];
      const a = pts[prev], b = pts[curr], c = pts[next];
      if (cross2D(a, b, c) <= 1e-6) continue;
      let containsOther = false;
      for (let j = 0; j < indices.length; j++) {
        const idx = indices[j];
        if (idx === prev || idx === curr || idx === next) continue;
        if (dansTriangle(pts[idx], a, b, c)) { containsOther = true; break; }
      }
      if (!containsOther) {
        tris.push([a, b, c]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break;
  }
  if (indices.length === 3) {
    tris.push([pts[indices[0]], pts[indices[1]], pts[indices[2]]]);
  }
  return tris;
}

function compilerStlBinaire(spec) {
  const triangles = [];
  const addTri = (v1, v2, v3) => triangles.push([v1, v2, v3]);
  const addQuad = (v1, v2, v3, v4) => {
    addTri(v1, v2, v3);
    addTri(v1, v3, v4);
  };

  const addBoxRaw = (x0, x1, y0, y1, z0, z1) => {
    // Bas (-Z)
    addQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
    // Haut (+Z)
    addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    // Avant (-Y)
    addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    // Arrière (+Y)
    addQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    // Gauche (-X)
    addQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    // Droite (+X)
    addQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  };

  const pieces = Array.isArray(spec?.pieces) && spec.pieces.length > 0
    ? spec.pieces
    : [{ type: "box", w: 30, d: 20, h: 10, pos: [0, 0, 0] }];

  for (const p of pieces) {
    const localTris = [];
    const pushLocalTri = (a, b, c) => localTris.push([a, b, c]);
    const pushLocalQuad = (a, b, c, d) => { pushLocalTri(a, b, c); pushLocalTri(a, c, d); };

    const type = String(p.type || "box").toLowerCase();
    if (type === "box") {
      const w = Math.max(0.5, Number(p.w) || 10);
      const d = Math.max(0.5, Number(p.d) || 10);
      const h = Math.max(0.5, Number(p.h) || 10);
      const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h / 2, z1 = h / 2;
      pushLocalQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
      pushLocalQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
      pushLocalQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
      pushLocalQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
      pushLocalQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
      pushLocalQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    } else if (type === "hollow_box" || type === "enclosure") {
      const w = Math.max(3, Number(p.w) || 20);
      const d = Math.max(3, Number(p.d) || 20);
      const h = Math.max(3, Number(p.h) || 12);
      const wall = Math.min(Math.min(w, d) * 0.4, Math.max(0.8, Number(p.wall) || 2));
      const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h / 2, z1 = h / 2;
      const ix0 = x0 + wall, ix1 = x1 - wall, iy0 = y0 + wall, iy1 = y1 - wall, iz0 = z0 + wall;
      // Coque externe
      pushLocalQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
      pushLocalQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
      pushLocalQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
      pushLocalQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
      pushLocalQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
      // Cavité interne ouverte sur +Z
      pushLocalQuad([ix0, iy0, iz0], [ix1, iy0, iz0], [ix1, iy1, iz0], [ix0, iy1, iz0]);
      pushLocalQuad([ix1, iy0, iz0], [ix0, iy0, iz0], [ix0, iy0, z1], [ix1, iy0, z1]);
      pushLocalQuad([ix0, iy1, iz0], [ix1, iy1, iz0], [ix1, iy1, z1], [ix0, iy1, z1]);
      pushLocalQuad([ix0, iy0, iz0], [ix0, iy1, iz0], [ix0, iy1, z1], [ix0, iy0, z1]);
      pushLocalQuad([ix1, iy1, iz0], [ix1, iy0, iz0], [ix1, iy0, z1], [ix1, iy1, z1]);
      // Rebord supérieur (+Z)
      pushLocalQuad([x0, y0, z1], [x1, y0, z1], [ix1, iy0, z1], [ix0, iy0, z1]);
      pushLocalQuad([x1, y1, z1], [x0, y1, z1], [ix0, iy1, z1], [ix1, iy1, z1]);
      pushLocalQuad([x0, y1, z1], [x0, y0, z1], [ix0, iy0, z1], [ix0, iy1, z1]);
      pushLocalQuad([x1, y0, z1], [x1, y1, z1], [ix1, iy1, z1], [ix1, iy0, z1]);
    } else if (type === "cylinder" || type === "cone") {
      const r1 = Math.max(0.2, Number(p.r1 ?? p.r) || 8);
      const r2 = type === "cone" ? Math.max(0, Number(p.r2) || 0) : Math.max(0.2, Number(p.r2 ?? p.r) || r1);
      const h = Math.max(0.5, Number(p.h) || 15);
      const seg = Math.max(12, Math.min(64, Math.round(Number(p.segments) || 32)));
      const z0 = -h / 2, z1 = h / 2;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        const b0 = [Math.cos(a0) * r1, Math.sin(a0) * r1, z0];
        const b1 = [Math.cos(a1) * r1, Math.sin(a1) * r1, z0];
        const t0 = [Math.cos(a0) * r2, Math.sin(a0) * r2, z1];
        const t1 = [Math.cos(a1) * r2, Math.sin(a1) * r2, z1];
        pushLocalTri([0, 0, z0], b1, b0);
        if (r2 > 0.01) {
          pushLocalTri([0, 0, z1], t0, t1);
          pushLocalQuad(b0, b1, t1, t0);
        } else {
          pushLocalTri(b0, b1, [0, 0, z1]);
        }
      }
    } else if (type === "tube" || type === "ring") {
      const rOut = Math.max(1, Number(p.rOuter ?? p.r) || 10);
      const rIn = Math.min(rOut - 0.4, Math.max(0.3, Number(p.rInner) || rOut * 0.6));
      const h = Math.max(0.5, Number(p.h) || 12);
      const seg = Math.max(12, Math.min(64, Math.round(Number(p.segments) || 32)));
      const z0 = -h / 2, z1 = h / 2;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        const ob0 = [Math.cos(a0) * rOut, Math.sin(a0) * rOut, z0];
        const ob1 = [Math.cos(a1) * rOut, Math.sin(a1) * rOut, z0];
        const ot0 = [Math.cos(a0) * rOut, Math.sin(a0) * rOut, z1];
        const ot1 = [Math.cos(a1) * rOut, Math.sin(a1) * rOut, z1];
        const ib0 = [Math.cos(a0) * rIn, Math.sin(a0) * rIn, z0];
        const ib1 = [Math.cos(a1) * rIn, Math.sin(a1) * rIn, z0];
        const it0 = [Math.cos(a0) * rIn, Math.sin(a0) * rIn, z1];
        const it1 = [Math.cos(a1) * rIn, Math.sin(a1) * rIn, z1];
        pushLocalQuad(ob0, ob1, ot1, ot0); // Externe
        pushLocalQuad(ib1, ib0, it0, it1); // Interne
        pushLocalQuad(ot0, ot1, it1, it0); // Haut
        pushLocalQuad(ib0, ib1, ob1, ob0); // Bas
      }
    } else if (type === "sphere" || type === "dome") {
      const r = Math.max(0.5, Number(p.r) || 10);
      const seg = Math.max(12, Math.min(48, Math.round(Number(p.segments) || 24)));
      const rings = Math.max(8, Math.round(seg / 2));
      for (let i = 0; i < rings; i++) {
        const phi0 = (i / rings) * Math.PI;
        const phi1 = ((i + 1) / rings) * Math.PI;
        for (let j = 0; j < seg; j++) {
          const th0 = (j / seg) * Math.PI * 2;
          const th1 = ((j + 1) / seg) * Math.PI * 2;
          const pt = (ph, th) => [
            r * Math.sin(ph) * Math.cos(th),
            r * Math.sin(ph) * Math.sin(th),
            r * Math.cos(ph)
          ];
          const p00 = pt(phi0, th0), p10 = pt(phi1, th0), p11 = pt(phi1, th1), p01 = pt(phi0, th1);
          if (i > 0) pushLocalTri(p00, p10, p01);
          if (i < rings - 1) pushLocalTri(p10, p11, p01);
        }
      }
    } else if (type === "extrude_poly" && Array.isArray(p.points) && p.points.length >= 3) {
      const h = Math.max(0.5, Number(p.h) || 10);
      const z0 = -h / 2, z1 = h / 2;
      const capTris = triangulerPolygone2D(p.points);
      for (const [a, b, c] of capTris) {
        pushLocalTri([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]);
        pushLocalTri([c[0], c[1], z0], [b[0], b[1], z0], [a[0], a[1], z0]);
      }
      const pts = p.points.map(pt => [Number(pt[0]) || 0, Number(pt[1]) || 0]);
      let aire = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        aire += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
      }
      if (aire < 0) pts.reverse();
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        pushLocalQuad(
          [pts[i][0], pts[i][1], z0],
          [pts[j][0], pts[j][1], z0],
          [pts[j][0], pts[j][1], z1],
          [pts[i][0], pts[i][1], z1]
        );
      }
    }

    // Transformation 3D (Scale -> Euler XYZ deg -> Translate)
    const [sx, sy, sz] = Array.isArray(p.scale) ? p.scale.map(v => Number(v) || 1) : [1, 1, 1];
    const [rx, ry, rz] = Array.isArray(p.rot) ? p.rot.map(v => ((Number(v) || 0) * Math.PI) / 180) : [0, 0, 0];
    const [tx, ty, tz] = Array.isArray(p.pos) ? p.pos.map(v => Number(v) || 0) : [0, 0, 0];

    const cx = Math.cos(rx), sxr = Math.sin(rx);
    const cy = Math.cos(ry), syr = Math.sin(ry);
    const cz = Math.cos(rz), szr = Math.sin(rz);

    const transformerPoint = (pt, invertX = false) => {
      let x = pt[0] * sx, y = pt[1] * sy, z = pt[2] * sz;
      // Rot X
      let y1 = y * cx - z * sxr, z1 = y * sxr + z * cx;
      // Rot Y
      let x2 = x * cy + z1 * syr, z2 = -x * syr + z1 * cy;
      // Rot Z
      let x3 = x2 * cz - y1 * szr, y3 = x2 * szr + y1 * cz;
      const fx = invertX ? -(x3 + tx) : (x3 + tx);
      return [fx, y3 + ty, z2 + tz];
    };

    for (const [v1, v2, v3] of localTris) {
      addTri(transformerPoint(v1, false), transformerPoint(v2, false), transformerPoint(v3, false));
      if (p.mirrorX) {
        addTri(transformerPoint(v1, true), transformerPoint(v3, true), transformerPoint(v2, true));
      }
    }
  }

  // Mise à plat sur le plateau d'impression (minZ = 0)
  let minZ = Infinity;
  for (const tri of triangles) {
    for (const v of tri) if (v[2] < minZ) minZ = v[2];
  }
  const offsetZ = Number.isFinite(minZ) ? -minZ : 0;

  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write("Nyx Workshop Binary STL - Parametric CAD", 0, 80, "ascii");
  buf.writeUInt32LE(triangles.length, 80);

  let offset = 84;
  for (const [a, b, c] of triangles) {
    const va = [a[0], a[1], a[2] + offsetZ];
    const vb = [b[0], b[1], b[2] + offsetZ];
    const vc = [c[0], c[1], c[2] + offsetZ];
    const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
    const vx = vc[0] - va[0], vy = vc[1] - va[1], vz = vc[2] - va[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    buf.writeFloatLE(nx, offset);
    buf.writeFloatLE(ny, offset + 4);
    buf.writeFloatLE(nz, offset + 8);
    buf.writeFloatLE(va[0], offset + 12);
    buf.writeFloatLE(va[1], offset + 16);
    buf.writeFloatLE(va[2], offset + 20);
    buf.writeFloatLE(vb[0], offset + 24);
    buf.writeFloatLE(vb[1], offset + 28);
    buf.writeFloatLE(vb[2], offset + 32);
    buf.writeFloatLE(vc[0], offset + 36);
    buf.writeFloatLE(vc[1], offset + 40);
    buf.writeFloatLE(vc[2], offset + 44);
    buf.writeUInt16LE(0, offset + 48);
    offset += 50;
  }

  return { stlBuffer: buf, triangleCount: triangles.length };
}

function analyserStlBuffer(buffer, nomFichier) {
  try {
    const asText = buffer.slice(0, 256).toString("utf8");
    if (/^\s*solid /i.test(asText) && buffer.toString("utf8").includes("facet normal")) {
      const matches = [...buffer.toString("utf8").matchAll(/vertex\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/g)];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const m of matches) {
        const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const tris = Math.round(matches.length / 3);
      return `Modèle 3D STL ASCII "${nomFichier}" : ${tris} triangles | Dimensions : ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} x ${(maxZ - minZ).toFixed(1)} mm.`;
    }
    if (buffer.length >= 84) {
      const triCount = buffer.readUInt32LE(80);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      const maxRead = Math.min(triCount, Math.floor((buffer.length - 84) / 50));
      for (let i = 0; i < maxRead; i++) {
        const base = 84 + i * 50 + 12;
        for (let v = 0; v < 3; v++) {
          const x = buffer.readFloatLE(base + v * 12);
          const y = buffer.readFloatLE(base + v * 12 + 4);
          const z = buffer.readFloatLE(base + v * 12 + 8);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
      return `Modèle 3D STL Binaire "${nomFichier}" : ${triCount} triangles | Encombrement : ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} x ${(maxZ - minZ).toFixed(1)} mm.`;
    }
  } catch (e) {}
  return `Fichier STL "${nomFichier}" (${buffer.length} octets).`;
}


function analyserObjBuffer(buffer, nomFichier) {
  try {
    let vCount = 0, fCount = 0;
    const objets = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;

    let start = 0;
    const len = buffer.length;
    while (start < len) {
      let end = buffer.indexOf(10, start); // '\n'
      if (end === -1) end = len;
      const b0 = buffer[start];
      const b1 = start + 1 < end ? buffer[start + 1] : 0;

      if (b1 === 32 && (b0 === 118 || b0 === 102 || b0 === 103 || b0 === 111)) { // 'v ', 'f ', 'g ', 'o '
        const line = buffer.toString("utf8", start, end).trim();
        if (b0 === 118) {
          vCount++;
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
          }
        } else if (b0 === 102) {
          fCount++;
        } else {
          const nomObj = line.slice(2).trim();
          if (nomObj && !objets.includes(nomObj) && objets.length < 25) {
            objets.push(nomObj);
          }
        }
      }
      start = end + 1;
    }

    if (vCount > 0) {
      const dim = `Dimensions : ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} x ${(maxZ - minZ).toFixed(1)} mm`;
      const struct = objets.length > 0
        ? `${objets.length} groupe(s)/pièce(s) [${objets.slice(0, 12).join(", ")}${objets.length > 12 ? "..." : ""}]`
        : "1 maillage unifié";
      return `Modèle 3D OBJ "${nomFichier}" (${(buffer.length / (1024 * 1024)).toFixed(2)} Mo) : ${vCount} sommets, ${fCount} faces, ${struct} | ${dim}.`;
    }
  } catch (e) {}
  return `Fichier OBJ "${nomFichier}" (${buffer.length} octets).`;
}


function convertirLienTelechargementDirect(urlBrute) {
  const u = String(urlBrute || "").trim();
  // Google Drive : https://drive.google.com/file/d/<ID>/view... ou ?id=<ID>
  const mDriveFile = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  if (mDriveFile) {
    return `https://drive.google.com/uc?export=download&confirm=t&id=${mDriveFile[1]}`;
  }
  const mDriveOpen = u.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i);
  if (mDriveOpen) {
    return `https://drive.google.com/uc?export=download&confirm=t&id=${mDriveOpen[1]}`;
  }
  // Dropbox : dl=0 -> dl=1
  if (/dropbox\.com\//i.test(u)) {
    return u.replace(/([?&])dl=0\b/i, '$1dl=1');
  }
  return u;
}

async function telechargerBufferCloudSecurise(urlBrute) {
  const urlDirecte = convertirLienTelechargementDirect(urlBrute);
  const resDl = await axiosGetHttpsPublic(urlDirecte, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  let buf = Buffer.from(resDl.data);
  resDl.data = null;
  let headers = resDl.headers || {};

  // Si Google Drive renvoie la page HTML d'avertissement gros fichier (>25 Mo), on extrait l'action/uuid réel
  const ctype = String(headers['content-type'] || "");
  if (ctype.includes('text/html') && /drive\.google\.com|usercontent\.google\.com/i.test(urlDirecte) && buf.length < 200000) {
    const html = buf.toString('utf8');
    const mId = urlDirecte.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
    const mUuid = html.match(/name="uuid"\s+value="([^"]+)"/i);
    const mConfirm = html.match(/name="confirm"\s+value="([^"]+)"/i);
    if (mId) {
      const urlConfirm = `https://drive.usercontent.google.com/download?id=${mId[1]}&export=download&confirm=${mConfirm ? mConfirm[1] : 't'}${mUuid ? `&uuid=${mUuid[1]}` : ''}`;
      const resDl2 = await axiosGetHttpsPublic(urlConfirm, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      buf = Buffer.from(resDl2.data);
      resDl2.data = null;
      headers = resDl2.headers || headers;
    }
  }
  return { buffer: buf, headers };
}

function extraireFichiersArchive(buffer, nomArchive) {
  const nomMin = String(nomArchive || "").toLowerCase();
  const fichiers = [];

  if (nomMin.endsWith('.gz') && !nomMin.endsWith('.tar.gz')) {
    const decomp = zlib.gunzipSync(buffer, { maxOutputLength: LIMITE_DECOMPRESSION_OCTETS });
    const nomInterne = nomArchive.replace(/\.gz$/i, '') || `piece_${Date.now()}.obj`;
    fichiers.push({ nom: nomInterne, buffer: decomp });
    return fichiers;
  }

  if (nomMin.endsWith('.zip')) {
    // Recherche de l'End of Central Directory (0x06054b50) depuis la fin
    let eocdOffset = -1;
    const minSearch = Math.max(0, buffer.length - 65558);
    for (let i = buffer.length - 22; i >= minSearch; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error("Archive ZIP invalide ou corrompue (EOCD introuvable).");
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    if (totalEntries > 100) throw new Error("Archive refusée : plus de 100 entrées.");
    let totalDecompresse = 0;
    let pos = buffer.readUInt32LE(eocdOffset + 16);

    for (let idx = 0; idx < totalEntries && pos + 46 <= buffer.length; idx++) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) break;

      const method = buffer.readUInt16LE(pos + 10);
      const compSize = buffer.readUInt32LE(pos + 20);
      const uncompSize = buffer.readUInt32LE(pos + 24);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const localOffset = buffer.readUInt32LE(pos + 42);

      const rawName = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
      pos += 46 + nameLen + extraLen + commentLen;

      const baseName = rawName.split('/').pop();
      if (!baseName || rawName.endsWith('/') || baseName.startsWith('.')) continue;
      if (uncompSize > 120 * 1024 * 1024) continue; // Sécurité RAM 120 Mo max par entrée

      if (localOffset + 30 > buffer.length) continue;
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      if (dataStart + compSize > buffer.length) continue;

      const compSlice = buffer.subarray(dataStart, dataStart + compSize);
      let rawBuf = null;
      if (method === 0) {
        rawBuf = Buffer.from(compSlice);
      } else if (method === 8) {
        rawBuf = zlib.inflateRawSync(compSlice, { maxOutputLength: Math.max(1, LIMITE_DECOMPRESSION_OCTETS - totalDecompresse) });
      }
      if (rawBuf && rawBuf.length > 0) {
        totalDecompresse += rawBuf.length;
        if (totalDecompresse > LIMITE_DECOMPRESSION_OCTETS) {
          throw new Error("Archive refusée : limite totale de décompression dépassée.");
        }
        if (rawBuf.length > uncompSize + 1024) {
          throw new Error("Archive refusée : taille décompressée incohérente.");
        }
        fichiers.push({ nom: baseName, buffer: rawBuf });
      }
    }
  }

  return fichiers;
}

async function genererPiece3D(description, contexteProjet = "") {
  const promptCad = `Tu es le moteur CAO paramétrique de Nyx. Transforme cette demande de pièce 3D en un assemblage géométrique exact (en millimètres) ET son script OpenSCAD.

DEMANDE : "${description}"
${contexteProjet ? `CONTEXTE PROJET : ${contexteProjet}` : ""}

PRIMIVES SUPPORTÉES DANS "pieces" :
- {"type": "box", "w": X, "d": Y, "h": Z, "pos": [x,y,z], "rot": [rx,ry,rz], "mirrorX": false}
- {"type": "hollow_box", "w": X, "d": Y, "h": Z, "wall": 2, "pos": [x,y,z], "rot": [rx,ry,rz]}
- {"type": "cylinder", "r1": R1, "r2": R2, "h": Z, "segments": 32, "pos": [x,y,z], "rot": [rx,ry,rz]}
- {"type": "tube", "rOuter": RO, "rInner": RI, "h": Z, "segments": 32, "pos": [x,y,z], "rot": [rx,ry,rz]}
- {"type": "sphere", "r": R, "segments": 24, "pos": [x,y,z]}
- {"type": "extrude_poly", "points": [[x1,y1],[x2,y2],...], "h": Z, "pos": [x,y,z], "rot": [rx,ry,rz], "mirrorX": false}

RÈGLES :
- Fais chevaucher légèrement les sous-pièces (0.5mm) pour qu'elles soient solidaires à l'impression 3D.
- Réponds STRICTEMENT avec un JSON valide sans markdown autour :
{"nom_fichier": "nom_sans_extension", "projet": "nom_projet_court", "resume": "Description technique courte et cotes", "pieces": [...], "openscad": "// Code OpenSCAD complet"}`;

  let brut = "";
  try {
    brut = await appelerCascadeCode("Compilateur CAO JSON & OpenSCAD.", [], promptCad, 2500);
  } catch (e) {
    brut = await appelerCascadeDiscussion("Compilateur CAO JSON & OpenSCAD.", [], promptCad, 2500);
  }

  const matchJson = brut.match(/\{[\s\S]*\}/);
  let spec = { nom_fichier: `nyx_piece_${Date.now()}`, projet: "atelier_3d", resume: description.slice(0, 120), pieces: [{ type: "hollow_box", w: 30, d: 20, h: 12, wall: 2, pos: [0, 0, 0] }], openscad: "" };
  if (matchJson) {
    try {
      spec = { ...spec, ...JSON.parse(matchJson[0]) };
    } catch (eParse) {}
  }

  const { stlBuffer, triangleCount } = compilerStlBinaire(spec);
  const nomBase = slugifierNom(spec.nom_fichier, `nyx_piece_${Date.now()}`);
  const scadBuffer = spec.openscad && String(spec.openscad).trim().length > 10
    ? Buffer.from(String(spec.openscad).trim(), "utf8")
    : null;

  return {
    nomBase,
    projet: slugifierNom(spec.projet, "atelier_3d"),
    resume: `${spec.resume} (${triangleCount} triangles)`,
    stlBuffer,
    scadBuffer,
    triangleCount
  };
}

function nettoyerSvgSecurise(svgBrut) {
  let svg = String(svgBrut || "");
  if (!svg || svg.length > 2 * 1024 * 1024) throw new Error("SVG vide ou supérieur à 2 Mo.");
  if (!/<svg\b[\s\S]*<\/svg>/i.test(svg)) throw new Error("Structure SVG invalide.");

  svg = svg
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|xlink:href)\s*=\s*("(?!(?:#))[^"]*"|'(?!(?:#))[^']*'|(?!(?:#))[^\s>]+)/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]+\)/gi, "none")
    .replace(/@import[^;]+;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/data\s*:\s*text\/html/gi, "");
  return svg;
}

async function genererPlanSvg(description, contexteProjet = "") {
  const promptPlan = `Tu es le bureau d'études techniques de Nyx. Génère un plan technique SVG vectoriel précis, lisible et coté pour :
"${description}"
${contexteProjet ? `CONTEXTE : ${contexteProjet}` : ""}

CONTRAINTES SVG STRICTES :
- Balise racine : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
- Fond sombre atelier (#0b0f17), grille technique subtile (#162032), tracés principaux cyan (#00f0ff) et blanc (#e2e8f0), cotes et flèches magenta/ambre (#f59e0b).
- Inclus un cartouche technique en bas à droite (Titre, Échelle, Date, Nyx Atelier) et des annotations claires.
- Réponds STRICTEMENT avec le code <svg>...</svg> complet, zéro texte avant ou après.`;

  let brut = "";
  try {
    brut = await appelerCascadeCode("Dessinateur industriel SVG.", [], promptPlan, 3000);
  } catch (e) {
    brut = await appelerCascadeDiscussion("Dessinateur industriel SVG.", [], promptPlan, 3000);
  }

  const matchSvg = brut.match(/<svg[\s\S]*?<\/svg>/i);
  if (!matchSvg) {
    throw new Error("Impossible de compiler le schéma SVG.");
  }
  const svgCode = nettoyerSvgSecurise(matchSvg[0].trim());
  const nomFichier = `plan_${slugifierNom(description.slice(0, 35), String(Date.now()))}.svg`;
  return {
    nomFichier,
    svgBuffer: Buffer.from(svgCode, "utf8"),
    resume: description.slice(0, 160)
  };
}

function refermerBalisesAtelierTronquees(texte) {
  if (!texte) return texte;
  let t = String(texte).trim();

  // Si une balise [DESSIN: ...], [3D_STL: ...] ou [PLAN_SVG: ...] a été coupée par max_tokens sans ']', on la referme proprement
  const regexBaliseOuverte = /\[(DESSIN|3D_STL|PLAN_SVG):\s*([^\]]*)$/i;
  if (regexBaliseOuverte.test(t)) {
    t = t.replace(/[,;:\s-]+$/, '') + ']';
  }

  // Idem pour [FICHIER: nom.ext]... non refermé
  if (/\[FICHIER:\s*[^\]\r\n]+\]/i.test(t) && !/\[\/FICHIER\]/i.test(t)) {
    t = t + '\n[/FICHIER]';
  }

  return t;
}

/**
 * Initialise les fonctions d'expédition Telegram liées à l'atelier.
 */
function createAtelierOutputs({ envoyerTelegram, afficherFrappeTelegram, envoyerPhotoTelegram, envoyerDocumentTelegram }) {
async function executerSortiesAtelier(texteBrutNyx, chatId, contexteProjet = "") {
  let texteNet = String(texteBrutNyx || "");
  const artefactsProduits = [];

  // 1. Extraction de tous les fichiers explicites [FICHIER: nom.ext]...[/FICHIER]
  const regexFichier = /\[FICHIER:\s*([^\]\r\n]+)\]\s*([\s\S]*?)\[\/FICHIER\]/gi;
  let matchF;
  while ((matchF = regexFichier.exec(texteNet)) !== null) {
    const nomBrut = matchF[1].trim();
    const contenuFichier = matchF[2].replace(/^```[a-z]*\r?\n?|\r?\n?```$/gi, '').trim();
    if (contenuFichier.length > 0) {
      const buf = Buffer.from(contenuFichier, "utf8");
      const art = await archiverArtefactAtelier({
        projet: contexteProjet || "atelier_code",
        type: "fichier",
        nomFichier: nomBrut,
        buffer: buf,
        mimeType: "text/plain",
        resume: `Fichier généré (${buf.length} octets)`,
        chatId
      });
      artefactsProduits.push(art);
      if (chatId) {
        await envoyerDocumentTelegram(chatId, buf, art.nom, "text/plain", `📎 ${art.nom}`).catch(e => console.error("[DOC TG KO]", e.message));
      }
    }
  }
  texteNet = texteNet.replace(/\[FICHIER:\s*([^\]\r\n]+)\]\s*[\s\S]*?\[\/FICHIER\]/gi, (_, nom) => `📎 *Fichier livré :* \`${nom.trim()}\``).trim();

  texteNet = refermerBalisesAtelierTronquees(texteNet);

  // 2. Extraction des pièces 3D [3D_STL: description]
  const matchStl = texteNet.match(/\[3D_STL:\s*([\s\S]*?)(?:\]|$)/i);
  let stlResult = null;
  if (matchStl) {
    const desc3D = matchStl[1].trim();
    texteNet = texteNet.replace(matchStl[0], '').trim();
    try {
      if (chatId) await afficherFrappeTelegram(chatId);
      stlResult = await genererPiece3D(desc3D, contexteProjet);
      const artStl = await archiverArtefactAtelier({
        projet: stlResult.projet,
        type: "stl_3d",
        nomFichier: `${stlResult.nomBase}.stl`,
        buffer: stlResult.stlBuffer,
        mimeType: "application/sla",
        resume: stlResult.resume,
        chatId
      });
      artefactsProduits.push(artStl);
      if (chatId) {
        await envoyerDocumentTelegram(chatId, stlResult.stlBuffer, `${stlResult.nomBase}.stl`, "application/sla", `🧊 STL prêt à slicer : ${stlResult.resume}`);
      }
      if (stlResult.scadBuffer) {
        const artScad = await archiverArtefactAtelier({
          projet: stlResult.projet,
          type: "openscad",
          nomFichier: `${stlResult.nomBase}.scad`,
          buffer: stlResult.scadBuffer,
          mimeType: "text/plain",
          resume: `Source paramétrique OpenSCAD de ${stlResult.nomBase}`,
          chatId
        });
        artefactsProduits.push(artScad);
        if (chatId) {
          await envoyerDocumentTelegram(chatId, stlResult.scadBuffer, `${stlResult.nomBase}.scad`, "text/plain", `📐 Source OpenSCAD paramétrique`);
        }
      }
    } catch (errStl) {
      if (chatId) await envoyerTelegram(chatId, `⚠️ Échec compilation 3D STL : ${errStl.message}`);
    }
  }

  // 3. Extraction des plans techniques [PLAN_SVG: description]
  const matchPlan = texteNet.match(/\[PLAN_SVG:\s*([\s\S]*?)(?:\]|$)/i);
  if (matchPlan) {
    const descPlan = matchPlan[1].trim();
    texteNet = texteNet.replace(matchPlan[0], '').trim();
    try {
      if (chatId) await afficherFrappeTelegram(chatId);
      const planRes = await genererPlanSvg(descPlan, contexteProjet);
      const artPlan = await archiverArtefactAtelier({
        projet: contexteProjet || "plans_atelier",
        type: "plan_svg",
        nomFichier: planRes.nomFichier,
        buffer: planRes.svgBuffer,
        mimeType: "image/svg+xml",
        resume: planRes.resume,
        chatId
      });
      artefactsProduits.push(artPlan);
      if (chatId) {
        await envoyerDocumentTelegram(chatId, planRes.svgBuffer, planRes.nomFichier, "image/svg+xml", `📐 Plan technique : ${planRes.resume}`);
      }
    } catch (errPlan) {
      if (chatId) await envoyerTelegram(chatId, `⚠️ Échec génération plan SVG : ${errPlan.message}`);
    }
  }

  // 4. Extraction des visuels [DESSIN: prompt] (tolère une balise coupée en fin de message)
  const matchDessin = texteNet.match(/\[DESSIN:\s*([\s\S]*?)(?:\]|$)/i)
    || texteNet.match(/\*{0,2}DESSIN\*{0,2}\s*:\s*["“]([\s\S]*?)["”]/i)
    || texteNet.match(/(?:^|\n)\*{0,2}DESSIN\*{0,2}\s*:\s*([^\n\r]+)/i);

  let imageB64 = null;
  if (matchDessin) {
    const promptDessin = (matchDessin[1] || "").trim();
    texteNet = texteNet.replace(matchDessin[0], '').trim();
    try {
      if (chatId) await afficherFrappeTelegram(chatId);
      imageB64 = await genererImageVenice(promptDessin);
      if (imageB64) {
        const imgBuf = Buffer.from(imageB64, 'base64');
        const artImg = await archiverArtefactAtelier({
          projet: contexteProjet || "visuels_atelier",
          type: "image",
          nomFichier: `vision_${Date.now()}.jpg`,
          buffer: imgBuf,
          mimeType: "image/jpeg",
          resume: promptDessin.slice(0, 160),
          chatId
        });
        artefactsProduits.push(artImg);
        if (chatId) await envoyerPhotoTelegram(chatId, imageB64);
      }
    } catch (errImg) {
      if (chatId) await envoyerTelegram(chatId, `[ÉCHEC IMAGE] : ${errImg.message}`);
    }
  }

  return { texteNet, imageB64, artefactsProduits };
}

const LIMITE_TELEGRAM_BOT_BYTES = 20 * 1024 * 1024; // Plafond strict de l'API Bot Telegram (20 Mo)

async function lireBufferTelegramSecurise(fileId, fileSize = 0) {
  if (fileSize && fileSize > LIMITE_TELEGRAM_BOT_BYTES) {
    const tailleMo = (fileSize / (1024 * 1024)).toFixed(1);
    throw new Error(`TELEGRAM_FILE_TOO_BIG:${tailleMo}`);
  }
  try {
    const urlMeta = "https://api.telegram.org/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/getFile?file_id=" + encodeURIComponent(fileId);
    const resMeta = await axios.get(urlMeta, { timeout: 15000 });
    const urlMedia = "https://api.telegram.org/file/bot" + encodeURIComponent(TELEGRAM_BOT_TOKEN) + "/" + resMeta.data.result.file_path;
    const resMedia = await axios.get(urlMedia, { responseType: 'arraybuffer', timeout: 45000 });
    const buf = Buffer.from(resMedia.data);
    resMedia.data = null;
    return buf;
  } catch (err) {
    const descTg = err.response?.data?.description || "";
    if (/file is too big/i.test(descTg) || err.response?.status === 400) {
      const tailleMo = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : ">20";
      throw new Error(`TELEGRAM_FILE_TOO_BIG:${tailleMo}`);
    }
    throw new Error(descTg || err.message);
  }
}

async function lireMediaSecurise(fileId, fileSize = 0) {
  const buf = await lireBufferTelegramSecurise(fileId, fileSize);
  return buf.toString('base64');
}

async function extraireTextePdfBuffer(buffer) {
  try {
    const data = await pdfParse(buffer);
    if (data.text && data.text.trim().length > 30) {
      return data.text.trim();
    }
  } catch (err) {
    console.warn("Échec pdfParse, passage au secours visuel...", err.message);
  }

  if (buffer.length > 18 * 1024 * 1024) {
    const tailleMo = (buffer.length / (1024 * 1024)).toFixed(1);
    throw new Error(`PDF scanné sans couche texte de ${tailleMo} Mo (secours OCR Gemini limité à 18 Mo).`);
  }

  const geminiKey = process.env.GEMINI_API_KEY_FREE
                 || process.env.GEMINI_API_KEY_PAID
                 || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    throw new Error("Clé GEMINI_API_KEY_FREE ou GEMINI_API_KEY_PAID absente sur Render.");
  }

  const modelesGamme3 = [
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash",
    "gemini-3-flash",
    "gemini-3.6-flash"
  ].filter(Boolean);

  const base64Data = buffer.toString('base64');
  const payload = {
    contents: [{
      parts: [
        { text: "Tu es Nyx. Lis et retranscris fidèlement l'intégralité du texte, des idées, des schémas et de la structure de cette présentation ou document PDF." },
        {
          inline_data: {
            mime_type: "application/pdf",
            data: base64Data
          }
        }
      ]
    }]
  };

  let erreurRetour = null;

  for (const model of modelesGamme3) {
    try {
      const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const resGemini = await axios.post(urlGemini, payload, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        timeout: 120000 
      });

      const texteExtrait = resGemini.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (texteExtrait && texteExtrait.trim().length > 0) {
        console.log(`[PDF LECTURE] Succès avec : ${model}`);
        return texteExtrait.trim();
      }
    } catch (err) {
      erreurRetour = err;
      console.warn(`[PDF LECTURE] Modèle ${model} non joignable (HTTP ${err.response?.status || 'ERR'})`);
    }
  }

  throw new Error(`Échec de lecture visuelle : ${erreurRetour?.response?.data?.error?.message || erreurRetour?.message || "Modèles 3.x inaccessibles"}`);
}

async function lirePdfSecurise(fileId, fileSize = 0) {
  const buffer = await lireBufferTelegramSecurise(fileId, fileSize);
  return await extraireTextePdfBuffer(buffer);
}

function plafonnerTexteDocument(texte, maxChars = 22000) {
  const propre = String(texte || "").trim();
  if (propre.length <= maxChars) return propre;
  return propre.slice(0, maxChars) + "\n\n[...document tronqué à 22 000 caractères pour préserver la mémoire du serveur...]";
}

function formaterDocumentPourNyx(typeDoc, nomFichier, contenu, consigneDoc) {
  const contenuSecurise = plafonnerTexteDocument(contenu, 22000);
  const consigneFinale = (consigneDoc || "").trim()
    || "Donne ton avis franc de binôme d'atelier sur ce document (ce qui te plaît, ce qui te fait tiquer ou ce qu'il faut ajuster), avec ton franc-parler habituel et zéro formule polie d'assistant.";
  return `[${typeDoc} PARTAGÉ PAR DOC : "${nomFichier}"]\n${contenuSecurise}\n[FIN DU DOCUMENT]\n\nConsigne de réaction (ton oral direct d'atelier, zéro langue de bois corporate) : ${consigneFinale}`;
}

async function lireDocxSecurise(fileId, fileSize = 0) {
  const buf = await lireBufferTelegramSecurise(fileId, fileSize);
  const data = await mammoth.extractRawText({ buffer: buf });
  return plafonnerTexteDocument(data.value, 22000);
}

async function lireTexteSecurise(fileId, fileSize = 0) {
  const buf = await lireBufferTelegramSecurise(fileId, fileSize);
  const texte = buf.toString('utf-8');
  return plafonnerTexteDocument(texte, 22000);
}

  return {
    executerSortiesAtelier
  };
}

module.exports = {
  BUCKET_ATELIER,
  LIMITE_TELEGRAM_BOT_BYTES,
  initialiserAtelierStorage,
  archiverArtefactAtelier,
  triangulerPolygone2D,
  compilerStlBinaire,
  analyserStlBuffer,
  analyserObjBuffer,
  convertirLienTelechargementDirect,
  telechargerBufferCloudSecurise,
  extraireFichiersArchive,
  genererPiece3D,
  nettoyerSvgSecurise,
  genererPlanSvg,
  refermerBalisesAtelierTronquees,
  lireBufferTelegramSecurise,
  lireMediaSecurise,
  extraireTextePdfBuffer,
  lirePdfSecurise,
  plafonnerTexteDocument,
  formaterDocumentPourNyx,
  lireDocxSecurise,
  lireTexteSecurise,
  createAtelierOutputs
};
