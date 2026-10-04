// Package the Windows desktop app through electron-packager's JS API.
//
// Why a script instead of the plain CLI: electron-packager 17 always infers
// `appVersion` (from package.json `version`) and `win32metadata.CompanyName`
// (from `author`) for Windows targets, which makes it shell out to `rcedit`.
// rcedit only rewrites the icon and the version metadata embedded inside the
// .exe. On machines where Windows Defender blocks writes to a PE image (or the
// temp copy is locked), rcedit fails the whole run with
// "Fatal error: Unable to commit changes" and no executable is produced.
//
// The application does not need that step, so this script disables it by
// pre-seeding require.cache with a no-op `rcedit`. The icon and the version
// block are then written back with `resedit`, a pure-JavaScript PE resource
// editor: no native binary, no shell-out, no admin rights, therefore nothing
// for Defender to block. Everything else (dist/, desktop/, the patched main
// entry) is unchanged.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "release");
const appName = "Smolcoder";

function fail(message, detail) {
  console.error(`package-win: ${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
  throw new Error(message);
}

const copiedEntries = ["dist", "desktop", "LICENSE", "README.md"];

function stageProject(stageDir) {
  fs.mkdirSync(stageDir, { recursive: true });

  for (const entry of copiedEntries) {
    const from = path.join(repoRoot, entry);
    if (!fs.existsSync(from)) {
      fail(`missing ${entry} - run \`npm run build\` before packaging.`);
    }
    fs.cpSync(from, path.join(stageDir, entry), { recursive: true });
  }

  // Electron resolves its own binary from node_modules at runtime.
  const electronFrom = path.join(repoRoot, "node_modules", "electron");
  if (!fs.existsSync(electronFrom)) fail("electron is not installed in node_modules.");
  fs.mkdirSync(path.join(stageDir, "node_modules"), { recursive: true });
  fs.cpSync(electronFrom, path.join(stageDir, "node_modules", "electron"), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}electron${path.sep}node_modules`),
  });

  const real = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const staged = {
    name: real.name,
    productName: appName,
    version: real.version,
    description: real.description,
    main: "desktop/main.js",
    license: real.license,
  };
  fs.writeFileSync(path.join(stageDir, "package.json"), JSON.stringify(staged, null, 2));
  return staged;
}

const iconPath = path.join(repoRoot, "build", "icon.ico");

// Write the icon and the version block straight into the PE image. The result
// is written to a sibling temp file first: a failed stamp can then never leave
// a half-written executable behind.
async function stampExe(exePath, version) {
  if (!fs.existsSync(iconPath)) {
    fail(`missing ${iconPath} - run: powershell -File scripts/make-icon.ps1`);
  }

  const PELibrary = require("pe-library");
  const ResEdit = await require("resedit/cjs").load();

  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath));
  const res = PELibrary.NtExecutableResource.from(exe);

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groups[0]?.id ?? 1,
    groups[0]?.lang ?? 1033,
    iconFile.icons.map((item) => item.data)
  );

  const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (!versionInfo) fail(`no version resource found in ${exePath}`);
  const lang = versionInfo.lang;
  const langId = typeof lang === "number" ? lang : Number.parseInt(String(lang), 16) || 1033;

  // `setFileVersion` expects a full a.b.c.d tuple; package.json carries "0.7.1".
  const v = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [major = 0, minor = 0, micro = 0, revision = 0] = [v[0], v[1], v[2], v[3]];
  versionInfo.setFileVersion(major, minor, micro, revision, langId);
  versionInfo.setProductVersion(major, minor, micro, revision, langId);
  versionInfo.setStringValues(
    { lang: langId, codepage: 1200 },
    {
      CompanyName: appName,
      FileDescription: `${appName} - IDE et Auto Copilot`,
      InternalName: `${appName}.exe`,
      LegalCopyright: `Copyright (C) 2026 ${appName}`,
      OriginalFilename: `${appName}.exe`,
      ProductName: appName,
    }
  );
  versionInfo.removeStringValue({ lang: langId, codepage: 1200 }, "SquirrelAwareVersion");
  versionInfo.outputToResourceEntries(res.entries);

  res.outputResource(exe);

  const tmp = `${exePath}.stamp.tmp`;
  fs.writeFileSync(tmp, Buffer.from(exe.generate()));
  // Parse the temp copy back before replacing: guarantees a valid image.
  PELibrary.NtExecutable.from(fs.readFileSync(tmp));
  fs.renameSync(tmp, exePath);
}

// Replace `rcedit` with a no-op so packaging never shells out to the PE editor.
function neutralizeRcedit() {
  const rceditPath = require.resolve("rcedit", { paths: [repoRoot] });
  const stub = new (require("node:module"))(rceditPath, module);
  stub.filename = rceditPath;
  stub.loaded = true;
  stub.paths = path.dirname(rceditPath).split(path.sep);
  stub.exports = async function skippedRcedit() {
    console.log("package-win: rcedit skipped (version metadata left at Electron defaults)");
  };
  require.cache[rceditPath] = stub;
  return rceditPath;
}

async function main() {
  const packager = require(path.join(repoRoot, "node_modules", "electron-packager"));

  const patched = neutralizeRcedit();
  console.log("package-win: rcedit stub ->", patched);

  // Provide every property electron-packager would otherwise infer from
  // package.json, so it never reads the staged manifest and never re-injects
  // appVersion / win32metadata (which would re-enable rcedit).
  const electronVersion = require(path.join(repoRoot, "node_modules", "electron", "package.json")).version;
  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "smolcoder-stage-"));
  console.log("package-win: staging ->", stageDir);

  let paths;
  try {
    stageProject(stageDir);

    paths = await packager({
      dir: stageDir,
      out: outDir,
      overwrite: true,
      platform: "win32",
      arch: "x64",
      prune: false,
      asar: false,
      name: appName,
      executableName: appName,
      electronVersion,
      appVersion,
      win32metadata: { CompanyName: "Smolcoder" },
    });
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  for (const target of paths) {
    const exe = path.join(target, `${appName}.exe`);
    const main = path.join(target, "resources", "app", "package.json");
    if (!fs.existsSync(exe)) fail("packaged executable is missing:", exe);
    if (!fs.existsSync(main)) fail("packaged app manifest is missing:", main);

    // The staged manifest already points at the Electron entry point; re-assert
    // it so the published CLI contract (bin -> dist/index.js) is untouched.
    const manifest = JSON.parse(fs.readFileSync(main, "utf8"));
    manifest.main = "desktop/main.js";
    fs.writeFileSync(main, JSON.stringify(manifest, null, 2));

    await stampExe(exe, appVersion);
    console.log(`package-win: icone et version ${appVersion} gravees dans ${path.basename(exe)}`);

    const bytes = fs.statSync(exe).size;
    console.log("package-win: OK ->", exe, `(${Math.round(bytes / 1048576)} Mo)`);
  }

  console.log("package-win: done.");
}

main().catch((err) => {
  if (process.exitCode) return;
  console.error(err?.stack ? err.stack : String(err));
  process.exitCode = 1;
});
