'use strict'

// 桥接 API：启动画面（splash.html）、应用外壳（shell.html）与设置窗口（settings.html）共同使用。
// 渲染进程处于 contextIsolation + sandbox 模式，只能通过这里暴露的能力与主进程通信。

const { contextBridge, ipcRenderer } = require('electron')

const api = {
  // —— 启动画面 ——
  getConfig: () => ipcRenderer.invoke('splash:get-config'),
  retry: (p) => ipcRenderer.invoke('splash:retry', p),
  openBrowser: () => ipcRenderer.invoke('splash:open-browser'),
  openLogs: () => ipcRenderer.invoke('splash:open-logs'),
  setKeepServer: (v) => ipcRenderer.invoke('splash:set-keep-server', v),
  quit: () => ipcRenderer.invoke('splash:quit'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)),
  // —— 应用外壳 ——
  shellGetState: () => ipcRenderer.invoke('shell:get-state'),
  shellLoaded: () => ipcRenderer.send('shell:loaded'),
  shellIframeOk: () => ipcRenderer.send('shell:iframe-ok'),
  onNavigate: (cb) => ipcRenderer.on('shell:navigate', (_e, v) => cb(v)),
  // —— 余额与用量 ——
  usageSnapshot: () => ipcRenderer.invoke('usage:get-snapshot'),
  usageRefresh: () => ipcRenderer.invoke('usage:refresh'),
  usageGetSettings: () => ipcRenderer.invoke('usage:get-settings'),
  usageSetSettings: (s) => ipcRenderer.invoke('usage:set-settings', s),
  usageOpenPlatform: () => ipcRenderer.invoke('usage:open-platform'),
  usageOpenSettings: () => ipcRenderer.invoke('usage:open-settings'),
  onUsageUpdate: (cb) => ipcRenderer.on('usage:update', (_e, d) => cb(d)),
  onUsageVisibility: (cb) => ipcRenderer.on('usage:visibility', (_e, v) => cb(v))
}

contextBridge.exposeInMainWorld('dshDesktop', api)
