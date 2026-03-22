const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const Store = require("electron-store");

const store = new Store();
let mainWindow;
let apiServer;

async function startApiServer() {
  const { createServer } = await import("./server.mjs");
  apiServer = await createServer();
  console.log(`[main] API server started on port ${apiServer.port}`);
}

function createWindow() {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    frame: isWin ? false : true,
    backgroundColor: "#0d0d0d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// Start server import early — don't wait for window
const serverReady = app.whenReady().then(() => {
  // Start server and window in parallel
  const serverP = startApiServer().catch((err) =>
    console.error("[main] server failed:", err),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  return serverP;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (apiServer) apiServer.close();
});

ipcMain.handle("get-api-port", () => apiServer?.port ?? 3847);
ipcMain.handle("get-platform", () => process.platform);
ipcMain.handle("win-minimize", () => mainWindow?.minimize());
ipcMain.handle("win-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle("win-close", () => mainWindow?.close());

ipcMain.handle("open-downloads", () => {
  const dir = store.get("downloadDir", app.getPath("music"));
  shell.openPath(dir);
});

ipcMain.handle("choose-download-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose download folder",
  });
  if (!result.canceled && result.filePaths.length) {
    store.set("downloadDir", result.filePaths[0]);
    return result.filePaths[0];
  }
  return store.get("downloadDir", app.getPath("music"));
});

ipcMain.handle("choose-music-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose music library folder",
  });
  if (!result.canceled && result.filePaths.length) {
    store.set("musicDir", result.filePaths[0]);
    return result.filePaths[0];
  }
  return store.get("musicDir", "");
});

ipcMain.handle("store-get", (_e, key, def) => store.get(key, def));
ipcMain.handle("store-set", (_e, key, val) => {
  store.set(key, val);
});
