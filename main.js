const {
  app,
  Menu,
  BrowserWindow,
  dialog,
  session,
  shell,
} = require("electron");
const request = require("electron-request");
const path = require("path");
const cp = require("child_process");
const portfinder = require("portfinder");
const prompt = require("electron-prompt");
const fs = require("fs");
const url = require("url");
const util = require("util");

const execFile = util.promisify(cp.execFile);
const mkdir = util.promisify(fs.mkdir);

function postConfigure(win) {
  win.webContents.on("will-navigate", function (event, reqUrl) {
    let requestedHost = new url.URL(reqUrl).host;
    let currentHost = new url.URL(win.webContents.getURL()).host;
    if (requestedHost && requestedHost != currentHost) {
      event.preventDefault();
      shell.openExternal(reqUrl);
    }
  });
  win.on('did-start-navigation', function() {
    session.defaultSession.cookies.flushStore();
  });
  win.on('did-navigate', function() {
    session.defaultSession.cookies.flushStore();
  });
}

class DatasetteServer {
  constructor(app, port) {
    this.app = app;
    this.port = port;
    this.process = null;
  }
  async startOrRestart() {
    const python_bin = await this.ensureDatasetteInstalled();
    const args = [
      "-u", // Unbuffered, to ensure process.stdin gets data
      "-m",
      "datasette",
      "--memory",
      "--root",
      "--port",
      this.port,
      "--version-note",
      "xyz-for-datasette-app",
    ];
    if (this.process) {
      this.process.kill();
    }
    const re = new RegExp(".*(http://[^/]+/-/auth-token\\?token=\\w+).*");
    let serverStarted = false;
    let authURL = null;
    return new Promise((resolve, reject) => {
      const process = cp.spawn(python_bin, args, { stdio: "pipe" });
      this.process = process;
      process.stdout.on("data", (data) => {
        console.log("stdout", data.toString());
        const m = re.exec(data);
        if (m) {
          authURL = m[1].replace('auth-token', 'auth-token-persistent');
          if (serverStarted) {
            resolve(authURL);
          }
        }
      });
      process.stderr.on("data", (data) => {
        console.log("stderr", data.toString());
        if (/Uvicorn running/.test(data)) {
          console.log("Uvicorn is running");
          serverStarted = true;
          if (authURL) {
            resolve(authURL);
          }
        }
      });
      this.process.on("error", (err) => {
        console.error("Failed to start datasette", err);
        this.app.quit();
        reject();
      });
    });
  }

  shutdown() {
    this.process.kill();
  }

  async installPlugin(plugin) {
    const pip_binary = path.join(
      process.env.HOME,
      ".datasette-app",
      "venv",
      "bin",
      "pip"
    );
    await execFile(pip_binary, ["install", plugin]);
  }

  async ensureDatasetteInstalled() {
    const datasette_app_dir = path.join(process.env.HOME, ".datasette-app");
    const venv_dir = path.join(datasette_app_dir, "venv");
    const datasette_binary = path.join(venv_dir, "bin", "datasette");
    if (fs.existsSync(datasette_binary)) {
      return path.join(venv_dir, "bin", "python3.9");
    }
    if (!fs.existsSync(datasette_app_dir)) {
      await mkdir(datasette_app_dir);
    }
    if (!fs.existsSync(venv_dir)) {
      await execFile(findPython(), ["-m", "venv", venv_dir]);
    }
    const pip_path = path.join(venv_dir, "bin", "pip");
    await execFile(pip_path, [
      "install",
      "datasette==0.59a2",
      "datasette-app-support>=0.1.2",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return path.join(venv_dir, "bin", "python3.9");
  }
}

function findPython() {
  const possibilities = [
    // In packaged app
    path.join(process.resourcesPath, "python", "bin", "python3.9"),
    // In development
    path.join(__dirname, "python", "bin", "python3.9"),
  ];
  for (const path of possibilities) {
    if (fs.existsSync(path)) {
      return path;
    }
  }
  console.log("Could not find python3, checked", possibilities);
  app.quit();
}

function windowOpts() {
  let opts = {
    width: 800,
    height: 600,
    webPreferences: {
      partition: "persist:sharecookies"
    }
  };
  if (BrowserWindow.getFocusedWindow()) {
    const pos = BrowserWindow.getFocusedWindow().getPosition();
    opts.x = pos[0] + 22;
    opts.y = pos[1] + 22;
  }
  console.log(opts);
  return opts;
}

function createWindow() {
  let datasette = null;
  let port = null;
  let mainWindow = null;

  mainWindow = new BrowserWindow({
    ...windowOpts(),
    ...{ show: false },
  });
  mainWindow.loadFile("loading.html");
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  postConfigure(mainWindow);

  portfinder.getPort(
    {
      port: 8001,
    },
    async (err, freePort) => {
      if (err) {
        console.error("Failed to obtain a port", err);
        app.quit();
      }
      port = freePort;
      // Start Python Datasette process
      datasette = new DatasetteServer(app, port);
      const url = await datasette.startOrRestart();
      mainWindow.loadURL(url);
      app.on("will-quit", () => {
        datasette.shutdown();
      });

      var menu = Menu.buildFromTemplate([
        {
          label: "Menu",
          submenu: [
            {
              label: "About Datasette",
              click() {
                dialog.showMessageBox({
                  type: "info",
                  title: "Datasette",
                  message: cp.execSync("datasette --version").toString(),
                });
              },
            },
            { type: "separator" },
            {
              role: "quit",
            },
          ],
        },
        {
          label: "File",
          submenu: [
            {
              label: "New Window",
              accelerator: "CommandOrControl+N",
              click() {
                let newWindow = new BrowserWindow({
                  ...windowOpts(),
                  ...{ show: false },
                });
                newWindow.loadURL(`http://localhost:${port}`);
                newWindow.once("ready-to-show", () => {
                  newWindow.show();
                });
                postConfigure(newWindow);
              },
            },
            {
              label: "Open Database…",
              accelerator: "CommandOrControl+O",
              click: async () => {
                let selectedFiles = dialog.showOpenDialogSync({
                  properties: ["openFile", "multiSelections"],
                });
                for (const filepath of selectedFiles) {
                  const response = await request(
                    `http://localhost:${port}/-/open-database-file`,
                    {
                      method: "POST",
                      body: JSON.stringify({ path: filepath }),
                    }
                  );
                  if (!response.ok) {
                    console.log(await response.json());
                  }
                }
                setTimeout(() => {
                  let shouldOpen = true;
                  BrowserWindow.getAllWindows().forEach((win) => {
                    let url = new URL(win.webContents.getURL());
                    if (url.pathname == "/") {
                      shouldOpen = false;
                      setTimeout(() => win.webContents.reload(), 300);
                    }
                  });
                  if (shouldOpen) {
                    // Open a new window
                    let newWindow = new BrowserWindow({
                      ...windowOpts(),
                      ...{ show: false },
                    });
                    newWindow.loadURL(`http://localhost:${port}`);
                    newWindow.once("ready-to-show", () => {
                      newWindow.show();
                    });
                    postConfigure(newWindow);
                  }
                }, 500);
              },
            },
            { type: "separator" },
            {
              role: "close",
            },
          ],
        },
        {
          label: "Plugins",
          submenu: [
            {
              label: "Install Plugin…",
              click() {
                prompt({
                  title: "Install Plugin",
                  label: "Plugin name:",
                  value: "datasette-vega",
                  type: "input",
                  alwaysOnTop: true,
                })
                  .then(async (pluginName) => {
                    if (pluginName !== null) {
                      await datasette.installPlugin(pluginName);
                      await datasette.startOrRestart();
                      dialog.showMessageBoxSync({
                        type: "info",
                        message: "Plugin installed",
                      });
                    }
                  })
                  .catch(console.error);
              },
            },
            {
              label: "List Installed Plugins",
              click() {
                let newWindow = new BrowserWindow({
                  ...windowOpts(),
                  ...{ show: false },
                });
                newWindow.loadURL(`http://localhost:${port}/-/plugins`);
                newWindow.once("ready-to-show", () => {
                  newWindow.show();
                });
                postConfigure(newWindow);
              },
            },
            {
              label: "Plugins Directory",
              click() {
                shell.openExternal("https://datasette.io/plugins");
              },
            },
          ],
        },
        {
          label: 'Debug',
          submenu: [{
            label: 'Open DevTools',
            click() {
              BrowserWindow.getFocusedWindow().webContents.openDevTools();
            }
          }]
        }
      ]);
      Menu.setApplicationMenu(menu);
    }
  );
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});
