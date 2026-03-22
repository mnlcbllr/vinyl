const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getApiPort: () => ipcRenderer.invoke("get-api-port"),
  openDownloads: () => ipcRenderer.invoke("open-downloads"),
  chooseDownloadDir: () => ipcRenderer.invoke("choose-download-dir"),
  chooseMusicDir: () => ipcRenderer.invoke("choose-music-dir"),
  storeGet: (key, def) => ipcRenderer.invoke("store-get", key, def),
  storeSet: (key, val) => ipcRenderer.invoke("store-set", key, val),
});
