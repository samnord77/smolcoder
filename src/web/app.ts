// Desktop app mode (`smol --web --app`): open the hub in a standalone
// window instead of a browser tab. Chrome/Edge `--app=` gives a chromeless
// window with its own icon; anywhere else the system browser opens the URL.
// No new dependency: only the browsers already on the machine are used.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AppEnv {
  [k: string]: string | undefined;
}

/** A Chrome/Edge executable for `--app=` windows, or null. `platform` and
 * `env` are injectable so tests drive every OS offline. */
export function findAppBrowser(platform: string = process.platform, env: AppEnv = process.env): string | null {
  const exists = (p: string): boolean => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    for (const exe of ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe"]) {
      for (const root of roots) {
        const full = path.join(root, exe);
        if (exists(full)) return full;
      }
    }
    return null;
  }
  if (platform === "darwin") {
    for (const full of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]) {
      if (exists(full)) return full;
    }
    return null;
  }
  return null;
}

/** Own browser profile so the app window stands apart from daily browsing. */
export function appProfileDir(): string {
  return path.join(os.tmpdir(), "smolcoder-app");
}

/** argv (after the executable) that opens the hub as a standalone window. */
export function buildAppArgs(url: string): string[] {
  return [`--app=${url}`, `--user-data-dir=${appProfileDir()}`];
}

/** Open the URL with the system browser (a tab, not an app window). */
export function openUrl(url: string, platform: string = process.platform): boolean {
  try {
    const child =
      platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Open the hub like a desktop app. Returns "app" (own window), "browser"
 * (plain tab) or "printed" (copy the URL yourself). Never throws. */
export function launchApp(url: string): "app" | "browser" | "printed" {
  try {
    const exe = findAppBrowser();
    if (exe) {
      const child = spawn(exe, buildAppArgs(url), { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return "app";
    }
  } catch {
    /* fall through to the plain browser */
  }
  return openUrl(url) ? "browser" : "printed";
}
