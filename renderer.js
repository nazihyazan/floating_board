const api = window.floatingBoard;

// Instant theme application on load to prevent flashing
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light');

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

async function showUpgradeModal() {
  api.openExternal('https://floatboard.xyz/pricing.html');
}

function checkDailyLimit(kind) {
  if (isPremium) return true;
  // We'll treat video as image for limits, or just let it pass if we only track text and image.
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

  if (usage[limitKind] >= 5) {
    showToast(`Daily limit reached (5/5). Upgrade to Premium for unlimited access.`);
    showUpgradeModal();
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
let zoomEnabled = localStorage.getItem('zoomEnabled') !== 'false';
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
    const videoCandidate = linkedMediaCandidate(video, baseUrl)
      || candidateFromElementUrl(video, 'src', 'video', baseUrl);
    if (videoCandidate) return videoCandidate;

    for (const image of Array.from(doc.querySelectorAll('img[src], source[type^="image/"][src]'))) {
      const imageCandidate = linkedMediaCandidate(image, baseUrl)
        || candidateFromElementUrl(image, 'src', 'image', baseUrl);
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

    if (section.type === 'image' || section.type === 'video') {
      next.sections.push({
        type: section.type,
        items: Array.isArray(section.items)
          ? section.items.filter((item) => item && (item.src || item.fileName))
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
      
      let scale = 1;
      let panX = 0;
      let panY = 0;

      mediaItem.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault(); // Prevent whole app zooming
          const zoomSensitivity = 0.01;
          scale = Math.max(1, Math.min(scale - e.deltaY * zoomSensitivity, 10));
        } else if (scale > 1) {
          e.preventDefault(); // Prevent scrolling the board
          panX -= e.deltaX;
          panY -= e.deltaY;
        }

        if (scale === 1) { panX = 0; panY = 0; }

        img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        img.style.transition = 'none';
      });

      mediaItem.addEventListener('pointerenter', () => {
        if (!zoomEnabled) return;
        const previewPopup = document.getElementById('media-preview-popup');
        if (previewPopup) {
          previewPopup.innerHTML = `<img src="${item.src}" alt="${escapeHtml(item.name || 'Preview')}" />`;
          
          const rect = mediaItem.getBoundingClientRect();
          const windowHeight = window.innerHeight;
          const isLowerHalf = rect.top > windowHeight / 2;

          if (isLowerHalf) {
            previewPopup.style.top = '40px';
            previewPopup.style.bottom = 'auto';
          } else {
            previewPopup.style.top = 'auto';
            previewPopup.style.bottom = '40px';
          }

          previewPopup.classList.add('active');
        }
      });

      mediaItem.addEventListener('pointerleave', () => {
        scale = 1;
        panX = 0;
        panY = 0;
        img.style.transform = `translate(0px, 0px) scale(1)`;
        img.style.transition = 'transform 0.2s ease';

        const previewPopup = document.getElementById('media-preview-popup');
        if (previewPopup) {
          previewPopup.classList.remove('active');
        }
      });
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
      copyButton.title = 'Copy image';
      copyButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
        </svg>
      `;
      copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const response = await fetch(item.src);
          const blob = await response.blob();

          if (blob.type === 'image/png') {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            showToast('Image copied to clipboard');
            return;
          }

          const img = new Image();
          img.src = item.src;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          canvas.toBlob(async (pngBlob) => {
            if (!pngBlob) {
              showToast('Failed to copy image');
              return;
            }
            try {
              await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': pngBlob })
              ]);
              showToast('Image copied to clipboard');
            } catch (err) {
              console.error(err);
              showToast('Failed to copy image');
            }
          }, 'image/png');
        } catch (err) {
          console.error(err);
          showToast('Failed to copy image');
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

async function addFile(file) {
  const kind = getKind(file);
  if (!kind) return false;

  if (!checkDailyLimit(kind)) {
    return false;
  }

  try {
    const section = ensureSection(kind);
    const item = await createMediaItem(file, kind);
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
    const item = await api.importMediaUrl({ url, kind });
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
});

boardEl.addEventListener('dragenter', (event) => {
  event.preventDefault();
  boardEl.classList.add('drag-over');
});

boardEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  boardEl.classList.add('drag-over');
});

boardEl.addEventListener('dragleave', (event) => {
  if (!boardEl.contains(event.relatedTarget)) {
    boardEl.classList.remove('drag-over');
  }
});

boardEl.addEventListener('drop', async (event) => {
  event.preventDefault();
  boardEl.classList.remove('drag-over');

  const files = Array.from(event.dataTransfer.files || []);
  const text = event.dataTransfer.getData('text/plain');
  let handled = false;

  // 1. First handle images/videos dragged from a browser (extracts clean HTTP URLs)
  const droppedMedia = extractMediaCandidateFromDrop(event.dataTransfer);
  if (droppedMedia) {
    showToast(`Importing web ${droppedMedia.kind}...`);
    await addMediaFromUrl(droppedMedia.url, droppedMedia.kind);
    handled = true;
  }

  // 2. Then fallback to local files
  if (!handled && files.length > 0) {
    handled = await addFiles(files);
  }

  // 3. Finally, fall back to standard text drop.
  if (!handled && text) {
    addText(text);
    handled = true;
  }

  if (!handled && files.length > 0) {
    showToast('Unsupported file type');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest('textarea, input, button, video')) return;

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
  const zoomToggle = document.getElementById('zoom-toggle');

  if (zoomToggle) {
    zoomToggle.checked = zoomEnabled;
    zoomToggle.addEventListener('change', () => {
      zoomEnabled = zoomToggle.checked;
      localStorage.setItem('zoomEnabled', zoomEnabled);
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

  if (isPremium && activateBtn) {
    activateBtn.style.display = 'none';
  }

  if (activateBtn && licenseOverlay) {
    activateBtn.addEventListener('click', () => {
      licenseOverlay.classList.add('active');
      isLicenseModalOpen = true;
      if (licenseError) licenseError.style.display = 'none';
      if (licenseInput) licenseInput.focus();
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

  if (licenseSubmitBtn && licenseInput) {
    licenseSubmitBtn.addEventListener('click', async () => {
      const key = licenseInput.value.trim();
      if (!key) return;
      
      if (licenseError) licenseError.style.display = 'none';
      licenseSubmitBtn.disabled = true;
      licenseSubmitBtn.textContent = 'Verifying...';
      
      try {
        const isValid = await verifyLicenseKey(key);
        
        if (isValid) {
          const success = await api.activateLicense(key);
          if (success) {
            isPremium = true;
            if (activateBtn) activateBtn.style.display = 'none';
            licenseOverlay.classList.remove('active');
            isLicenseModalOpen = false;
            showToast('Premium Activated ✅');
          } else {
            if (licenseError) {
              licenseError.textContent = 'Failed to save license locally';
              licenseError.style.display = 'block';
            }
          }
        } else {
          if (licenseError) {
            licenseError.textContent = 'Invalid License Key';
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

async function verifyLicenseKey(key) {
  try {
    const response = await fetch('https://floatboard-landing.vercel.app/api/verify-lemon-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key })
    });
    const data = await response.json();
    return data.valid;
  } catch (error) {
    console.error('Verification error:', error);
    throw error;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  
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
  const count = 25; // 20-30 particles
  for (let i = 0; i < count; i++) {
    snowflakes.push({
      x: Math.random() * (snowCanvas.width || window.innerWidth),
      y: Math.random() * (snowCanvas.height || window.innerHeight),
      r: Math.random() * 3 + 2, // size: 2 to 5px
      d: Math.random() * 0.7 + 0.3, // speed: between 0.3 and 1px
      wind: Math.random() * 0.2 - 0.1 // slight wind drift
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
