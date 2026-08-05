// nagare as a standalone desktop app.
//
// The UI is the same web app, but nothing here involves a browser: this process
// starts the python server on a private port, waits for it to answer, and shows
// it in an Electron window. The server is a child process, so it dies with the
// app rather than outliving it.

const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Packaged, the python side ships beside the asar in Resources rather than in a
// checkout, and Resources is where the pyproject and the web assets live too.
const PROJECT_DIR = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");

// A double-clicked app inherits almost nothing: launchd hands it
// /usr/bin:/bin:/usr/sbin:/sbin, and a .desktop launch is not much better, so uv
// and ffmpeg are invisible even when they are installed. Look where they
// actually get installed rather than trusting PATH.
const TOOL_DIRS = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
  path.join(os.homedir(), "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/snap/bin",
  "/var/lib/flatpak/exports/bin",
];

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function onPath(tool) {
  const dirs = [...(process.env.PATH || "").split(path.delimiter), ...TOOL_DIRS];
  for (const dir of dirs) {
    const hit = dir && executable(path.join(dir, tool));
    if (hit) return hit;
  }
  return null;
}

/** Last resort: ask the login shell. It knows about mise, asdf, nix, pyenv and
    every other thing that installs itself into a shell profile and nowhere a
    fixed list would find it. */
function fromLoginShell(tool) {
  if (!process.env.SHELL) return null;
  try {
    const out = execFileSync(process.env.SHELL, ["-lc", `command -v ${tool}`], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return executable(out.trim().split("\n").pop() || "");
  } catch {
    return null;
  }
}

function findTool(tool, override) {
  return executable(override || "") || onPath(tool) || fromLoginShell(tool);
}

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
  const uv = findTool("uv", process.env.NAGARE_UV);
  if (!uv) {
    throw new Error(
      "uv is not installed, or is somewhere nagare cannot see.\n\n" +
        "uv runs the python side of nagare. Install it with:\n\n" +
        "    curl -LsSf https://astral.sh/uv/install.sh | sh\n\n" +
        "then start nagare again. If it is installed somewhere unusual, point at\n" +
        "it with the NAGARE_UV environment variable.",
    );
  }
  // ffmpeg is the python side's business, but it looks for it on PATH, and PATH
  // is exactly what a double-clicked app does not have. Hand over a real one.
  const ffmpeg = findTool("ffmpeg", process.env.NAGARE_FFMPEG);
  const dirs = [path.dirname(uv), ...(ffmpeg ? [path.dirname(ffmpeg)] : []), ...TOOL_DIRS];
  const searchPath = [...new Set(dirs)].join(path.delimiter);

  const args = ["run", "--project", PROJECT_DIR];
  // Packaged, the project lives inside the app bundle: read-only, and not the
  // place for a virtualenv. Keep the environment in the user's own data dir and
  // never let uv try to rewrite the lockfile it shipped with.
  const env = {
    ...process.env,
    PATH: `${searchPath}${path.delimiter}${process.env.PATH || ""}`,
    NAGARE_PORT: String(port),
    NAGARE_HOST: "127.0.0.1",
    NAGARE_OPEN: "0",
  };
  if (app.isPackaged) {
    args.push("--frozen");
    env.UV_PROJECT_ENVIRONMENT = path.join(app.getPath("userData"), "venv");
  }
  args.push("python", "-m", "nagare.server");

  const child = spawn(uv, args, {
    cwd: PROJECT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
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
    // The first packaged launch builds the python environment, and may fetch an
    // interpreter to build it with. That is a download, not a hang.
    await waitForServer(serverPort, app.isPackaged ? 300000 : 60000);
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
