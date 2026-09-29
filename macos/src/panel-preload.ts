import { contextBridge, ipcRenderer } from "electron"

/** For the app's own pages in static/: the status overlay and the sheets. */
contextBridge.exposeInMainWorld("kannaPanel", {
  onState: (callback: (state: unknown) => void) => {
    ipcRenderer.on("panel:state", (_event, state) => callback(state))
  },
  action: (id: string) => ipcRenderer.send("panel:action", id),
  init: () => ipcRenderer.invoke("panel:init"),
  done: (result: unknown) => ipcRenderer.send("panel:done", result),
  resize: (height: number) => ipcRenderer.send("panel:resize", height),
})
