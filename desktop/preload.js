// Pont securise : la fenetre editeur n'a pas acces a Node,
// elle passe par ces 6 fonctions validees dans main.js.
const { contextBridge, ipcRenderer } = require("electron");
const { highlightHtml } = require("../dist/highlight.js");
const { makeEditorTabStore } = require("../dist/editor-tabs.js");
const editorTools = require("../dist/editor-tools.js");
const termFix = require("../dist/term-fix.js");
const gutter = require("../dist/editor-gutter.js");
const tabs = makeEditorTabStore();

contextBridge.exposeInMainWorld("smolEd", {
  pickFolder: () => ipcRenderer.invoke("ed:pickFolder"),
  setRoot: (dir) => ipcRenderer.invoke("ed:setRoot", dir),
  suggestRoot: () => ipcRenderer.invoke("ed:askModel"),
  list: (rel) => ipcRenderer.invoke("ed:list", rel),
  read: (rel) => ipcRenderer.invoke("ed:read", rel),
  readImage: (rel) => ipcRenderer.invoke("ed:image", rel),
  search: (query) => ipcRenderer.invoke("ed:search", query),
  diagnostics: (rel) => ipcRenderer.invoke("ed:diagnostics", rel),
  save: (rel, content, expectedMtimeMs) => ipcRenderer.invoke("ed:save", rel, content, expectedMtimeMs),
  createEntry: (rel, dir) => ipcRenderer.invoke("ed:new", rel, dir),
  renameEntry: (rel, to) => ipcRenderer.invoke("ed:rename", rel, to),
  deleteEntry: (rel) => ipcRenderer.invoke("ed:delete", rel),
  completion: (rel, line, col) => ipcRenderer.invoke("ed:completion", rel, line, col),
  aiComplete: (rel, line, col) => ipcRenderer.invoke("ed:aiComplete", rel, line, col),
  hover: (rel, line, col) => ipcRenderer.invoke("ed:hover", rel, line, col),
  definition: (rel, line, col) => ipcRenderer.invoke("ed:definition", rel, line, col),
  wsymbol: (query, lang) => ipcRenderer.invoke("ed:wsymbol", query, lang),
  inlineStart: (payload) => ipcRenderer.invoke("ed:inlineStart", payload),
  inlineResult: (op) => ipcRenderer.invoke("ed:inlineResult", op),
  gitStatus: () => ipcRenderer.invoke("ed:gitStatus"),
  gitSyncStatus: () => ipcRenderer.invoke("ed:gitSyncStatus"),
  gitBlame: (rel, line) => ipcRenderer.invoke("ed:gitBlame", rel, line),
  gitShow: (rel) => ipcRenderer.invoke("ed:gitShow", rel),
  gutterDecorations: (head, current) => gutter.gutterDecorations(head, current),
  backendStatus: () => ipcRenderer.invoke("ed:backendStatus"),
  runCommand: (cmd) => ipcRenderer.invoke("ed:runCommand", cmd),
  highlightCode: (source, language) => highlightHtml(source, language),
  buildTermErrorText: (cmd, output, errText) => termFix.buildTermErrorText(cmd, output, errText),
  extractSourcePath: (text, root) => termFix.extractSourcePath(text, root),
  editorTools: {
    cursorPosition: (text, offset) => editorTools.cursorPosition(text, offset),
    offsetForPosition: (text, line, column) => editorTools.offsetForPosition(text, line, column),
    changeIndent: (text, start, end, direction) => editorTools.changeIndent(text, start, end, direction),
    insertNewlineWithIndent: (text, start, end) => editorTools.insertNewlineWithIndent(text, start, end),
    findMatches: (text, query, options) => editorTools.findMatches(text, query, options),
    findNextMatch: (text, query, offset, backwards, caseSensitive) =>
      editorTools.findNextMatch(text, query, offset, backwards, caseSensitive),
    replaceAllLiteral: (text, query, replacement, caseSensitive) => editorTools.replaceAllLiteral(text, query, replacement, caseSensitive),
  },
  tabs: {
    list: () => tabs.list(),
    open: (filePath, content, mtimeMs) => tabs.open(filePath, content, mtimeMs),
    activate: (filePath) => tabs.activate(filePath),
    update: (filePath, content) => tabs.update(filePath, content),
    saved: (filePath, mtimeMs, savedContent) => tabs.saved(filePath, mtimeMs, savedContent),
    close: (filePath, discard) => tabs.close(filePath, discard),
    active: () => tabs.active(),
    clear: () => tabs.clear(),
  },
});
