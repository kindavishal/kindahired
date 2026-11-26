import { contextBridge, ipcRenderer } from "electron";

// The setup window's only way to reach the main process.
contextBridge.exposeInMainWorld("kh", {
  state: () => ipcRenderer.invoke("setup:state"),
  check: (hubUrl: string, token: string) => ipcRenderer.invoke("setup:check", { hubUrl, token }),
  save: (hubUrl: string, token: string, openAtLogin: boolean) => ipcRenderer.invoke("setup:save", { hubUrl, token, openAtLogin }),
  checkClaude: () => ipcRenderer.invoke("claude:check"),
  openInstallPage: () => ipcRenderer.invoke("claude:install-page"),
  openDashboard: () => ipcRenderer.invoke("dashboard:open"),
  close: () => ipcRenderer.invoke("setup:close"),
});
