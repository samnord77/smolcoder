const fs = require("fs");
const path = require("path");
const { resolveInWorkspace, SandboxError } = require("../dist/sandbox.js");

const MAX_EDITOR_FILE_BYTES = 1024 * 1024;

function workspacePath(workspace, requested) {
  try { return resolveInWorkspace(workspace, requested); }
  catch (error) { throw new Error(error instanceof SandboxError ? error.message : String(error.message || error)); }
}

function readWorkspaceFile(workspace, requested) {
  const absolute = workspacePath(workspace, requested);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) throw new Error("C’est un dossier.");
  if (stat.size > MAX_EDITOR_FILE_BYTES) throw new Error("Fichier > 1 Mo : ouvrez-le dans un autre éditeur.");
  return { content: fs.readFileSync(absolute, "utf8"), mtimeMs: stat.mtimeMs };
}

function saveWorkspaceFile(workspace, requested, content, expectedMtimeMs) {
  if (typeof content !== "string") throw new Error("Le contenu à enregistrer doit être du texte.");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EDITOR_FILE_BYTES) throw new Error("Fichier > 1 Mo : réduisez son contenu avant de l’enregistrer.");
  const absolute = workspacePath(workspace, requested);
  const exists = fs.existsSync(absolute);
  if (exists) {
    const current = fs.statSync(absolute);
    if (current.isDirectory()) throw new Error("Impossible d’enregistrer sur un dossier.");
    if (!Number.isFinite(expectedMtimeMs) || Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
      throw new Error("Le fichier a changé sur le disque. Rechargez-le avant d’enregistrer.");
    }
  } else if (Number.isFinite(expectedMtimeMs)) {
    throw new Error("Le fichier a été supprimé du disque. Rechargez le dossier avant d’enregistrer.");
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return { mtimeMs: fs.statSync(absolute).mtimeMs, size: bytes };
}

module.exports = { MAX_EDITOR_FILE_BYTES, readWorkspaceFile, saveWorkspaceFile };
