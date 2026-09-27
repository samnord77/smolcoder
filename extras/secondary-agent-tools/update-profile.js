const fs = require("fs");
const path = require("path");

const smolSnippet = `
# >>> smolcoder (CLI & Web) >>>
function smol {
    & "C:\\Program Files\\nodejs\\node.exe" "C:\\npm-global\\node_modules\\smolcoder\\dist\\index.js" @args
}
# <<< smolcoder <<<
`;

const ps7Path = path.join("C:", "Users", "DELL", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
if (fs.existsSync(ps7Path)) {
  const content = fs.readFileSync(ps7Path, "utf8");
  if (!content.includes("function smol")) {
    fs.appendFileSync(ps7Path, smolSnippet, "utf8");
    console.log("[OK] Profil PowerShell 7 mis à jour avec smol");
  } else {
    console.log("[INFO] Profil PowerShell 7 contient déjà smol");
  }
}

const winPsDir = path.join("C:", "Users", "DELL", "Documents", "WindowsPowerShell");
if (!fs.existsSync(winPsDir)) {
  fs.mkdirSync(winPsDir, { recursive: true });
}
const winPsPath = path.join(winPsDir, "Microsoft.PowerShell_profile.ps1");
if (fs.existsSync(winPsPath)) {
  const content = fs.readFileSync(winPsPath, "utf8");
  if (!content.includes("function smol")) {
    fs.appendFileSync(winPsPath, smolSnippet, "utf8");
    console.log("[OK] Profil Windows PowerShell mis à jour avec smol");
  } else {
    console.log("[INFO] Profil Windows PowerShell contient déjà smol");
  }
} else {
  fs.writeFileSync(winPsPath, smolSnippet, "utf8");
  console.log("[OK] Profil Windows PowerShell créé avec smol");
}
