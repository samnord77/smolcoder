// Pont du panneau : statut + interrupteur on/off (ecriture limitee au flag
// "enabled" du serveur, jamais d'acces Node direct).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smolPanel", {
  getData: () => ipcRenderer.invoke("panel:data"),
  setEnabled: (name, on) => ipcRenderer.invoke("panel:setEnabled", name, on),
});
