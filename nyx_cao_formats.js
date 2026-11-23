// ==========================================
// MOTEUR CAO 3D AVANCÉ (CSG + .3MF + .STL + OPENSCAD)
// & PARSEURS MULTIFORMATS (.XLSX, .PPTX, .3MF, VIDÉO)
// ==========================================
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const cheerio = require('cheerio');

// ==========================================
// 1. ARCHIVEUR & EXTRACTEUR PKZIP NATIF EN RAM
// ==========================================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function calculerCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function lireEntreesZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return [];
  const minSearch = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries && ptr + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);

    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (uncompressedSize > 60 * 1024 * 1024) continue; // Protection anti-zip-bomb (60 Mo max par entrée)
    if (localHeaderOffset + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const lfNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
    if (dataStart + compressedSize > buffer.length) continue;

    const compSlice = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      let data = null;
      if (compression === 0) {
        data = Buffer.from(compSlice);
      } else if (compression === 8) {
        data = zlib.inflateRawSync(compSlice, { maxOutputLength: 60 * 1024 * 1024 });
      }
      if (data) {
        entries.push({ name, data });
      }
    } catch (e) {}
  }
  return entries;
}

function creerArchiveZipBuffer(fichiers) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const f of fichiers) {
    const nameBuf = Buffer.from(String(f.name), 'utf8');
    const rawBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = calculerCrc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // Deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compBuf.length;
  }

  const centralDirBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fichiers.length, 8);
  eocd.writeUInt16LE(fichiers.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

// ==========================================
// 2. PARSEURS TABLEURS (.XLSX), PRÉSENTATIONS (.PPTX), .3MF & VIDÉO
// ==========================================
function extraireTexteXlsxBuffer(buffer, nomFichier = "classeur.xlsx") {
  const entries = lireEntreesZipBuffer(buffer);
  if (entries.length === 0) {
    throw new Error(`Archive XLSX "${nomFichier}" illisible ou corrompue.`);
  }

  const mapEntries = new Map(entries.map(e => [e.name, e.data]));

  // 1. Table des chaînes partagées (xl/sharedStrings.xml)
  const sharedStrings = [];
  if (mapEntries.has('xl/sharedStrings.xml')) {
    const $ss = cheerio.load(mapEntries.get('xl/sharedStrings.xml').toString('utf8'), { xmlMode: true });
    $ss('si').each((_, el) => {
      const txt = $ss(el).find('t').map((__, tEl) => $ss(tEl).text()).get().join('');
      sharedStrings.push(txt);
    });
  }

  // 2. Noms des onglets (xl/workbook.xml)
  const sheetNames = [];
  if (mapEntries.has('xl/workbook.xml')) {
    const $wb = cheerio.load(mapEntries.get('xl/workbook.xml').toString('utf8'), { xmlMode: true });
    $wb('sheet').each((_, el) => {
      const name = $wb(el).attr('name');
      if (name) sheetNames.push(name);
    });
  }

  // 3. Extraction de chaque feuille (xl/worksheets/sheet*.xml)
  const sheetFiles = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/sheet(\d+)\.xml/i)?.[1] || "0", 10);
      const nb = parseInt(b.name.match(/sheet(\d+)\.xml/i)?.[1] || "0", 10);
      return na - nb;
    });

  if (sheetFiles.length === 0) {
    throw new Error(`Aucune feuille de calcul trouvée dans "${nomFichier}".`);
  }

  const sections = [];
  for (let sIdx = 0; sIdx < sheetFiles.length; sIdx++) {
    const titreOnglet = sheetNames[sIdx] || `Feuille ${sIdx + 1}`;
    const $sh = cheerio.load(sheetFiles[sIdx].data.toString('utf8'), { xmlMode: true });
    const lignesTexte = [];

    $sh('row').each((rIdx, rowEl) => {
      if (rIdx >= 400) return false; // Plafond 400 lignes par onglet pour préserver le contexte
      const cellules = [];
      $sh(rowEl).find('c').each((_, cEl) => {
        const ref = $sh(cEl).attr('r') || "";
        const type = $sh(cEl).attr('t') || "";
        let val = "";
        if (type === 's') {
          const idxStr = parseInt($sh(cEl).find('v').text(), 10);
          val = Number.isFinite(idxStr) && sharedStrings[idxStr] !== undefined ? sharedStrings[idxStr] : "";
        } else if (type === 'inlineStr') {
          val = $sh(cEl).find('t').text();
        } else {
          val = $sh(cEl).find('v').text();
        }
        val = String(val || "").replace(/\s+/g, ' ').trim();
        if (val !== "") {
          cellules.push(ref ? `${ref}: ${val}` : val);
        }
      });
      if (cellules.length > 0) {
        lignesTexte.push(cellules.join(' | '));
      }
    });

    sections.push(`=== ONGLET : ${titreOnglet} (${lignesTexte.length} ligne(s)) ===\n${lignesTexte.join('\n') || "(Feuille vide)"}`);
  }

  return sections.join('\n\n');
}

function extraireTextePptxBuffer(buffer, nomFichier = "presentation.pptx") {
  const entries = lireEntreesZipBuffer(buffer);
  if (entries.length === 0) {
    throw new Error(`Archive PPTX "${nomFichier}" illisible ou corrompue.`);
  }

  const mapEntries = new Map(entries.map(e => [e.name, e.data]));
  const slideFiles = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
      const nb = parseInt(b.name.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
      return na - nb;
    });

  if (slideFiles.length === 0) {
    throw new Error(`Aucune diapositive trouvée dans "${nomFichier}".`);
  }

  const slidesOut = [];
  for (const sf of slideFiles) {
    const numSlide = sf.name.match(/slide(\d+)\.xml/i)?.[1] || "?";
    const $sl = cheerio.load(sf.data.toString('utf8'), { xmlMode: true });
    const paragraphes = [];
    $sl('a\\:p, p').each((_, pEl) => {
      const txt = $sl(pEl).find('a\\:t, t').map((__, tEl) => $sl(tEl).text()).get().join('').trim();
      if (txt) paragraphes.push(txt);
    });

    let notesTxt = "";
    const notePath = `ppt/notesSlides/notesSlide${numSlide}.xml`;
    if (mapEntries.has(notePath)) {
      const $nt = cheerio.load(mapEntries.get(notePath).toString('utf8'), { xmlMode: true });
      const notesList = [];
      $nt('a\\:p, p').each((_, pEl) => {
        const txt = $nt(pEl).find('a\\:t, t').map((__, tEl) => $nt(tEl).text()).get().join('').trim();
        if (txt && !/^\d+$/.test(txt)) notesList.push(txt);
      });
      if (notesList.length > 0) {
        notesTxt = `\n  [Notes présentateur] : ${notesList.join(' ')}`;
      }
    }

    slidesOut.push(`--- Slide ${numSlide} ---\n${paragraphes.join('\n') || "(Diapositive visuelle sans texte)"}${notesTxt}`);
  }

  return slidesOut.join('\n\n');
}

function analyser3mfBuffer(buffer, nomFichier = "modele.3mf") {
  try {
    const entries = lireEntreesZipBuffer(buffer);
    const modelEntry = entries.find(e => /\.model$/i.test(e.name));
    if (!modelEntry) {
      return `Archive 3MF "${nomFichier}" (${(buffer.length / 1024).toFixed(1)} Ko, ${entries.length} entrées).`;
    }

    const $m = cheerio.load(modelEntry.data.toString('utf8'), { xmlMode: true });
    const unit = $m('model').attr('unit') || 'millimeter';
    let vCount = 0;
    let tCount = 0;
    let objCount = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;

    $m('object').each((_, objEl) => {
      objCount++;
      $m(objEl).find('vertex').each((__, vEl) => {
        vCount++;
        const x = parseFloat($m(vEl).attr('x'));
        const y = parseFloat($m(vEl).attr('y'));
        const z = parseFloat($m(vEl).attr('z'));
        if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (Number.isFinite(z)) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
      });
      tCount += $m(objEl).find('triangle').length;
    });

    if (vCount > 0) {
      const dim = `${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} x ${(maxZ - minZ).toFixed(1)} (${unit})`;
      return `Modèle 3D 3MF "${nomFichier}" : ${objCount} objet(s), ${vCount} sommets, ${tCount} triangles | Dimensions : ${dim}.`;
    }
  } catch (e) {}
  return `Fichier 3MF "${nomFichier}" (${buffer.length} octets).`;
}

function estExtensionVideo(nomFichier = "") {
  return /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(String(nomFichier || ""));
}

function detecterMimeVideo(nomFichier = "", fallbackMime = "video/mp4") {
  const n = String(nomFichier || "").toLowerCase();
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.avi')) return 'video/x-msvideo';
  return fallbackMime || 'video/mp4';
}

function analyserVideoMetadataBuffer(buffer, nomFichier = "video.mp4") {
  const tailleMo = (buffer.length / (1024 * 1024)).toFixed(2);
  let dureeSec = null;
  try {
    // Lecture rapide de l'atome MP4/MOV 'mvhd' pour extraire la durée réelle si présente
    const idx = buffer.indexOf(Buffer.from('mvhd'));
    if (idx !== -1 && idx + 24 < buffer.length) {
      const version = buffer[idx + 4];
      if (version === 0 && idx + 24 <= buffer.length) {
        const timescale = buffer.readUInt32BE(idx + 16);
        const duration = buffer.readUInt32BE(idx + 20);
        if (timescale > 0 && duration > 0) {
          dureeSec = Math.round(duration / timescale);
        }
      } else if (version === 1 && idx + 36 <= buffer.length) {
        const timescale = buffer.readUInt32BE(idx + 24);
        const durationHi = buffer.readUInt32BE(idx + 28);
        const durationLo = buffer.readUInt32BE(idx + 32);
        const duration = durationHi * 4294967296 + durationLo;
        if (timescale > 0 && duration > 0) {
          dureeSec = Math.round(duration / timescale);
        }
      }
    }
  } catch (e) {}
  const dureeStr = dureeSec !== null ? ` · durée ~${dureeSec}s` : "";
  return `Vidéo "${nomFichier}" (${tailleMo} Mo${dureeStr})`;
}

// ==========================================
// 3. MOTEUR CSG BOOLÉEN (BSP-TREE PUR JS)
// ==========================================
const CSG_EPSILON = 1e-5;

class CsgVec {
  constructor(x, y, z) {
    this.x = x; this.y = y; this.z = z;
  }
  clone() { return new CsgVec(this.x, this.y, this.z); }
  negated() { return new CsgVec(-this.x, -this.y, -this.z); }
  plus(a) { return new CsgVec(this.x + a.x, this.y + a.y, this.z + a.z); }
  minus(a) { return new CsgVec(this.x - a.x, this.y - a.y, this.z - a.z); }
  times(t) { return new CsgVec(this.x * t, this.y * t, this.z * t); }
  dot(a) { return this.x * a.x + this.y * a.y + this.z * a.z; }
  lerp(a, t) { return this.plus(a.minus(this).times(t)); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  unit() {
    const l = this.length() || 1;
    return new CsgVec(this.x / l, this.y / l, this.z / l);
  }
  cross(a) {
    return new CsgVec(
      this.y * a.z - this.z * a.y,
      this.z * a.x - this.x * a.z,
      this.x * a.y - this.y * a.x
    );
  }
}

class CsgVertex {
  constructor(pos, normal) {
    this.pos = pos;
    this.normal = normal;
  }
  clone() { return new CsgVertex(this.pos.clone(), this.normal.clone()); }
  flip() { this.normal = this.normal.negated(); }
  interpolate(other, t) {
    return new CsgVertex(this.pos.lerp(other.pos, t), this.normal.lerp(other.normal, t).unit());
  }
}

class CsgPlane {
  constructor(normal, w) {
    this.normal = normal;
    this.w = w;
  }
  static fromPoints(a, b, c) {
    const n = b.minus(a).cross(c.minus(a));
    const len = n.length();
    if (len < 1e-10) return null;
    const unitN = n.times(1 / len);
    return new CsgPlane(unitN, unitN.dot(a));
  }
  clone() { return new CsgPlane(this.normal.clone(), this.w); }
  flip() { this.normal = this.normal.negated(); this.w = -this.w; }
  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
    let polygonType = 0;
    const types = [];
    for (let i = 0; i < polygon.vertices.length; i++) {
      const t = this.normal.dot(polygon.vertices[i].pos) - this.w;
      const type = (t < -CSG_EPSILON) ? BACK : (t > CSG_EPSILON) ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f = [], b = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i], tj = types[j];
          const vi = polygon.vertices[i], vj = polygon.vertices[j];
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
          if ((ti | tj) === SPANNING) {
            const t = (this.w - this.normal.dot(vi.pos)) / this.normal.dot(vj.pos.minus(vi.pos));
            const v = vi.interpolate(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) front.push(new CsgPolygon(f));
        if (b.length >= 3) back.push(new CsgPolygon(b));
        break;
      }
    }
  }
}

class CsgPolygon {
  constructor(vertices) {
    this.vertices = vertices;
    this.plane = CsgPlane.fromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos);
  }
  clone() { return new CsgPolygon(this.vertices.map(v => v.clone())); }
  flip() {
    this.vertices.reverse().forEach(v => v.flip());
    if (this.plane) this.plane.flip();
  }
}

class CsgNode {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }
  clone() {
    const node = new CsgNode();
    node.plane = this.plane && this.plane.clone();
    node.front = this.front && this.front.clone();
    node.back = this.back && this.back.clone();
    node.polygons = this.polygons.map(p => p.clone());
    return node;
  }
  invert() {
    for (let i = 0; i < this.polygons.length; i++) this.polygons[i].flip();
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const temp = this.front;
    this.front = this.back;
    this.back = temp;
  }
  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [], back = [];
    for (let i = 0; i < polygons.length; i++) {
      this.plane.splitPolygon(polygons[i], front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back = [];
    return front.concat(back);
  }
  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }
  allPolygons() {
    let polygons = this.polygons.slice();
    if (this.front) polygons = polygons.concat(this.front.allPolygons());
    if (this.back) polygons = polygons.concat(this.back.allPolygons());
    return polygons;
  }
  build(polygons, depth = 0) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();
    if (depth > 85) {
      this.polygons = this.polygons.concat(polygons);
      return;
    }
    const front = [], back = [];
    for (let i = 0; i < polygons.length; i++) {
      this.plane.splitPolygon(polygons[i], this.polygons, this.polygons, front, back);
    }
    if (front.length) {
      if (!this.front) this.front = new CsgNode();
      this.front.build(front, depth + 1);
    }
    if (back.length) {
      if (!this.back) this.back = new CsgNode();
      this.back.build(back, depth + 1);
    }
  }
}

function trianglesToCsgPolygons(tris) {
  const polys = [];
  for (const [a, b, c] of tris) {
    const va = new CsgVec(a[0], a[1], a[2]);
    const vb = new CsgVec(b[0], b[1], b[2]);
    const vc = new CsgVec(c[0], c[1], c[2]);
    const plane = CsgPlane.fromPoints(va, vb, vc);
    if (!plane) continue;
    polys.push(new CsgPolygon([
      new CsgVertex(va, plane.normal),
      new CsgVertex(vb, plane.normal),
      new CsgVertex(vc, plane.normal)
    ]));
  }
  return polys;
}

function csgPolygonsToTriangles(polys) {
  const tris = [];
  for (const p of polys) {
    const verts = p.vertices;
    for (let i = 2; i < verts.length; i++) {
      tris.push([
        [verts[0].pos.x, verts[0].pos.y, verts[0].pos.z],
        [verts[i - 1].pos.x, verts[i - 1].pos.y, verts[i - 1].pos.z],
        [verts[i].pos.x, verts[i].pos.y, verts[i].pos.z]
      ]);
    }
  }
  return tris;
}

function appliquerOperationCsg(trisA, trisB, operation = "union") {
  const a = new CsgNode(trianglesToCsgPolygons(trisA));
  const b = new CsgNode(trianglesToCsgPolygons(trisB));

  if (operation === "subtract" || operation === "difference") {
    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
  } else if (operation === "intersect" || operation === "intersection") {
    a.invert();
    b.clipTo(a);
    b.invert();
    a.clipTo(b);
    b.clipTo(a);
    a.build(b.allPolygons());
    a.invert();
  } else {
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
  }

  return csgPolygonsToTriangles(a.allPolygons());
}

// ==========================================
// 4. GÉNÉRATEUR DE PRIMITIVES ÉTENDU (12 PRIMITIVES)
// ==========================================
function triangulerPolygone2D(points) {
  const pts = points.map(p => [Number(p[0]) || 0, Number(p[1]) || 0]);
  if (pts.length < 3) return [];
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
  if (indices.length === 3) tris.push([pts[indices[0]], pts[indices[1]], pts[indices[2]]]);
  return tris;
}

function genererTrianglesPrimitive(p, maxSegCsg = 48) {
  const localTris = [];
  const pushLocalTri = (a, b, c) => localTris.push([a, b, c]);
  const pushLocalQuad = (a, b, c, d) => { pushLocalTri(a, b, c); pushLocalTri(a, c, d); };
  const type = String(p.type || "box").toLowerCase();

  if (type === "box") {
    const w = Math.max(0.5, Number(p.w) || 10), d = Math.max(0.5, Number(p.d) || 10), h = Math.max(0.5, Number(p.h) || 10);
    const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h / 2, z1 = h / 2;
    pushLocalQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
    pushLocalQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    pushLocalQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    pushLocalQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    pushLocalQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    pushLocalQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  } else if (type === "chamfer_box" || type === "bevel_box") {
    const w = Math.max(2, Number(p.w) || 20), d = Math.max(2, Number(p.d) || 20), h = Math.max(2, Number(p.h) || 12);
    const ch = Math.min(Math.min(w, d, h) * 0.3, Math.max(0.4, Number(p.chamfer ?? p.bevel) || 1.5));
    const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h / 2, z1 = h / 2;
    const ix0 = x0 + ch, ix1 = x1 - ch, iy0 = y0 + ch, iy1 = y1 - ch, iz0 = z0 + ch, iz1 = z1 - ch;
    // Top & bottom inset faces
    pushLocalQuad([ix0, iy1, z0], [ix1, iy1, z0], [ix1, iy0, z0], [ix0, iy0, z0]);
    pushLocalQuad([ix0, iy0, z1], [ix1, iy0, z1], [ix1, iy1, z1], [ix0, iy1, z1]);
    // 4 main side walls
    pushLocalQuad([ix0, y0, iz0], [ix1, y0, iz0], [ix1, y0, iz1], [ix0, y0, iz1]);
    pushLocalQuad([ix1, y1, iz0], [ix0, y1, iz0], [ix0, y1, iz1], [ix1, y1, iz1]);
    pushLocalQuad([x0, iy1, iz0], [x0, iy0, iz0], [x0, iy0, iz1], [x0, iy1, iz1]);
    pushLocalQuad([x1, iy0, iz0], [x1, iy1, iz0], [x1, iy1, iz1], [x1, iy0, iz1]);
    // 4 vertical corner chamfers
    pushLocalQuad([x0, iy0, iz0], [ix0, y0, iz0], [ix0, y0, iz1], [x0, iy0, iz1]);
    pushLocalQuad([ix1, y0, iz0], [x1, iy0, iz0], [x1, iy0, iz1], [ix1, y0, iz1]);
    pushLocalQuad([x1, iy1, iz0], [ix1, y1, iz0], [ix1, y1, iz1], [x1, iy1, iz1]);
    pushLocalQuad([ix0, y1, iz0], [x0, iy1, iz0], [x0, iy1, iz1], [ix0, y1, iz1]);
    // 4 top edge chamfers
    pushLocalQuad([ix0, y0, iz1], [ix1, y0, iz1], [ix1, iy0, z1], [ix0, iy0, z1]);
    pushLocalQuad([ix1, y1, iz1], [ix0, y1, iz1], [ix0, iy1, z1], [ix1, iy1, z1]);
    pushLocalQuad([x0, iy1, iz1], [x0, iy0, iz1], [ix0, iy0, z1], [ix0, iy1, z1]);
    pushLocalQuad([x1, iy0, iz1], [x1, iy1, iz1], [ix1, iy1, z1], [ix1, iy0, z1]);
    // 4 bottom edge chamfers
    pushLocalQuad([ix1, y0, iz0], [ix0, y0, iz0], [ix0, iy0, z0], [ix1, iy0, z0]);
    pushLocalQuad([ix0, y1, iz0], [ix1, y1, iz0], [ix1, iy1, z0], [ix0, iy1, z0]);
    pushLocalQuad([x0, iy0, iz0], [x0, iy1, iz0], [ix0, iy1, z0], [ix0, iy0, z0]);
    pushLocalQuad([x1, iy1, iz0], [x1, iy0, iz0], [ix1, iy0, z0], [ix1, iy1, z0]);
    // 8 corner triangles
    pushLocalTri([x0, iy0, iz1], [ix0, y0, iz1], [ix0, iy0, z1]);
    pushLocalTri([ix1, y0, iz1], [x1, iy0, iz1], [ix1, iy0, z1]);
    pushLocalTri([x1, iy1, iz1], [ix1, y1, iz1], [ix1, iy1, z1]);
    pushLocalTri([ix0, y1, iz1], [x0, iy1, iz1], [ix0, iy1, z1]);
    pushLocalTri([ix0, y0, iz0], [x0, iy0, iz0], [ix0, iy0, z0]);
    pushLocalTri([x1, iy0, iz0], [ix1, y0, iz0], [ix1, iy0, z0]);
    pushLocalTri([ix1, y1, iz0], [x1, iy1, iz0], [ix1, iy1, z0]);
    pushLocalTri([x0, iy1, iz0], [ix0, y1, iz0], [ix0, iy1, z0]);
  } else if (type === "hollow_box" || type === "enclosure") {
    const w = Math.max(3, Number(p.w) || 20), d = Math.max(3, Number(p.d) || 20), h = Math.max(3, Number(p.h) || 12);
    const wall = Math.min(Math.min(w, d) * 0.4, Math.max(0.8, Number(p.wall) || 2));
    const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = -h / 2, z1 = h / 2;
    const ix0 = x0 + wall, ix1 = x1 - wall, iy0 = y0 + wall, iy1 = y1 - wall, iz0 = z0 + wall;
    pushLocalQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
    pushLocalQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    pushLocalQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    pushLocalQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    pushLocalQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    pushLocalQuad([ix0, iy0, iz0], [ix1, iy0, iz0], [ix1, iy1, iz0], [ix0, iy1, iz0]);
    pushLocalQuad([ix1, iy0, iz0], [ix0, iy0, iz0], [ix0, iy0, z1], [ix1, iy0, z1]);
    pushLocalQuad([ix0, iy1, iz0], [ix1, iy1, iz0], [ix1, iy1, z1], [ix0, iy1, z1]);
    pushLocalQuad([ix0, iy0, iz0], [ix0, iy1, iz0], [ix0, iy1, z1], [ix0, iy0, z1]);
    pushLocalQuad([ix1, iy1, iz0], [ix1, iy0, iz0], [ix1, iy0, z1], [ix1, iy1, z1]);
    pushLocalQuad([x0, y0, z1], [x1, y0, z1], [ix1, iy0, z1], [ix0, iy0, z1]);
    pushLocalQuad([x1, y1, z1], [x0, y1, z1], [ix0, iy1, z1], [ix1, iy1, z1]);
    pushLocalQuad([x0, y1, z1], [x0, y0, z1], [ix0, iy0, z1], [ix0, iy1, z1]);
    pushLocalQuad([x1, y0, z1], [x1, y1, z1], [ix1, iy1, z1], [ix1, iy0, z1]);
  } else if (type === "cylinder" || type === "cone") {
    const r1 = Math.max(0.2, Number(p.r1 ?? p.r) || 8);
    const r2 = type === "cone" ? Math.max(0, Number(p.r2) || 0) : Math.max(0.2, Number(p.r2 ?? p.r) || r1);
    const h = Math.max(0.5, Number(p.h) || 15);
    const seg = Math.max(10, Math.min(maxSegCsg, Math.round(Number(p.segments) || 28)));
    const z0 = -h / 2, z1 = h / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const b0 = [Math.cos(a0) * r1, Math.sin(a0) * r1, z0], b1 = [Math.cos(a1) * r1, Math.sin(a1) * r1, z0];
      const t0 = [Math.cos(a0) * r2, Math.sin(a0) * r2, z1], t1 = [Math.cos(a1) * r2, Math.sin(a1) * r2, z1];
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
    const seg = Math.max(10, Math.min(maxSegCsg, Math.round(Number(p.segments) || 28)));
    const z0 = -h / 2, z1 = h / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const ob0 = [Math.cos(a0) * rOut, Math.sin(a0) * rOut, z0], ob1 = [Math.cos(a1) * rOut, Math.sin(a1) * rOut, z0];
      const ot0 = [Math.cos(a0) * rOut, Math.sin(a0) * rOut, z1], ot1 = [Math.cos(a1) * rOut, Math.sin(a1) * rOut, z1];
      const ib0 = [Math.cos(a0) * rIn, Math.sin(a0) * rIn, z0], ib1 = [Math.cos(a1) * rIn, Math.sin(a1) * rIn, z0];
      const it0 = [Math.cos(a0) * rIn, Math.sin(a0) * rIn, z1], it1 = [Math.cos(a1) * rIn, Math.sin(a1) * rIn, z1];
      pushLocalQuad(ob0, ob1, ot1, ot0);
      pushLocalQuad(ib1, ib0, it0, it1);
      pushLocalQuad(ot0, ot1, it1, it0);
      pushLocalQuad(ib0, ib1, ob1, ob0);
    }
  } else if (type === "sphere" || type === "dome") {
    const r = Math.max(0.5, Number(p.r) || 10);
    const seg = Math.max(10, Math.min(maxSegCsg, Math.round(Number(p.segments) || 20)));
    const rings = type === "dome" ? Math.max(5, Math.round(seg / 4)) : Math.max(8, Math.round(seg / 2));
    const maxPhi = type === "dome" ? Math.PI / 2 : Math.PI;
    for (let i = 0; i < rings; i++) {
      const phi0 = (i / rings) * maxPhi, phi1 = ((i + 1) / rings) * maxPhi;
      for (let j = 0; j < seg; j++) {
        const th0 = (j / seg) * Math.PI * 2, th1 = ((j + 1) / seg) * Math.PI * 2;
        const pt = (ph, th) => [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)];
        const p00 = pt(phi0, th0), p10 = pt(phi1, th0), p11 = pt(phi1, th1), p01 = pt(phi0, th1);
        if (i > 0) pushLocalTri(p00, p10, p01);
        if (i < rings - 1 || type === "dome") pushLocalTri(p10, p11, p01);
        if (type === "dome" && i === rings - 1) {
          pushLocalTri([0, 0, 0], p11, p10);
        }
      }
    }
  } else if (type === "torus") {
    const rMajor = Math.max(2, Number(p.rMajor ?? p.R ?? p.r) || 12);
    const rMinor = Math.max(0.4, Number(p.rMinor ?? p.tube) || 3);
    const segMajor = Math.max(12, Math.min(maxSegCsg, Math.round(Number(p.segments) || 28)));
    const segMinor = Math.max(8, Math.min(24, Math.round(Number(p.tubeSegments) || 14)));
    for (let i = 0; i < segMajor; i++) {
      const u0 = (i / segMajor) * Math.PI * 2, u1 = ((i + 1) / segMajor) * Math.PI * 2;
      for (let j = 0; j < segMinor; j++) {
        const v0 = (j / segMinor) * Math.PI * 2, v1 = ((j + 1) / segMinor) * Math.PI * 2;
        const pt = (u, v) => [
          (rMajor + rMinor * Math.cos(v)) * Math.cos(u),
          (rMajor + rMinor * Math.cos(v)) * Math.sin(u),
          rMinor * Math.sin(v)
        ];
        pushLocalQuad(pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1));
      }
    }
  } else if (type === "revolution" && Array.isArray(p.profile) && p.profile.length >= 2) {
    const seg = Math.max(12, Math.min(maxSegCsg, Math.round(Number(p.segments) || 28)));
    const prof = p.profile.map(pt => [Math.max(0, Number(pt[0]) || 0), Number(pt[1]) || 0]);
    for (let k = 0; k < prof.length - 1; k++) {
      const [r0, z0] = prof[k], [r1, z1] = prof[k + 1];
      if (r0 < 1e-4 && r1 < 1e-4) continue;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const p00 = [Math.cos(a0) * r0, Math.sin(a0) * r0, z0];
        const p10 = [Math.cos(a1) * r0, Math.sin(a1) * r0, z0];
        const p11 = [Math.cos(a1) * r1, Math.sin(a1) * r1, z1];
        const p01 = [Math.cos(a0) * r1, Math.sin(a0) * r1, z1];
        if (r0 < 1e-4) pushLocalTri(p00, p11, p01);
        else if (r1 < 1e-4) pushLocalTri(p00, p10, p01);
        else pushLocalQuad(p00, p10, p11, p01);
      }
    }
    const [rBot, zBot] = prof[0];
    if (rBot > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        pushLocalTri([0, 0, zBot], [Math.cos(a1) * rBot, Math.sin(a1) * rBot, zBot], [Math.cos(a0) * rBot, Math.sin(a0) * rBot, zBot]);
      }
    }
    const [rTop, zTop] = prof[prof.length - 1];
    if (rTop > 1e-4) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        pushLocalTri([0, 0, zTop], [Math.cos(a0) * rTop, Math.sin(a0) * rTop, zTop], [Math.cos(a1) * rTop, Math.sin(a1) * rTop, zTop]);
      }
    }
  } else if (type === "gear") {
    const teeth = Math.max(6, Math.min(60, Math.round(Number(p.teeth) || 16)));
    const rOuter = Math.max(4, Number(p.rOuter ?? p.r) || 18);
    const toothDepth = Math.max(0.8, Number(p.toothDepth) || (rOuter * 2.2) / teeth);
    const rRoot = Math.max(2, rOuter - toothDepth);
    const rBore = Math.max(0, Math.min(rRoot - 1.2, Number(p.rInner ?? p.bore) || 0));
    const h = Math.max(1, Number(p.h) || 6);
    const z0 = -h / 2, z1 = h / 2;

    const ringOuter = [];
    for (let i = 0; i < teeth; i++) {
      const base = (i / teeth) * Math.PI * 2;
      const step = (Math.PI * 2) / teeth;
      const angles = [
        [base, rRoot],
        [base + step * 0.18, rRoot],
        [base + step * 0.28, rOuter],
        [base + step * 0.52, rOuter],
        [base + step * 0.62, rRoot]
      ];
      for (const [ang, rad] of angles) {
        ringOuter.push([Math.cos(ang) * rad, Math.sin(ang) * rad]);
      }
    }

    const n = ringOuter.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = ringOuter[i], b = ringOuter[j];
      pushLocalQuad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
      if (rBore > 0.2) {
        const angA = Math.atan2(a[1], a[0]), angB = Math.atan2(b[1], b[0]);
        const ia = [Math.cos(angA) * rBore, Math.sin(angA) * rBore];
        const ib = [Math.cos(angB) * rBore, Math.sin(angB) * rBore];
        pushLocalQuad([ib[0], ib[1], z0], [ia[0], ia[1], z0], [ia[0], ia[1], z1], [ib[0], ib[1], z1]);
        pushLocalQuad([ia[0], ia[1], z1], [ib[0], ib[1], z1], [b[0], b[1], z1], [a[0], a[1], z1]);
        pushLocalQuad([a[0], a[1], z0], [b[0], b[1], z0], [ib[0], ib[1], z0], [ia[0], ia[1], z0]);
      } else {
        pushLocalTri([0, 0, z1], [a[0], a[1], z1], [b[0], b[1], z1]);
        pushLocalTri([0, 0, z0], [b[0], b[1], z0], [a[0], a[1], z0]);
      }
    }
  } else if (type === "thread" || type === "screw") {
    const rMajor = Math.max(1.5, Number(p.rMajor ?? p.r) || 6);
    const pitch = Math.max(0.5, Number(p.pitch) || 1.5);
    const rMinor = Math.max(0.8, Number(p.rMinor) || (rMajor - pitch * 0.55));
    const h = Math.max(2, Number(p.h) || 16);
    const seg = Math.max(12, Math.min(32, Math.round(Number(p.segments) || 20)));
    const turns = h / pitch;
    const zSteps = Math.max(8, Math.min(80, Math.round(turns * 6)));
    const z0 = -h / 2, z1 = h / 2;

    const radiusAt = (ang, z) => {
      const phase = ((z - z0) / pitch - ang / (Math.PI * 2)) % 1;
      const norm = phase < 0 ? phase + 1 : phase;
      const triWave = 1 - Math.abs(2 * norm - 1);
      return rMinor + (rMajor - rMinor) * triWave;
    };

    for (let k = 0; k < zSteps; k++) {
      const za = z0 + (k / zSteps) * h, zb = z0 + ((k + 1) / zSteps) * h;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const r00 = radiusAt(a0, za), r10 = radiusAt(a1, za);
        const r11 = radiusAt(a1, zb), r01 = radiusAt(a0, zb);
        pushLocalQuad(
          [Math.cos(a0) * r00, Math.sin(a0) * r00, za],
          [Math.cos(a1) * r10, Math.sin(a1) * r10, za],
          [Math.cos(a1) * r11, Math.sin(a1) * r11, zb],
          [Math.cos(a0) * r01, Math.sin(a0) * r01, zb]
        );
      }
    }
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const rb0 = radiusAt(a0, z0), rb1 = radiusAt(a1, z0);
      const rt0 = radiusAt(a0, z1), rt1 = radiusAt(a1, z1);
      pushLocalTri([0, 0, z0], [Math.cos(a1) * rb1, Math.sin(a1) * rb1, z0], [Math.cos(a0) * rb0, Math.sin(a0) * rb0, z0]);
      pushLocalTri([0, 0, z1], [Math.cos(a0) * rt0, Math.sin(a0) * rt0, z1], [Math.cos(a1) * rt1, Math.sin(a1) * rt1, z1]);
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
      pushLocalQuad([pts[i][0], pts[i][1], z0], [pts[j][0], pts[j][1], z0], [pts[j][0], pts[j][1], z1], [pts[i][0], pts[i][1], z1]);
    }
  }

  const [sx, sy, sz] = Array.isArray(p.scale) ? p.scale.map(v => Number(v) || 1) : [1, 1, 1];
  const [rx, ry, rz] = Array.isArray(p.rot) ? p.rot.map(v => ((Number(v) || 0) * Math.PI) / 180) : [0, 0, 0];
  const [tx, ty, tz] = Array.isArray(p.pos) ? p.pos.map(v => Number(v) || 0) : [0, 0, 0];
  const cx = Math.cos(rx), sxr = Math.sin(rx), cy = Math.cos(ry), syr = Math.sin(ry), cz = Math.cos(rz), szr = Math.sin(rz);

  const transformerPoint = (pt, invertX = false) => {
    let x = pt[0] * sx, y = pt[1] * sy, z = pt[2] * sz;
    let y1 = y * cx - z * sxr, z1 = y * sxr + z * cx;
    let x2 = x * cy + z1 * syr, z2 = -x * syr + z1 * cy;
    let x3 = x2 * cz - y1 * szr, y3 = x2 * szr + y1 * cz;
    return [invertX ? -(x3 + tx) : (x3 + tx), y3 + ty, z2 + tz];
  };

  const outTris = [];
  for (const [v1, v2, v3] of localTris) {
    outTris.push([transformerPoint(v1, false), transformerPoint(v2, false), transformerPoint(v3, false)]);
    if (p.mirrorX) {
      outTris.push([transformerPoint(v1, true), transformerPoint(v3, true), transformerPoint(v2, true)]);
    }
  }
  return outTris;
}

// ==========================================
// 5. COMPILATION STL BINAIRE + .3MF NATIF + OPENSCAD CLI
// ==========================================
function construireBuffersStlEt3mf(triangles, nomModele = "Piece Nyx") {
  let minZ = Infinity;
  for (const tri of triangles) {
    for (const v of tri) if (v[2] < minZ) minZ = v[2];
  }
  const offsetZ = Number.isFinite(minZ) ? -minZ : 0;

  // 1. STL Binaire
  const stlBuffer = Buffer.alloc(84 + triangles.length * 50);
  stlBuffer.write("Nyx Workshop Binary STL - Parametric CSG CAD", 0, 80, "ascii");
  stlBuffer.writeUInt32LE(triangles.length, 80);

  // 2. Déduplication des sommets pour un maillage .3mf propre et compact
  const vertices = [];
  const vertexMap = new Map();
  const indexedTris = [];

  const getVertexIndex = (v) => {
    const x = Math.round(v[0] * 10000) / 10000;
    const y = Math.round(v[1] * 10000) / 10000;
    const z = Math.round((v[2] + offsetZ) * 10000) / 10000;
    const key = `${x},${y},${z}`;
    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push([x, y, z]);
      vertexMap.set(key, idx);
    }
    return idx;
  };

  let offset = 84;
  for (const [a, b, c] of triangles) {
    const va = [a[0], a[1], a[2] + offsetZ];
    const vb = [b[0], b[1], b[2] + offsetZ];
    const vc = [c[0], c[1], c[2] + offsetZ];
    const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
    const vx = vc[0] - va[0], vy = vc[1] - va[1], vz = vc[2] - va[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    stlBuffer.writeFloatLE(nx, offset);
    stlBuffer.writeFloatLE(ny, offset + 4);
    stlBuffer.writeFloatLE(nz, offset + 8);
    stlBuffer.writeFloatLE(va[0], offset + 12);
    stlBuffer.writeFloatLE(va[1], offset + 16);
    stlBuffer.writeFloatLE(va[2], offset + 20);
    stlBuffer.writeFloatLE(vb[0], offset + 24);
    stlBuffer.writeFloatLE(vb[1], offset + 28);
    stlBuffer.writeFloatLE(vb[2], offset + 32);
    stlBuffer.writeFloatLE(vc[0], offset + 36);
    stlBuffer.writeFloatLE(vc[1], offset + 40);
    stlBuffer.writeFloatLE(vc[2], offset + 44);
    stlBuffer.writeUInt16LE(0, offset + 48);
    offset += 50;

    const i1 = getVertexIndex(a);
    const i2 = getVertexIndex(b);
    const i3 = getVertexIndex(c);
    if (i1 !== i2 && i2 !== i3 && i1 !== i3) {
      indexedTris.push([i1, i2, i3]);
    }
  }

  // 3. Génération du XML 3MF Core Spec 1.2.3
  const xmlVertices = vertices.map(v => `          <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}" />`).join('\n');
  const xmlTriangles = indexedTris.map(t => `          <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}" />`).join('\n');
  const safeName = String(nomModele || "Piece Nyx").replace(/[<>&"']/g, '');

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="fr-FR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${safeName}</metadata>
  <metadata name="Designer">Nyx Atelier CAO</metadata>
  <resources>
    <object id="1" type="model" name="${safeName}">
      <mesh>
        <vertices>
${xmlVertices}
        </vertices>
        <triangles>
${xmlTriangles}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const threemfBuffer = creerArchiveZipBuffer([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: relsXml },
    { name: '3D/3dmodel.model', data: modelXml }
  ]);

  return { stlBuffer, threemfBuffer, triangleCount: triangles.length };
}

function compilerSpecAvecCsg(spec) {
  const pieces = Array.isArray(spec?.pieces) && spec.pieces.length > 0
    ? spec.pieces
    : [{ type: "box", w: 30, d: 20, h: 10, pos: [0, 0, 0] }];

  const aDesOperationsCsg = pieces.some(p => {
    const op = String(p.op || "union").toLowerCase();
    return op === "subtract" || op === "difference" || op === "intersect" || op === "intersection";
  });

  const maxSeg = aDesOperationsCsg ? 22 : 44;
  let trianglesCourants = [];

  for (const p of pieces) {
    const op = String(p.op || "union").toLowerCase();
    const trisPiece = genererTrianglesPrimitive(p, maxSeg);
    if (trisPiece.length === 0) continue;

    if (trianglesCourants.length === 0) {
      trianglesCourants = trisPiece;
      continue;
    }

    if (op === "subtract" || op === "difference") {
      if (trianglesCourants.length + trisPiece.length <= 16000) {
        trianglesCourants = appliquerOperationCsg(trianglesCourants, trisPiece, "subtract");
      }
    } else if (op === "intersect" || op === "intersection") {
      if (trianglesCourants.length + trisPiece.length <= 16000) {
        trianglesCourants = appliquerOperationCsg(trianglesCourants, trisPiece, "intersect");
      }
    } else if (op === "csg_union") {
      if (trianglesCourants.length + trisPiece.length <= 16000) {
        trianglesCourants = appliquerOperationCsg(trianglesCourants, trisPiece, "union");
      } else {
        trianglesCourants = trianglesCourants.concat(trisPiece);
      }
    } else {
      trianglesCourants = trianglesCourants.concat(trisPiece);
    }
  }

  return construireBuffersStlEt3mf(trianglesCourants, spec?.nom_fichier || "Piece Nyx");
}

function tenterCompilationOpenScadCli(scadCode, nomBase) {
  if (!scadCode || String(scadCode).trim().length < 15) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx_scad_'));
  const scadPath = path.join(tmpDir, `${nomBase}.scad`);
  const stlPath = path.join(tmpDir, `${nomBase}.stl`);
  const threemfPath = path.join(tmpDir, `${nomBase}.3mf`);

  try {
    fs.writeFileSync(scadPath, String(scadCode), 'utf8');
    execFileSync('openscad', ['-o', stlPath, scadPath], { timeout: 15000, stdio: 'ignore' });
    if (!fs.existsSync(stlPath)) return null;
    const stlBuffer = fs.readFileSync(stlPath);
    if (stlBuffer.length < 84) return null;

    let threemfBuffer = null;
    try {
      execFileSync('openscad', ['-o', threemfPath, scadPath], { timeout: 15000, stdio: 'ignore' });
      if (fs.existsSync(threemfPath)) threemfBuffer = fs.readFileSync(threemfPath);
    } catch (e3mf) {}

    const triangleCount = stlBuffer.length >= 84 ? stlBuffer.readUInt32LE(80) : 0;
    return { stlBuffer, threemfBuffer, triangleCount, moteur: "openscad_cli" };
  } catch (e) {
    return null; // OpenSCAD CLI absent sur le conteneur -> bascule transparente sur CSG interne
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (eClean) {}
  }
}

async function genererPiece3DAvancee(description, contexteProjet = "", appelerLlm = null) {
  const promptCad = `Tu es le moteur CAO paramétrique de Nyx. Transforme cette demande de pièce 3D en un assemblage géométrique exact (en millimètres) ET son script OpenSCAD.

DEMANDE : "${description}"
${contexteProjet ? `CONTEXTE PROJET : ${contexteProjet}` : ""}

PRIMITIVES SUPPORTÉES DANS "pieces" :
- {"type": "box", "w": X, "d": Y, "h": Z, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "chamfer_box", "w": X, "d": Y, "h": Z, "chamfer": 1.5, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "hollow_box", "w": X, "d": Y, "h": Z, "wall": 2, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "cylinder", "r1": R1, "r2": R2, "h": Z, "segments": 24, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union|subtract|intersect"}
- {"type": "cone", "r1": R1, "r2": 0, "h": Z, "segments": 24, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union|subtract"}
- {"type": "tube", "rOuter": RO, "rInner": RI, "h": Z, "segments": 24, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "sphere", "r": R, "segments": 20, "pos": [x,y,z], "op": "union|subtract"}
- {"type": "dome", "r": R, "segments": 20, "pos": [x,y,z], "op": "union"}
- {"type": "torus", "rMajor": RM, "rMinor": rm, "segments": 24, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "revolution", "profile": [[r0,z0],[r1,z1],...], "segments": 24, "pos": [x,y,z], "op": "union"}
- {"type": "gear", "teeth": 16, "rOuter": RO, "rInner": RI, "h": Z, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union"}
- {"type": "thread", "rMajor": RM, "rMinor": rm, "pitch": 1.5, "h": Z, "pos": [x,y,z], "op": "union|subtract"}
- {"type": "extrude_poly", "points": [[x1,y1],[x2,y2],...], "h": Z, "pos": [x,y,z], "rot": [rx,ry,rz], "op": "union|subtract"}

OPÉRATIONS BOOLÉENNES CSG RÉELLES :
- Utilise "op": "subtract" sur les pièces de perçage (cylindres traversants, encoches, logements d'écrous) : le moteur CSG creuse réellement la matière !
- Utilise "op": "intersect" pour sculpter des intersections de volumes.
- Réponds STRICTEMENT avec un JSON valide sans balises markdown :
{"nom_fichier": "nom_sans_extension", "projet": "nom_projet_court", "resume": "Description technique courte et cotes", "pieces": [...], "openscad": "// Code OpenSCAD complet"}`;

  let brut = "";
  if (typeof appelerLlm === 'function') {
    brut = await appelerLlm("Compilateur CAO CSG & OpenSCAD.", promptCad, 0.2, 2400);
  }

  const matchJson = String(brut || "").match(/\{[\s\S]*\}/);
  let spec = {
    nom_fichier: `nyx_piece_${Date.now()}`,
    projet: "atelier_3d",
    resume: description.slice(0, 120),
    pieces: [{ type: "chamfer_box", w: 30, d: 20, h: 12, chamfer: 1.5, pos: [0, 0, 0] }],
    openscad: ""
  };
  if (matchJson) {
    try { spec = { ...spec, ...JSON.parse(matchJson[0]) }; } catch (eParse) {}
  }

  const nomBase = String(spec.nom_fichier || `nyx_piece_${Date.now()}`)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || `nyx_piece_${Date.now()}`;

  const projetSlug = String(spec.projet || "atelier_3d")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "atelier_3d";

  // 1. Tente d'abord le binaire OpenSCAD CLI s'il est présent sur le serveur, sinon moteur CSG interne
  const cliResult = tenterCompilationOpenScadCli(spec.openscad, nomBase);
  const csgResult = compilerSpecAvecCsg(spec);

  const stlBuffer = cliResult ? cliResult.stlBuffer : csgResult.stlBuffer;
  const threemfBuffer = (cliResult && cliResult.threemfBuffer) ? cliResult.threemfBuffer : csgResult.threemfBuffer;
  const triangleCount = cliResult ? cliResult.triangleCount : csgResult.triangleCount;
  const moteurTag = cliResult ? "OpenSCAD" : "CSG";

  const scadBuffer = spec.openscad && String(spec.openscad).trim().length > 10
    ? Buffer.from(String(spec.openscad).trim(), "utf8")
    : null;

  return {
    nomBase,
    projet: projetSlug,
    resume: `${spec.resume} (${triangleCount} triangles · ${moteurTag} · STL + 3MF)`,
    stlBuffer,
    threemfBuffer,
    scadBuffer,
    triangleCount
  };
}

module.exports = {
  lireEntreesZipBuffer,
  creerArchiveZipBuffer,
  extraireTexteXlsxBuffer,
  extraireTextePptxBuffer,
  analyser3mfBuffer,
  estExtensionVideo,
  detecterMimeVideo,
  analyserVideoMetadataBuffer,
  appliquerOperationCsg,
  compilerSpecAvecCsg,
  genererPiece3DAvancee
};
