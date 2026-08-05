// Minimal bridge. The UI talks to the python server over HTTP like it always
// has; the only thing it needs from the shell is which port that server is on
// and a way to know it is running inside the app rather than a browser tab.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nagare", {
  isDesktop: true,
  port: () => ipcRenderer.invoke("nagare:port"),
});
