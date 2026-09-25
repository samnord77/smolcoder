// Pont du panneau : lecture seule du statut (aucune ecriture, aucun Node direct).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smolPanel", {
  getData: () => ipcRenderer.invoke("panel:data"),
});
