const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  api: process.env.FISHD_API || "http://127.0.0.1:7777",
  hover: (inside) => ipcRenderer.send("pet:hover", inside),
  dragStart: (point) => ipcRenderer.send("pet:drag-start", point),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  say: (text) => ipcRenderer.invoke("pet:say", text),
  menu: () => ipcRenderer.send("pet:menu"),
  spontaneous: () => ipcRenderer.invoke("pet:spontaneous"),
  onFeed: (fn) => ipcRenderer.on("pet:feed", (_e, name) => fn(name)),
  onSpeak: (fn) => ipcRenderer.on("pet:speak", () => fn()),
  onChat: (fn) => ipcRenderer.on("pet:chat", () => fn()),
  onMode: (fn) => ipcRenderer.on("pet:mode", (_e, state) => fn(state)),
  onFacing: (fn) => ipcRenderer.on("pet:facing", (_e, direction) => fn(direction)),
});
