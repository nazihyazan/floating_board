const api = window.floatingBoard;

// Instant theme application on load to prevent flashing
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light');

// Add platform class for OS specific styling
if (api.getPlatform) {
  document.body.classList.add(`platform-${api.getPlatform()}`);
}

const TYPE_META = {
  text: {
    title: 'Text',
    icon: '<path d="M5 5h14M7 9h10M7 13h7M7 17h9"></path>'
  },
  image: {
    title: 'Images',
    icon: '<path d="M4 5h16v14H4z"></path><path d="M7 15l3-3 3 3 2-2 3 3"></path><circle cx="9" cy="9" r="1.5"></circle>'
  },
  video: {
    title: 'Videos',
    icon: '<path d="M4 6h16v12H4z"></path><path d="M10 9l5 3-5 3z"></path>'
  },
  split: {
    title: 'Split View',
    icon: '<rect x="3" y="3" width="8" height="18" rx="2" ry="2"></rect><rect x="13" y="3" width="8" height="18" rx="2" ry="2"></rect>'
  },
  grid: {
    title: 'Grid View',
    icon: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>'
  },
  code: {
    title: 'Code Snippet',
    icon: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>'
  }
};

const MAX_INLINE_BYTES = 64 * 1024 * 1024;

const boardEl = document.getElementById('board');
const sectionsEl = document.getElementById('sections');
const emptyStateEl = document.getElementById('empty-state');
const toastEl = document.getElementById('toast');
const resizeGripEl = document.getElementById('resize-grip');
const pinBtn = document.getElementById('pin-btn');
const maximizeBtn = document.getElementById('maximize-btn');

let state = {
  version: 1,
  sections: []
};

let isPremium = false;
let upgradeModal = null;

let hasShownUpgradeModal = false;

function checkDailyLimit(kind) {
  if (isPremium) return true;
  // We'll map video to image for the limit.
  const limitKind = kind === 'video' ? 'image' : kind;
  if (limitKind !== 'text' && limitKind !== 'image') return true;

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  let usage = {};
  try {
    usage = JSON.parse(localStorage.getItem('daily_usage')) || {};
  } catch (e) {
    usage = {};
  }

  if (!usage.timestamp || (now - usage.timestamp) > ONE_DAY) {
    usage = { timestamp: now, text: 0, image: 0 };
  }

  const totalUsage = (usage.text || 0) + (usage.image || 0);

  if (totalUsage >= 10) {
    if (!hasShownUpgradeModal) {
      hasShownUpgradeModal = true;
      showToast(`Daily limit reached (10/10). Upgrade to Premium for unlimited access.`);
      api.openExternal('https://floatboard.xyz/pricing.html');
    } else {
      showToast(`Daily limit reached. The pricing page has been opened in your browser.`);
    }
    return false;
  }

  usage[limitKind]++;
  localStorage.setItem('daily_usage', JSON.stringify(usage));
  return true;
}

let activeType = null;
let pendingTextFocus = false;
let saveTimer = null;
let toastTimer = null;
let snowEnabled = localStorage.getItem('snowEnabled') === 'true';
let snowCanvas = null;
let snowCtx = null;
let snowAnimationId = null;
let snowflakes = [];
let historyItems = [];
let isLicenseModalOpen = false;
try {
  historyItems = JSON.parse(localStorage.getItem('board_history')) || [];
} catch (_) {
  historyItems = [];
}

document.getElementById('close-btn').addEventListener('click', () => {
  saveNow();
  api.close();
});

document.getElementById('minimize-btn').addEventListener('click', () => api.minimize());
maximizeBtn.addEventListener('click', () => api.toggleMaximize());

pinBtn.addEventListener('click', () => api.togglePin());

api.onWindowStatus(updateWindowStatus);
api.getWindowState().then(updateWindowStatus).catch(() => {});

function updateWindowStatus(status) {
  if (!status) return;

  pinBtn.classList.toggle('pinned', Boolean(status.pinned));
  pinBtn.setAttribute('aria-pressed', String(Boolean(status.pinned)));
  maximizeBtn.classList.toggle('maximized', Boolean(status.maximized));
}

function createId() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('visible');
  }, 2600);
}

function getKind(file) {
  const type = file.type || '';
  const name = (file.name || '').toLowerCase();

  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(name)) {
    return 'image';
  }

  if (type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/.test(name)) {
    return 'video';
  }

  return null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function normalizeHttpUrl(value, baseUrl) {
  const rawValue = String(value || '').trim();
  if (!rawValue || rawValue.startsWith('data:') || rawValue.startsWith('blob:')) return '';

  try {
    const url = baseUrl ? new URL(rawValue, baseUrl) : new URL(rawValue);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch (_error) {
    if (!/[?&](imgurl|mediaurl|image_url|image|img|url|u)=/i.test(rawValue)) return '';

    try {
      const wrappedUrl = new URL(rawValue, 'https://www.google.com');
      return wrappedUrl.toString();
    } catch (_innerError) {
      return '';
    }
  }
}

function unwrapKnownMediaUrl(value) {
  let currentUrl = normalizeHttpUrl(value);
  if (!currentUrl) return '';

  const mediaParamNames = ['imgurl', 'mediaurl', 'image_url', 'image', 'img', 'url', 'u'];

  for (let index = 0; index < 3; index += 1) {
    let nextUrl = '';

    try {
      const parsedUrl = new URL(currentUrl);
      for (const paramName of mediaParamNames) {
        const candidate = normalizeHttpUrl(parsedUrl.searchParams.get(paramName));
        if (candidate && candidate !== currentUrl) {
          nextUrl = candidate;
          break;
        }
      }
    } catch (_error) {
      break;
    }

    if (!nextUrl) break;
    currentUrl = nextUrl;
  }

  return currentUrl;
}

function inferKindFromUrl(value) {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(path)) return 'image';
    if (/\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/.test(path)) return 'video';
  } catch (_error) {
    return null;
  }

  return null;
}

function mediaCandidateFromUrl(value, fallbackKind = null) {
  const url = unwrapKnownMediaUrl(value);
  if (!url) return null;

  const kind = inferKindFromUrl(url) || fallbackKind;
  if (kind !== 'image' && kind !== 'video') return null;

  return { url, kind };
}

function firstUriListUrl(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && isHttpUrl(line)) || '';
}

function candidateFromElementUrl(element, attribute, fallbackKind, baseUrl) {
  const rawUrl = element && element.getAttribute(attribute);
  return mediaCandidateFromUrl(normalizeHttpUrl(rawUrl, baseUrl), fallbackKind);
}

function linkedMediaCandidate(element, baseUrl) {
  const link = element && element.closest && element.closest('a[href]');
  if (!link) return null;

  return candidateFromElementUrl(link, 'href', null, baseUrl);
}

function extractMediaCandidateFromHtml(html) {
  if (!html) return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const baseUrl = normalizeHttpUrl(doc.querySelector('base[href]')?.getAttribute('href'));

    const video = doc.querySelector('video[src], video source[src], source[type^="video/"][src]');
    const videoCandidate = candidateFromElementUrl(video, 'src', 'video', baseUrl)
      || linkedMediaCandidate(video, baseUrl);
    if (videoCandidate) return videoCandidate;

    for (const image of Array.from(doc.querySelectorAll('img[src], source[type^="image/"][src]'))) {
      const imageCandidate = candidateFromElementUrl(image, 'src', 'image', baseUrl)
        || linkedMediaCandidate(image, baseUrl);
      if (imageCandidate) return imageCandidate;
    }

    const linkedMedia = doc.querySelector('a[href]');
    return candidateFromElementUrl(linkedMedia, 'href', null, baseUrl);
  } catch (error) {
    console.error('Failed to parse dropped HTML:', error);
    return null;
  }
}

function extractMediaCandidateFromDownloadUrl(value) {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) return null;

  const mime = value.slice(0, firstSeparator);
  const url = value.slice(secondSeparator + 1);
  const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : inferKindFromUrl(url);

  return mediaCandidateFromUrl(url, kind);
}

function extractMediaCandidateFromDrop(dataTransfer) {
  const htmlMedia = extractMediaCandidateFromHtml(dataTransfer.getData('text/html'));
  if (htmlMedia) return htmlMedia;

  const downloadUrl = dataTransfer.getData('DownloadURL');
  if (downloadUrl) {
    const downloadMedia = extractMediaCandidateFromDownloadUrl(downloadUrl);
    if (downloadMedia) return downloadMedia;
  }

  const uriListUrl = firstUriListUrl(dataTransfer.getData('text/uri-list'));
  if (uriListUrl) {
    const uriListMedia = mediaCandidateFromUrl(uriListUrl);
    if (uriListMedia) return uriListMedia;
  }

  const textUrl = dataTransfer.getData('text/plain').trim();
  return mediaCandidateFromUrl(textUrl);
}

function getVisibleSections() {
  return state.sections.filter((section) => {
    const hasItems = Array.isArray(section.items) && section.items.length > 0;
    if (section.type === 'text') {
      return hasItems || activeType === 'text';
    }

    return hasItems;
  });
}

function ensureSection(type) {
  let section = state.sections.find((item) => item.type === type);

  if (!section) {
    section = { type, items: [], createdAt: now(), updatedAt: now() };
    state.sections.push(section);
  }

  return section;
}

function removeSection(type) {
  state.sections = state.sections.filter((section) => section.type !== type);
  if (activeType === type) activeType = null;
}

function cleanBoardForSave() {
  const sections = [];

  for (const section of state.sections) {
    if (section.type === 'text') {
      const items = (section.items || []).filter(item => item.text && item.text.trim().length > 0);
      if (items.length === 0 && activeType !== 'text') continue;
      sections.push({
        type: 'text',
        items: items,
        createdAt: section.createdAt,
        updatedAt: section.updatedAt
      });
      continue;
    }

    if (section.type === 'image' || section.type === 'video') {
      const items = (section.items || [])
        .filter((item) => item.storage === 'file' ? item.fileName : item.src)
        .map((item) => ({
          id: item.id,
          kind: item.kind || section.type,
          name: item.name || '',
          mime: item.mime || '',
          size: item.size || 0,
          storage: item.storage || 'inline',
          fileName: item.storage === 'file' ? item.fileName : undefined,
          src: item.storage === 'file' ? undefined : item.src,
          createdAt: item.createdAt || now()
        }));

      if (items.length === 0) continue;

      sections.push({
        type: section.type,
        items,
        createdAt: section.createdAt,
        updatedAt: section.updatedAt
      });
    }
  }

  return {
    version: 1,
    sections
  };
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

async function saveNow() {
  clearTimeout(saveTimer);

  try {
    await api.saveBoard(cleanBoardForSave());
  } catch (error) {
    console.error(error);
    showToast('Save failed');
  }
}

function normalizeLoadedBoard(data) {
  const next = { version: 1, sections: [] };

  if (!data || !Array.isArray(data.sections)) return next;

  for (const section of data.sections) {
    if (section.type === 'text') {
      let items = [];
      if (Array.isArray(section.items)) {
        items = section.items;
      } else if (typeof section.text === 'string' && section.text.length > 0) {
        items = [{
          id: createId(),
          text: section.text,
          createdAt: section.createdAt || now()
        }];
      }

      next.sections.push({
        type: 'text',
        items: items,
        createdAt: section.createdAt || now(),
        updatedAt: section.updatedAt || now()
      });
      continue;
    }

    if (['image', 'video', 'split', 'grid', 'code'].includes(section.type)) {
      next.sections.push({
        type: section.type,
        id: section.id || `sec-${Date.now()}-${Math.random()}`,
        items: Array.isArray(section.items)
          ? section.items.filter((item) => item && (item.src || item.fileName || section.type === 'split' || section.type === 'grid' || section.type === 'code'))
          : [],
        createdAt: section.createdAt || now(),
        updatedAt: section.updatedAt || now()
      });
    }
  }

  return next;
}

function render(options = {}) {
  if (options.focusText) pendingTextFocus = true;

  const visibleSections = getVisibleSections();
  const count = visibleSections.length;

  sectionsEl.dataset.count = String(count);
  sectionsEl.style.setProperty('--section-count', String(Math.max(count, 1)));
  emptyStateEl.hidden = count > 0;
  emptyStateEl.classList.toggle('is-hidden', count > 0);
  emptyStateEl.setAttribute('aria-hidden', String(count > 0));
  sectionsEl.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (const section of visibleSections) {
    fragment.appendChild(renderSection(section));
  }
  sectionsEl.appendChild(fragment);

  if (pendingTextFocus) {
    requestAnimationFrame(() => {
      const editors = sectionsEl.querySelectorAll('.text-card-editor');
      if (editors.length > 0) {
        const lastEditor = editors[editors.length - 1];
        lastEditor.focus();
        lastEditor.selectionStart = lastEditor.selectionEnd = lastEditor.value.length;
      }
      pendingTextFocus = false;
    });
  }
}

function renderSection(section) {
  const sectionEl = document.createElement('section');
  sectionEl.className = `content-section ${section.type}-section`;
  sectionEl.dataset.type = section.type;

  const count = Array.isArray(section.items) ? section.items.length : 0;

  sectionEl.innerHTML = `
    <header class="section-header">
      <div class="section-label">
        <svg viewBox="0 0 24 24" aria-hidden="true">${TYPE_META[section.type].icon}</svg>
        <span class="section-title">${TYPE_META[section.type].title} ${count}</span>
      </div>
      <div class="section-actions">
        <button class="section-button clear-section" type="button" aria-label="Clear ${TYPE_META[section.type].title}" title="Clear">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18"></path>
          </svg>
        </button>
      </div>
    </header>
    <div class="section-body"></div>
  `;

  sectionEl.querySelector('.clear-section').addEventListener('click', () => {
    if (Array.isArray(section.items)) {
      for (const item of section.items) {
        addToHistory({
          type: section.type,
          text: item.text,
          src: item.src,
          name: item.name,
          storage: item.storage,
          fileName: item.fileName,
          createdAt: item.createdAt || now()
        });
      }
    }
    removeSection(section.type);
    render();
    queueSave();
  });

  const body = sectionEl.querySelector('.section-body');
  if (section.type === 'text') {
    body.appendChild(renderTextEditor(section));
  } else if (section.type === 'split') {
    const splitDiv = document.createElement('div');
    splitDiv.className = 'split-view';
    splitDiv.innerHTML = `
      <textarea class="split-text" placeholder="Enter text here..."></textarea>
      <div class="split-img">Drag image here</div>
    `;
    body.appendChild(splitDiv);
  } else if (section.type === 'grid') {
    const gridDiv = document.createElement('div');
    gridDiv.className = 'image-grid-2x2';
    gridDiv.innerHTML = `
      <div class="grid-cell">Image 1</div>
      <div class="grid-cell">Image 2</div>
      <div class="grid-cell">Image 3</div>
      <div class="grid-cell">Image 4</div>
    `;
    body.appendChild(gridDiv);
  } else if (section.type === 'code') {
    const codeArea = document.createElement('textarea');
    codeArea.className = 'code-block';
    codeArea.placeholder = '// Paste your code here\nfunction helloWorld() {\n  console.log("Hello");\n}';
    body.appendChild(codeArea);
  } else {
    body.appendChild(renderMediaGrid(section));
  }

  return sectionEl;
}

function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function renderTextCard(item, section) {
  const card = document.createElement('div');
  card.className = 'text-card';
  card.dataset.id = item.id;

  card.innerHTML = `
    <div class="text-card-header">
      <span class="text-card-time">${formatTime(item.createdAt)}</span>
      <div class="text-card-actions">
        <button class="text-card-action-btn copy-btn" title="Copy text" type="button">
          <svg viewBox="0 0 24 24">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
          </svg>
        </button>
        <button class="text-card-action-btn delete-btn" title="Delete text" type="button">
          <svg viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="text-card-body">
      <textarea class="text-card-editor" placeholder="Text">${item.text}</textarea>
    </div>
  `;

  const textarea = card.querySelector('.text-card-editor');

  function autoResize() {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  setTimeout(autoResize, 0);

  textarea.addEventListener('input', () => {
    item.text = textarea.value;
    autoResize();
    queueSave();
  });

  textarea.addEventListener('focus', () => {
    activeType = 'text';
  });

  textarea.addEventListener('blur', () => {
    if (textarea.value.trim().length === 0) {
      if (item.text && item.text.trim().length > 0) {
        addToHistory({ type: 'text', text: item.text, createdAt: item.createdAt });
      }
      section.items = section.items.filter(i => i.id !== item.id);
      section.updatedAt = now();
      if (section.items.length === 0) {
        removeSection('text');
      }
      render();
      queueSave();
    }
  });

  card.querySelector('.copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Copy failed');
    }
  });

  card.querySelector('.delete-btn').addEventListener('click', () => {
    addToHistory({ type: 'text', text: item.text, createdAt: item.createdAt });
    section.items = section.items.filter(i => i.id !== item.id);
    section.updatedAt = now();
    if (section.items.length === 0) {
      removeSection('text');
    }
    render();
    queueSave();
  });

  return card;
}

function renderTextEditor(section) {
  const container = document.createElement('div');
  container.className = 'text-list-container';

  if (!section.items) {
    section.items = [];
  }

  if (section.items.length === 0 && activeType === 'text') {
    section.items.push({
      id: createId(),
      text: '',
      createdAt: now()
    });
  }

  section.items.forEach((item) => {
    container.appendChild(renderTextCard(item, section));
  });

  return container;
}

function renderMediaGrid(section) {
  const grid = document.createElement('div');
  grid.className = `media-grid ${section.items.length === 1 ? 'single' : ''}`;

  for (const item of section.items) {
    const mediaItem = document.createElement('article');
    mediaItem.className = 'media-item';
    mediaItem.title = item.name || TYPE_META[section.type].title;

    if (item.exists === false) {
      mediaItem.innerHTML = '<div class="missing-media">Missing file</div>';
    } else if (section.type === 'image') {
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = item.name || 'Image';
      mediaItem.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.src = item.src;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      mediaItem.appendChild(video);
    }

    const removeButton = document.createElement('button');
    removeButton.className = 'media-remove';
    removeButton.type = 'button';
    removeButton.setAttribute('aria-label', `Remove ${escapeHtml(item.name || section.type)}`);
    removeButton.title = 'Remove';
    removeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
    removeButton.addEventListener('click', () => {
      addToHistory({ 
        type: section.type, 
        src: item.src, 
        name: item.name, 
        storage: item.storage, 
        fileName: item.fileName, 
        createdAt: item.createdAt || now() 
      });
      section.items = section.items.filter((candidate) => candidate.id !== item.id);
      section.updatedAt = now();
      if (section.items.length === 0) removeSection(section.type);
      render();
      queueSave();
    });
    mediaItem.appendChild(removeButton);

    if (item.exists !== false && section.type === 'image') {
      const copyButton = document.createElement('button');
      copyButton.className = 'media-copy';
      copyButton.type = 'button';
      copyButton.setAttribute('aria-label', `Copy ${escapeHtml(item.name || 'Image')}`);
      copyButton.title = 'Copy as Screenshot';
      copyButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
        </svg>
      `;
      copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const displayImg = mediaItem.querySelector('img');
        if (displayImg) {
          await captureImageToClipboard(displayImg);
        } else {
          showToast('No image to copy');
        }
      });
      mediaItem.appendChild(copyButton);
    }

    grid.appendChild(mediaItem);
  }

  return grid;
}

function addText(text) {
  if (!text) return;
  
  if (!checkDailyLimit('text')) {
    return;
  }

  const section = ensureSection('text');
  if (!section.items) {
    section.items = [];
  }
  section.items.push({
    id: createId(),
    text: text,
    createdAt: now()
  });
  section.updatedAt = now();
  activeType = 'text';
  render({ focusText: true });
  queueSave();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function createMediaItem(file, kind) {
  const sourcePath = api.getFilePath(file);

  if (sourcePath) {
    try {
      return await api.importMedia({
        sourcePath,
        kind,
        name: file.name || `${kind}-${Date.now()}`,
        mime: file.type || ''
      });
    } catch (error) {
      console.warn('Falling back to inline media:', error);
    }
  }

  if (file.size > MAX_INLINE_BYTES) {
    throw new Error('Large media needs to be dropped from a local file.');
  }

  return {
    id: createId(),
    kind,
    name: file.name || `${kind}-${Date.now()}`,
    mime: file.type || '',
    size: file.size || 0,
    storage: 'inline',
    src: await readAsDataUrl(file),
    createdAt: now()
  };
}

async function flattenImageToItem(src, originalName = 'screenshot.png') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Allow cross-origin to avoid tainted canvas if loading from remote URL
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, img.width, img.height);
        
        canvas.toBlob(async (blob) => {
          if (!blob) return reject(new Error('Failed to create blob'));
          const buffer = await blob.arrayBuffer();
          const savedSrc = await api.saveBlob(buffer);
          if (!savedSrc) return reject(new Error('Failed to save flattened image'));
          
          resolve({
            id: crypto.randomUUID(),
            kind: 'image',
            name: originalName,
            mime: 'image/png',
            size: blob.size,
            storage: 'file',
            fileName: savedSrc.split('/').pop(),
            src: savedSrc,
            createdAt: now()
          });
        }, 'image/png', 1.0);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image for flattening'));
    img.src = src;
  });
}

async function addFile(file) {
  const kind = getKind(file);
  if (!kind) return false;

  if (!checkDailyLimit(kind)) {
    return false;
  }

  try {
    const section = ensureSection(kind);
    let item;
    if (kind === 'image') {
      const tempSrc = URL.createObjectURL(file);
      item = await flattenImageToItem(tempSrc, file.name);
      URL.revokeObjectURL(tempSrc);
    } else {
      item = await createMediaItem(file, kind);
    }
    section.items.push(item);
    section.updatedAt = now();
    activeType = kind;
    render();
    queueSave();
    return true;
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Media import failed');
    return false;
  }
}

async function addFiles(files) {
  let handled = false;

  for (const file of files) {
    handled = await addFile(file) || handled;
  }

  return handled;
}

async function addMediaFromUrl(url, kind) {
  if (!checkDailyLimit(kind)) {
    return false;
  }
  try {
    // Note: The main process downloads the file and returns a saved app-media:// path
    let item = await api.importMediaUrl({ url, kind });
    
    // WYSIWYG Image Flattening: if it's an image, draw it to a canvas and save the flattened version
    if (kind === 'image') {
      const flattenedItem = await flattenImageToItem(item.src, item.name);
      // We overwrite the imported item with the flattened item
      item = flattenedItem;
    }
    
    const section = ensureSection(item.kind);
    section.items.push(item);
    section.updatedAt = now();
    activeType = item.kind;
    render();
    queueSave();
    return true;
  } catch (error) {
    console.error(error);
    showToast(`Could not import web ${kind === 'video' ? 'video' : 'image'}`);
    return false;
  }
}

document.addEventListener('paste', async (event) => {
  if (isLicenseModalOpen) return;
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const text = clipboard.getData('text/plain');
  const files = [];

  for (const item of Array.from(clipboard.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && getKind(file)) files.push(file);
  }

  if (!text && files.length === 0) return;

  event.preventDefault();
  if (text) addText(text);
  if (files.length > 0) await addFiles(files);
});// Prevent default drag and drop behavior to avoid accidental app navigation
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;



  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest('textarea, input, button, video')) return;

  // Ignore spacebar to prevent accidental text creation and limit checks
  if (event.key === ' ') return;

  if (event.key.length === 1) {
    event.preventDefault();
    addText(event.key);
  }
});

sectionsEl.addEventListener('click', (event) => {
  const section = event.target.closest('.content-section');
  if (!section) return;
  activeType = section.dataset.type;
});

boardEl.addEventListener('click', (event) => {
  if (event.target !== boardEl && event.target !== emptyStateEl) return;
  if (getVisibleSections().length === 0) {
    activeType = 'text';
    ensureSection('text');
    render({ focusText: true });
  }
});

function shouldIgnoreMove(target) {
  return Boolean(target.closest('button, textarea, input, video, .resize-grip, .chrome-bar'));
}

let moveState = null;

boardEl.addEventListener('pointerdown', async (event) => {
  if (event.button !== 0 || shouldIgnoreMove(event.target)) return;

  moveState = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    bounds: await api.getWindowBounds(),
    moving: false
  };

  boardEl.setPointerCapture(event.pointerId);
});

boardEl.addEventListener('pointermove', (event) => {
  if (!moveState || moveState.pointerId !== event.pointerId) return;

  const dx = event.screenX - moveState.startX;
  const dy = event.screenY - moveState.startY;
  if (!moveState.moving && Math.hypot(dx, dy) < 4) return;

  moveState.moving = true;
  api.setWindowBounds({
    ...moveState.bounds,
    x: moveState.bounds.x + dx,
    y: moveState.bounds.y + dy
  });
});

boardEl.addEventListener('pointerup', (event) => {
  if (!moveState || moveState.pointerId !== event.pointerId) return;
  boardEl.releasePointerCapture(event.pointerId);
  moveState = null;
});

boardEl.addEventListener('pointercancel', () => {
  moveState = null;
});

let resizeState = null;

resizeGripEl.addEventListener('pointerdown', async (event) => {
  event.preventDefault();
  resizeState = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    bounds: await api.getWindowBounds()
  };
  resizeGripEl.setPointerCapture(event.pointerId);
});

resizeGripEl.addEventListener('pointermove', (event) => {
  if (!resizeState || resizeState.pointerId !== event.pointerId) return;

  api.setWindowBounds({
    ...resizeState.bounds,
    width: resizeState.bounds.width + event.screenX - resizeState.startX,
    height: resizeState.bounds.height + event.screenY - resizeState.startY
  });
});

resizeGripEl.addEventListener('pointerup', (event) => {
  if (!resizeState || resizeState.pointerId !== event.pointerId) return;
  resizeGripEl.releasePointerCapture(event.pointerId);
  resizeState = null;
});

resizeGripEl.addEventListener('pointercancel', () => {
  resizeState = null;
});

window.addEventListener('beforeunload', () => {
  saveNow();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});

function addToHistory(item) {
  // Cap history size to 50 items so the app remains fast and responsive
  historyItems.unshift({
    id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    deletedAt: now(),
    ...item
  });
  if (historyItems.length > 50) {
    historyItems.pop();
  }
  localStorage.setItem('board_history', JSON.stringify(historyItems));
  renderHistoryList();
}

function restoreHistoryItem(id) {
  const itemIndex = historyItems.findIndex(i => i.id === id);
  if (itemIndex === -1) return;
  const histItem = historyItems[itemIndex];
  
  // Remove from history
  historyItems.splice(itemIndex, 1);
  localStorage.setItem('board_history', JSON.stringify(historyItems));
  renderHistoryList();

  // Add back to active board state
  const section = ensureSection(histItem.type);
  const newItem = {
    id: crypto.randomUUID ? crypto.randomUUID() : 'id_' + Date.now(),
    createdAt: histItem.createdAt || now()
  };

  if (histItem.type === 'text') {
    newItem.text = histItem.text;
  } else {
    newItem.src = histItem.src;
    newItem.name = histItem.name;
    newItem.storage = histItem.storage;
    newItem.fileName = histItem.fileName;
  }

  section.items.push(newItem);
  section.updatedAt = now();
  render();
  queueSave();
  showToast('Restored successfully');
}

function deleteHistoryItem(id) {
  const itemIndex = historyItems.findIndex(i => i.id === id);
  if (itemIndex === -1) return;
  historyItems.splice(itemIndex, 1);
  localStorage.setItem('board_history', JSON.stringify(historyItems));
  renderHistoryList();
  showToast('Deleted permanently');
}

function clearAllHistory() {
  if (historyItems.length === 0) return;
  historyItems = [];
  localStorage.setItem('board_history', JSON.stringify(historyItems));
  renderHistoryList();
  showToast('History cleared');
}

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  if (historyItems.length === 0) {
    listEl.innerHTML = `
      <div class="history-empty-state">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <span>No history available</span>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';
  for (const item of historyItems) {
    const itemEl = document.createElement('div');
    itemEl.className = 'history-item';

    let bodyContent = '';
    let emojiIcon = '📝';
    if (item.type === 'text') {
      emojiIcon = '📝';
      bodyContent = escapeHtml(item.text);
    } else if (item.type === 'image') {
      emojiIcon = '🖼️';
      bodyContent = escapeHtml(item.name || 'Image');
    } else if (item.type === 'video') {
      emojiIcon = '🎬';
      bodyContent = escapeHtml(item.name || 'Video');
    }

    itemEl.innerHTML = `
      <div class="history-item-icon">${emojiIcon}</div>
      <div class="history-item-text">${bodyContent}</div>
      <div class="history-item-actions">
        <button class="history-action-btn restore" type="button" title="Restore to board">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
        </button>
        <button class="history-action-btn delete" type="button" title="Delete permanently">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
          </svg>
        </button>
      </div>
    `;

    itemEl.querySelector('.restore').addEventListener('click', () => restoreHistoryItem(item.id));
    itemEl.querySelector('.delete').addEventListener('click', () => deleteHistoryItem(item.id));

    listEl.appendChild(itemEl);
  }
}

async function init() {
  try {
    isPremium = await api.isPremium();
  } catch (error) {
    console.error('Failed to check premium status', error);
  }

  try {
    state = normalizeLoadedBoard(await api.loadBoard());
  } catch (error) {
    console.error(error);
    showToast('Load failed');
  }

  // Settings Panel Initialization
  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  // Shortcuts Panel Initialization
  const shortcutsBtn = document.getElementById('shortcuts-btn');
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  const shortcutsCloseBtn = document.getElementById('shortcuts-close-btn');

  if (shortcutsBtn && shortcutsOverlay) {
    shortcutsBtn.addEventListener('click', () => {
      shortcutsOverlay.classList.add('active');
    });
  }

  if (shortcutsCloseBtn && shortcutsOverlay) {
    shortcutsCloseBtn.addEventListener('click', () => {
      shortcutsOverlay.classList.remove('active');
    });
  }

  if (shortcutsOverlay) {
    shortcutsOverlay.addEventListener('click', (e) => {
      if (e.target === shortcutsOverlay) {
        shortcutsOverlay.classList.remove('active');
      }
    });
  }

  if (settingsBtn && settingsOverlay) {
    settingsBtn.addEventListener('click', () => {
      settingsOverlay.classList.add('active');
    });
  }

  if (settingsCloseBtn && settingsOverlay) {
    settingsCloseBtn.addEventListener('click', () => {
      settingsOverlay.classList.remove('active');
    });
  }

  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) {
        settingsOverlay.classList.remove('active');
      }
    });
  }

  // License Panel Initialization
  const activateBtn = document.getElementById('activate-btn');
  const licenseOverlay = document.getElementById('license-overlay');
  const licenseCloseBtn = document.getElementById('license-close-btn');
  const licenseInput = document.getElementById('license-input');
  const licenseSubmitBtn = document.getElementById('license-submit-btn');
  const licenseError = document.getElementById('license-error');

  const premiumBadge = document.getElementById('premium-badge');
  const activationEmail = document.getElementById('activation-email');

  if (isPremium) {
    if (activateBtn) activateBtn.style.display = 'none';
    if (premiumBadge) premiumBadge.style.display = 'inline-block';
  }

  if (activateBtn && licenseOverlay) {
    activateBtn.addEventListener('click', () => {
      licenseOverlay.classList.add('active');
      isLicenseModalOpen = true;
      if (licenseError) licenseError.style.display = 'none';
      if (licenseInput) licenseInput.focus();
    });
  }

  const buyLicenseBtn = document.getElementById('buy-license-btn');
  if (buyLicenseBtn && activationEmail) {
    buyLicenseBtn.addEventListener('click', async () => {
      const email = activationEmail.value.trim();
      if (!email) {
        if (licenseError) {
          licenseError.textContent = 'Please enter your email to continue to purchase';
          licenseError.style.display = 'block';
        }
        return;
      }
      if (licenseError) licenseError.style.display = 'none';
      buyLicenseBtn.disabled = true;
      buyLicenseBtn.textContent = 'Opening checkout...';
      
      const checkoutUrl = await createCheckout(email);
      if (checkoutUrl) {
        api.openExternal(checkoutUrl);
      } else {
        if (licenseError) {
          licenseError.textContent = 'Failed to generate checkout link. Please try again.';
          licenseError.style.display = 'block';
        }
      }
      
      buyLicenseBtn.disabled = false;
      buyLicenseBtn.textContent = 'Buy License';
    });
  }

  if (licenseCloseBtn && licenseOverlay) {
    licenseCloseBtn.addEventListener('click', () => {
      licenseOverlay.classList.remove('active');
      isLicenseModalOpen = false;
    });
  }

  if (licenseOverlay) {
    licenseOverlay.addEventListener('click', (e) => {
      if (e.target === licenseOverlay) {
        licenseOverlay.classList.remove('active');
        isLicenseModalOpen = false;
      }
    });
  }

  if (licenseSubmitBtn && licenseInput && activationEmail) {
    licenseSubmitBtn.addEventListener('click', async () => {
      const email = activationEmail.value.trim();
      const key = licenseInput.value.trim();
      
      if (!email) {
        if (licenseError) {
          licenseError.textContent = 'Please enter your email';
          licenseError.style.display = 'block';
        }
        return;
      }
      
      if (!key) {
        if (licenseError) {
          licenseError.textContent = 'Please enter your License Key';
          licenseError.style.display = 'block';
        }
        return;
      }
      
      if (licenseError) licenseError.style.display = 'none';
      licenseSubmitBtn.disabled = true;
      licenseSubmitBtn.textContent = 'Verifying...';
      
      try {
        const isValid = await verifyLicenseKey(email, key);
        
        if (isValid) {
          const success = await api.activateLicense(key);
          if (success) {
            isPremium = true;
            localStorage.setItem('floatboard-email', email);
            if (activateBtn) activateBtn.style.display = 'none';
            if (premiumBadge) premiumBadge.style.display = 'inline-block';
            licenseOverlay.classList.remove('active');
            isLicenseModalOpen = false;
            showToast('Activation Successful ✓');
          } else {
            if (licenseError) {
              licenseError.textContent = 'Failed to save license locally';
              licenseError.style.display = 'block';
            }
          }
        } else {
          if (licenseError) {
            licenseError.textContent = 'Invalid License Key. Please make sure you are using the exact email address you used during purchase.';
            licenseError.style.display = 'block';
          }
        }
      } catch (err) {
        console.error('Verification error:', err);
        if (licenseError) {
          licenseError.textContent = 'Connection Error: Please check your internet';
          licenseError.style.display = 'block';
        }
      } finally {
        licenseSubmitBtn.disabled = false;
        licenseSubmitBtn.textContent = 'Activate';
      }
    });
  }

  // History Panel Initialization
  const historyBtn = document.getElementById('history-btn');
  const historyOverlay = document.getElementById('history-overlay');
  const historyCloseBtn = document.getElementById('history-close-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');

  if (historyBtn && historyOverlay) {
    historyBtn.addEventListener('click', () => {
      renderHistoryList();
      historyOverlay.classList.add('active');
    });
  }

  if (historyCloseBtn && historyOverlay) {
    historyCloseBtn.addEventListener('click', () => {
      historyOverlay.classList.remove('active');
    });
  }

  if (historyOverlay) {
    historyOverlay.addEventListener('click', (e) => {
      if (e.target === historyOverlay) {
        historyOverlay.classList.remove('active');
      }
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      clearAllHistory();
    });
  }

  // Theme Initialization
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  let currentTheme = localStorage.getItem('theme') || 'light';
  applyTheme(currentTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme);
    });
  }

  // Snow Initialization
  initSnow();

  render();
  boardEl.focus();
}

async function createCheckout(email) {
  // Instantly return the pricing page with the email attached
  // This bypasses the slow Vercel API cold-start for a 0ms click
  return `https://floatboard.xyz/pricing.html?email=${encodeURIComponent(email.trim())}`;
}

async function verifyLicenseKey(email, key) {
  try {
    const response = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        license_key: key.trim()
      })
    });
    
    const data = await response.json();
    
    if (data.valid && data.meta && data.meta.customer_email) {
      // Strictly enforce that the email matches the one from LemonSqueezy
      return data.meta.customer_email.toLowerCase() === email.trim().toLowerCase();
    }
    
    return false;
  } catch (error) {
    console.error('Verification error:', error);
    return false;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  
  if (api.changeTheme) {
    api.changeTheme(theme);
  }
  
  const sunIcon = document.querySelector('.theme-icon-sun');
  const moonIcon = document.querySelector('.theme-icon-moon');
  if (sunIcon && moonIcon) {
    if (theme === 'dark') {
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
    } else {
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
    }
  }
}

function initSnow() {
  snowCanvas = document.getElementById('snow-canvas');
  if (!snowCanvas) return;
  
  snowCtx = snowCanvas.getContext('2d');
  
  window.addEventListener('resize', resizeSnowCanvas);
  resizeSnowCanvas();
  
  createSnowflakes();
  
  const snowToggle = document.getElementById('snow-toggle');
  if (snowToggle) {
    snowToggle.checked = snowEnabled;
    snowToggle.addEventListener('change', () => {
      snowEnabled = snowToggle.checked;
      localStorage.setItem('snowEnabled', snowEnabled);
      if (snowEnabled) {
        startSnowAnimation();
      } else {
        stopSnowAnimation();
      }
    });
  }
  
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (snowEnabled) startSnowAnimation();
    } else {
      stopSnowAnimation();
    }
  });
  
  if (snowEnabled) {
    startSnowAnimation();
  }
}

function resizeSnowCanvas() {
  if (!snowCanvas) return;
  snowCanvas.width = snowCanvas.offsetWidth || window.innerWidth;
  snowCanvas.height = snowCanvas.offsetHeight || window.innerHeight;
}

function createSnowflakes() {
  snowflakes = [];
  const count = 35; // 35 particles
  for (let i = 0; i < count; i++) {
    snowflakes.push({
      x: Math.random() * (snowCanvas.width || window.innerWidth),
      y: Math.random() * (snowCanvas.height || window.innerHeight),
      r: Math.random() * 3 + 2, // size: 2 to 5px
      d: Math.random() * 1.5 + 1.0, // speed: between 1 and 2.5px
      wind: Math.random() * 0.5 - 0.25 // slight wind drift
    });
  }
}

function startSnowAnimation() {
  if (!snowAnimationId && snowEnabled && document.visibilityState === 'visible') {
    animateSnow();
  }
}

function stopSnowAnimation() {
  if (snowAnimationId) {
    cancelAnimationFrame(snowAnimationId);
    snowAnimationId = null;
  }
  if (snowCtx && snowCanvas) {
    snowCtx.clearRect(0, 0, snowCanvas.width, snowCanvas.height);
  }
}

function animateSnow() {
  if (!snowEnabled || document.visibilityState !== 'visible') {
    snowAnimationId = null;
    return;
  }
  
  snowCtx.clearRect(0, 0, snowCanvas.width, snowCanvas.height);
  snowCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  
  for (let i = 0; i < snowflakes.length; i++) {
    const f = snowflakes[i];
    snowCtx.beginPath();
    snowCtx.arc(f.x, f.y, f.r, 0, Math.PI * 2, true);
    snowCtx.fill();
    
    // Update position
    f.y += f.d;
    f.x += f.wind;
    
    // Reset snowflake when it goes off screen
    if (f.y > snowCanvas.height + f.r) {
      f.y = -f.r;
      f.x = Math.random() * snowCanvas.width;
    }
    // Also reset if it goes too far left/right
    if (f.x > snowCanvas.width + f.r) {
      f.x = -f.r;
    } else if (f.x < -f.r) {
      f.x = snowCanvas.width + f.r;
    }
  }
  
  snowAnimationId = requestAnimationFrame(animateSnow);
}

init();

// --- Quick Look Image Preview ---
let hoveredImg = null;

sectionsEl.addEventListener('mouseover', (e) => {
  if (e.target.tagName === 'IMG') {
    hoveredImg = e.target;
  }
});

sectionsEl.addEventListener('mouseout', (e) => {
  if (e.target.tagName === 'IMG' && hoveredImg === e.target) {
    hoveredImg = null;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    saveNow();
    api.close();
    return;
  }
  
  if ((e.code === 'Space' || (e.ctrlKey && e.key.toLowerCase() === 'z')) && hoveredImg && previewOverlay.style.display !== 'flex') {
    e.preventDefault();
    openImagePreview(hoveredImg.src);
  }
});

// --- Quick Look Image Preview ---
const previewOverlay = document.getElementById('image-preview-overlay');
const previewImg = document.getElementById('image-preview-img');
const zoomInBtn = document.getElementById('preview-zoom-in');
const zoomOutBtn = document.getElementById('preview-zoom-out');
const closePreviewBtn = document.getElementById('preview-close');

let previewScale = 1;
let previewPanX = 0;
let previewPanY = 0;
let previewDragging = false;
let previewStartX = 0;
let previewStartY = 0;

function openImagePreview(imageSrc) {
  previewImg.src = imageSrc;
  previewScale = 1;
  previewPanX = 0;
  previewPanY = 0;
  updatePreviewTransform();
  previewOverlay.style.display = 'flex';
}

function closeImagePreview() {
  previewOverlay.style.display = 'none';
  previewImg.src = '';
}

function updatePreviewTransform() {
  previewImg.style.transform = `translate(${previewPanX}px, ${previewPanY}px) scale(${previewScale})`;
}

// Global listeners for triggering preview
sectionsEl.addEventListener('dblclick', (e) => {
  if (e.target.tagName === 'IMG') {
    openImagePreview(e.target.src);
  }
});

sectionsEl.addEventListener('auxclick', (e) => {
  if (e.target.tagName === 'IMG' && e.button === 1) { // Middle click
    e.preventDefault();
    openImagePreview(e.target.src);
  }
});

// Overlay interactions
previewOverlay.addEventListener('click', (e) => {
  if (e.target === previewOverlay) {
    closeImagePreview();
  }
});

previewOverlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeImagePreview();
});

closePreviewBtn.addEventListener('click', closeImagePreview);

zoomInBtn.addEventListener('click', () => {
  previewScale += 0.2;
  updatePreviewTransform();
});

zoomOutBtn.addEventListener('click', () => {
  previewScale = Math.max(0.2, previewScale - 0.2);
  updatePreviewTransform();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewOverlay.style.display === 'flex') {
    closeImagePreview();
  }
});

previewOverlay.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomSensitivity = 0.05;
  if (e.deltaY < 0) {
    previewScale += zoomSensitivity;
  } else {
    previewScale = Math.max(0.2, previewScale - zoomSensitivity);
  }
  updatePreviewTransform();
}, { passive: false });

async function captureImageToClipboard(displayImg) {
  try {
    const canvas = document.createElement('canvas');
    
    // Use the exact natural dimensions of the image to ensure 100% original quality
    canvas.width = displayImg.naturalWidth;
    canvas.height = displayImg.naturalHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(displayImg, 0, 0, displayImg.naturalWidth, displayImg.naturalHeight);

    canvas.toBlob(async (pngBlob) => {
      if (!pngBlob) {
        showToast('Failed to copy screenshot');
        return;
      }
      try {
        api.ignoreNextClipboardImage();
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
        showToast('Screenshot copied to clipboard');
      } catch (err) {
        console.error(err);
        showToast('Failed to copy screenshot');
      }
    }, 'image/png');
  } catch (err) {
    console.error(err);
    showToast('Failed to copy screenshot');
  }
}

api.onCopyScreenshot((params) => {
  const elements = document.elementsFromPoint(params.x, params.y);
  const displayImg = elements.find(el => el.tagName === 'IMG');
  if (displayImg) {
    captureImageToClipboard(displayImg);
  }
});

api.onUpdateDownloaded(() => {
  const updateToast = document.createElement('div');
  updateToast.className = 'update-toast glass';
  updateToast.innerHTML = `
    <span>Update ready to install</span>
    <button class="update-btn">Restart</button>
  `;
  document.body.appendChild(updateToast);
  
  updateToast.querySelector('.update-btn').addEventListener('click', () => {
    api.quitAndInstallUpdate();
  });
});

previewImg.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    previewDragging = true;
    previewStartX = e.clientX - previewPanX;
    previewStartY = e.clientY - previewPanY;
  }
});

document.addEventListener('mousemove', (e) => {
  if (previewDragging) {
    previewPanX = e.clientX - previewStartX;
    previewPanY = e.clientY - previewStartY;
    updatePreviewTransform();
  }
});

api.onHistoryShow((history) => {
  let dropdown = document.getElementById('history-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'history-dropdown';
    dropdown.className = 'history-dropdown glass';
    document.body.appendChild(dropdown);
  }
  
  if (dropdown.style.display === 'block') {
    dropdown.style.display = 'none';
    return;
  }
  
  dropdown.innerHTML = '<h3>Clipboard History</h3>';
  
  if (history.length === 0) {
    dropdown.innerHTML += '<div class="history-empty">No recent clips found.</div>';
  } else {
    history.forEach(item => {
      const el = document.createElement('div');
      el.className = 'history-item';
      
      const textSpan = document.createElement('span');
      textSpan.className = 'history-item-text';
      textSpan.textContent = item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content;
      textSpan.title = item.content;
      
      const copyBtn = document.createElement('button');
      copyBtn.className = 'history-copy-btn';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
      
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.content).then(() => {
          showToast('Copied to clipboard');
          dropdown.style.display = 'none';
        });
      });

      el.appendChild(textSpan);
      el.appendChild(copyBtn);

      el.addEventListener('click', () => {
        addMediaToBoard(item.content, 'text');
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(el);
    });
  }
  
  dropdown.style.display = 'block';
});

document.addEventListener('click', (event) => {
  const dropdown = document.getElementById('history-dropdown');
  if (dropdown && dropdown.style.display === 'block') {
    if (!dropdown.contains(event.target)) {
      dropdown.style.display = 'none';
    }
  }
});

api.onMediaAutoAdded((item) => {
  if (isLicenseModalOpen) return;
  if (!checkDailyLimit('image')) return;
  
  const section = ensureSection('image');
  section.items.push(item);
  section.updatedAt = now();
  activeType = 'image';
  render();
  queueSave();
  showToast('Screenshot auto-added from clipboard');
});

document.addEventListener('mouseup', () => {
  previewDragging = false;
});

// Auto-focus window when mouse enters so shortcuts work instantly
document.body.addEventListener('mouseenter', () => {
  if (api.focus) api.focus();
});

