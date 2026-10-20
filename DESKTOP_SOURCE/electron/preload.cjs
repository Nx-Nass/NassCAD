const { contextBridge, ipcRenderer, webUtils } = require('electron');
const listeners = new Map();
ipcRenderer.on('nasscad:medusa-frame', (_event,id,frame) => listeners.get(id)?.(frame));
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  prepareStepFile:file=>{const selected=webUtils.getPathForFile(file);return selected?ipcRenderer.invoke('nasscad:prepare-step-file',selected,file.size,file.lastModified):Promise.resolve(null);},
  confirmUnsaved:()=>ipcRenderer.invoke('nasscad:confirm-unsaved'),
  saveRecovery:data=>ipcRenderer.invoke('nasscad:recovery-save',data),
  readRecovery:()=>ipcRenderer.invoke('nasscad:recovery-read'),
  clearRecovery:()=>ipcRenderer.invoke('nasscad:recovery-clear'),
  onCloseRequest:callback=>ipcRenderer.on('nasscad:close-request',callback),
  approveClose:()=>ipcRenderer.send('nasscad:close-approved'),
  downloadsPath: () => ipcRenderer.invoke('nasscad:downloads'),
  showSaveDialog: options => ipcRenderer.invoke('nasscad:save-dialog', options),
  writeFile: (filePath, data) => ipcRenderer.invoke('nasscad:write', filePath, data),
  medusaStatus: () => ipcRenderer.invoke('nasscad:medusa-status'),
  medusaLog: (force=false) => ipcRenderer.invoke('nasscad:medusa-log',force),
  medusaRequest: (id,method,route,body) => ipcRenderer.invoke('nasscad:medusa-request',id,method,route,body),
  medusaSubscribe: (id,callback) => { listeners.set(id,callback); },
  medusaUnsubscribe: id => listeners.delete(id),
  medusaAck: id => ipcRenderer.send('nasscad:medusa-ack',id),
  medusaCancel: id => ipcRenderer.send('nasscad:medusa-cancel',id)
});
