// Pont sécurisé Git : la fenêtre git.html n'a pas accès à Node,
// elle passe par ces 3 fonctions validées dans main.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smolGit", {
  getStatus: () => ipcRenderer.invoke("git:status"),
  getDiff: (rel) => ipcRenderer.invoke("git:diff", rel),
  commit: (message, rel) => ipcRenderer.invoke("git:commit", message, rel),
});
