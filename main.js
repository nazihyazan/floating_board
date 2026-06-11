const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, protocol, net, shell, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');


// Auto Updater config
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Add updater IPC handlers
ipcMain.handle('updater:quit-and-install', () => {
  autoUpdater.quitAndInstall();
});

const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { isPremium, activateLicense } = require('./license.js');

const APP_NAME = 'FloatBoard';
const DEFAULT_BOUNDS = { width: 460, height: 460 };
const MIN_BOUNDS = { width: 320, height: 280 };

let mainWindow = null;
let tray = null;
let saveWindowTimer = null;
let isQuitting = false;
let restoreAlwaysOnTopAfterMinimize = false;

app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

function getUserPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function getBoardPath() {
  return getUserPath('board-data.json');
}

function getWindowStatePath() {
  return getUserPath('window-state.json');
}

function getMediaDir() {
  return getUserPath('media');
}

function getIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function readJsonSync(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tempPath, filePath);
}

function loadWindowState() {
  const state = readJsonSync(getWindowStatePath(), {});

  return {
    x: Number.isFinite(state.x) ? state.x : undefined,
    y: Number.isFinite(state.y) ? state.y : undefined,
    width: Math.max(Number(state.width) || DEFAULT_BOUNDS.width, MIN_BOUNDS.width),
    height: Math.max(Number(state.height) || DEFAULT_BOUNDS.height, MIN_BOUNDS.height),
    alwaysOnTop: state.alwaysOnTop !== false
  };
}

function saveWindowStateSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveWindowTimer);

  saveWindowTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const bounds = mainWindow.getBounds();
    writeJsonAtomic(getWindowStatePath(), {
      ...bounds,
      alwaysOnTop: mainWindow.isAlwaysOnTop()
    }).catch((error) => console.error('Failed to save window state:', error));
  }, 250);
}

function sendWindowStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const isMax = process.platform === 'win32' ? (normalBounds !== null) : mainWindow.isMaximized();
    mainWindow.webContents.send('window:status', {
      pinned: mainWindow.isAlwaysOnTop(),
      maximized: isMax,
      visible: mainWindow.isVisible()
    });
  }
}

function setPinned(value) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.setAlwaysOnTop(Boolean(value));
  saveWindowStateSoon();
  sendWindowStatus();
  updateTrayMenu();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();

  // Restore always-on-top on restore/show
  const state = loadWindowState();
  mainWindow.setAlwaysOnTop(state.alwaysOnTop);

  sendWindowStatus();
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createTray() {
  const iconPath = getIconPath();
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
    : nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', toggleWindowVisibility);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const pinned = mainWindow && !mainWindow.isDestroyed() ? mainWindow.isAlwaysOnTop() : true;
  const visible = mainWindow && !mainWindow.isDestroyed() ? mainWindow.isVisible() : false;

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? 'Hide FloatBoard' : 'Show FloatBoard',
      click: toggleWindowVisibility
    },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: pinned,
      click: (menuItem) => setPinned(menuItem.checked)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createPinnedWindow(dataUrl) {
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = `
    <html>
    <head>
      <style>
        body { margin: 0; overflow: hidden; background: transparent; -webkit-app-region: drag; }
        img { width: 100%; height: 100%; object-fit: contain; }
        .close { position: absolute; top: 4px; right: 4px; background: red; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; -webkit-app-region: no-drag; display: none; }
        body:hover .close { display: block; }
      </style>
    </head>
    <body>
      <button class="close" onclick="window.close()">X</button>
      <img src="${dataUrl}">
    </body>
    </html>
  `;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    title: APP_NAME,
    icon: getIconPath(),
    frame: process.platform === 'darwin' || process.platform === 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    transparent: process.platform !== 'win32',
    backgroundColor: process.platform === 'win32' ? '#ffffff' : '#00000000',
    hasShadow: true,
    resizable: true,
    minimizable: true,
    movable: true,
    skipTaskbar: false,
    show: false,
    alwaysOnTop: state.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...(process.platform === 'darwin' ? {
      vibrancy: 'under-window',
      visualEffectState: 'active'
    } : {}),
    ...(process.platform === 'win32' ? {
      // backgroundMaterial removed to keep it solid white
    } : {})
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    showWindow();
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];
    
    if (params.isEditable) {
      template.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.hasImageContents) {
      template.push({
        label: 'Copy as Screenshot',
        click: () => {
          mainWindow.webContents.send('context-menu:copy-screenshot', { x: params.x, y: params.y });
        }
      });
    } else if (params.selectionText) {
      template.push(
        { role: 'copy' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else {
      template.push(
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  mainWindow.on('move', saveWindowStateSoon);
  mainWindow.on('resize', () => {
    saveWindowStateSoon();
    sendWindowStatus();
  });
  mainWindow.on('maximize', sendWindowStatus);
  mainWindow.on('unmaximize', sendWindowStatus);
  mainWindow.on('restore', () => {
    const state = loadWindowState();
    if (restoreAlwaysOnTopAfterMinimize || state.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true);
    }
    restoreAlwaysOnTopAfterMinimize = false;
    sendWindowStatus();
  });
  mainWindow.on('show', () => {
    sendWindowStatus();
    updateTrayMenu();
  });
  mainWindow.on('hide', updateTrayMenu);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function normalizeBoardForRenderer(board) {
  const normalized = {
    version: 1,
    sections: []
  };

  if (!board || !Array.isArray(board.sections)) return normalized;

  for (const section of board.sections) {
    if (section.type === 'text') {
      let items = [];
      if (Array.isArray(section.items)) {
        items = section.items;
      } else if (typeof section.text === 'string' && section.text.length > 0) {
        items = [{
          id: crypto.randomUUID(),
          text: section.text,
          createdAt: section.createdAt || new Date().toISOString()
        }];
      }

      normalized.sections.push({
        type: 'text',
        items: items,
        createdAt: section.createdAt || new Date().toISOString(),
        updatedAt: section.updatedAt || new Date().toISOString()
      });
      continue;
    }

    if ((section.type === 'image' || section.type === 'video') && Array.isArray(section.items)) {
      normalized.sections.push({
        type: section.type,
        items: section.items.map((item) => {
          if (item.storage === 'file' && item.fileName) {
            const mediaPath = path.join(getMediaDir(), item.fileName);
            return {
              ...item,
              src: `app-media://${item.fileName}`,
              exists: fs.existsSync(mediaPath)
            };
          }

          return item;
        }).filter((item) => item.src || item.fileName),
        createdAt: section.createdAt || new Date().toISOString(),
        updatedAt: section.updatedAt || new Date().toISOString()
      });
    }
  }

  return normalized;
}

function sanitizeFileName(name) {
  const parsed = path.parse(name || 'media');
  const base = parsed.name
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'media';

  return `${base}${parsed.ext || ''}`;
}

function getExtensionForMedia(kind, mime, originalName) {
  const originalExt = path.extname(originalName || '');
  if (originalExt) return originalExt;

  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/quicktime') return '.mov';

  return kind === 'video' ? '.mp4' : '.bin';
}

function getMediaKindFromMime(mime) {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

function getMediaKindFromName(name) {
  const cleanName = (name || '').split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(cleanName)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/.test(cleanName)) return 'video';
  return null;
}

function minimizeMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  restoreAlwaysOnTopAfterMinimize = mainWindow.isAlwaysOnTop();
  if (restoreAlwaysOnTopAfterMinimize) {
    mainWindow.setAlwaysOnTop(false);
  }

  mainWindow.setSkipTaskbar(false);
  mainWindow.blur();

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.minimize();
    updateTrayMenu();
  }, process.platform === 'linux' ? 80 : 0);
}

ipcMain.on('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.focus();
  }
});

ipcMain.on('window:minimize', () => {
  minimizeMainWindow();
});

let normalBounds = null;
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  
  if (process.platform === 'win32') {
    // Custom maximize for Windows transparent windows
    if (normalBounds) {
      // Restore
      mainWindow.setBounds(normalBounds);
      normalBounds = null;
    } else {
      // Maximize
      normalBounds = mainWindow.getBounds();
      const { screen } = require('electron');
      const display = screen.getDisplayNearestPoint({ x: normalBounds.x, y: normalBounds.y });
      mainWindow.setBounds(display.workArea);
    }
    // Fake the maximized status for renderer
    sendWindowStatus();
  } else {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    sendWindowStatus();
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.on('window:toggle-pin', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setPinned(!mainWindow.isAlwaysOnTop());
});

ipcMain.handle('window:get-state', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { pinned: true, maximized: false, visible: false };
  }

  return {
    pinned: mainWindow.isAlwaysOnTop(),
    maximized: mainWindow.isMaximized(),
    visible: mainWindow.isVisible()
  };
});

ipcMain.handle('window:get-bounds', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { x: 0, y: 0, ...DEFAULT_BOUNDS };
  }

  return mainWindow.getBounds();
});

ipcMain.on('window:set-bounds', (_event, bounds) => {
  if (!mainWindow || mainWindow.isDestroyed() || !bounds) return;

  const current = mainWindow.getBounds();
  const next = {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : current.x,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : current.y,
    width: Math.max(Math.round(bounds.width || current.width), MIN_BOUNDS.width),
    height: Math.max(Math.round(bounds.height || current.height), MIN_BOUNDS.height)
  };

  mainWindow.setBounds(next);
});

ipcMain.handle('board:load', async () => {
  await fsp.mkdir(getMediaDir(), { recursive: true });
  const board = readJsonSync(getBoardPath(), { version: 1, sections: [] });
  return normalizeBoardForRenderer(board);
});

ipcMain.handle('board:save', async (_event, data) => {
  const safeData = {
    version: 1,
    savedAt: new Date().toISOString(),
    sections: Array.isArray(data && data.sections) ? data.sections : []
  };

  await writeJsonAtomic(getBoardPath(), safeData);
  return true;
});

ipcMain.handle('license:is-premium', () => {
  return isPremium();
});

ipcMain.handle('license:activate', (_event, key) => {
  return activateLicense(key);
});

ipcMain.handle('license:check-daily-limit', async (_event, kind) => {
  if (isPremium()) return true;
  const limitKind = kind === 'video' ? 'image' : kind;
  if (limitKind !== 'text' && limitKind !== 'image') return true;

  const usagePath = getUserPath('daily-usage.json');
  const usage = readJsonSync(usagePath, {});
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (!usage.timestamp || (now - usage.timestamp) > ONE_DAY) {
    usage.timestamp = now;
    usage.text = 0;
    usage.image = 0;
  }

  const totalUsage = (usage.text || 0) + (usage.image || 0);

  if (totalUsage >= 10) {
    return false;
  }

  usage[limitKind] = (usage[limitKind] || 0) + 1;
  await writeJsonAtomic(usagePath, usage);
  return true;
});

ipcMain.handle('license:get-daily-usage', () => {
  if (isPremium()) return 0;
  const usagePath = getUserPath('daily-usage.json');
  const usage = readJsonSync(usagePath, {});
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (!usage.timestamp || (now - usage.timestamp) > ONE_DAY) {
    return 0;
  }
  return (usage.text || 0) + (usage.image || 0);
});

ipcMain.on('open-external', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('media:import', async (_event, payload) => {
  const sourcePath = payload && payload.sourcePath;
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('Missing media source path.');
  }

  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile()) {
    throw new Error('Media source is not a file.');
  }

  await fsp.mkdir(getMediaDir(), { recursive: true });

  const kind = payload.kind === 'video' ? 'video' : 'image';
  const originalName = payload.name || path.basename(sourcePath);
  const extension = getExtensionForMedia(kind, payload.mime, originalName);
  const safeName = sanitizeFileName(originalName.replace(path.extname(originalName), extension));
  const id = crypto.randomUUID();
  const fileName = `${Date.now()}-${id}-${safeName}`;
  const destination = path.join(getMediaDir(), fileName);

  await fsp.copyFile(sourcePath, destination);

  return {
    id,
    kind,
    name: originalName,
    mime: payload.mime || '',
    size: stat.size,
    storage: 'file',
    fileName,
    src: `app-media://media/${fileName}`,
    createdAt: new Date().toISOString()
  };
});

ipcMain.handle('media:import-url', async (_event, payload) => {
  const { url, kind } = payload;
  if (!url || typeof url !== 'string') {
    throw new Error('Missing media URL.');
  }

  const parsedUrl = new URL(url.trim());
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only HTTP(S) media URLs are supported.');
  }

  const normalizedUrl = parsedUrl.toString();
  const urlParts = parsedUrl.pathname.split('/');
  const rawName = urlParts[urlParts.length - 1] || 'web-media';
  
  // Fetch remote media via main process net.fetch (immune to CORS restrictions)
  const response = await net.fetch(normalizedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote media: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  const mime = response.headers.get('content-type') || '';
  const mimeKind = getMediaKindFromMime(mime);
  const nameKind = getMediaKindFromName(rawName || parsedUrl.pathname);
  const hintedKind = kind === 'video' || kind === 'image' ? kind : null;
  const actualKind = mimeKind || nameKind || hintedKind;

  if (!actualKind) {
    throw new Error('Dropped URL is not an image or video.');
  }

  if (mime && !mimeKind && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') {
    throw new Error(`Dropped URL returned unsupported content type: ${mime}`);
  }
  
  const extension = getExtensionForMedia(actualKind, mime, rawName);
  const baseName = rawName.includes('.') ? rawName.slice(0, rawName.lastIndexOf('.')) : rawName;
  const safeName = sanitizeFileName(baseName + extension);
  const id = crypto.randomUUID();
  const fileName = `${Date.now()}-${id}-${safeName}`;
  const destination = path.join(getMediaDir(), fileName);

  await fsp.mkdir(getMediaDir(), { recursive: true });
  await fsp.writeFile(destination, buffer);

  return {
    id,
    kind: actualKind,
    name: rawName,
    mime,
    size: buffer.length,
    storage: 'file',
    fileName,
    src: `app-media://media/${fileName}`,
    createdAt: new Date().toISOString()
  };
});

ipcMain.handle('media:save-blob', async (event, arrayBuffer) => {
  try {
    const ext = '.png';
    const id = crypto.randomUUID();
    const fileName = `${Date.now()}-${id}${ext}`;
    const destination = path.join(getMediaDir(), fileName);
    
    // We receive an ArrayBuffer from the renderer, convert to Buffer
    const buffer = Buffer.from(arrayBuffer);
    await fsp.mkdir(getMediaDir(), { recursive: true });
    await fsp.writeFile(destination, buffer);
    return `app-media://media/${fileName}`;
  } catch (err) {
    console.error('Failed to save blob:', err);
    return null;
  }
});

app.whenReady().then(() => {
  // Set the App User Model ID so the taskbar icon shows correctly on Windows and Linux
  app.setAppUserModelId('com.nazih.floatboard');
  if (process.platform === 'linux') {
    app.setDesktopName('floatboard.desktop');
  }

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    console.error('Failed to check for updates:', err);
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-downloaded', info);
    }
  });

  // Register custom app-media protocol to load local files safely without webSecurity blocks
  protocol.handle('app-media', async (request) => {
    try {
      const url = new URL(request.url);
      const mediaDir = getMediaDir();
      
      let fileName = decodeURIComponent(
        url.pathname && url.pathname !== '/'
          ? url.pathname.replace(/^\/+/, '')
          : url.host
      );
      
      // Parse case-preserving pathname if host is 'media'
      if (url.host === 'media' && url.pathname) {
        fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      }

      let filePath = path.join(mediaDir, fileName);

      // Backwards compatibility for broken legacy lowercase host URLs
      if (!fs.existsSync(filePath)) {
        const files = await fsp.readdir(mediaDir);
        const lowerName = fileName.toLowerCase();
        const match = files.find(f => f.toLowerCase() === lowerName);
        if (match) {
          filePath = path.join(mediaDir, match);
        }
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      console.error('Failed to handle app-media protocol request:', error);
      return new Response('Not Found', { status: 404 });
    }
  });
// Removed theme:change since titleBarOverlay is no longer used

  createWindow();
  createTray();
  
  // Clipboard History Polling
  const clipHistory = [];
  let lastText = '';
  let lastImageHash = '';
  let ignoreNextClipboardImage = false;
  
  ipcMain.on('clipboard:ignore-next', () => {
    ignoreNextClipboardImage = true;
  });

  setInterval(() => {
    const text = clipboard.readText();
    if (text && text !== lastText) {
      lastText = text;
      // Push new text to history, remove duplicates, keep top 10
      const existingIdx = clipHistory.findIndex(item => item.type === 'text' && item.content === text);
      if (existingIdx !== -1) clipHistory.splice(existingIdx, 1);
      clipHistory.unshift({ type: 'text', content: text, timestamp: Date.now() });
      if (clipHistory.length > 10) clipHistory.pop();
    }

    // Auto-import clipboard images as screenshots
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      const imgBuffer = img.toPNG();
      const imgHash = crypto.createHash('md5').update(imgBuffer).digest('hex');
      if (imgHash !== lastImageHash) {
        lastImageHash = imgHash;
        
        if (ignoreNextClipboardImage) {
          ignoreNextClipboardImage = false;
          return;
        }
        
        const fileName = `${Date.now()}-${crypto.randomUUID()}.png`;
        const dest = path.join(getMediaDir(), fileName);
        fsp.mkdir(getMediaDir(), { recursive: true }).then(() => {
          return fsp.writeFile(dest, imgBuffer);
        }).then(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
             mainWindow.webContents.send('media:auto-added', {
               id: crypto.randomUUID(),
               kind: 'image',
               name: 'screenshot.png',
               mime: 'image/png',
               size: imgBuffer.length,
               storage: 'file',
               fileName,
               src: `app-media://media/${fileName}`,
               createdAt: new Date().toISOString()
             });
          }
        }).catch(err => console.error('Failed to auto-save clipboard image:', err));
      }
    }
  }, 1000);

  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) showWindow();
      mainWindow.webContents.send('history:show', clipHistory);
    }
  });

  if (process.platform === 'win32' || process.platform === 'darwin') {
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      let cmd = '';
      if (process.platform === 'win32') {
        cmd = 'powershell.exe -Command "Start-Process ms-screenclip:"';
      } else if (process.platform === 'darwin') {
        cmd = 'screencapture -i -c';
      }
      if (cmd) {
        exec(cmd, (error) => {
          if (error) {
            console.error('Failed to trigger native screenshot tool:', error);
          }
        });
      }
    });
  }
  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowStateSoon();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (event) => {
  if (!isQuitting) {
    event.preventDefault();
  }
});
