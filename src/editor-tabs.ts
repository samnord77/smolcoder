export interface EditorTab {
  path: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  dirty: boolean;
}

/** Small shared buffer model used by the browser and Electron editors. */
export function makeEditorTabStore() {
  const tabs = new Map<string, EditorTab>();
  let activePath: string | null = null;
  const copy = (tab: EditorTab | undefined): EditorTab | null => (tab ? { ...tab } : null);
  return {
    open(filePath: string, content: string, mtimeMs = 0): EditorTab {
      if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Le chemin du fichier est requis.");
      if (typeof content !== "string") throw new Error("Le contenu du fichier doit être du texte.");
      const existing = tabs.get(filePath);
      if (existing) {
        activePath = filePath;
        return { ...existing };
      }
      const tab = { path: filePath, content, savedContent: content, mtimeMs: Number(mtimeMs) || 0, dirty: false };
      tabs.set(filePath, tab);
      activePath = filePath;
      return { ...tab };
    },
    activate(filePath: string): EditorTab | null {
      const tab = tabs.get(filePath);
      if (!tab) return null;
      activePath = filePath;
      return { ...tab };
    },
    update(filePath: string, content: string): EditorTab | null {
      const tab = tabs.get(filePath);
      if (!tab || typeof content !== "string") return null;
      tab.content = content;
      tab.dirty = content !== tab.savedContent;
      return { ...tab };
    },
    saved(filePath: string, mtimeMs?: number, savedContent?: string): EditorTab | null {
      const tab = tabs.get(filePath);
      if (!tab) return null;
      tab.savedContent = typeof savedContent === "string" ? savedContent : tab.content;
      tab.dirty = tab.content !== tab.savedContent;
      if (Number.isFinite(Number(mtimeMs))) tab.mtimeMs = Number(mtimeMs);
      return { ...tab };
    },
    reload(filePath: string, content: string, mtimeMs = 0): EditorTab | null {
      const tab = tabs.get(filePath);
      if (!tab || tab.dirty || typeof content !== "string") return null;
      tab.content = content;
      tab.savedContent = content;
      tab.mtimeMs = Number(mtimeMs) || 0;
      return { ...tab };
    },
    close(filePath: string, discard = false): { closed: boolean; active: EditorTab | null } {
      const tab = tabs.get(filePath);
      if (!tab) return { closed: false, active: copy(tabs.get(activePath || "")) };
      if (tab.dirty && !discard) return { closed: false, active: copy(tabs.get(activePath || "")) };
      const order = [...tabs.keys()];
      const index = order.indexOf(filePath);
      tabs.delete(filePath);
      if (activePath === filePath) activePath = order[index + 1] || order[index - 1] || null;
      return { closed: true, active: copy(tabs.get(activePath || "")) };
    },
    active(): EditorTab | null {
      return copy(tabs.get(activePath || ""));
    },
    list(): EditorTab[] {
      return [...tabs.values()].map((tab) => ({ ...tab }));
    },
    clear(): void {
      tabs.clear();
      activePath = null;
    },
  };
}

/** Source form for the dependency-free browser script assembled at runtime. */
export const editorTabStoreBrowserSource = `(${makeEditorTabStore.toString()})`;
