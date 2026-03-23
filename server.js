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
// DRIVERS SUPPORTÉS
// Chaque driver a : un label lisible, sa valeur
// CLI pour NAPS2, et les OS où il est disponible.
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

// Driver par défaut selon la plateforme
function getDefaultDriver() {
  switch (os.platform()) {
    case "win32":  return "wia";
    case "darwin": return "apple";
    case "linux":  return "sane";
    default:       return "wia";
  }
}

// Vérifie si un driver est compatible avec la plateforme courante
function isDriverAvailable(driverKey) {
  const driver = SUPPORTED_DRIVERS[driverKey];
  return driver && driver.platforms.includes(os.platform());
}

// Valide et retourne la valeur CLI du driver, ou le driver par défaut
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
// GET /api/health
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  const platform = os.platform();

  // Drivers disponibles sur cette plateforme
  const availableDrivers = Object.entries(SUPPORTED_DRIVERS)
    .filter(([key]) => isDriverAvailable(key))
    .map(([key, d]) => ({
      key,
      label:       d.label,
      description: d.description
    }));

  res.json({
    status:        200,
    service:       "PjCare",
    naps2:         NAPS2_EXE ? "found" : "missing",
    naps2Path:     NAPS2_EXE || null,
    twain:         twainApp  ? "ready" : "unavailable",
    platform,
    defaultDriver: getDefaultDriver(),
    drivers:       availableDrivers,
    timestamp:     new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// GET /api/drivers
// Retourne la liste des drivers disponibles sur ce poste
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

  res.json({
    status:   200,
    platform,
    drivers
  });
});

// ─────────────────────────────────────────────
// GET /api/GetListScanner?driver=wia|twain|escl|sane|apple
// Liste les scanners pour un driver donné
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

// Même si err est présent, vérifier d'abord si stdout contient des données
      // (NAPS2 peut retourner exit code non-zéro mais quand même lister les scanners)
      if (!stdout.trim()) {
        console.warn(`⚠️  Aucun scanner détecté avec le driver ${driverKey}`);
        return res.json({
          status:   200,
          driver:   driverKey,
          scanners: [],
          warning:  `Aucun scanner trouvé avec le driver ${driverKey}`
        });
      }

      const scanners = stdout
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0);

      res.json({ status: 200, driver: driverKey, scanners });
    }
  );
});

// ─────────────────────────────────────────────
// GET /api/Acquire
//   ?source=…      nom du scanner (obligatoire)
//   &driver=…      wia | twain | escl | sane | apple  (optionnel, défaut auto)
//   &dpi=…         150 par défaut
//   &jpegquality=… 75 par défaut
//   &format=…      jpg par défaut (jpg | png | pdf | tiff)
//   &name=…        nom de base du fichier (optionnel)
//   &bitdepth=…    color | gray | bw  (optionnel, défaut color)
//   &duplex=…      true | false  (optionnel)
// ─────────────────────────────────────────────
app.get("/api/Acquire", (req, res) => {
  if (!NAPS2_EXE) {
    return res.status(503).json({
      status: 503,
      error:  "NAPS2 n'est pas installé sur ce poste. Installez NAPS2 depuis https://www.naps2.com"
    });
  }

const {
    source,
    driver,
    dpi              = 150,
    jpegquality      = 75,
    format           = "jpg",
    name,
    bitdepth         = "color",
    duplex           = "false",
    excludeblank     = "false",
    blankthreshold   = "70",
    coveragethreshold = "25",
    pagesize          = "A4" 
  } = req.query;

  if (!source) {
    return res.status(400).json({ status: 400, error: "Paramètre 'source' manquant" });
  }

  // Résoudre le driver
  const driverKey = resolveDriver(driver);
  const driverDef = SUPPORTED_DRIVERS[driverKey];
  console.log(`📷 Scan avec driver: ${driverKey} | source: ${source}`);

  // Valider le format
  const ALLOWED_FORMATS = ["jpg", "png", "pdf", "tiff"];
  const safeFormat = ALLOWED_FORMATS.includes(format.toLowerCase()) ? format.toLowerCase() : "jpg";

  // Valider bitdepth
  const ALLOWED_BITDEPTHS = ["color", "gray", "bw"];
  const safeBitdepth = ALLOWED_BITDEPTHS.includes(bitdepth.toLowerCase()) ? bitdepth.toLowerCase() : "color";

  // Sanitiser le nom de fichier
  let baseName = source.toString().replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (name) {
    const safe = name.toString().trim().replace(/[^\p{L}\p{N}_-]/gu, "_");
    if (safe.length > 0) baseName = safe;
  }

  const filename = `${baseName}-${Date.now()}.${safeFormat}`;
  const outPath  = path.join(TEMP_DIR, filename);
  console.log("→ Scan vers :", outPath);

  // Construction des arguments NAPS2
  const args = [
    "--noprofile",
    "--driver",      driverDef.cliValue,
    "--device",      source.toString(),
    "--output",      outPath,
    "--dpi",         dpi.toString(),
    "--bitdepth",    safeBitdepth,
    "--pagesize",    pagesize,
  ];

  // jpegquality uniquement pour jpg
  if (safeFormat === "jpg") {
    args.push("--jpegquality", jpegquality.toString());
  }

// Duplex (recto-verso) si demandé
  if (duplex === "true") {
    args.push("--duplex");
  }

  // Pages blanches
  if (excludeblank === "true") {
    args.push("--excludeblank", blankthreshold.toString());
    args.push("--blankpagecoverage", coveragethreshold.toString());
  }

  // Pour eSCL, certains scanners réseau nécessitent un délai plus long
  const timeoutMs = driverKey === "escl" ? 90000 : 60000;

  execFile(NAPS2_EXE, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
    console.log("← stdout:", stdout);
    if (stderr) console.error("← stderr:", stderr);

    if (err) {
      return res.status(500).json({
        status: 500,
        driver: driverKey,
        error:  stderr || err.message
      });
    }

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({
        status: 500,
        driver: driverKey,
        error:  "Scan terminé mais fichier introuvable"
      });
    }

    fs.readFile(outPath, (readErr, data) => {
      if (readErr) {
        return res.status(500).json({ status: 500, error: readErr.message });
      }

      fs.unlink(outPath, () => {});

      res.json({
        status:   200,
        driver:   driverKey,
        data:     data.toString("base64"),
        file:     filename,
        format:   safeFormat,
        bitdepth: safeBitdepth
      });
    });
  });
});

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = 7777;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ PjCare API démarrée sur http://127.0.0.1:${PORT}`);
  console.log(`   Plateforme   : ${os.platform()}`);
  console.log(`   Driver défaut: ${getDefaultDriver()}`);
  console.log(`   Health check : http://127.0.0.1:${PORT}/api/health`);
  console.log(`   Drivers      : http://127.0.0.1:${PORT}/api/drivers`);
});