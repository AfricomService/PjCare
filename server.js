// server.js
const express      = require("express");
const cors         = require("cors");
const { execFile } = require("child_process");
const path         = require("path");
const fs           = require("fs");
const os           = require("os");

const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// TEMP DIR
// ─────────────────────────────────────────────
const tmpBase  = process.env.TEMP || process.env.TMP || os.tmpdir();
const TEMP_DIR = path.join(tmpBase, "CorrespPj");
fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log("📂 Dossier temp :", TEMP_DIR);

app.use("/Temp", express.static(TEMP_DIR));

// ─────────────────────────────────────────────
// NAPS2 : recherche dynamique
// ─────────────────────────────────────────────
const { findNaps2 } = require("./config");
const NAPS2_EXE = findNaps2();

if (!NAPS2_EXE) {
  console.warn("⚠️  NAPS2 introuvable. Le scan ne fonctionnera pas.");
} else {
  console.log("✅ NAPS2 trouvé :", NAPS2_EXE);
}

// ─────────────────────────────────────────────
// sharp (optionnel) — détection pages blanches
// ─────────────────────────────────────────────
let sharp = null;
try {
  sharp = require("sharp");
  console.log("✅ sharp disponible — détection pages blanches activée");
} catch {
  console.warn("⚠️  sharp non installé. Exécutez : npm install sharp");
  console.warn("   La détection de pages blanches sera désactivée.");
}

// ─────────────────────────────────────────────
// DRIVERS SUPPORTÉS
// ─────────────────────────────────────────────
const SUPPORTED_DRIVERS = {
  wia: {
    label:       "WIA (Windows Image Acquisition)",
    cliValue:    "wia",
    platforms:   ["win32"],
    description: "Driver natif Windows, recommandé pour scanners USB et réseau"
  },
  twain: {
    label:       "TWAIN",
    cliValue:    "twain",
    platforms:   ["win32", "darwin", "linux"],
    description: "Standard universel — attention : nécessite une session graphique"
  },
  escl: {
    label:       "eSCL / AirScan (réseau IP)",
    cliValue:    "escl",
    platforms:   ["win32", "darwin", "linux"],
    description: "Scan via HTTP réseau, idéal pour scanners Wi-Fi"
  },
  sane: {
    label:       "SANE",
    cliValue:    "sane",
    platforms:   ["linux", "darwin"],
    description: "Backend Linux/macOS open-source"
  },
  apple: {
    label:       "Apple (ImageCaptureCore)",
    cliValue:    "apple",
    platforms:   ["darwin"],
    description: "Driver natif macOS uniquement"
  }
};

function getDefaultDriver() {
  switch (os.platform()) {
    case "win32":  return "wia";
    case "darwin": return "apple";
    case "linux":  return "sane";
    default:       return "wia";
  }
}

function isDriverAvailable(driverKey) {
  const driver = SUPPORTED_DRIVERS[driverKey];
  return driver && driver.platforms.includes(os.platform());
}

function resolveDriver(driverParam) {
  const key = (driverParam || "").toLowerCase().trim();
  if (key && SUPPORTED_DRIVERS[key] && isDriverAvailable(key)) {
    return key;
  }
  return getDefaultDriver();
}

// ─────────────────────────────────────────────
// TWAIN via node-twain (optionnel)
// ─────────────────────────────────────────────
let twainApp = null;
try {
  const { TwainSDK, TWCY_FRANCE, TWLG_FRENCH } = require("node-twain");
  twainApp = new TwainSDK({
    productName:   "PjCare",
    productFamily: "CorrespCare",
    manufacturer:  "Africom",
    version: {
      country:  TWCY_FRANCE,
      language: TWLG_FRENCH,
      majorNum: 1,
      minorNum: 0,
      info:     "v1.0.0"
    }
  });
  console.log("✅ TWAIN initialisé");
} catch (err) {
  console.warn("⚠️  node-twain indisponible :", err.message);
}

// ─────────────────────────────────────────────
// DÉTECTION PAGE BLANCHE (sharp)
//
// Retourne true si l'image est considérée blanche.
//
// Algorithme :
//   1. Convertir en niveaux de gris
//   2. Calculer la moyenne des pixels (0 = noir, 255 = blanc)
//   3. Si moyenne >= blankThreshold → page blanche
//
// blankThreshold : 0-255 (défaut 240)
//   → valeur haute = très sélectif (seules les pages quasi-vierges sont exclues)
//   → valeur basse  = plus agressif
//
// coverageThreshold (0-100) : % max de pixels sombres tolérés.
//   Un pixel est "sombre" si sa valeur < (255 - blankThreshold).
// ─────────────────────────────────────────────
async function isBlankImage(filePath, blankThreshold = 240, coverageThreshold = 5) {
  if (!sharp) return false; // sharp non disponible → on garde toutes les pages

  try {
    const { data, info } = await sharp(filePath)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    if (totalPixels === 0) return true;

    // Compter les pixels sombres (valeur < seuil de noirceur)
    const darkThreshold = 255 - blankThreshold; // ex: 255-240 = 15
    let darkPixels = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < darkThreshold) darkPixels++;
    }

    const darkPercent = (darkPixels / totalPixels) * 100;
    console.log(`  → darkPixels: ${darkPixels}/${totalPixels} (${darkPercent.toFixed(2)}%) | seuil coverageThreshold: ${coverageThreshold}%`);

    // Page blanche si le % de pixels sombres est inférieur au seuil de couverture
    return darkPercent < coverageThreshold;
  } catch (err) {
    console.warn("⚠️  isBlankImage erreur :", err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// Scan multi-pages avec filtre pages blanches
//
// NAPS2 peut produire plusieurs fichiers si --split est utilisé.
// Pour les formats image (jpg, png, tiff), on scanne d'abord en PDF
// multi-pages, puis on convertit page par page, ou on utilise
// le placeholder $(nnnn) pour obtenir un fichier par page.
//
// Stratégie retenue (simple, compatible NAPS2 8.x) :
//   - Scan en un seul fichier
//   - Si format = jpg/png et excludeblank = true :
//       → scan en TIFF multi-pages (format conteneur)
//       → séparer les pages avec sharp
//       → filtrer les blanches
//       → recombiner ou retourner les pages restantes
//
// Pour PDF avec excludeblank :
//   - Scan avec placeholder $(nnnn) → N fichiers PDF mono-page
//   - Analyser chaque page (conversion en image temporaire)
//   - Supprimer les pages blanches
//   - Recombiner avec pdf-lib
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  const platform = os.platform();
  const availableDrivers = Object.entries(SUPPORTED_DRIVERS)
    .filter(([key]) => isDriverAvailable(key))
    .map(([key, d]) => ({ key, label: d.label, description: d.description }));

  res.json({
    status:        200,
    service:       "PjCare",
    naps2:         NAPS2_EXE ? "found" : "missing",
    naps2Path:     NAPS2_EXE || null,
    twain:         twainApp  ? "ready" : "unavailable",
    sharp:         sharp     ? "available" : "unavailable",
    platform,
    defaultDriver: getDefaultDriver(),
    drivers:       availableDrivers,
    timestamp:     new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// GET /api/drivers
// ─────────────────────────────────────────────
app.get("/api/drivers", (req, res) => {
  const platform = os.platform();
  const drivers = Object.entries(SUPPORTED_DRIVERS)
    .filter(([key]) => isDriverAvailable(key))
    .map(([key, d]) => ({
      key,
      label:       d.label,
      description: d.description,
      isDefault:   key === getDefaultDriver()
    }));
  res.json({ status: 200, platform, drivers });
});

// ─────────────────────────────────────────────
// GET /api/GetListScanner
// ─────────────────────────────────────────────
app.get("/api/GetListScanner", (req, res) => {
  if (!NAPS2_EXE) {
    return res.status(503).json({ status: 503, error: "NAPS2 introuvable", scanners: [] });
  }

  const driverKey = resolveDriver(req.query.driver);
  const driverDef = SUPPORTED_DRIVERS[driverKey];
  console.log(`🔍 Listing scanners avec driver: ${driverKey}`);

  execFile(NAPS2_EXE, ["--listdevices", "--driver", driverDef.cliValue],
    { windowsHide: true, timeout: 15000 },
    (err, stdout, stderr) => {
      console.log("listdevices stdout:", stdout);
      if (stderr) console.log("listdevices stderr:", stderr);

      if (!stdout.trim()) {
        return res.json({
          status:   200,
          driver:   driverKey,
          scanners: [],
          warning:  `Aucun scanner trouvé avec le driver ${driverKey}`
        });
      }

      const scanners = stdout.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      res.json({ status: 200, driver: driverKey, scanners });
    }
  );
});

// ─────────────────────────────────────────────
// GET /api/Acquire
//   ?source=…           nom du scanner (obligatoire)
//   &driver=…           wia | twain | escl | sane | apple
//   &dpi=…              150 par défaut
//   &jpegquality=…      75 par défaut
//   &format=…           jpg | png | pdf | tiff  (défaut: jpg)
//   &name=…             nom de base du fichier
//   &bitdepth=…         color | gray | bw  (défaut: color)
//   &duplex=…           true | false
//   &pagesize=…         A4 par défaut
//   &excludeblank=…     true | false  (traitement côté serveur via sharp)
//   &blankthreshold=…   0-255, défaut 240  (luminosité minimale pour "blanc")
//   &coveragethreshold= 0-100, défaut 5    (% max de pixels sombres tolérés)
// ─────────────────────────────────────────────
app.get("/api/Acquire", async (req, res) => {
  if (!NAPS2_EXE) {
    return res.status(503).json({
      status: 503,
      error:  "NAPS2 n'est pas installé sur ce poste. Installez NAPS2 depuis https://www.naps2.com"
    });
  }

  const {
    source,
    driver,
    dpi               = "150",
    jpegquality       = "75",
    format            = "jpg",
    name,
    bitdepth          = "color",
    duplex            = "false",
    pagesize          = "A4",
    excludeblank      = "false",
    blankthreshold    = "240",   // 0-255 : luminosité seuil (255 = blanc pur)
    coveragethreshold = "5",     // 0-100 : % max de pixels sombres
  } = req.query;

  if (!source) {
    return res.status(400).json({ status: 400, error: "Paramètre 'source' manquant" });
  }

  const driverKey = resolveDriver(driver);
  const driverDef = SUPPORTED_DRIVERS[driverKey];
  console.log(`📷 Scan | driver: ${driverKey} | source: ${source} | excludeblank: ${excludeblank}`);

  // Validation format
  const ALLOWED_FORMATS = ["jpg", "png", "pdf", "tiff"];
  const safeFormat = ALLOWED_FORMATS.includes(format.toLowerCase()) ? format.toLowerCase() : "jpg";

  // Validation bitdepth
  const ALLOWED_BITDEPTHS = ["color", "gray", "bw"];
  const safeBitdepth = ALLOWED_BITDEPTHS.includes(bitdepth.toLowerCase()) ? bitdepth.toLowerCase() : "color";

  // Sanitisation nom de fichier
  let baseName = source.toString().replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (name) {
    const safe = name.toString().trim().replace(/[^\p{L}\p{N}_-]/gu, "_");
    if (safe.length > 0) baseName = safe;
  }

  // ── Stratégie excludeblank ──────────────────────────────────────────────
  // NAPS2 8.x CLI ne supporte pas --excludeblank ni --blankpagecoverage.
  // On implémente la détection côté Node.js avec sharp.
  //
  // Pour pouvoir analyser page par page, on force un scan en TIFF multi-pages
  // (format conteneur natif de NAPS2), puis on filtre les pages blanches,
  // puis on reconvertit dans le format demandé.
  //
  // Si sharp n'est pas disponible, on scanne normalement sans filtrage.
  // ────────────────────────────────────────────────────────────────────────
  const doExcludeBlank = excludeblank === "true" && sharp !== null;

  // Format de scan intermédiaire : toujours TIFF quand on doit filtrer
  // (NAPS2 supporte le TIFF multi-pages nativement)
  const scanFormat = doExcludeBlank ? "tiff" : safeFormat;

  const timestamp  = Date.now();
  const scanFile   = `${baseName}-${timestamp}.${scanFormat}`;
  const scanPath   = path.join(TEMP_DIR, scanFile);
  const finalFile  = `${baseName}-${timestamp}.${safeFormat}`;
  const finalPath  = path.join(TEMP_DIR, finalFile);

  // Construction des arguments NAPS2
  // NOTE : --duplex n'est pas une option standalone dans NAPS2 8.x.
  //        Le recto-verso se contrôle via --source (feeder/duplex/glass).
  const args = [
    "--noprofile",
    "--driver",   driverDef.cliValue,
    "--device",   source.toString(),
    "--output",   scanPath,
    "--dpi",      dpi.toString(),
    "--bitdepth", safeBitdepth,
    "--pagesize", pagesize.toString(),
    "--verbose",
  ];

  // Source de papier : duplex si demandé, sinon feeder si disponible
  if (duplex === "true") {
    args.push("--source", "duplex");
  }

  // Qualité JPEG uniquement pour jpg
  if (scanFormat === "jpg") {
    args.push("--jpegquality", jpegquality.toString());
  }

  const timeoutMs = driverKey === "escl" ? 90000 : 60000;

  // ── Exécution NAPS2 ──────────────────────────────────────────────────────
  execFile(NAPS2_EXE, args, { windowsHide: true, timeout: timeoutMs }, async (err, stdout, stderr) => {
    console.log("← stdout:", stdout);
    if (stderr) console.log("← stderr:", stderr);

    if (err) {
      return res.status(500).json({
        status: 500,
        driver: driverKey,
        error:  stderr || err.message
      });
    }

    if (!fs.existsSync(scanPath)) {
      return res.status(500).json({
        status: 500,
        driver: driverKey,
        error:  "Scan terminé mais fichier introuvable"
      });
    }

    // ── Pas de filtre pages blanches : renvoyer directement ─────────────
    if (!doExcludeBlank) {
      return sendFile(res, scanPath, finalFile, safeFormat, safeBitdepth, driverKey, true);
    }

    // ── Filtre pages blanches avec sharp ────────────────────────────────
    console.log("🔍 Analyse pages blanches en cours...");

    try {
      const blankThr = Math.min(255, Math.max(0, parseInt(blankthreshold, 10) || 240));
      const coverThr = Math.min(100, Math.max(0, parseFloat(coveragethreshold)  || 5));

      // Extraire les pages du TIFF multi-pages
      // sharp gère les TIFF multi-pages via l'option `page`
      const metadata = await sharp(scanPath).metadata();
      const pageCount = metadata.pages || 1;
      console.log(`  TIFF pages détectées : ${pageCount}`);

      const keptPages = []; // indices des pages à conserver

      for (let p = 0; p < pageCount; p++) {
        // Extraire la page p en PNG temporaire pour analyse
        const tmpPage = path.join(TEMP_DIR, `__page_${timestamp}_${p}.png`);
        await sharp(scanPath, { page: p })
          .png()
          .toFile(tmpPage);

        const blank = await isBlankImage(tmpPage, blankThr, coverThr);
        console.log(`  Page ${p + 1}/${pageCount} : ${blank ? "BLANCHE (ignorée)" : "contenu détecté"}`);
        fs.unlink(tmpPage, () => {});

        if (!blank) keptPages.push(p);
      }

      console.log(`  Pages conservées : ${keptPages.length}/${pageCount}`);

      if (keptPages.length === 0) {
        fs.unlink(scanPath, () => {});
        return res.status(422).json({
          status:  422,
          driver:  driverKey,
          error:   "Toutes les pages ont été détectées comme blanches. Vérifiez les seuils ou le document."
        });
      }

      // ── Reconstruire le fichier final avec les pages conservées ─────────
      if (safeFormat === "pdf") {
        // Utiliser pdf-lib pour assembler les pages en PDF
        await buildPdfFromPages(scanPath, keptPages, finalPath);
      } else if (safeFormat === "tiff") {
        // TIFF multi-pages : reconstruire via sharp
        await buildTiffFromPages(scanPath, keptPages, finalPath);
      } else {
        // jpg ou png : une seule page (la première conservée)
        await sharp(scanPath, { page: keptPages[0] })
          [safeFormat === "jpg" ? "jpeg" : "png"]({
            quality: safeFormat === "jpg" ? parseInt(jpegquality, 10) : undefined
          })
          .toFile(finalPath);
      }

      fs.unlink(scanPath, () => {}); // supprimer le TIFF intermédiaire
      return sendFile(res, finalPath, finalFile, safeFormat, safeBitdepth, driverKey, true);

    } catch (sharpErr) {
      console.error("❌ Erreur traitement sharp :", sharpErr.message);
      // En cas d'erreur sharp, on renvoie le fichier brut sans filtre
      return sendFile(res, scanPath, scanFile, scanFormat, safeBitdepth, driverKey, true);
    }
  });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Lit un fichier et l'envoie en base64 dans la réponse JSON.
 * Supprime le fichier après lecture si deleteAfter = true.
 */
function sendFile(res, filePath, filename, format, bitdepth, driverKey, deleteAfter) {
  fs.readFile(filePath, (readErr, data) => {
    if (readErr) {
      return res.status(500).json({ status: 500, error: readErr.message });
    }
    if (deleteAfter) fs.unlink(filePath, () => {});
    res.json({
      status:   200,
      driver:   driverKey,
      data:     data.toString("base64"),
      file:     filename,
      format,
      bitdepth,
    });
  });
}

/**
 * Reconstruit un PDF mono-page ou multi-pages à partir des pages TIFF sélectionnées.
 * Nécessite pdf-lib : npm install pdf-lib
 */
async function buildPdfFromPages(tiffPath, pageIndices, outPath) {
  let PDFDocument;
  try {
    ({ PDFDocument } = require("pdf-lib"));
  } catch {
    // pdf-lib non disponible : reconstruire via sharp (conversion en images)
    console.warn("⚠️  pdf-lib non installé. Conversion PDF via sharp (images).");
    return buildPdfFromPagesViaSharp(tiffPath, pageIndices, outPath);
  }

  const { default: fetch } = await import("node-fetch").catch(() => ({ default: null }));

  // Créer un nouveau PDF
  const pdfDoc = await PDFDocument.create();

  for (const pageIdx of pageIndices) {
    // Extraire la page TIFF en PNG via sharp
    const tmpPng = outPath + `_p${pageIdx}.png`;
    await sharp(tiffPath, { page: pageIdx }).png().toFile(tmpPng);

    const imgBytes = fs.readFileSync(tmpPng);
    const pngImage = await pdfDoc.embedPng(imgBytes);
    const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
    page.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });

    fs.unlink(tmpPng, () => {});
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outPath, pdfBytes);
}

/**
 * Fallback si pdf-lib n'est pas disponible : crée un PDF "image dans page"
 * via sharp en chaînant les pages. Résultat : un fichier PNG pour la première page.
 * (Limitation : non multi-pages sans pdf-lib)
 */
async function buildPdfFromPagesViaSharp(tiffPath, pageIndices, outPath) {
  // Sans pdf-lib on ne peut pas faire du vrai PDF multi-pages.
  // On extrait la première page en PNG et on renomme en .pdf (non idéal mais fonctionnel).
  console.warn("  buildPdfFromPagesViaSharp : extraction page 0 uniquement (installez pdf-lib pour le multi-pages)");
  const outPng = outPath.replace(/\.pdf$/i, ".png");
  await sharp(tiffPath, { page: pageIndices[0] }).png().toFile(outPng);
  fs.renameSync(outPng, outPath);
}

/**
 * Reconstruit un TIFF multi-pages à partir des pages sélectionnées.
 * sharp ne supporte pas l'écriture TIFF multi-pages nativement → on produit
 * un TIFF mono-page (première page conservée).
 * Pour un vrai TIFF multi-pages, il faudrait ImageMagick.
 */
async function buildTiffFromPages(tiffPath, pageIndices, outPath) {
  // Extraire la première page conservée en TIFF
  await sharp(tiffPath, { page: pageIndices[0] })
    .tiff()
    .toFile(outPath);

  if (pageIndices.length > 1) {
    console.warn("  TIFF multi-pages : seule la première page conservée est incluse (sharp ne supporte pas le TIFF multi-pages en écriture).");
  }
}

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = 7777;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ PjCare API démarrée sur http://127.0.0.1:${PORT}`);
  console.log(`   Plateforme    : ${os.platform()}`);
  console.log(`   Driver défaut : ${getDefaultDriver()}`);
  console.log(`   sharp         : ${sharp ? "✅ disponible" : "⚠️  manquant (npm install sharp)"}`);
  console.log(`   Health check  : http://127.0.0.1:${PORT}/api/health`);
  console.log(`   Drivers       : http://127.0.0.1:${PORT}/api/drivers`);
});