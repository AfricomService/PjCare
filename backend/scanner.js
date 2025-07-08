// scanner.js
const { exec } = require("child_process");
const path     = require("path");
const fs       = require("fs");

// Chemin vers NAPS2.Console.exe
const NAPS2 = `"C:\\Program Files\\NAPS2\\NAPS2.Console.exe"`;

// Renvoie la liste des scanners TWAIN configurés dans NAPS2
function listTWAIN() {
  return new Promise(resolve => {
    exec(`${NAPS2} --noprofile --listdevices --driver twain`, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      // Chaque ligne représente un scanner
      const lines = stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l);
      resolve(lines);
    });
  });
}

// Lance un scan sur le scanner 'device' et renvoie le Buffer du JPEG
function scanTWAIN(device) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(__dirname, "scan_temp.jpg");
    const cmd = [
      NAPS2,
      `--noprofile`,
      `--driver twain`,
      `--device "${device}"`,
      `-o "${outPath}"`,
      `--bitdepth color`,
      `--dpi 150`,
      `--format jpeg`
    ].join(" ");

    exec(cmd, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      // Lire le fichier généré
      fs.readFile(outPath, (e, data) => {
        if (e) return reject(e.message);
        // Nettoyage
        fs.unlinkSync(outPath);
        resolve(data);
      });
    });
  });
}

module.exports = { listTWAIN, scanTWAIN };
