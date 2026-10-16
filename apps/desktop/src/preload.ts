import { contextBridge, ipcRenderer } from 'electron';

// The UI reports its Appearance setting, so the title bar and native controls follow it.
contextBridge.exposeInMainWorld('capybaraDesktop', {
  setAppearance: (appearance: string) => ipcRenderer.send('appearance', appearance),
});
