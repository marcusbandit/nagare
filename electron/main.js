// nagare as a standalone desktop app.
//
// The UI is the same web app, but nothing here involves a browser: this process
// starts the python server on a private port, waits for it to answer, and shows
// it in an Electron window. The server is a child process, so it dies with the
// app rather than outliving it.

const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const PROJECT_DIR = path.resolve(__dirname, "..");

// Hardware video decode on Linux. YouTube hands back AV1/VP9 for the "best"
// ladder, and software-decoding 4K AV1 will melt a laptop. Harmless where the
// platform decoder is missing: Chromium just falls back to software.
app.commandLine.appendSwitch(
  "enable-features",
  ["VaapiVideoDecoder", "VaapiVideoDecodeLinuxGL", "VaapiIgnoreDriverChecks"].join(","),
);
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// Launched from a .desktop entry, stdout/stderr are connected to nothing, and
// the first write to a closed pipe would take the process down with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}

let server = null;
let win = null;
let serverPort = 0;
const serverLog = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const child = spawn(
    "uv",
    ["run", "--project", PROJECT_DIR, "python", "-m", "nagare.server"],
    {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        NAGARE_PORT: String(port),
        NAGARE_HOST: "127.0.0.1",
        NAGARE_OPEN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );
  const keep = (buf) => {
    serverLog.push(buf.toString());
    if (serverLog.length > 200) serverLog.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (code, signal) => {
    server = null;
    // A server that dies while the window is open leaves a dead app; say so
    // rather than showing an empty frame.
    if (!app.isQuitting && win && !win.isDestroyed()) {
      dialog.showErrorBox(
        "nagare backend stopped",
        `The download server exited (${signal || code}).\n\n${serverLog.slice(-12).join("")}`,
      );
    }
  });
  return child;
}

async function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!server) throw new Error(`server exited early:\n${serverLog.slice(-15).join("")}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start within ${timeoutMs / 1000}s`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#070C0A",
    autoHideMenuBar: true,
    title: "nagare",
    icon: path.join(__dirname, "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The player needs these for fullscreen and picture-in-picture.
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Anything that is not our own server opens in the real browser, so a stray
  // link can never navigate the app shell away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

app.whenReady().then(async () => {
  try {
    serverPort = await freePort();
    server = startServer(serverPort);
    createWindow();
    win.loadFile(path.join(__dirname, "loading.html"));
    await waitForServer(serverPort);
    await win.loadURL(`http://127.0.0.1:${serverPort}/`);
  } catch (err) {
    dialog.showErrorBox("nagare could not start", String(err && err.message ? err.message : err));
    app.quit();
  }
});

ipcMain.handle("nagare:port", () => serverPort);

app.on("before-quit", () => {
  app.isQuitting = true;
});

function stopServer() {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    // If uvicorn is mid-shutdown with downloads attached, give it a moment
    // before insisting.
    setTimeout(() => server && !server.killed && server.kill("SIGKILL"), 3000);
  }
}

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
app.on("quit", stopServer);
process.on("exit", stopServer);
