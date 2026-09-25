// Pont securise : la fenetre editeur n'a pas acces a Node,
// elle passe par ces 6 fonctions validees dans main.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smolEd", {
  pickFolder: () => ipcRenderer.invoke("ed:pickFolder"),
  setRoot: (dir) => ipcRenderer.invoke("ed:setRoot", dir),
  suggestRoot: () => ipcRenderer.invoke("ed:askModel"),
  list: (rel) => ipcRenderer.invoke("ed:list", rel),
  read: (rel) => ipcRenderer.invoke("ed:read", rel),
  save: (rel, content) => ipcRenderer.invoke("ed:save", rel, content),
});
