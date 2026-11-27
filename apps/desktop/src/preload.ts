import { contextBridge, ipcRenderer } from "electron";

// The settings window's only way to reach the main process.
contextBridge.exposeInMainWorld("kh", {
  state: () => ipcRenderer.invoke("setup:state"),
  setOpenAtLogin: (on: boolean) => ipcRenderer.invoke("setup:login-item", on),
  signOut: () => ipcRenderer.invoke("setup:sign-out"),
  checkClaude: () => ipcRenderer.invoke("claude:check"),
  openInstallPage: () => ipcRenderer.invoke("claude:install-page"),
  openDashboard: () => ipcRenderer.invoke("dashboard:open"),
  close: () => ipcRenderer.invoke("setup:close"),
});
