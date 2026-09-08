// Isolated runtime verification; no preload, production credentials, or user project.
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'aily-v4-electron-')))
app.commandLine.appendSwitch('remote-debugging-port', '9255')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1000, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await window.loadURL('http://127.0.0.1:8019/')
})
app.on('window-all-closed', () => app.quit())
