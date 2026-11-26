/* PDF 閱讀編輯器 — 純前端實作，使用 PDF.js 顯示、pdf-lib 匯出。
   所有檔案都只在瀏覽器記憶體中處理，不會上傳到任何伺服器。
   標註（文字／螢光筆／畫筆／圖形）都是「物件」，存在 entry.objects，
   每次都從物件資料重新畫到 overlay canvas，所以加入後還能再選取、移動、調整、改樣式。 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const { PDFDocument, degrees } = PDFLib;

const CSS_SCALE = 1.0;      // 100% 縮放時，1 PDF point = 1 CSS px
const BACKING_DPR = 1.5;    // 畫面用的實際像素密度（清晰度）
// 頁面四周多留一圈「暫放區」，可以把物件拖出頁面範圍外暫時擺放（例如表格內容被頁面
// 邊緣裁掉時，先把備註文字放在旁邊）；這塊區域只存在於畫面上，匯出 PDF 時不會印出來。
// 這個數值不能無限加大：每頁外面包了一層 page-row，寬高故意算進暫放區的寬度／高度
// （見 layoutPage()），這樣瀏覽器才會把暫放區算進可捲動範圍；如果暫放區只是疊加在頁面
// 上的 overlay-canvas 視覺溢出、不算進任何元素真正的 box 大小，瀏覽器置中時「開頭側」
// （往左／往上）超出視窗的部分天生無法捲過去看，捲到底（scrollLeft/scrollTop=0）就是
// 極限，等於白白浪費、還會讓使用者以為「選取/拖曳往左或往上過不去」。所以 margin 只抓一個
// 在大多數視窗大小下，不用捲動就能完整看到的寬度（太寬在小視窗一樣會卡到這個限制）。
const PASTEBOARD_MARGIN = 500;
// 雙頁並排模式下，頁面本來就左右緊鄰著排，暫放區會把兩頁硬是撐開一大截，所以並排時不保留暫放區寬度
// （右側多留的視覺暫放效果還是在，只是並排時這塊不算進版面寬度，跟現在的行為一致）。
function pasteboardMarginPx() {
  return state.viewMode === "spread" ? 0 : Math.round(PASTEBOARD_MARGIN * state.zoom * CSS_SCALE);
}
const TEXT_PAD = 4;         // 文字物件背景／外框的內距（point）
const ROTATE_HANDLE_DIST = 26; // 旋轉把手離物件上緣的距離（point）

let _nextId = 1;
const newId = () => "o" + _nextId++;

const state = {
  sources: [],   // { buffer: ArrayBuffer, pdfjsDoc, libDoc(lazy), fileName }
  pages: [],     // { sourceIndex, pageIndexInSource, pdfjsPage, baseRotation, userDelta,
                 //   objects:[], watermark:null, history:[],
                 //   outerEl, innerEl, baseCanvasEl, overlayCanvasEl, textLayerEl, thumb* }
  zoom: 1.0,
  tool: "pan",
  viewMode: "scroll",    // "scroll" | "single" | "spread"
  currentPageIndex: 0,   // single／spread 模式下目前顯示的頁（spread 時為左頁）
  selected: null,       // { entry, objs: [...] }（可多選，objs 永遠是陣列）
  pageNumberConfig: null, // 全域頁碼設定（不是每頁各自存一份，數字是畫的時候依頁面目前的順序即時算出來的）
  interaction: null,    // 目前進行中的滑鼠操作
  currentTextEditor: null,
  lastActiveEntry: null,
  objectClipboard: null, // 按 Ctrl+C 複製的物件備份；平常貼上一律看系統剪貼簿，這個只在系統剪貼簿讀不到東西時當備援
  defaults: {
    text: { color: "#000000", fontSize: 20, bg: { enabled: false, color: "#ffff00" }, border: { enabled: false, color: "#000000", width: 2 } },
    highlight: { color: "#ffeb3b", width: 18 },
    pen: { color: "#1d4ed8", width: 3 },
    shape: { kind: "rect", stroke: "#1d4ed8", strokeWidth: 3, fill: { enabled: false, color: "#60a5fa", opacity: 1 }, textColor: "#000000", fontSize: 16 },
    stamp: { dataUrl: null, fileName: null, naturalW: 0, naturalH: 0, targetW: 120, border: { enabled: false, color: "#000000", width: 2 } },
    indexmark: { stroke: "#e21818", strokeWidth: 2, fill: { enabled: false, color: "#e21818", opacity: 1 }, textColor: "#000000", fontSize: 28 },
  },
};
let pendingObjEditPushed = false;

const $ = (sel) => document.querySelector(sel);
const viewerScroll = $("#viewerScroll");
const viewer = $("#viewer");
const thumbList = $("#thumbList");
const emptyState = $("#emptyState");
const toolOptionsEl = $("#toolOptions");

function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

function showLoading(text) {
  $("#loadingText").textContent = text || "處理中…";
  $("#loadingOverlay").hidden = false;
}
function hideLoading() {
  $("#loadingOverlay").hidden = true;
}

function setControlsEnabled(enabled) {
  ["btnDownload", "btnUndo", "btnZoomOut", "btnZoomIn", "btnExtract", "btnDeleteSelected"].forEach((id) => {
    $("#" + id).disabled = !enabled;
  });
  emptyState.style.display = enabled ? "none" : "flex";
}

/* ---------------- 檔案開啟 / 合併 ---------------- */

$("#btnOpen").addEventListener("click", () => $("#fileInputOpen").click());
$("#btnAppend").addEventListener("click", () => $("#fileInputAppend").click());

$("#fileInputOpen").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  await resetAndLoad(file);
});

$("#fileInputAppend").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  for (const f of files) await appendFile(f);
});

["dragover", "dragenter"].forEach((ev) =>
  viewerScroll.addEventListener(ev, (e) => {
    e.preventDefault();
  })
);
viewerScroll.addEventListener("drop", async (e) => {
  e.preventDefault();
  const allFiles = Array.from(e.dataTransfer.files || []);
  const pdfFiles = allFiles.filter((f) => f.type === "application/pdf");
  const imageFiles = allFiles.filter((f) => f.type.startsWith("image/"));
  if (pdfFiles.length) {
    if (state.pages.length === 0) {
      await resetAndLoad(pdfFiles[0]);
      for (const f of pdfFiles.slice(1)) await appendFile(f);
    } else {
      for (const f of pdfFiles) await appendFile(f);
    }
  }
  if (imageFiles.length) await dropImagesOntoPage(imageFiles, e);
});

// 把拖曳進來的照片檔案直接插入成頁面上的圖片物件（不用再先存檔、再用印章工具一張一張選）。
// 目標頁面／座標看滑鼠放開時真正在哪個 .page-outer 底下，找不到（例如放在頁與頁之間的間隔）
// 才退回用 pickActivePage() 猜目前在看哪一頁。
async function dropImagesOntoPage(imageFiles, e) {
  if (!state.pages.length) {
    toast("請先開啟 PDF，才能把照片拖曳進頁面裡", true);
    return;
  }
  const outerEl = e.target && e.target.closest && e.target.closest(".page-outer");
  const entry = (outerEl && state.pages.find((p) => p.outerEl === outerEl)) || pickActivePage();
  if (!entry) return;
  const pt = eventToPoint(entry, e);
  pushHistory(entry);
  let lastObj = null;
  let offset = 0; // 一次拖進多張照片時，每張稍微錯開位置，避免整疊疊在同一個點看不出張數
  for (const file of imageFiles) {
    try {
      lastObj = await insertImageObjectAt(entry, file, { x: pt.x + offset, y: pt.y + offset });
      offset += 20;
    } catch (err) {
      console.error(err);
      toast("插入照片失敗：" + err.message, true);
    }
  }
  if (lastObj) {
    setTool("pan");
    setSelected({ entry, objs: [lastObj] });
    redraw(entry);
    renderToolOptions();
    toast(imageFiles.length > 1 ? `已插入 ${imageFiles.length} 張照片` : "已插入照片");
  }
}

async function resetAndLoad(file) {
  showLoading("讀取 PDF 中…");
  try {
    clearAll();
    await appendFile(file, true);
    state.zoom = 1.0;
    updateZoomLabel();
    setControlsEnabled(true);
  } catch (err) {
    console.error(err);
    toast("開啟檔案失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

/* ---------------- PWA：安裝成應用程式後，才能被設成 Windows 的預設 PDF 開啟程式 ---------------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* 本機用 file:// 開啟、或瀏覽器不支援時略過即可，不影響正常使用 */
    });
  });
}

// Windows「用這個程式開啟」PDF 時，瀏覽器會把檔案透過這個 API 傳進來（而不是走網址列）
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || !launchParams.files.length) return;
    try {
      const fileHandle = launchParams.files[0];
      const file = await fileHandle.getFile();
      await resetAndLoad(file);
    } catch (err) {
      console.error(err);
      toast("開啟檔案失敗：" + err.message, true);
    }
  });
}

function clearAll() {
  state.pages.forEach((p) => clearTimeout(p._thumbTimer));
  state.sources = [];
  state.pages = [];
  state.pageNumberConfig = null;
  setSelected(null);
  viewerScroll.innerHTML = "";
  thumbList.innerHTML = "";
  setControlsEnabled(false);
}

async function appendFile(file, isFirst) {
  showLoading("讀取 PDF 中…");
  try {
    const buffer = await file.arrayBuffer();
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const restored = await tryRestoreEditableBackup(pdfjsDoc, file.name, isFirst);

    if (!restored) {
      const sourceIndex = state.sources.length;
      state.sources.push({ buffer, pdfjsDoc, libDoc: null, fileName: file.name });

      for (let i = 1; i <= pdfjsDoc.numPages; i++) {
        const pdfjsPage = await pdfjsDoc.getPage(i);
        const entry = {
          sourceIndex,
          pageIndexInSource: i - 1,
          pdfjsPage,
          baseRotation: pdfjsPage.rotate || 0,
          userDelta: 0,
          objects: [],
          watermark: null,
          history: [],
        };
        state.pages.push(entry);
        await buildPageDOM(entry);
        buildThumb(entry);
      }
    }
    setControlsEnabled(true);
    scheduleAutosave();
    if (!isFirst && !restored) toast(`已合併「${file.name}」，共 ${pdfjsDoc.numPages} 頁`);
  } catch (err) {
    console.error(err);
    toast("讀取檔案失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

/* ---------------- 頁面渲染（固定未旋轉座標系，旋轉用 CSS 呈現） ---------------- */

// 頁面裁切／延伸：cropX,cropY,cropW,cropH 是「原始（未裁切）頁面座標系」下，目前要顯示的範圍。
// 預設（還沒裁切過）就是整張原始頁面；裁切範圍可以超出原始頁面邊緣（延伸出去的部分補白色）。
function getNativeSize(entry) {
  const view = entry.pdfjsPage.view;
  return { w: view[2] - view[0], h: view[3] - view[1] };
}
function ensureCropDefaults(entry) {
  if (entry.cropW != null) return;
  const { w, h } = getNativeSize(entry);
  entry.cropX = 0;
  entry.cropY = 0;
  entry.cropW = w;
  entry.cropH = h;
}
function isCropped(entry) {
  ensureCropDefaults(entry);
  const { w: nativeW, h: nativeH } = getNativeSize(entry);
  return (
    Math.abs(entry.cropX) > 0.01 ||
    Math.abs(entry.cropY) > 0.01 ||
    Math.abs(entry.cropW - nativeW) > 0.01 ||
    Math.abs(entry.cropH - nativeH) > 0.01
  );
}

function nativeViewport(entry, zoom) {
  const scale = zoom * CSS_SCALE;
  return entry.pdfjsPage.getViewport({
    scale, rotation: 0,
    offsetX: -entry.cropX * scale,
    offsetY: -entry.cropY * scale,
  });
}

async function buildPageDOM(entry) {
  ensureCropDefaults(entry);
  const row = document.createElement("div");
  row.className = "page-row";

  const outer = document.createElement("div");
  outer.className = "page-outer";

  const inner = document.createElement("div");
  inner.className = "page-inner";

  const baseCanvas = document.createElement("canvas");
  baseCanvas.className = "base-canvas";
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.className = "overlay-canvas";
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";

  inner.appendChild(baseCanvas);
  inner.appendChild(textLayer);
  inner.appendChild(overlayCanvas);
  outer.appendChild(inner);

  const label = document.createElement("div");
  label.className = "page-label";
  outer.appendChild(label);

  const sizeTip = document.createElement("div");
  sizeTip.className = "page-size-tip";
  sizeTip.hidden = true;
  outer.appendChild(sizeTip);

  row.appendChild(outer);
  viewerScroll.appendChild(row);

  entry.rowEl = row;
  entry.outerEl = outer;
  entry.innerEl = inner;
  entry.baseCanvasEl = baseCanvas;
  entry.overlayCanvasEl = overlayCanvas;
  entry.textLayerEl = textLayer;
  entry.labelEl = label;
  entry.sizeTipEl = sizeTip;

  attachPageSizeTip(entry);
  attachPageInteractions(entry);
  overlayCanvas.style.pointerEvents = state.tool === "edittext" ? "none" : "auto";
  await renderPage(entry, state.zoom);
  layoutPage(entry);
  renumber();
}

async function renderPage(entry, zoom, opts) {
  const viewport = nativeViewport(entry, zoom);
  const w = Math.round(entry.cropW * zoom * CSS_SCALE);
  const h = Math.round(entry.cropH * zoom * CSS_SCALE);

  const base = entry.baseCanvasEl;
  base.width = Math.round(w * BACKING_DPR);
  base.height = Math.round(h * BACKING_DPR);
  base.style.width = w + "px";
  base.style.height = h + "px";
  const ctx = base.getContext("2d");
  ctx.setTransform(BACKING_DPR, 0, 0, BACKING_DPR, 0, 0);
  await entry.pdfjsPage.render({ canvasContext: ctx, viewport }).promise;

  // overlay-canvas 比頁面本身上下左右各多留一塊暫放區，用來放暫時拖出頁面外的物件，
  // 畫面上看起來就是頁面四周多了一截空白。
  const marginPx = Math.round(PASTEBOARD_MARGIN * zoom * CSS_SCALE);
  // （注意：這裡故意不呼叫 pasteboardMarginPx()，overlay-canvas 本身的暫放區寬高不受並排模式影響，
  // 只有 page-row 版面保留的寬高在並排模式下會變成 0，見 layoutPage()）
  const overlay = entry.overlayCanvasEl;
  const ow = w + marginPx * 2, oh = h + marginPx * 2;
  overlay.width = Math.round(ow * BACKING_DPR);
  overlay.height = Math.round(oh * BACKING_DPR);
  overlay.style.width = ow + "px";
  overlay.style.height = oh + "px";
  overlay.style.left = -marginPx + "px";
  overlay.style.top = -marginPx + "px";

  entry.innerEl.style.width = w + "px";
  entry.innerEl.style.height = h + "px";

  await renderTextLayer(entry, viewport, w, h);
  redraw(entry, opts);
}

async function renderTextLayer(entry, viewport, w, h) {
  const layer = entry.textLayerEl;
  layer.innerHTML = "";
  layer.style.setProperty("--scale-factor", viewport.scale);
  layer.style.width = w + "px";
  layer.style.height = h + "px";
  try {
    const textContent = await entry.pdfjsPage.getTextContent();
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: layer,
      viewport,
      textDivs: [],
    });
    if (task && task.promise) await task.promise;
  } catch (err) {
    // 部分版本 / 無文字內容的頁面可能失敗，略過即可（不影響其他功能）
    console.warn("文字層建立失敗", err);
  }
}

function layoutPage(entry) {
  const total = (entry.baseRotation + entry.userDelta + 360) % 360;
  const w = entry.innerEl.style.width;
  const h = entry.innerEl.style.height;
  const wPx = parseFloat(w), hPx = parseFloat(h);
  entry.innerEl.style.transform = `translate(-50%,-50%) rotate(${total}deg)`;
  const rotated = total === 90 || total === 270;
  const outerW = rotated ? hPx : wPx;
  const outerH = rotated ? wPx : hPx;
  entry.outerEl.style.width = outerW + "px";
  entry.outerEl.style.height = outerH + "px";
  // 暫放區疊在 inner 本身（未旋轉座標系）的四周、四邊距離相等，頁面整塊旋轉 90°/270° 後
  // 這圈距離還是四邊相等，所以 page-row 保留的暫放區空間不用管旋轉角度，寬高都一律多留
  // 同一個 marginPx 即可。
  const marginPx = pasteboardMarginPx();
  entry.rowEl.style.width = (outerW + marginPx * 2) + "px";
  entry.rowEl.style.height = (outerH + marginPx * 2) + "px";
  entry.textLayerEl.classList.toggle("edit-mode", state.tool === "edittext");
}

// page-row 保留了左右暫放區的寬度，通常會比視窗寬，預設捲動位置要主動置中，
// 不然畫面一開始會卡在最左邊的暫放區，看不到頁面本身。只在「這是文件剛開啟後的第一頁」
// 時做，避免編輯中途（插入/刪除/搬移頁面）無預警地把使用者原本的水平捲動位置扯回正中間。
function centerViewerHorizontally() {
  const max = viewerScroll.scrollWidth - viewerScroll.clientWidth;
  if (max > 0) viewerScroll.scrollLeft = max / 2;
}

// 上下暫放區不像左右那樣有「捲不到」的瀏覽器限制（viewerScroll 直向是一般文件流，
// 預設 scrollTop=0 就看得到），但文件剛開啟時如果不處理，第一頁上方會先看到一截
// 空白暫放區才看到頁面本身，體感不好，所以一樣只在「文件剛開啟的第一頁」時主動置中一次。
// 跟 centerViewerHorizontally() 不同，這個絕對不能在縮放／切換瀏覽模式時也呼叫——那些時機
// 文件通常不只一頁，直向置中會把使用者捲動到的頁面硬是拉到全文件正中間，不是只重算暫放區。
function centerViewerVertically() {
  const max = viewerScroll.scrollHeight - viewerScroll.clientHeight;
  if (max > 0) viewerScroll.scrollTop = max / 2;
}

function renumber() {
  state.pages.forEach((entry, idx) => {
    entry.labelEl.textContent = "第 " + (idx + 1) + " 頁";
    if (entry.thumbNumEl) entry.thumbNumEl.textContent = idx + 1;
  });
  if (state.pages.length === 1) {
    centerViewerHorizontally();
    centerViewerVertically();
  }
  // 頁碼是依照頁面「目前的順序」即時算出來的，順序一變就要重畫全部頁面讓頁碼同步更新
  if (state.pageNumberConfig) state.pages.forEach((entry) => redraw(entry));
  applyViewMode();
}

/* ---------------- 左下角顯示頁面尺寸 ---------------- */

const PAPER_SIZES = [
  { name: "A3", w: 297, h: 420 },
  { name: "A4", w: 210, h: 297 },
  { name: "A5", w: 148, h: 210 },
  { name: "B5", w: 176, h: 250 },
  { name: "Letter", w: 215.9, h: 279.4 },
  { name: "Legal", w: 215.9, h: 355.6 },
];
function matchPaperSize(mmW, mmH) {
  const tol = 2;
  const a = Math.min(mmW, mmH), b = Math.max(mmW, mmH);
  for (const p of PAPER_SIZES) {
    const pa = Math.min(p.w, p.h), pb = Math.max(p.w, p.h);
    if (Math.abs(a - pa) <= tol && Math.abs(b - pb) <= tol) return p.name;
  }
  return null;
}
function getDisplayedPageSizePt(entry) {
  ensureCropDefaults(entry);
  let w = entry.cropW, h = entry.cropH;
  const total = (((entry.baseRotation + entry.userDelta) % 360) + 360) % 360;
  if (total === 90 || total === 270) {
    const t = w;
    w = h;
    h = t;
  }
  return { w, h };
}
function formatPageSize(entry) {
  const { w, h } = getDisplayedPageSizePt(entry);
  const mmW = (w * 25.4) / 72, mmH = (h * 25.4) / 72;
  const name = matchPaperSize(mmW, mmH);
  const mmText = `${mmW.toFixed(0)} × ${mmH.toFixed(0)} mm`;
  const ptText = `${Math.round(w)} × ${Math.round(h)} pt`;
  return (name ? `${mmText}（${name}）` : mmText) + " · " + ptText;
}

const PAGE_SIZE_TIP_ZONE = 60; // 左下角熱區大小（CSS px，與縮放無關）
function attachPageSizeTip(entry) {
  const outer = entry.outerEl;
  const tip = entry.sizeTipEl;
  outer.addEventListener("mousemove", (e) => {
    const r = outer.getBoundingClientRect();
    const fromLeft = e.clientX - r.left;
    const fromBottom = r.bottom - e.clientY;
    if (fromLeft <= PAGE_SIZE_TIP_ZONE && fromBottom <= PAGE_SIZE_TIP_ZONE && fromLeft >= 0 && fromBottom >= 0) {
      tip.textContent = formatPageSize(entry);
      tip.hidden = false;
    } else {
      tip.hidden = true;
    }
  });
  outer.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });
}

/* ---------------- 縮圖 ---------------- */

function buildThumb(entry) {
  const item = document.createElement("div");
  item.className = "thumb-item";
  item.draggable = true;

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "thumb-check";

  const canvas = document.createElement("canvas");
  const rotWrap = document.createElement("div");
  rotWrap.className = "thumb-rot";
  const btnL = document.createElement("button");
  btnL.textContent = "⟲";
  btnL.title = "向左旋轉";
  const btnR = document.createElement("button");
  btnR.textContent = "⟳";
  btnR.title = "向右旋轉";
  rotWrap.appendChild(btnL);
  rotWrap.appendChild(btnR);
  const btnMore = document.createElement("button");
  btnMore.textContent = "⋮";
  btnMore.title = "更多選項（複製／插入空白頁／刪除／移動）";
  rotWrap.appendChild(btnMore);

  const num = document.createElement("div");
  num.className = "thumb-num";
  num.textContent = state.pages.indexOf(entry) + 1;

  item.appendChild(check);
  item.appendChild(canvas);
  item.appendChild(rotWrap);
  item.appendChild(num);
  thumbList.appendChild(item);

  entry.thumbItemEl = item;
  entry.thumbCanvasEl = canvas;
  entry.thumbCheckEl = check;
  entry.thumbNumEl = num;

  renderThumb(entry);

  item.addEventListener("click", (e) => {
    if (e.target === check || rotWrap.contains(e.target)) return;
    if (state.viewMode === "scroll") {
      entry.outerEl.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      goToPage(state.pages.indexOf(entry));
    }
    highlightCurrent(entry);
    setSidebarOpen(false);
  });
  btnL.addEventListener("click", (e) => {
    e.stopPropagation();
    rotatePage(entry, -90);
  });
  btnR.addEventListener("click", (e) => {
    e.stopPropagation();
    rotatePage(entry, 90);
  });
  btnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = btnMore.getBoundingClientRect();
    showThumbContextMenu(entry, r.right, r.bottom);
  });
  check.addEventListener("change", updateSelectionButtons);

  item.addEventListener("dragstart", (e) => {
    // 若拖曳的是已勾選的頁面，連同所有勾選頁面一起移動或複製；否則只處理這一頁
    thumbDragEntries = entry.thumbCheckEl && entry.thumbCheckEl.checked
      ? state.pages.filter((p) => p.thumbCheckEl && p.thumbCheckEl.checked)
      : [entry];
    thumbDragEntries.forEach((p) => p.thumbItemEl && p.thumbItemEl.classList.add("dragging"));
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "copyMove";
      try { e.dataTransfer.setData("text/plain", String(state.pages.indexOf(entry))); } catch (err) {}
    }
  });
  item.addEventListener("dragend", () => {
    clearThumbDragState();
  });
  item.addEventListener("dragover", (e) => {
    if (isFileDrag(e) || !thumbDragEntries.length) return;
    const isCopy = !!(e.ctrlKey || e.metaKey);
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
    if (!isCopy && thumbDragEntries.includes(entry)) {
      clearThumbDragOver();
      return;
    }
    const r = item.getBoundingClientRect();
    const multiCol = isThumbGridMultiCol();
    const placeAfter = multiCol
      ? e.clientX > r.left + r.width / 2
      : e.clientY > r.top + r.height / 2;
    const side = multiCol ? (placeAfter ? "right" : "left") : (placeAfter ? "bottom" : "top");
    setThumbDragOver(item, entry, side, placeAfter, isCopy);
  });
  item.addEventListener("drop", async (e) => {
    if (isFileDrag(e) || !thumbDragEntries.length) return;
    e.preventDefault();
    e.stopPropagation();
    const isCopy = !!(e.ctrlKey || e.metaKey);
    const entries = thumbDragEntries.slice();
    const target = thumbDragTarget;
    clearThumbDragState();
    if (!isCopy && entries.includes(entry)) return;
    const toIdx = state.pages.indexOf(entry);
    if (toIdx < 0) return;
    const placeAfter = target && target.entry === entry ? target.placeAfter : false;
    const insertIdx = placeAfter ? toIdx + 1 : toIdx;
    if (isCopy) await duplicatePagesToIndex(entries, insertIdx);
    else movePagesToIndex(entries, insertIdx);
  });

  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showThumbContextMenu(entry, e.clientX, e.clientY);
  });
}

let thumbDragEntries = [];
let thumbDragTarget = null;
function isThumbGridMultiCol() {
  const cols = getComputedStyle(thumbList).gridTemplateColumns;
  return cols && cols.trim().split(/\s+/).length > 1;
}
function clearThumbDragOver() {
  if (thumbDragTarget && thumbDragTarget.itemEl) {
    thumbDragTarget.itemEl.classList.remove("drag-over-top", "drag-over-bottom", "drag-over-left", "drag-over-right", "drag-copy");
  }
  thumbDragTarget = null;
}
function clearThumbDragState() {
  thumbDragEntries.forEach((p) => p.thumbItemEl && p.thumbItemEl.classList.remove("dragging"));
  thumbDragEntries = [];
  clearThumbDragOver();
}
function setThumbDragOver(itemEl, entry, side, placeAfter, isCopy) {
  if (thumbDragTarget && thumbDragTarget.itemEl && thumbDragTarget.itemEl !== itemEl) {
    thumbDragTarget.itemEl.classList.remove("drag-over-top", "drag-over-bottom", "drag-over-left", "drag-over-right", "drag-copy");
  }
  itemEl.classList.remove("drag-over-top", "drag-over-bottom", "drag-over-left", "drag-over-right", "drag-copy");
  itemEl.classList.add("drag-over-" + side);
  if (isCopy) itemEl.classList.add("drag-copy");
  thumbDragTarget = { itemEl, entry, placeAfter, isCopy };
}

const THUMB_TARGET_W = 520;
const THUMB_MAX_H = 1040;

// 編輯物件（拖曳／繪圖／輸入）會頻繁呼叫 redraw()，這裡做短時間節流，避免每次滑鼠移動都重繪縮圖
function scheduleThumbRender(entry) {
  if (!entry || !entry.thumbCanvasEl) return;
  clearTimeout(entry._thumbTimer);
  entry._thumbTimer = setTimeout(() => {
    entry._thumbTimer = null;
    if (entry.thumbCanvasEl && state.pages.includes(entry)) {
      renderThumb(entry);
    }
  }, 120);
}

async function renderThumb(entry) {
  if (!entry || !entry.thumbCanvasEl) return;
  clearTimeout(entry._thumbTimer);
  entry._thumbTimer = null;
  const seq = (entry._thumbRenderSeq = (entry._thumbRenderSeq || 0) + 1);

  ensureCropDefaults(entry);
  const totalRotation = getPageRotation(entry);
  const rotated = totalRotation === 90 || totalRotation === 270;
  const cw = Math.max(1, entry.cropW);
  const ch = Math.max(1, entry.cropH);
  const dispW = rotated ? ch : cw;
  const dispH = rotated ? cw : ch;
  const scale = Math.min(THUMB_TARGET_W / dispW, THUMB_MAX_H / dispH);

  const unrotW = Math.max(1, Math.round(cw * scale));
  const unrotH = Math.max(1, Math.round(ch * scale));
  const outW = rotated ? unrotH : unrotW;
  const outH = rotated ? unrotW : unrotH;

  // 先在未旋轉座標系合成「PDF 底圖（含裁切／延伸）＋所有物件／浮水印／頁碼」，
  // 若頁面有旋轉再整張轉正貼到縮圖 canvas，確保縮圖與主畫面／匯出結果完全一致。
  const canvas = entry.thumbCanvasEl;
  let workCanvas, workCtx;
  if (totalRotation === 0) {
    canvas.width = outW;
    canvas.height = outH;
    workCanvas = canvas;
    workCtx = canvas.getContext("2d");
  } else {
    workCanvas = document.createElement("canvas");
    workCanvas.width = unrotW;
    workCanvas.height = unrotH;
    workCtx = workCanvas.getContext("2d");
  }

  workCtx.fillStyle = "#ffffff";
  workCtx.fillRect(0, 0, unrotW, unrotH);

  if (entry.baseCanvasEl && entry.baseCanvasEl.width > 0 && entry.baseCanvasEl.height > 0) {
    workCtx.drawImage(entry.baseCanvasEl, 0, 0, unrotW, unrotH);
  } else {
    try {
      const viewport = entry.pdfjsPage.getViewport({
        scale,
        rotation: 0,
        offsetX: -entry.cropX * scale,
        offsetY: -entry.cropY * scale,
      });
      await entry.pdfjsPage.render({ canvasContext: workCtx, viewport }).promise;
      if (entry._thumbRenderSeq !== seq) return;
    } catch (err) {
      /* 忽略縮圖底圖渲染錯誤 */
    }
  }

  renderPageObjects(entry, workCtx, scale, { withHandles: false, noClear: true });

  if (totalRotation !== 0) {
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((totalRotation * Math.PI) / 180);
    ctx.drawImage(workCanvas, -unrotW / 2, -unrotH / 2);
    ctx.restore();
  }
}

function highlightCurrent(entry) {
  state.pages.forEach((p) => p.thumbItemEl.classList.remove("current"));
  entry.thumbItemEl.classList.add("current");
}

function reorderPages(fromEntry, toEntry) {
  const fromIdx = state.pages.indexOf(fromEntry);
  const toIdx = state.pages.indexOf(toEntry);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
  state.pages.splice(fromIdx, 1);
  state.pages.splice(toIdx, 0, fromEntry);
  reflowDomOrder();
  renumber();
  scheduleAutosave();
}

function movePagesToIndex(entries, insertIdx) {
  if (!entries.length) return;
  const movingSet = new Set(entries);
  let targetIdx = 0;
  for (let i = 0; i < insertIdx && i < state.pages.length; i++) {
    if (!movingSet.has(state.pages[i])) targetIdx++;
  }
  const ordered = state.pages.filter((p) => movingSet.has(p));
  const remaining = state.pages.filter((p) => !movingSet.has(p));
  remaining.splice(targetIdx, 0, ...ordered);
  if (remaining.every((p, i) => p === state.pages[i])) return;
  state.pages = remaining;
  reflowDomOrder();
  renumber();
  scheduleAutosave();
}

function reflowDomOrder() {
  thumbList.innerHTML = "";
  state.pages.forEach((p) => thumbList.appendChild(p.thumbItemEl));
  viewerScroll.innerHTML = "";
  state.pages.forEach((p) => viewerScroll.appendChild(p.rowEl));
}

/* 插入一組已建好 DOM 的頁面到指定位置（複製頁面／插入空白頁／拖曳檔案插入都共用） */
async function insertEntries(entries, index) {
  for (const entry of entries) {
    await buildPageDOM(entry);
    buildThumb(entry);
  }
  state.pages.splice(index, 0, ...entries);
  reflowDomOrder();
  renumber();
  setControlsEnabled(true);
  scheduleAutosave();
}

function clonePageEntry(entry) {
  return {
    sourceIndex: entry.sourceIndex,
    pageIndexInSource: entry.pageIndexInSource,
    pdfjsPage: entry.pdfjsPage,
    baseRotation: entry.baseRotation,
    userDelta: entry.userDelta,
    objects: cleanObjects(entry.objects),
    watermark: entry.watermark ? { ...entry.watermark } : null,
    history: [],
    cropX: entry.cropX, cropY: entry.cropY, cropW: entry.cropW, cropH: entry.cropH,
  };
}

async function duplicatePagesToIndex(entries, insertIdx) {
  if (!entries.length) return;
  const clones = entries.map(clonePageEntry);
  const clampedIdx = Math.max(0, Math.min(insertIdx, state.pages.length));
  await insertEntries(clones, clampedIdx);
  highlightCurrent(clones[0]);
  toast(clones.length > 1 ? `已複製 ${clones.length} 頁` : "已複製頁面");
}

function duplicatePage(entry) {
  const idx = state.pages.indexOf(entry);
  duplicatePagesToIndex([entry], idx + 1);
}

async function insertBlankPage(referenceEntry) {
  showLoading("插入空白頁中…");
  try {
    const view = referenceEntry.pdfjsPage.view;
    const w = view[2] - view[0], h = view[3] - view[1];
    const blankDoc = await PDFDocument.create();
    blankDoc.addPage([w, h]);
    const bytes = await blankDoc.save();
    const buffer = bytes.slice().buffer;
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const sourceIndex = state.sources.length;
    state.sources.push({ buffer, pdfjsDoc, libDoc: null, fileName: "空白頁.pdf" });
    const pdfjsPage = await pdfjsDoc.getPage(1);
    const entry = {
      sourceIndex, pageIndexInSource: 0, pdfjsPage,
      baseRotation: 0, userDelta: 0, objects: [], watermark: null, history: [],
    };
    const idx = state.pages.indexOf(referenceEntry);
    await insertEntries([entry], idx + 1);
    toast("已插入空白頁");
  } catch (err) {
    console.error(err);
    toast("插入空白頁失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

async function appendBlankPages(wPt, hPt, count) {
  showLoading("建立空白頁面中…");
  try {
    const blankDoc = await PDFDocument.create();
    for (let i = 0; i < count; i++) blankDoc.addPage([wPt, hPt]);
    const bytes = await blankDoc.save();
    const buffer = bytes.slice().buffer;
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const sourceIndex = state.sources.length;
    state.sources.push({ buffer, pdfjsDoc, libDoc: null, fileName: "空白頁面.pdf" });

    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const pdfjsPage = await pdfjsDoc.getPage(i);
      const entry = {
        sourceIndex, pageIndexInSource: i - 1, pdfjsPage,
        baseRotation: 0, userDelta: 0, objects: [], watermark: null, history: [],
      };
      state.pages.push(entry);
      await buildPageDOM(entry);
      buildThumb(entry);
    }
    setControlsEnabled(true);
    scheduleAutosave();
    toast(`已新增 ${count} 張空白頁面`);
  } catch (err) {
    console.error(err);
    toast("新增空白頁面失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

async function deleteSinglePage(entry) {
  if (state.pages.length <= 1) {
    toast("不能刪除全部頁面", true);
    return;
  }
  const ok = await showConfirm("確定要刪除這一頁嗎？");
  if (!ok) return;
  if (state.selected && state.selected.entry === entry) {
    setSelected(null);
    renderToolOptions();
  }
  clearTimeout(entry._thumbTimer);
  entry.rowEl.remove();
  entry.thumbItemEl.remove();
  state.pages.splice(state.pages.indexOf(entry), 1);
  renumber();
  updateSelectionButtons();
  scheduleAutosave();
}

/* ---------------- 縮圖右鍵選單：複製／插入空白頁／刪除此頁 ---------------- */

let thumbContextMenuEl = null;
function closeThumbContextMenu() {
  if (thumbContextMenuEl) {
    thumbContextMenuEl.remove();
    thumbContextMenuEl = null;
  }
}
function showThumbContextMenu(entry, x, y) {
  closeThumbContextMenu();
  const menu = document.createElement("div");
  menu.className = "thumb-context-menu";
  const idx = state.pages.indexOf(entry);
  const items = [
    { label: "📄 複製此頁", action: () => duplicatePage(entry) },
    { label: "➕ 在此頁後插入空白頁", action: () => insertBlankPage(entry) },
    { label: "🗑 刪除此頁", action: () => deleteSinglePage(entry) },
  ];
  // 拖曳排序（HTML5 drag-and-drop）在手機觸控上沒辦法用，所以用選單按鈕做替代方案
  if (idx > 0) items.push({ label: "⬆️ 上移一頁", action: () => reorderPages(entry, state.pages[idx - 1]) });
  if (idx < state.pages.length - 1) items.push({ label: "⬇️ 下移一頁", action: () => reorderPages(entry, state.pages[idx + 1]) });
  items.forEach((it) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.addEventListener("click", () => {
      closeThumbContextMenu();
      it.action();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - menuRect.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - menuRect.height - 8) + "px";
  thumbContextMenuEl = menu;
  setTimeout(() => document.addEventListener("click", closeThumbContextMenu, { once: true }), 0);
}

/* ---------------- 拖曳 PDF 檔案到頁面縮圖區：插入到拖放的位置 ---------------- */

let thumbDropIndicator = null;
function ensureThumbDropIndicator() {
  if (!thumbDropIndicator) {
    thumbDropIndicator = document.createElement("div");
    thumbDropIndicator.className = "thumb-drop-indicator";
    thumbDropIndicator.hidden = true;
    thumbList.appendChild(thumbDropIndicator);
  }
  return thumbDropIndicator;
}
function computeThumbDropIndex(clientX, clientY) {
  for (let i = 0; i < state.pages.length; i++) {
    const r = state.pages[i].thumbItemEl.getBoundingClientRect();
    if (clientY < r.top) return i;
    if (clientY <= r.bottom && clientX < r.left + r.width / 2) return i;
  }
  return state.pages.length;
}
function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}
thumbList.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) {
    // 拖曳縮圖排序／Ctrl 複製時，即使游標停在卡片間距或列表下方空白處也能持續顯示放置位置並成功放下
    if (thumbDragEntries.length) {
      const isCopy = !!(e.ctrlKey || e.metaKey);
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
      if (e.target === thumbList && state.pages.length) {
        const idx = computeThumbDropIndex(e.clientX, e.clientY);
        const multiCol = isThumbGridMultiCol();
        const placeAfter = idx >= state.pages.length;
        const targetEntry = placeAfter ? state.pages[state.pages.length - 1] : state.pages[idx];
        if (!isCopy && thumbDragEntries.includes(targetEntry)) {
          clearThumbDragOver();
        } else {
          const side = multiCol ? (placeAfter ? "right" : "left") : (placeAfter ? "bottom" : "top");
          setThumbDragOver(targetEntry.thumbItemEl, targetEntry, side, placeAfter, isCopy);
        }
      }
    }
    return;
  }
  e.preventDefault();
  const indicator = ensureThumbDropIndicator();
  const idx = computeThumbDropIndex(e.clientX, e.clientY);
  indicator.hidden = false;
  if (idx >= state.pages.length) {
    thumbList.appendChild(indicator);
  } else {
    thumbList.insertBefore(indicator, state.pages[idx].thumbItemEl);
  }
});
thumbList.addEventListener("dragleave", (e) => {
  if (!thumbList.contains(e.relatedTarget)) {
    if (thumbDropIndicator) thumbDropIndicator.hidden = true;
    clearThumbDragOver();
  }
});
thumbList.addEventListener("drop", async (e) => {
  if (!isFileDrag(e)) {
    if (thumbDragEntries.length && thumbDragTarget) {
      e.preventDefault();
      const isCopy = !!(e.ctrlKey || e.metaKey);
      const entries = thumbDragEntries.slice();
      const target = thumbDragTarget;
      clearThumbDragState();
      if (!isCopy && entries.includes(target.entry)) return;
      const toIdx = state.pages.indexOf(target.entry);
      if (toIdx >= 0) {
        const insertIdx = target.placeAfter ? toIdx + 1 : toIdx;
        if (isCopy) await duplicatePagesToIndex(entries, insertIdx);
        else movePagesToIndex(entries, insertIdx);
      }
    }
    return;
  }
  e.preventDefault();
  if (thumbDropIndicator) thumbDropIndicator.hidden = true;
  const idx = computeThumbDropIndex(e.clientX, e.clientY);
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type === "application/pdf");
  if (!files.length) return;
  let insertAt = idx;
  for (const f of files) {
    await insertFileAtIndex(f, insertAt);
    insertAt += state.sources[state.sources.length - 1].pdfjsDoc.numPages;
  }
});

async function insertFileAtIndex(file, index) {
  showLoading("讀取 PDF 中…");
  try {
    const buffer = await file.arrayBuffer();
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const sourceIndex = state.sources.length;
    state.sources.push({ buffer, pdfjsDoc, libDoc: null, fileName: file.name });
    const newEntries = [];
    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const pdfjsPage = await pdfjsDoc.getPage(i);
      newEntries.push({
        sourceIndex, pageIndexInSource: i - 1, pdfjsPage,
        baseRotation: pdfjsPage.rotate || 0, userDelta: 0, objects: [], watermark: null, history: [],
      });
    }
    await insertEntries(newEntries, index);
    toast(`已插入「${file.name}」，共 ${pdfjsDoc.numPages} 頁`);
  } catch (err) {
    console.error(err);
    toast("讀取檔案失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

function updateSelectionButtons() {
  const anyChecked = state.pages.some((p) => p.thumbCheckEl && p.thumbCheckEl.checked);
  $("#btnExtract").disabled = !anyChecked;
  $("#btnDeleteSelected").disabled = !anyChecked;
}

/* ---------------- 旋轉 / 刪除 / 取出 ---------------- */

function rotatePage(entry, delta) {
  entry.userDelta = (((entry.userDelta + delta) % 360) + 360) % 360;
  layoutPage(entry);
  renderThumb(entry);
  scheduleAutosave();
}

$("#btnDeleteSelected").addEventListener("click", async () => {
  const toDelete = state.pages.filter((p) => p.thumbCheckEl.checked);
  if (!toDelete.length) return;
  if (toDelete.length === state.pages.length) {
    toast("不能刪除全部頁面", true);
    return;
  }
  const ok = await showConfirm(`確定要刪除 ${toDelete.length} 頁嗎？`);
  if (!ok) return;
  if (state.selected && toDelete.includes(state.selected.entry)) {
    setSelected(null);
    renderToolOptions();
  }
  toDelete.forEach((entry) => {
    clearTimeout(entry._thumbTimer);
    entry.rowEl.remove();
    entry.thumbItemEl.remove();
    state.pages.splice(state.pages.indexOf(entry), 1);
  });
  renumber();
  updateSelectionButtons();
  scheduleAutosave();
});

function showConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>請確認</h3>
        <p style="margin:0;color:var(--label-d);font-size:14px;">${message}</p>
        <div class="modal-actions">
          <button data-act="cancel">取消</button>
          <button data-act="ok" class="primary">確定</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "ok") {
        backdrop.remove();
        resolve(true);
      } else if (act === "cancel" || e.target === backdrop) {
        backdrop.remove();
        resolve(false);
      }
    });
  });
}

$("#btnExtract").addEventListener("click", async () => {
  const selected = state.pages.filter((p) => p.thumbCheckEl.checked);
  if (!selected.length) return;
  await exportPages(selected, "取出頁面.pdf");
});

/* ---------------- 縮放 ---------------- */

$("#btnZoomIn").addEventListener("click", () => changeZoom(0.15));
$("#btnZoomOut").addEventListener("click", () => changeZoom(-0.15));

// 雙指縮放手勢會在很短時間內連續觸發很多次（每個畫面更新週期一次），如果上一次的
// setZoom 還在跑（renderPage 要等 PDF.js 重繪，不是立即完成），不能再疊一次重複執行，
// 不然好幾個縮放同時重畫同一批 canvas，畫面會亂跳、loading 遮罩也會閃爍。這裡用「尾端
// 節流」：忙碌中新進來的縮放要求只記住最新那個目標值，等目前這次跑完才接著處理。
let zoomRunning = false;
let zoomQueued = null;
async function setZoom(next, opts) {
  next = Math.min(3, Math.max(0.3, Math.round(next * 100) / 100));
  if (next === state.zoom) return;
  if (zoomRunning) {
    zoomQueued = { next, opts };
    return;
  }
  zoomRunning = true;
  const oldZoom = state.zoom;
  // 如果有指定 anchor（兩指縮放的手指中點，螢幕座標），先記下這個點目前對應到
  // viewerScroll 捲動內容裡的哪個位置，縮放完、頁面尺寸改變之後，再把捲動位置
  // 反推回去，讓這個點縮放前後都還是停在同一個螢幕位置——體感上就是「以兩指中心為準縮放」。
  let anchorScrollLeftBefore, anchorScrollTopBefore, anchorScreenX, anchorScreenY;
  if (opts && opts.anchor) {
    const viewportRect = viewerScroll.getBoundingClientRect();
    anchorScrollLeftBefore = viewerScroll.scrollLeft;
    anchorScrollTopBefore = viewerScroll.scrollTop;
    anchorScreenX = opts.anchor.x - viewportRect.left;
    anchorScreenY = opts.anchor.y - viewportRect.top;
  }
  state.zoom = next;
  updateZoomLabel();
  // 縮放（尤其滑鼠滾輪／雙指手勢）動作很頻繁，每次都跳出載入遮罩會一直閃爍、很煩，
  // 所以縮放不顯示載入中——這個流程本來就快，不需要遮罩擋互動。
  try {
    for (const entry of state.pages) {
      await renderPage(entry, state.zoom, { skipThumb: true });
      layoutPage(entry);
    }
    if (opts && opts.anchor) {
      // 用「加上縮放造成的差額」而不是直接設成算好的絕對值：renderPage 要等 PDF.js
      // 重繪，這段 await 期間使用者的兩指平移（上面 touchmove 直接調整 scrollLeft/Top
      // 那段）可能還在繼續跑，用相加的才不會把這段期間使用者手指帶動的捲動蓋掉、產生頓挫感。
      const r = next / oldZoom;
      viewerScroll.scrollLeft += (anchorScrollLeftBefore + anchorScreenX) * (r - 1);
      viewerScroll.scrollTop += (anchorScrollTopBefore + anchorScreenY) * (r - 1);
    } else if (!opts || opts.recenter !== false) {
      // 手機雙指縮放手勢沒有指定 anchor 時（理論上不會發生，保留當 fallback），或滑鼠／
      // 按鈕縮放時，才用「整個置中」這個比較粗略的方式；兩指縮放手勢一律會帶 anchor，
      // 不會跟使用者手指正在帶動的捲動位置打架、畫面被硬拉回正中間。
      centerViewerHorizontally();
      // 單頁模式下畫面永遠只會有「目前這一頁」一個 row，跟一般連續捲動模式不同，不會有
      // 「使用者原本捲到文件中間，結果被縮放硬拉回正中間」的問題，所以可以放心直向也置中。
      if (state.viewMode === "single") centerViewerVertically();
    }
  } finally {
    zoomRunning = false;
    if (zoomQueued) {
      const q = zoomQueued;
      zoomQueued = null;
      setZoom(q.next, q.opts);
    }
  }
}
async function changeZoom(delta, opts) {
  await setZoom(state.zoom + delta, opts);
}
function updateZoomLabel() {
  $("#zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
}

// 可視範圍扣掉 viewer-scroll 的 padding 之後，實際可以放頁面內容的寬高。
function viewerAvailableSize() {
  const cs = getComputedStyle(viewerScroll);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  return { w: viewer.clientWidth - padX, h: viewer.clientHeight - padY };
}

// 算出讓這一頁（不含暫放區，暫放區本來就預期要捲動才看得到）完整顯示在目前可視範圍內的縮放比例。
function computeFitZoom(entry) {
  const total = (entry.baseRotation + entry.userDelta + 360) % 360;
  const rotated = total === 90 || total === 270;
  const nativeW = (rotated ? entry.cropH : entry.cropW) * CSS_SCALE;
  const nativeH = (rotated ? entry.cropW : entry.cropH) * CSS_SCALE;
  const avail = viewerAvailableSize();
  const fit = Math.min(avail.w / nativeW, avail.h / nativeH);
  return Math.min(3, Math.max(0.3, Math.round(fit * 100) / 100));
}

// 切到單頁模式時，把「目前這一頁」縮放到整頁完整顯示在畫面上，不用使用者自己手動調縮放。
async function fitCurrentPageToViewer() {
  const entry = state.pages[state.currentPageIndex];
  if (!entry) return;
  await setZoom(computeFitZoom(entry));
}

// 按住 Ctrl 滾滾輪可以縮放（觸控板兩指縮放手勢瀏覽器也會視為 ctrlKey+wheel，一併支援）。
// 用 requestAnimationFrame 把同一個畫面更新週期內的多次 wheel 事件合併成一次縮放，
// 避免連續滾動時每個事件都重新渲染全部頁面造成卡頓。
// 滑鼠游標位置當 anchor，縮放基準點跟著滑鼠走（道理跟手機雙指縮放的 anchor 一樣，
// 見 setZoom() 的 opts.anchor），游標指著哪裡，縮放前後那裡的內容都停在原地不會跑掉。
let wheelZoomPending = 0;
let wheelZoomX = 0;
let wheelZoomY = 0;
let wheelZoomScheduled = false;
viewer.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !state.pages.length) return;
    e.preventDefault();
    wheelZoomPending += -e.deltaY * 0.002;
    wheelZoomX = e.clientX;
    wheelZoomY = e.clientY;
    if (!wheelZoomScheduled) {
      wheelZoomScheduled = true;
      requestAnimationFrame(() => {
        const delta = Math.max(-0.3, Math.min(0.3, wheelZoomPending));
        wheelZoomPending = 0;
        wheelZoomScheduled = false;
        changeZoom(delta, { anchor: { x: wheelZoomX, y: wheelZoomY } });
      });
    }
  },
  { passive: false }
);

/* ---------------- 手機雙指縮放／雙指拖曳瀏覽 ----------------
   單指要留給畫筆／螢光筆／選取移動物件等既有編輯操作用，所以頁面本身的縮放、上下左右
   瀏覽都改成一定要用兩指：兩指開合＝縮放，兩指拖曳＝平移；單指在頁面上不管怎麼滑都不會
   讓畫面移動（固定），只會觸發原本的編輯工具行為。對應地，overlay-canvas 原本「瀏覽工具
   時用 pan-y 讓單指原生捲動」的設定也拿掉了（見 setTool() 跟 attachPageInteractions()），
   一律 touch-action:none，捲動／縮放全部交給這裡的 JS 自己處理。 */
function touchDist(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}
function touchMid(t0, t1) {
  return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
}
let twoFingerGesture = null;
// 目前螢幕上同時有幾根手指。canvas 的 pointerdown 要靠這個判斷「現在是不是已經有兩指在
// 進行縮放／平移手勢了，不要再多開一個單指畫圖／選取的互動」（見 attachPageInteractions()）。
// touchstart 會比對應那根手指的 pointerdown 先觸發，所以在這裡更新一定來得及。
let activeTouchCount = 0;
let pinchZoomPending = null;
let pinchZoomScheduled = false;
function schedulePinchZoom(z, mid) {
  pinchZoomPending = { z, mid };
  if (!pinchZoomScheduled) {
    pinchZoomScheduled = true;
    requestAnimationFrame(() => {
      const pending = pinchZoomPending;
      pinchZoomScheduled = false;
      if (pending != null) setZoom(pending.z, { recenter: false, anchor: pending.mid });
    });
  }
}
viewer.addEventListener(
  "touchstart",
  (e) => {
    activeTouchCount = e.touches.length;
    if (e.touches.length !== 2 || !state.pages.length) return;
    e.preventDefault();
    // 兩指手勢一開始，取消任何正在進行中的單指操作（例如不小心先碰到畫筆畫了一點點），
    // 避免兩指縮放／平移跟單指畫圖同時進行、狀態互相打架
    if (state.interaction) finishInteraction();
    const mid = touchMid(e.touches[0], e.touches[1]);
    twoFingerGesture = {
      startDist: touchDist(e.touches[0], e.touches[1]),
      startZoom: state.zoom,
      lastMidX: mid.x,
      lastMidY: mid.y,
    };
  },
  { passive: false }
);
viewer.addEventListener(
  "touchmove",
  (e) => {
    if (!twoFingerGesture || e.touches.length !== 2) return;
    e.preventDefault();
    const mid = touchMid(e.touches[0], e.touches[1]);
    // 平移：兩指中點移動多少，畫面就反方向捲動多少，手感跟直接拖著內容走一致
    viewerScroll.scrollLeft -= mid.x - twoFingerGesture.lastMidX;
    viewerScroll.scrollTop -= mid.y - twoFingerGesture.lastMidY;
    twoFingerGesture.lastMidX = mid.x;
    twoFingerGesture.lastMidY = mid.y;
    // 縮放：跟兩指「這次手勢一開始」的間距比較出比例，套在手勢開始當下的縮放值上；
    // 用目前這個當下的兩指中點當 anchor，讓縮放基準點跟著手指即時的中心點走
    const dist = touchDist(e.touches[0], e.touches[1]);
    schedulePinchZoom(twoFingerGesture.startZoom * (dist / twoFingerGesture.startDist), mid);
  },
  { passive: false }
);
["touchend", "touchcancel"].forEach((ev) =>
  viewer.addEventListener(ev, (e) => {
    activeTouchCount = e.touches.length;
    if (e.touches.length < 2) twoFingerGesture = null;
  })
);

// 避免 Ctrl+滾輪／觸控板兩指縮放把「整個網頁」放大，而不是只放大 PDF 頁面：上面那個
// wheel 監聽器只掛在 #viewer 上，滾到工具列、側邊欄那些區域時不會被攔到，所以這裡再掛一個
// 全域的，只負責擋掉瀏覽器原生縮放，不處理縮放邏輯（邏輯交給上面 #viewer 那個監聽器）。
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false }
);
// Safari／iPad 的雙指 pinch 縮放手勢不會觸發 wheel 事件，是另一套 gesture 事件，要分開擋。
["gesturestart", "gesturechange", "gestureend"].forEach((type) => {
  document.addEventListener(type, (e) => e.preventDefault());
});
// Ctrl + "+"/"-"/"="/"0" 這幾個瀏覽器縮放鍵盤快捷鍵也一併擋掉；但部分瀏覽器（尤其 Chrome）
// 把這幾個鍵當成保留的瀏覽器層級快捷鍵，網頁 JS 無法真的攔截，只能在允許攔截的瀏覽器上生效。
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
});

/* ---------------- 瀏覽方式：連續捲動／單頁／雙頁並排 ---------------- */

document.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => setViewMode(btn.dataset.view));
});
$("#btnPrevPage").addEventListener("click", () => goToPage(state.currentPageIndex - (state.viewMode === "spread" ? 2 : 1)));
$("#btnNextPage").addEventListener("click", () => goToPage(state.currentPageIndex + (state.viewMode === "spread" ? 2 : 1)));

function setViewMode(mode) {
  state.viewMode = mode;
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === mode));
  $("#pageNav").hidden = mode === "scroll";
  applyViewMode();
  // 按下「單頁顯示」時，把目前這一頁縮放到整頁完整顯示在畫面上，不用使用者自己手動調縮放。
  if (mode === "single") fitCurrentPageToViewer();
}

function applyViewMode() {
  if (state.currentPageIndex >= state.pages.length) {
    state.currentPageIndex = Math.max(0, state.pages.length - 1);
  }
  if (state.viewMode === "scroll") {
    viewerScroll.style.flexDirection = "column";
    state.pages.forEach((p) => (p.rowEl.style.display = ""));
  } else if (state.viewMode === "single") {
    viewerScroll.style.flexDirection = "column";
    state.pages.forEach((p, i) => (p.rowEl.style.display = i === state.currentPageIndex ? "" : "none"));
  } else if (state.viewMode === "spread") {
    viewerScroll.style.flexDirection = "row";
    state.pages.forEach((p, i) => {
      p.rowEl.style.display = i === state.currentPageIndex || i === state.currentPageIndex + 1 ? "" : "none";
    });
  }
  // 並排模式下 page-row 不保留暫放區寬度（見 pasteboardMarginPx），切換模式時要重算，
  // 不然寬度會停留在切換前的狀態
  state.pages.forEach((p) => layoutPage(p));
  centerViewerHorizontally();
  // 單頁模式下畫面永遠只有「目前這一頁」一個 row，不是連續捲動模式那種使用者自己捲到
  // 文件中間的情況，直向置中不會打斷使用者原本的捲動位置，可以放心每次都重算。
  if (state.viewMode === "single") centerViewerVertically();
  updateViewNav();
}

function goToPage(idx) {
  if (!state.pages.length) return false;
  const clamped = Math.max(0, Math.min(idx, state.pages.length - 1));
  if (clamped === state.currentPageIndex) return false;
  state.currentPageIndex = clamped;
  applyViewMode();
  return true;
}

function updateViewNav() {
  if (state.viewMode === "scroll" || !state.pages.length) return;
  const total = state.pages.length;
  const cur = state.currentPageIndex;
  if (state.viewMode === "spread" && cur + 1 < total) {
    $("#pageIndicator").textContent = `${cur + 1}-${cur + 2} / ${total}`;
  } else {
    $("#pageIndicator").textContent = `${cur + 1} / ${total}`;
  }
  $("#btnPrevPage").disabled = cur <= 0;
  $("#btnNextPage").disabled = state.viewMode === "spread" ? cur + 2 >= total : cur >= total - 1;
}

let wheelLock = false;
viewer.addEventListener(
  "wheel",
  (e) => {
    if (state.viewMode === "scroll" || !state.pages.length) return;
    e.preventDefault();
    if (wheelLock) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const step = state.viewMode === "spread" ? 2 : 1;
    goToPage(state.currentPageIndex + dir * step);
    wheelLock = true;
    setTimeout(() => {
      wheelLock = false;
    }, 350);
  },
  { passive: false }
);

/* ---------------- 工具切換 ---------------- */

document.querySelectorAll(".tool-btn:not(.view-btn)").forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

function setTool(tool) {
  if (state.currentTextEditor) closeTextEditor(true);
  if (tool === "watermark") {
    openWatermarkModal();
    return;
  }
  if (tool === "pagenum") {
    openPageNumberModal();
    return;
  }
  if (state.tool === "crop" && tool !== "crop") {
    state.pages.forEach((p) => clearCropPreview(p));
  }
  state.tool = tool;
  if (tool !== "pan" && state.selected) {
    setSelected(null);
  }
  document.querySelectorAll(".tool-btn:not(.view-btn)").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  state.pages.forEach((p) => {
    p.textLayerEl.classList.toggle("edit-mode", tool === "edittext");
    p.overlayCanvasEl.style.pointerEvents = tool === "edittext" ? "none" : "auto";
    // 一律 touch-action:none：頁面的捲動／縮放固定交給兩指手勢處理（見上面「手機雙指
    // 縮放／雙指拖曳瀏覽」），單指不管哪個工具都不觸發瀏覽器原生的單指捲動。
    p.overlayCanvasEl.style.touchAction = "none";
    redraw(p);
  });
  renderToolOptions();
}

function setSelected(sel) {
  state.selected = sel;
  pendingObjEditPushed = false;
}

/* ---------------- 物件模型：繪製 ---------------- */

function redraw(entry, opts) {
  const ctx = entry.overlayCanvasEl.getContext("2d");
  const scale = BACKING_DPR * state.zoom;
  renderPageObjects(entry, ctx, scale, { withHandles: true, pasteboard: true });
  if (!opts || !opts.skipThumb) scheduleThumbRender(entry);
}

const HIGHLIGHT_OPACITY = 0.42; // 同一批連續畫的螢光筆，不管塗幾筆、疊幾次，最後都只套用「一次」這個透明度，不會把底下蓋掉

function renderPageObjects(entry, ctx, scale, opts) {
  opts = opts || {};
  if (!opts.noClear) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // 暫放區只在畫面上的 overlay canvas 才有（opts.pasteboard），匯出時完全不套用，
  // 暫放區裡的物件不會被印出來。畫布可能比頁面本身還大（四周留了暫放區），
  // 所以頁面本身的實際像素寬高要另外算，不能直接拿 ctx.canvas.width/height 當頁面大小。
  const marginPx = opts.pasteboard ? PASTEBOARD_MARGIN : 0;
  const pageW = (entry.cropW || 0) * scale, pageH = (entry.cropH || 0) * scale;
  ctx.save();
  ctx.translate((marginPx - (entry.cropX || 0)) * scale, (marginPx - (entry.cropY || 0)) * scale);
  if (entry.watermark) drawWatermarkObj(ctx, entry.watermark, scale, pageW, pageH, entry);

  const drawOne = (obj) => {
    if (obj.rotation && obj.type !== "indexmark") {
      const c = getCenter(obj);
      ctx.save();
      ctx.translate(c.x * scale, c.y * scale);
      ctx.rotate((obj.rotation * Math.PI) / 180);
      ctx.translate(-c.x * scale, -c.y * scale);
      drawObject(ctx, obj, scale, entry);
      ctx.restore();
    } else {
      drawObject(ctx, obj, scale, entry);
    }
  };

  // 依原本的疊放順序處理，但「連續」好幾筆螢光筆會先合併成一塊（互相重疊只是形狀聯集，
  // 不會疊加變深），再整塊套用一次固定透明度畫上去——這樣既不會塗很多次就蓋掉底下內容，
  // 也不會因為螢光筆都被排到最底層，而被後來貼上的圖片／物件蓋住看不到。
  const objs = entry.objects.filter((o) => !o._editing);
  let i = 0;
  while (i < objs.length) {
    if (objs[i].type === "highlight") {
      const run = [];
      while (i < objs.length && objs[i].type === "highlight") {
        run.push(objs[i]);
        i++;
      }
      drawHighlightRun(ctx, run, scale);
    } else {
      drawOne(objs[i]);
      i++;
    }
  }

  if (opts.withHandles && state.selected && state.selected.entry === entry) {
    // 正在用浮動輸入框編輯文字的物件不疊畫選取框／把手——物件很小的時候，
    // 虛線框、縮放把手、旋轉把手全部擠在一小塊範圍裡，看起來會很亂。
    const visibleSel = state.selected.objs.filter((o) => !o._editing);
    if (visibleSel.length) drawSelectionUI(ctx, visibleSel, scale);
  }
  ctx.restore();
  // 頁碼畫在裁切位移之外（不受裁切影響，永遠貼齊目前看得到的頁面邊緣），但還是要跟著
  // 暫放區的位移平移，頁碼才會貼在「頁面」真正的邊緣，不會因為四周多留的暫放區而跑位。
  if (state.pageNumberConfig) {
    ctx.save();
    ctx.translate(marginPx * scale, marginPx * scale);
    drawPageNumberObj(ctx, state.pageNumberConfig, scale, pageW, pageH, entry);
    ctx.restore();
  }
  // 只有編輯畫面（有暫放區）才需要顯示邊界參考線；匯出的乾淨版本不畫。
  if (opts.pasteboard && objectsExceedPageBounds(entry)) {
    ctx.save();
    ctx.translate(marginPx * scale, marginPx * scale);
    drawPageBoundaryGuide(ctx, pageW, pageH);
    ctx.restore();
  }
}

// 頁碼：cfg = { format, startAt, skipFirst, position, fontSize, color }
// format 支援 {n}（目前頁碼）、{total}（總頁數，skipFirst 時不計入被跳過的那一頁）
function drawPageNumberObj(ctx, cfg, scale, cw, ch, entry) {
  const pageIndex = state.pages.indexOf(entry);
  if (pageIndex < 0) return;
  if (cfg.skipFirst && pageIndex === 0) return;
  const numberedIndex = cfg.skipFirst ? pageIndex - 1 : pageIndex;
  const displayNumber = (cfg.startAt || 0) + numberedIndex;
  const total = cfg.skipFirst ? Math.max(0, state.pages.length - 1) : state.pages.length;
  const text = String(cfg.format || "{n}").replace(/\{n\}/g, displayNumber).replace(/\{total\}/g, total);
  if (!text) return;

  const marginPt = 24;
  const marginPx = marginPt * scale;
  const fontPx = Math.max(1, (cfg.fontSize || 12) * scale);
  const pos = cfg.position || "bottom-center";

  ctx.save();
  ctx.font = `${fontPx}px "Microsoft JhengHei","Noto Sans TC",sans-serif`;
  ctx.fillStyle = cfg.color || "#000000";
  let x;
  if (pos.includes("left")) {
    ctx.textAlign = "left";
    x = marginPx;
  } else if (pos.includes("right")) {
    ctx.textAlign = "right";
    x = cw - marginPx;
  } else {
    ctx.textAlign = "center";
    x = cw / 2;
  }
  let y;
  if (pos.startsWith("top")) {
    ctx.textBaseline = "top";
    y = marginPx;
  } else {
    ctx.textBaseline = "bottom";
    y = ch - marginPx;
  }

  if (cfg.bg && cfg.bg.enabled) {
    const padX = fontPx * 0.5, padY = fontPx * 0.25;
    const textWidth = ctx.measureText(text).width;
    let boxLeft;
    if (ctx.textAlign === "left") boxLeft = x - padX;
    else if (ctx.textAlign === "right") boxLeft = x - textWidth - padX;
    else boxLeft = x - textWidth / 2 - padX;
    const boxTop = ctx.textBaseline === "top" ? y - padY : y - fontPx - padY;
    ctx.save();
    ctx.fillStyle = cfg.bg.color || "#ffeb3b";
    ctx.fillRect(boxLeft, boxTop, textWidth + padX * 2, fontPx + padY * 2);
    ctx.restore();
  }

  ctx.fillText(text, x, y);
  ctx.restore();
}

// 頁面邊界參考線：有物件超出目前頁面範圍、可能蓋住紙張邊緣讓人看不出實際多大時，
// 用「白底＋深色虛線」疊在最上層補畫一圈邊界，不管物件本身是什麼顏色都能看得出來。
function drawPageBoundaryGuide(ctx, pageW, pageH) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,.9)";
  ctx.strokeRect(0, 0, pageW, pageH);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(0, 0, pageW, pageH);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawHighlightRun(ctx, run, scale) {
  const hCanvas = document.createElement("canvas");
  hCanvas.width = ctx.canvas.width;
  hCanvas.height = ctx.canvas.height;
  const hctx = hCanvas.getContext("2d");
  // hctx 是全新的離屏 canvas，預設是單位矩陣（沒有 ctx 目前的暫放區／裁切位移）。螢光筆拖進
  // 左邊或上面的暫放區時，物件的頁面座標會是負值，沒有這段位移的話畫出來的點會落在 hCanvas
  // 畫布範圍外（canvas 本身會直接裁掉畫布外的內容，不是之後才裁），整條筆跡就會憑空消失。
  // 用 ctx.getTransform() 把目前的位移複製過去，螢光筆才會跟其他物件一樣可以畫到暫放區。
  hctx.setTransform(ctx.getTransform());
  run.forEach((obj) => drawStrokeObject(hctx, obj, scale, 1));
  ctx.save();
  // hCanvas 裡的內容已經用上面複製的位移畫成「絕對位置」了，合成回 ctx 時要用單位矩陣，
  // 不然 ctx 身上還在生效的同一份位移會被疊加兩次，畫面會跑位。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = HIGHLIGHT_OPACITY;
  ctx.drawImage(hCanvas, 0, 0);
  ctx.restore();
}

function drawObject(ctx, obj, scale, entry) {
  if (obj.type === "text") drawTextObject(ctx, obj, scale);
  else if (obj.type === "pen") drawStrokeObject(ctx, obj, scale, 1);
  else if (obj.type === "rect" || obj.type === "ellipse" || obj.type === "cloud") drawShapeObject(ctx, obj, scale);
  else if (obj.type === "image") drawImageObject(ctx, obj, scale, entry);
  else if (obj.type === "indexmark") drawIndexMarkObject(ctx, obj, scale, entry);
}

// 文字物件量測用的共用離屏 canvas：編輯時的輸入框跟最後畫出來的結果都用同一套公式算尺寸，
// 這樣編輯中看到的框框大小就會跟排版完成後一模一樣，不用自己憑感覺拖/縮。
const textMeasureCtx = document.createElement("canvas").getContext("2d");
function measureTextBoxPt(text, fontSize) {
  textMeasureCtx.font = `${fontSize}px "Microsoft JhengHei","Noto Sans TC",sans-serif`;
  const lines = (text || "").split("\n");
  const lineHeightPt = fontSize * 1.3;
  const widthsPt = lines.map((l) => textMeasureCtx.measureText(l).width);
  const boxWPt = Math.max(...widthsPt, 10);
  const boxHPt = lineHeightPt * Math.max(lines.length, 1);
  return { w: boxWPt + TEXT_PAD * 2, h: boxHPt + TEXT_PAD * 2 };
}

function drawTextObject(ctx, obj, scale) {
  const fontPx = Math.max(1, obj.fontSize * scale);
  ctx.font = `${fontPx}px "Microsoft JhengHei","Noto Sans TC",sans-serif`;
  ctx.textBaseline = "top";
  const lines = (obj.text || "").split("\n");
  const lineHeightPt = obj.fontSize * 1.3;
  const box = measureTextBoxPt(obj.text, obj.fontSize);
  obj._w = box.w;
  obj._h = box.h;

  const x = obj.x * scale, y = obj.y * scale;
  const padPx = TEXT_PAD * scale;
  const boxWPx = obj._w * scale, boxHPx = obj._h * scale;
  if (obj.bg && obj.bg.enabled) {
    ctx.fillStyle = obj.bg.color;
    ctx.fillRect(x - padPx, y - padPx, boxWPx, boxHPx);
  }
  if (obj.border && obj.border.enabled) {
    ctx.strokeStyle = obj.border.color;
    ctx.lineWidth = Math.max(1, obj.border.width * scale);
    ctx.strokeRect(x - padPx, y - padPx, boxWPx, boxHPx);
  }
  ctx.fillStyle = obj.color;
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeightPt * scale));
}

function drawImageObject(ctx, obj, scale, entry) {
  if (!obj._img) {
    const img = new Image();
    img.onload = () => {
      if (entry) redraw(entry);
    };
    img.src = obj.dataUrl;
    obj._img = img;
    return;
  }
  if (!obj._img.complete || !obj._img.naturalWidth) return;
  const crop = obj.crop || { x: 0, y: 0, w: 1, h: 1 };
  const natW = obj._img.naturalWidth, natH = obj._img.naturalHeight;
  ctx.drawImage(
    obj._img,
    crop.x * natW, crop.y * natH, crop.w * natW, crop.h * natH,
    obj.x * scale, obj.y * scale, obj.w * scale, obj.h * scale
  );
  if (obj.border && obj.border.enabled) {
    ctx.save();
    ctx.strokeStyle = obj.border.color;
    ctx.lineWidth = Math.max(1, obj.border.width * scale);
    ctx.strokeRect(obj.x * scale, obj.y * scale, obj.w * scale, obj.h * scale);
    ctx.restore();
  }
  if (obj.dateStamp && obj.dateStamp.enabled && obj.dateStamp.date) {
    drawImageDateStamp(ctx, obj, scale);
  }
}

// 相機日期章：仿照相機會把拍照日期燒印在照片左下角的樣子，橘黃色數字＋深色描邊
// 確保疊在任何顏色的照片上都看得清楚；字級跟留白都是照片本身高度的比例，照片縮放時
// 日期章也會跟著等比例縮放，不用每張照片自己再調一次大小。
function drawImageDateStamp(ctx, obj, scale) {
  const w = Math.abs(obj.w), h = Math.abs(obj.h);
  const x0 = Math.min(obj.x, obj.x + obj.w), y0 = Math.min(obj.y, obj.y + obj.h);
  const [y, m, d] = obj.dateStamp.date.split("-");
  const text = `${y}/${m}/${d}`;
  const fontPt = Math.max(10, Math.min(42, h * 0.045));
  const padPt = fontPt * 0.6;
  const fontPx = fontPt * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 * scale, y0 * scale, w * scale, h * scale);
  ctx.clip();
  ctx.font = `${fontPx}px "Consolas","DejaVu Sans Mono",monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const tx = x0 * scale + padPt * scale;
  const ty = y0 * scale + h * scale - padPt * scale;
  ctx.lineWidth = Math.max(1, fontPx * 0.12);
  ctx.strokeStyle = "rgba(0,0,0,.55)";
  ctx.strokeText(text, tx, ty);
  ctx.fillStyle = "#ffae00";
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function drawStrokeObject(ctx, obj, scale, opacity) {
  if (!obj.points || obj.points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = Math.max(1, obj.width * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(obj.points[0].x * scale, obj.points[0].y * scale);
  for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x * scale, obj.points[i].y * scale);
  ctx.stroke();
  ctx.restore();
}

function drawShapeObject(ctx, obj, scale) {
  const x = Math.min(obj.x, obj.x + obj.w) * scale;
  const y = Math.min(obj.y, obj.y + obj.h) * scale;
  const w = Math.abs(obj.w) * scale;
  const h = Math.abs(obj.h) * scale;
  ctx.save();
  if (obj.fill && obj.fill.enabled) {
    ctx.save();
    ctx.globalAlpha = obj.fill.opacity == null ? 1 : obj.fill.opacity;
    ctx.fillStyle = obj.fill.color;
    traceShapePath(ctx, obj, x, y, w, h);
    ctx.fill();
    ctx.restore();
  }
  if (obj.strokeWidth > 0) {
    ctx.strokeStyle = obj.stroke;
    ctx.lineWidth = Math.max(1, obj.strokeWidth * scale);
    ctx.lineJoin = "round";
    traceShapePath(ctx, obj, x, y, w, h);
    ctx.stroke();
  }
  if (obj.text) {
    ctx.save();
    traceShapePath(ctx, obj, x, y, w, h);
    ctx.clip();
    drawCenteredTextInBox(ctx, obj.text, obj.textColor || "#000000", (obj.fontSize || 16) * scale, x, y, w, h);
    ctx.restore();
  }
  ctx.restore();
}

// 依形狀種類描出路徑：方形／橢圓跟以前一樣，雲型線則沿著外框畫一圈連續的弧形（像手繪雲朵的外框），
// 常用在建築圖上標示「這個範圍有改過」。
function traceShapePath(ctx, obj, x, y, w, h) {
  ctx.beginPath();
  if (obj.type === "rect") {
    ctx.rect(x, y, w, h);
  } else if (obj.type === "cloud") {
    traceCloudPath(ctx, x, y, w, h);
  } else {
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.01, w / 2), Math.max(0.01, h / 2), 0, 0, Math.PI * 2);
  }
  ctx.closePath();
}

function traceCloudPath(ctx, x, y, w, h) {
  const perim = 2 * (w + h);
  if (perim < 1) return;
  const targetChord = Math.min(40, Math.max(10, perim / 14));
  const n = Math.max(6, Math.round(perim / targetChord));
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(pointOnRectPerimeter(x, y, w, h, (perim * i) / n));
  let p1 = pts[0];
  ctx.moveTo(p1.x, p1.y);
  for (let i = 1; i <= pts.length; i++) {
    const p2 = pts[i % pts.length];
    const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
    if (r > 0.01) {
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      // 每一段都用「以兩點連線為直徑」的半圓往外鼓起，一段接一段就會變成雲朵狀的連續弧線
      ctx.arc((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, r, angle + Math.PI, angle, false);
    }
    p1 = p2;
  }
}

// 從外框左上角出發，沿順時針方向（上→右→下→左）走到距離 d 的位置
function pointOnRectPerimeter(x, y, w, h, d) {
  if (d <= w) return { x: x + d, y: y };
  d -= w;
  if (d <= h) return { x: x + w, y: y + d };
  d -= h;
  if (d <= w) return { x: x + w - d, y: y + h };
  d -= w;
  return { x: x, y: y + h - d };
}

// 將文字依字元自動換行（中文多半沒有空白可斷行，所以用逐字量測寬度的方式換行，保留原有的手動換行符號）
function wrapTextLines(ctx, text, maxWidthPx) {
  const out = [];
  (text || "").split("\n").forEach((para) => {
    if (para === "") {
      out.push("");
      return;
    }
    let cur = "";
    for (const ch of para) {
      const test = cur + ch;
      if (cur && ctx.measureText(test).width > maxWidthPx) {
        out.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    if (cur) out.push(cur);
  });
  return out;
}

// 在指定方框（像素座標）中垂直＋水平置中畫出（可換行、超出範圍的部分由呼叫端用 clip() 裁切）文字
function drawCenteredTextInBox(ctx, text, color, fontPx, x, y, w, h) {
  if (!text) return;
  fontPx = Math.max(1, fontPx);
  ctx.font = `${fontPx}px "Microsoft JhengHei","Noto Sans TC",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  const pad = Math.min(w, h) * 0.08 + 4;
  const maxWidth = Math.max(4, w - pad * 2);
  const lines = wrapTextLines(ctx, text, maxWidth);
  const lineHeight = fontPx * 1.3;
  const totalH = lineHeight * lines.length;
  const cx = x + w / 2;
  const startY = y + h / 2 - totalH / 2 + lineHeight / 2;
  lines.forEach((line, i) => ctx.fillText(line, cx, startY + i * lineHeight));
}

// 索引符號（剖面／立面索引用的圓圈＋三角指標）：圖案可以旋轉（讓三角形指向正確方向），
// 但文字與圓圈本體永遠保持水平不轉，方便閱讀。外框（obj.x/y/w/h）本身也不隨旋轉變化，
// 已在 isTransformable／getBBox／toLocalPointForBBox／applyResize／drawSelectionUI 中特別處理。
function drawIndexMarkObject(ctx, obj, scale, entry) {
  const bx = Math.min(obj.x, obj.x + obj.w) * scale;
  const by = Math.min(obj.y, obj.y + obj.h) * scale;
  const s = Math.abs(obj.w) * scale;
  const cx = bx + s / 2, cy = by + s / 2;
  const R = s * 0.33;
  const stroke = obj.stroke || "#e21818";
  const sw = Math.max(1, (obj.strokeWidth || 2) * scale);
  const rot = ((obj.rotation || 0) * Math.PI) / 180;
  // 頁面本身可能有旋轉（例如橫式圖紙用直式顯示），頁面旋轉是用 CSS 整頁轉的，
  // canvas 裡畫的東西並不知道。文字要永遠保持「畫面上看起來正的」，所以要反方向轉回來抵銷掉。
  const pageRot = entry ? (((entry.baseRotation + entry.userDelta) % 360) + 360) % 360 : 0;

  // 三角形指標的三個頂點（局部座標：尖端朝 -y／「上」，再依 obj.rotation 轉到實際方向）
  const triHalf = R * 0.75; // 底邊半寬：要比圓半徑小，讓底邊兩端確實落在圓「裡面」，裁切時才不會在圓外留下殘段
  const tipDist = R * 1.8;  // 尖端到圓心的距離
  const baseDist = R * 0.3; // 底邊到圓心的距離（正值＝底邊在尖端的另一側，疊進圓裡）
  const rotPoint = (lx, ly) => ({
    x: cx + lx * Math.cos(rot) - ly * Math.sin(rot),
    y: cy + lx * Math.sin(rot) + ly * Math.cos(rot),
  });
  const tip = rotPoint(0, -tipDist);
  const baseA = rotPoint(triHalf, baseDist);
  const baseB = rotPoint(-triHalf, baseDist);

  // 填色：圓形＋三角形合併成「一個路徑」再整個 fill 一次，重疊的地方才不會疊加兩次透明度
  if (obj.fill && obj.fill.enabled) {
    ctx.save();
    ctx.globalAlpha = obj.fill.opacity == null ? 1 : obj.fill.opacity;
    ctx.fillStyle = obj.fill.color;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(baseA.x, baseA.y);
    ctx.lineTo(baseB.x, baseB.y);
    ctx.closePath();
    ctx.fill("nonzero");
    ctx.restore();
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = sw;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // 三角形的外框線只畫在圓「外面」的部分，裁掉圓內那段，圓裡面才不會被線條切過、擋到文字
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip("evenodd");
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(baseA.x, baseA.y);
  ctx.lineTo(baseB.x, baseB.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // 文字：永遠水平置中、畫面上看起來是正的，不隨三角指標的旋轉而轉，也不受頁面本身旋轉影響
  if (obj.text) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    if (pageRot) {
      ctx.translate(cx, cy);
      ctx.rotate((-pageRot * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    const fontPx = Math.max(1, (obj.fontSize || 28) * scale);
    drawCenteredTextInBox(ctx, obj.text, obj.textColor || "#000000", fontPx, cx - R, cy - R, R * 2, R * 2);
    ctx.restore();
  }
}

const watermarkImageCache = new Map(); // dataUrl -> Image，避免每頁各自重複載入同一張浮水印圖
function getOrLoadWatermarkImage(dataUrl) {
  let img = watermarkImageCache.get(dataUrl);
  if (img) return img;
  img = new Image();
  img.onload = () => {
    state.pages.forEach((p) => {
      if (p.watermark && p.watermark.mode === "image" && p.watermark.dataUrl === dataUrl) {
        redraw(p);
      }
    });
  };
  img.src = dataUrl;
  watermarkImageCache.set(dataUrl, img);
  return img;
}

function drawWatermarkObj(ctx, wm, scale, cw, ch, entry) {
  const rad = (wm.rotate * Math.PI) / 180;

  if (wm.mode === "image") {
    const img = getOrLoadWatermarkImage(wm.dataUrl);
    if (!img.complete || !img.naturalWidth) return;
    const wPx = wm.size * scale;
    const hPx = wPx * (img.naturalHeight / img.naturalWidth);
    ctx.save();
    ctx.globalAlpha = wm.opacity;
    if (wm.tile) {
      const stepX = wPx * 1.4, stepY = hPx * 1.4;
      for (let y = -ch; y < ch * 2; y += stepY) {
        for (let x = -cw; x < cw * 2; x += stepX) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(rad);
          ctx.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
          ctx.restore();
        }
      }
    } else {
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
      ctx.restore();
    }
    ctx.restore();
    return;
  }

  const fontPx = wm.size * scale;
  ctx.save();
  ctx.globalAlpha = wm.opacity;
  ctx.fillStyle = wm.color;
  ctx.font = `bold ${fontPx}px "Microsoft JhengHei","Noto Sans TC",sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  if (wm.tile) {
    const stepX = ctx.measureText(wm.text).width + fontPx * 2;
    const stepY = fontPx * 4;
    for (let y = -ch; y < ch * 2; y += stepY) {
      for (let x = -cw; x < cw * 2; x += stepX) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rad);
        ctx.fillText(wm.text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rad);
    ctx.fillText(wm.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// 單一物件的選取框（含縮放／旋轉把手）；outlineOnly 時只畫虛線外框，不畫把手
// （多選時每個物件都用這個畫一次外框，把手只出現在整體的外框上，見 drawSelectionUI）
function drawSingleSelectionUI(ctx, obj, scale, outlineOnly) {
  const b = getBBox(obj);
  const transformable = isTransformable(obj) && !obj.locked;
  // 索引符號的外框／縮放把手不隨旋轉變化（只有裡面的三角指標會轉），所以選取框也要維持不轉
  const wholeRotates = transformable && obj.rotation && obj.type !== "indexmark";
  ctx.save();
  if (wholeRotates) {
    const c = getCenter(obj);
    ctx.translate(c.x * scale, c.y * scale);
    ctx.rotate((obj.rotation * Math.PI) / 180);
    ctx.translate(-c.x * scale, -c.y * scale);
  }
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
  ctx.setLineDash([]);
  if (transformable && !outlineOnly) {
    const hx = (b.x + b.w) * scale, hy = (b.y + b.h) * scale;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(hx - 5, hy - 5, 10, 10);

    const cx = (b.x + b.w / 2) * scale;
    const topY = b.y * scale;
    const rotY = (b.y - ROTATE_HANDLE_DIST) * scale;

    if (obj.type === "indexmark" && obj.rotation) {
      // 旋轉把手要顯示目前指標角度，所以單獨再疊加一次旋轉來畫，外框本身不受影響
      const c = getCenter(obj);
      ctx.save();
      ctx.translate(c.x * scale, c.y * scale);
      ctx.rotate((obj.rotation * Math.PI) / 180);
      ctx.translate(-c.x * scale, -c.y * scale);
      drawRotateHandleGlyph(ctx, cx, topY, rotY);
      ctx.restore();
    } else {
      drawRotateHandleGlyph(ctx, cx, topY, rotY);
    }
  }
  ctx.restore();
}

// objs 永遠是陣列：只選一個時跟以前一樣（完整把手）；選多個時每個都畫外框，
// 再用一個橘色外框＋一個縮放把手涵蓋整體範圍，拖那個把手可以把整批物件一起等比例縮放。
function drawSelectionUI(ctx, objs, scale) {
  if (objs.length === 1) {
    drawSingleSelectionUI(ctx, objs[0], scale, false);
    return;
  }
  objs.forEach((obj) => drawSingleSelectionUI(ctx, obj, scale, true));
  const b = getSelectionBBox(objs);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#ea580c";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ea580c";
  ctx.fillRect((b.x + b.w) * scale - 5, (b.y + b.h) * scale - 5, 10, 10);
  ctx.restore();
}
function drawRotateHandleGlyph(ctx, cx, topY, rotY) {
  ctx.beginPath();
  ctx.moveTo(cx, topY);
  ctx.lineTo(cx, rotY);
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, rotY, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.stroke();
}

// 框選多個物件時的預覽框：直接畫在 overlay canvas 上，框選範圍可以延伸到頁面四周的暫放區
function drawMarqueePreview(entry, start, current) {
  const ctx = entry.overlayCanvasEl.getContext("2d");
  const scale = BACKING_DPR * state.zoom;
  const x0 = Math.min(start.x, current.x) - entry.cropX + PASTEBOARD_MARGIN;
  const y0 = Math.min(start.y, current.y) - entry.cropY + PASTEBOARD_MARGIN;
  const w = Math.abs(current.x - start.x);
  const h = Math.abs(current.y - start.y);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "#2563eb";
  ctx.fillStyle = "rgba(37,99,235,.08)";
  ctx.lineWidth = 1.5;
  ctx.fillRect(x0 * scale, y0 * scale, w * scale, h * scale);
  ctx.strokeRect(x0 * scale, y0 * scale, w * scale, h * scale);
  ctx.restore();
}

/* ---------------- 物件模型：幾何與命中測試 ---------------- */

function getBBox(obj) {
  if (obj.type === "text") {
    return { x: obj.x - TEXT_PAD, y: obj.y - TEXT_PAD, w: obj._w || 40, h: obj._h || 24 };
  }
  if (obj.type === "rect" || obj.type === "ellipse" || obj.type === "cloud" || obj.type === "image" || obj.type === "indexmark") {
    return { x: Math.min(obj.x, obj.x + obj.w), y: Math.min(obj.y, obj.y + obj.h), w: Math.abs(obj.w), h: Math.abs(obj.h) };
  }
  const xs = obj.points.map((p) => p.x), ys = obj.points.map((p) => p.y);
  const pad = (obj.width || 3) / 2 + 3;
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
}
function bboxContains(b, pt) {
  return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;
}
function getCenter(obj) {
  const b = getBBox(obj);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
function rotatePointAround(pt, center, deg) {
  if (!deg) return pt;
  const rad = (-deg * Math.PI) / 180;
  const dx = pt.x - center.x, dy = pt.y - center.y;
  return {
    x: center.x + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: center.y + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}
function toLocalPoint(obj, pt) {
  if (!obj.rotation) return pt;
  return rotatePointAround(pt, getCenter(obj), obj.rotation);
}
// 索引符號的外框本身不隨 obj.rotation 旋轉（只有裡面的三角指標會轉），
// 所以外框相關的命中測試／縮放要用原始座標，不能先轉回局部座標
function toLocalPointForBBox(obj, pt) {
  if (obj.type === "indexmark") return pt;
  return toLocalPoint(obj, pt);
}
function normalizeAngle(deg) {
  deg = deg % 360;
  if (deg < 0) deg += 360;
  return deg;
}
// 把物件自己的局部（未旋轉）外框角點，轉回旋轉後實際顯示在畫面上的世界座標
// （toLocalPoint 是世界→局部，这裡要反過來，所以用反向角度）
function localCornerToWorld(obj, pt) {
  const rotation = obj.type === "indexmark" ? 0 : obj.rotation || 0;
  if (!rotation) return pt;
  return rotatePointAround(pt, getCenter(obj), -rotation);
}
// 多選時用的整體外框（涵蓋所有選取物件「旋轉後」實際佔據範圍的聯集）：
// 先取每個物件未旋轉外框的四個角點，各自轉回旋轉後的世界座標，再取全部角點的最外圍，
// 這樣框起來的範圍才會跟畫面上看到的（已經轉過的）物件外觀一致，不會因為某個物件轉了
// 角度，選取框跟實際物件對不上、看起來很奇怪。
function getSelectionBBox(objs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  objs.forEach((obj) => {
    const b = getBBox(obj);
    const corners = [
      { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
      { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h },
    ];
    corners.forEach((c) => {
      const w = localCornerToWorld(obj, c);
      x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
      x1 = Math.max(x1, w.x); y1 = Math.max(y1, w.y);
    });
  });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// 判斷目前有沒有物件（旋轉後實際佔據的範圍）超出了目前顯示的頁面邊界、跑到暫放區，
// 這種時候物件可能會蓋住紙張邊緣，才需要額外畫邊界參考線（見 drawPageBoundaryGuide）。
function objectsExceedPageBounds(entry) {
  const x0 = entry.cropX || 0, y0 = entry.cropY || 0;
  const x1 = x0 + (entry.cropW || 0), y1 = y0 + (entry.cropH || 0);
  const EPS = 0.5;
  return entry.objects.some((obj) => {
    if (obj._editing) return false;
    const b = getSelectionBBox([obj]);
    return b.x < x0 - EPS || b.y < y0 - EPS || b.x + b.w > x1 + EPS || b.y + b.h > y1 + EPS;
  });
}
function bboxIntersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
// 手指比滑鼠游標粗很多，觸控時把縮放／旋轉把手的可點擊範圍放大，不然在手機上幾乎點不到
let lastPointerIsTouch = false;
function handleThresholdPt() {
  return (lastPointerIsTouch ? 22 : 10) / state.zoom;
}
function isOnGroupResizeHandle(b, pt) {
  const hx = b.x + b.w, hy = b.y + b.h;
  const thresholdPt = handleThresholdPt();
  return Math.hypot(pt.x - hx, pt.y - hy) <= thresholdPt;
}
function hitTest(entry, pt) {
  for (let i = entry.objects.length - 1; i >= 0; i--) {
    const obj = entry.objects[i];
    if (bboxContains(getBBox(obj), toLocalPointForBBox(obj, pt))) return obj;
  }
  return null;
}
function isTransformable(obj) {
  return obj.type === "text" || obj.type === "rect" || obj.type === "ellipse" || obj.type === "cloud" || obj.type === "image" || obj.type === "indexmark";
}
function isOnResizeHandle(obj, pt) {
  if (!isTransformable(obj) || obj.locked) return false;
  const lp = toLocalPointForBBox(obj, pt);
  const b = getBBox(obj);
  const hx = b.x + b.w, hy = b.y + b.h;
  const thresholdPt = handleThresholdPt();
  return Math.hypot(lp.x - hx, lp.y - hy) <= thresholdPt;
}
function isOnRotateHandle(obj, pt) {
  if (!isTransformable(obj) || obj.locked) return false;
  const lp = toLocalPoint(obj, pt);
  const b = getBBox(obj);
  const hx = b.x + b.w / 2, hy = b.y - ROTATE_HANDLE_DIST;
  const thresholdPt = handleThresholdPt();
  return Math.hypot(lp.x - hx, lp.y - hy) <= thresholdPt;
}
function cloneObj(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ---------------- 畫布座標換算（考慮旋轉與縮放） ---------------- */
// 由於 overlay-canvas 本身未旋轉，瀏覽器的 offsetX/offsetY 會自動把旋轉後的滑鼠座標
// 換算回元素本身未旋轉的本地座標，因此這裡只需再換算成 backing pixel 座標即可。
function eventToCanvasXY(entry, e) {
  const rect = entry.overlayCanvasEl.getBoundingClientRect();
  let x, y;
  if (e.target === entry.overlayCanvasEl && typeof e.offsetX === "number") {
    x = e.offsetX;
    y = e.offsetY;
  } else {
    x = e.clientX - rect.left;
    y = e.clientY - rect.top;
  }
  const scaleX = entry.overlayCanvasEl.width / entry.overlayCanvasEl.clientWidth;
  const scaleY = entry.overlayCanvasEl.height / entry.overlayCanvasEl.clientHeight;
  return { x: x * scaleX, y: y * scaleY };
}
function eventToPoint(entry, e) {
  const xy = eventToCanvasXY(entry, e);
  const s = BACKING_DPR * state.zoom;
  // 換算回「原始（未裁切）頁面」座標系，物件的 x/y 才會跟裁切範圍無關、永遠對齊內容本身；
  // overlay-canvas 四周比頁面多留了一截暫放區（見 PASTEBOARD_MARGIN），要先扣掉才會對齊
  return { x: xy.x / s + entry.cropX - PASTEBOARD_MARGIN, y: xy.y / s + entry.cropY - PASTEBOARD_MARGIN };
}

/* ---------------- 標註互動：建立 / 選取 / 移動 / 縮放 ---------------- */

function attachPageInteractions(entry) {
  const canvas = entry.overlayCanvasEl;
  // 一律 touch-action:none：單指保留給選取／移動物件／畫筆等既有編輯操作，頁面本身的
  // 捲動／縮放固定交給兩指手勢處理（見「手機雙指縮放／雙指拖曳瀏覽」），避免單指滑動
  // 被瀏覽器當成原生捲動手勢，跟編輯動作衝突。
  canvas.style.touchAction = "none";

  canvas.addEventListener("pointerdown", (e) => {
    // 已經有兩根手指在做縮放／平移手勢時，不要讓其中一根手指同時又另外開一個單指畫圖／
    // 選取物件的互動，不然兩套狀態會同時搶著動同一個物件、畫面亂跳。
    if (e.pointerType === "touch" && activeTouchCount >= 2) return;
    lastPointerIsTouch = e.pointerType === "touch";
    if (state.currentTextEditor) closeTextEditor(true);
    if (state.tool === "edittext" || state.tool === "text") return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 部分情況（例如測試環境的合成事件）沒有有效的 pointer，略過即可 */
    }
    const pt = eventToPoint(entry, e);
    if (state.tool === "pan") {
      startPanInteraction(entry, pt, e);
    } else if (state.tool === "highlight" || state.tool === "pen") {
      startFreehand(entry, pt, state.tool);
    } else if (state.tool === "shape") {
      startShape(entry, pt);
    } else if (state.tool === "crop") {
      startCrop(entry, pt);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.interaction) return;
    updateInteraction(eventToPoint(entry, e), e);
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
    canvas.addEventListener(ev, () => {
      if (!state.interaction) return;
      finishInteraction();
    })
  );

  canvas.addEventListener("click", (e) => {
    if (state.tool === "text") {
      const pt = eventToPoint(entry, e);
      pushHistory(entry);
      const d = state.defaults.text;
      const obj = {
        // 頁面本身可能有旋轉（例如橫式圖紙存成直式顯示），新增的文字預設要讓畫面上看起來是正的
        // （橫式書寫），不要讓它一開始就跟著頁面的旋轉歪掉，所以旋轉角度要抵銷頁面本身的旋轉。
        id: newId(), type: "text", x: pt.x, y: pt.y, text: "", rotation: normalizeAngle(-getPageRotation(entry)),
        color: d.color, fontSize: d.fontSize,
        bg: { enabled: d.bg.enabled, color: d.bg.color },
        border: { enabled: d.border.enabled, color: d.border.color, width: d.border.width },
      };
      entry.objects.push(obj);
      openObjectTextEditor(entry, obj, { selectAll: false, switchToPanAfter: true });
    } else if (state.tool === "stamp") {
      const d = state.defaults.stamp;
      if (!d.dataUrl) {
        toast("請先在上方選擇蓋章圖片", true);
        return;
      }
      const pt = eventToPoint(entry, e);
      const aspect = d.naturalW ? d.naturalH / d.naturalW : 1;
      const w = d.targetW, h = w * aspect;
      pushHistory(entry);
      const obj = {
        id: newId(), type: "image", x: pt.x - w / 2, y: pt.y - h / 2, w, h,
        rotation: normalizeAngle(-getPageRotation(entry)), dataUrl: d.dataUrl,
        border: { enabled: d.border.enabled, color: d.border.color, width: d.border.width },
      };
      entry.objects.push(obj);
      redraw(entry);
      toast("已蓋章");
    }
  });

  canvas.addEventListener("dblclick", (e) => {
    if (state.tool === "crop") {
      if (entry.pendingCropRect) {
        const r = entry.pendingCropRect;
        clearCropPreview(entry);
        applyCrop(entry, r.x, r.y, r.w, r.h);
      }
      return;
    }
    if (state.tool !== "pan") return;
    const pt = eventToPoint(entry, e);
    const hit = hitTest(entry, pt);
    if (hit && hit.locked) {
      setSelected({ entry, objs: [hit] });
      redraw(entry);
      renderToolOptions();
      toast("此物件已鎖定，請先解鎖才能編輯", true);
    } else if (hit && hit.type === "text") {
      setSelected({ entry, objs: [hit] });
      redraw(entry);
      renderToolOptions();
      openObjectTextEditor(entry, hit, { selectAll: true });
    } else if (hit && (hit.type === "rect" || hit.type === "ellipse" || hit.type === "cloud")) {
      setSelected({ entry, objs: [hit] });
      redraw(entry);
      renderToolOptions();
      openShapeTextEditor(entry, hit);
    } else if (hit && hit.type === "indexmark") {
      setSelected({ entry, objs: [hit] });
      redraw(entry);
      renderToolOptions();
      openIndexMarkEditor(entry, hit);
    }
  });

  entry.textLayerEl.addEventListener("click", (e) => {
    if (state.tool !== "edittext") return;
    const span = e.target.closest("span");
    if (!span) return;
    const innerRect = entry.innerEl.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const toPoint = 1 / state.zoom; // CSS px -> point
    const x = (spanRect.left - innerRect.left) * toPoint + entry.cropX;
    const y = (spanRect.top - innerRect.top) * toPoint + entry.cropY;
    const h = spanRect.height * toPoint;
    pushHistory(entry);
    const obj = {
      id: newId(), type: "text", x, y: y + h * 0.08, text: span.textContent,
      rotation: normalizeAngle(-getPageRotation(entry)),
      color: "#000000", fontSize: Math.max(6, h * 0.78),
      bg: { enabled: true, color: "#ffffff" },
      border: { enabled: false, color: "#000000", width: 2 },
    };
    entry.objects.push(obj);
    redraw(entry);
    openObjectTextEditor(entry, obj, { selectAll: true });
  });
}

/* ---- pan 工具：選取／移動／縮放 ---- */

function startPanInteraction(entry, pt, e) {
  const shift = !!(e && e.shiftKey);
  const sel = state.selected;
  const selHere = sel && sel.entry === entry ? sel : null;

  // 只選一個物件時，先檢查是不是點在它自己的旋轉／縮放把手上
  if (selHere && selHere.objs.length === 1) {
    const obj = selHere.objs[0];
    if (isOnRotateHandle(obj, pt)) {
      state.interaction = {
        mode: "rotate", entry, obj, center: getCenter(obj),
        startRotation: obj.rotation || 0, historyPushed: false,
      };
      return;
    }
    if (isOnResizeHandle(obj, pt)) {
      state.interaction = {
        mode: "resize", entry, obj, start: pt, orig: cloneObj(obj),
        historyPushed: false,
      };
      return;
    }
  }
  // 選了多個物件時，檢查是不是點在「整體」縮放把手上（拖它會把整批一起等比例縮放）
  if (selHere && selHere.objs.length > 1) {
    const groupBBox = getSelectionBBox(selHere.objs);
    if (isOnGroupResizeHandle(groupBBox, pt)) {
      // 鎖定的物件不參與縮放，但整體外框仍依全部選取物件計算，縮放基準點才不會跑掉
      const resizeTargets = selHere.objs.filter((o) => !o.locked);
      if (resizeTargets.length) {
        state.interaction = {
          mode: "groupResize", entry, objs: resizeTargets, start: pt,
          origs: resizeTargets.map(cloneObj), groupBBox, historyPushed: false,
        };
      }
      return;
    }
  }

  const hit = hitTest(entry, pt);
  if (hit) {
    let objs;
    if (shift) {
      // Shift+點擊：加入／移出目前的多選（如果原本選的是別頁的物件，就從這頁重新開始選）
      objs = selHere ? selHere.objs.slice() : [];
      const idx = objs.indexOf(hit);
      if (idx >= 0) objs.splice(idx, 1);
      else objs.push(hit);
    } else if (selHere && selHere.objs.length > 1 && selHere.objs.includes(hit)) {
      // 點在「目前已經是多選一部分」的物件上：維持整個多選，一起移動
      objs = selHere.objs;
    } else {
      objs = [hit];
    }
    if (objs.length === 0) {
      setSelected(null);
      state.interaction = null;
    } else {
      setSelected({ entry, objs });
      // 鎖定的物件不能被拖曳移動；多選時其餘未鎖定的物件仍可以一起拖走
      const moveTargets = objs.filter((o) => !o.locked);
      state.interaction = moveTargets.length
        ? { mode: "move", entry, objs: moveTargets, start: pt, origs: moveTargets.map(cloneObj), historyPushed: false }
        : null;
    }
    redraw(entry);
    renderToolOptions();
    return;
  }

  // 點在空白處：開始框選。按住 Shift 的話是「加選」，否則先清掉原本的選取再框選新的
  if (!shift && state.selected) {
    setSelected(null);
    redraw(entry);
    renderToolOptions();
  }
  state.interaction = {
    mode: "marquee", entry, start: pt, current: pt,
    additive: shift && selHere ? selHere.objs.slice() : [],
  };
}

function startFreehand(entry, pt, type) {
  pushHistory(entry);
  const d = state.defaults[type];
  const obj = { id: newId(), type, points: [pt], color: d.color, width: d.width };
  entry.objects.push(obj);
  state.interaction = { mode: "freehand", entry, obj };
  redraw(entry);
}

function startShape(entry, pt) {
  if (state.defaults.shape.kind === "indexmark") {
    startIndexMark(entry, pt);
    return;
  }
  pushHistory(entry);
  const d = state.defaults.shape;
  const obj = {
    id: newId(), type: d.kind, x: pt.x, y: pt.y, w: 0, h: 0, rotation: 0,
    stroke: d.stroke, strokeWidth: d.strokeWidth,
    fill: { enabled: d.fill.enabled, color: d.fill.color, opacity: d.fill.opacity == null ? 1 : d.fill.opacity },
    text: "", textColor: d.textColor || "#000000", fontSize: d.fontSize || 16,
  };
  entry.objects.push(obj);
  state.interaction = { mode: "shape", entry, obj };
  redraw(entry);
}

// 索引符號（剖面／立面索引用的圓圈＋三角指標）：外框固定是正方形，拖曳建立時沿用「shape」
// 互動模式（在 updateInteraction／finishInteraction 裡用 obj.type 判斷強制鎖定正方形）
function startIndexMark(entry, pt) {
  pushHistory(entry);
  const d = state.defaults.indexmark;
  const obj = {
    id: newId(), type: "indexmark", x: pt.x, y: pt.y, w: 0, h: 0, rotation: 0,
    stroke: d.stroke, strokeWidth: d.strokeWidth,
    fill: { enabled: d.fill.enabled, color: d.fill.color, opacity: d.fill.opacity == null ? 1 : d.fill.opacity },
    textColor: d.textColor, fontSize: d.fontSize,
    text: "",
  };
  entry.objects.push(obj);
  state.interaction = { mode: "shape", entry, obj };
  redraw(entry);
}

// 裁切頁面：拖曳框選要保留的範圍，放開滑鼠後範圍框會留著（還沒真的裁切），
// 雙擊頁面才會真的套用裁切。框選範圍可以超出目前頁面邊緣（延伸出去的部分會補白色），
// 預覽框是用一個獨立的 DOM 元素（不是畫在 canvas 上），才能顯示超出頁面邊緣的部分。
// pt 已經是 eventToPoint 換算回來的「原始頁面」座標，直接記錄起點／目前點即可。
//
// 注意：雙擊事件實際上是「按下、放開、按下、放開、dblclick」，前面兩次單擊也會各自觸發
// pointerdown／pointerup。所以這裡只記錄起點，真正建立／更新預覽框要等到 pointermove
// 真的發生時才做（見 updateInteraction），不然雙擊確認時框就會被前面兩次單擊洗掉。
function startCrop(entry, pt) {
  state.interaction = { mode: "crop", entry, start: snapToPageEdge(entry, pt), current: null };
}

const CROP_SNAP_DIST = 10; // 框選裁切範圍時，靠近原始頁面邊界會自動吸附（CSS px，會依縮放換算）

// 框選時，起點／目前點如果靠近原始（未裁切）頁面的四個邊界，就直接吸附上去，
// 方便精準對齊頁面邊緣（例如剛好裁掉某一邊，或剛好延伸回原本的邊界）。
function snapToPageEdge(entry, pt) {
  const { w: nativeW, h: nativeH } = getNativeSize(entry);
  const tol = CROP_SNAP_DIST / state.zoom;
  const snapAxis = (v, edges) => {
    for (const edge of edges) {
      if (Math.abs(v - edge) <= tol) return edge;
    }
    return v;
  };
  return { x: snapAxis(pt.x, [0, nativeW]), y: snapAxis(pt.y, [0, nativeH]) };
}

function ensureCropPreviewEl(entry) {
  if (entry.cropPreviewEl) return entry.cropPreviewEl;
  const el = document.createElement("div");
  el.className = "crop-preview-box";
  entry.innerEl.appendChild(el);
  entry.cropPreviewEl = el;
  return el;
}

// 四個角＋四個邊中點的把手，放開滑鼠後框選範圍可以再個別拖曳每一邊／每個角微調，
// 不用整個重新框選一次。handle 名稱用方位縮寫：n/s/e/w 是邊，ne/nw/se/sw 是角。
const CROP_HANDLE_KEYS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function ensureCropHandleEls(entry) {
  if (entry.cropHandleEls) return entry.cropHandleEls;
  const els = {};
  CROP_HANDLE_KEYS.forEach((key) => {
    const el = document.createElement("div");
    el.className = "crop-handle crop-handle-" + key;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        entry.overlayCanvasEl.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 同上，合成事件沒有有效 pointer 時略過即可 */
      }
      state.interaction = { mode: "cropResize", entry, handle: key, orig: { ...entry.pendingCropRect } };
    });
    entry.innerEl.appendChild(el);
    els[key] = el;
  });
  entry.cropHandleEls = els;
  return els;
}

// 把框選範圍（原始頁面座標系下的矩形）換算成畫面位置，同步更新虛線框跟八個把手
function renderCropPreviewFromRect(entry, r) {
  const box = ensureCropPreviewEl(entry);
  const x0 = (r.x - entry.cropX) * state.zoom;
  const y0 = (r.y - entry.cropY) * state.zoom;
  const w = r.w * state.zoom, h = r.h * state.zoom;
  box.style.left = x0 + "px";
  box.style.top = y0 + "px";
  box.style.width = w + "px";
  box.style.height = h + "px";

  const handles = ensureCropHandleEls(entry);
  const x1 = x0 + w, y1 = y0 + h, xm = x0 + w / 2, ym = y0 + h / 2;
  const pos = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] };
  CROP_HANDLE_KEYS.forEach((key) => {
    const [hx, hy] = pos[key];
    handles[key].style.left = hx + "px";
    handles[key].style.top = hy + "px";
  });
}

function cropRectFromPoints(start, current) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
  };
}

function updateCropPreviewEl(entry, start, current) {
  renderCropPreviewFromRect(entry, cropRectFromPoints(start, current));
}

function clearCropPreview(entry) {
  if (entry.cropPreviewEl) {
    entry.cropPreviewEl.remove();
    entry.cropPreviewEl = null;
  }
  if (entry.cropHandleEls) {
    Object.values(entry.cropHandleEls).forEach((el) => el.remove());
    entry.cropHandleEls = null;
  }
  entry.pendingCropRect = null;
}

const CROP_MIN_SIZE = 20; // 裁切範圍的最小寬／高（point），避免拖成一個點或負值

async function applyCrop(entry, x, y, w, h) {
  entry.cropX = x;
  entry.cropY = y;
  entry.cropW = Math.max(CROP_MIN_SIZE, w);
  entry.cropH = Math.max(CROP_MIN_SIZE, h);
  await renderPage(entry, state.zoom, { skipThumb: true });
  layoutPage(entry);
  renderThumb(entry);
  scheduleAutosave();
  toast("已裁切頁面，雙擊頁面即可套用");
}

const OBJECT_SNAP_DIST = 8; // 拖曳物件時靠近其他物件的邊緣／中心會自動吸附（CSS px，會依縮放換算）

// 拖曳物件（群）時，看目前這個 dx/dy 會不會讓外框的邊緣／中心跟「同頁其他沒被選取的物件」的
// 邊緣／中心對齊，如果在容許誤差內就把 dx/dy 微調成剛好對齊，並回傳要畫的輔助線。
// axisLockX/axisLockY：對應的軸已經被 Ctrl 單向移動鎖定在 0，不能再被吸附改動。
function computeMoveSnap(it, dx, dy, axisLockX, axisLockY) {
  const tol = OBJECT_SNAP_DIST / state.zoom;
  const boxes = it.objs.map((obj, i) => {
    const b = getBBox(it.origs[i]);
    return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
  });
  const gx0 = Math.min(...boxes.map((b) => b.x));
  const gy0 = Math.min(...boxes.map((b) => b.y));
  const gx1 = Math.max(...boxes.map((b) => b.x + b.w));
  const gy1 = Math.max(...boxes.map((b) => b.y + b.h));
  const xCandidates = [gx0, (gx0 + gx1) / 2, gx1];
  const yCandidates = [gy0, (gy0 + gy1) / 2, gy1];

  const selectedSet = new Set(it.objs);
  let bestX = null, bestY = null;
  for (const other of it.entry.objects) {
    if (selectedSet.has(other) || other._editing) continue;
    const ob = getBBox(other);
    const ox0 = ob.x, oy0 = ob.y, ox1 = ob.x + ob.w, oy1 = ob.y + ob.h;
    const targetXs = [ox0, (ox0 + ox1) / 2, ox1];
    const targetYs = [oy0, (oy0 + oy1) / 2, oy1];
    if (!axisLockX) {
      for (const cand of xCandidates) {
        for (const tx of targetXs) {
          const diff = tx - cand;
          if (Math.abs(diff) <= tol && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
            bestX = { diff, x: tx, y0: Math.min(oy0, gy0), y1: Math.max(oy1, gy1) };
          }
        }
      }
    }
    if (!axisLockY) {
      for (const cand of yCandidates) {
        for (const ty of targetYs) {
          const diff = ty - cand;
          if (Math.abs(diff) <= tol && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
            bestY = { diff, y: ty, x0: Math.min(ox0, gx0), x1: Math.max(ox1, gx1) };
          }
        }
      }
    }
  }
  const guides = [];
  let outDx = dx, outDy = dy;
  if (bestX) {
    outDx = dx + bestX.diff;
    guides.push({ axis: "v", x: bestX.x, y0: bestX.y0, y1: bestX.y1 });
  }
  if (bestY) {
    outDy = dy + bestY.diff;
    guides.push({ axis: "h", y: bestY.y, x0: bestY.x0, x1: bestY.x1 });
  }
  return { dx: outDx, dy: outDy, guides };
}

// 縮放單一物件時（左上角固定、右下角把手拖曳），看右下角目前的候選位置 (x1,y1) 靠不靠近
// 「同頁其他物件」的邊緣／中心，在容許誤差內就吸附上去，並回傳要畫的輔助線。跟 computeMoveSnap
// 邏輯一樣，只是移動的只有右下角這一個點，不是整個外框。
function computeResizeSnap(entry, obj, x1, y1) {
  const tol = OBJECT_SNAP_DIST / state.zoom;
  let bestX = null, bestY = null;
  for (const other of entry.objects) {
    if (other === obj || other._editing) continue;
    const ob = getBBox(other);
    const ox0 = ob.x, oy0 = ob.y, ox1 = ob.x + ob.w, oy1 = ob.y + ob.h;
    const targetXs = [ox0, (ox0 + ox1) / 2, ox1];
    const targetYs = [oy0, (oy0 + oy1) / 2, oy1];
    for (const tx of targetXs) {
      const diff = tx - x1;
      if (Math.abs(diff) <= tol && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
        bestX = { diff, x: tx, y0: Math.min(oy0, y1), y1: Math.max(oy1, y1) };
      }
    }
    for (const ty of targetYs) {
      const diff = ty - y1;
      if (Math.abs(diff) <= tol && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
        bestY = { diff, y: ty, x0: Math.min(ox0, x1), x1: Math.max(ox1, x1) };
      }
    }
  }
  const guides = [];
  let outX1 = x1, outY1 = y1;
  if (bestX) {
    outX1 = x1 + bestX.diff;
    guides.push({ axis: "v", x: bestX.x, y0: bestX.y0, y1: bestX.y1 });
  }
  if (bestY) {
    outY1 = y1 + bestY.diff;
    guides.push({ axis: "h", y: bestY.y, x0: bestY.x0, x1: bestY.x1 });
  }
  return { x1: outX1, y1: outY1, guides };
}

// 按住 Ctrl 鎖定長寬比例時的縮放吸附：x、y 兩軸不是獨立的（寬高比固定住了，只有一個自由度），
// 不能像上面 computeResizeSnap 那樣兩軸各自吸附，不然吸完比例就跑掉了。做法是：x 邊緣候選
// 跟 y 邊緣候選都先各自算出「吸上去之後、依比例換算回來的另一邊」，兩邊都在容許誤差內的話，
// 取誤差最小的那一個當作唯一的吸附結果（只會動一條輔助線），確保吸附之後比例仍然精確。
function computeResizeSnapRatioLocked(entry, obj, x1, y1, ratio) {
  const tol = OBJECT_SNAP_DIST / state.zoom;
  let best = null;
  for (const other of entry.objects) {
    if (other === obj || other._editing) continue;
    const ob = getBBox(other);
    const ox0 = ob.x, oy0 = ob.y, ox1 = ob.x + ob.w, oy1 = ob.y + ob.h;
    const targetXs = [ox0, (ox0 + ox1) / 2, ox1];
    const targetYs = [oy0, (oy0 + oy1) / 2, oy1];
    for (const tx of targetXs) {
      const diff = tx - x1;
      if (Math.abs(diff) <= tol && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        const nw = tx - obj.x;
        const ny1 = obj.y + nw * ratio;
        best = { diff, x1: tx, y1: ny1, guide: { axis: "v", x: tx, y0: Math.min(oy0, ny1), y1: Math.max(oy1, ny1) } };
      }
    }
    for (const ty of targetYs) {
      const diff = ty - y1;
      if (Math.abs(diff) <= tol && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        const nh = ty - obj.y;
        const nx1 = obj.x + (ratio ? nh / ratio : 0);
        best = { diff, x1: nx1, y1: ty, guide: { axis: "h", y: ty, x0: Math.min(ox0, nx1), x1: Math.max(ox1, nx1) } };
      }
    }
  }
  if (!best) return { x1, y1, guides: [] };
  return { x1: best.x1, y1: best.y1, guides: [best.guide] };
}

// 吸附輔助線：畫在 overlay canvas 上的洋紅色虛線，跟框選預覽框（drawMarqueePreview）用同一套
// 座標換算（要加回 PASTEBOARD_MARGIN，因為暫放區的物件也要能正常吸附、畫出輔助線）。
function drawSnapGuidesPreview(entry, guides) {
  if (!guides || !guides.length) return;
  const ctx = entry.overlayCanvasEl.getContext("2d");
  const scale = BACKING_DPR * state.zoom;
  const toCanvasX = (x) => (x - entry.cropX + PASTEBOARD_MARGIN) * scale;
  const toCanvasY = (y) => (y - entry.cropY + PASTEBOARD_MARGIN) * scale;
  ctx.save();
  ctx.strokeStyle = "#ff3b9a";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  guides.forEach((g) => {
    ctx.beginPath();
    if (g.axis === "v") {
      ctx.moveTo(toCanvasX(g.x), toCanvasY(g.y0));
      ctx.lineTo(toCanvasX(g.x), toCanvasY(g.y1));
    } else {
      ctx.moveTo(toCanvasX(g.x0), toCanvasY(g.y));
      ctx.lineTo(toCanvasX(g.x1), toCanvasY(g.y));
    }
    ctx.stroke();
  });
  ctx.restore();
}

function updateInteraction(pt, e) {
  const it = state.interaction;
  if (!it) return;
  const ctrl = !!(e && e.ctrlKey);
  if (it.mode === "move") {
    let dx = pt.x - it.start.x, dy = pt.y - it.start.y;
    if (!it.historyPushed && (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3)) {
      pushHistory(it.entry);
      it.historyPushed = true;
    }
    // 按住 Ctrl：鎖定成單一方向移動，哪個方向拖得比較多就鎖那個方向，另一軸歸零
    let axisLockX = false, axisLockY = false;
    if (ctrl) {
      if (Math.abs(dx) >= Math.abs(dy)) { dy = 0; axisLockY = true; }
      else { dx = 0; axisLockX = true; }
    }
    // 靠近其他物件的邊緣／中心時自動吸附（磁貼效果），鎖定的軸不會再被吸附改動
    const snap = computeMoveSnap(it, dx, dy, axisLockX, axisLockY);
    dx = snap.dx;
    dy = snap.dy;
    it.objs.forEach((obj, i) => applyMove(obj, it.origs[i], dx, dy));
    redraw(it.entry);
    drawSnapGuidesPreview(it.entry, snap.guides);
    return; // 吸附輔助線畫在 overlay canvas 上，上面那行 redraw 已經重畫過一次了
  } else if (it.mode === "resize") {
    const dx = pt.x - it.start.x, dy = pt.y - it.start.y;
    if (!it.historyPushed && (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3)) {
      pushHistory(it.entry);
      it.historyPushed = true;
    }
    const guides = applyResize(it.obj, it.orig, pt, ctrl, it.entry);
    redraw(it.entry);
    drawSnapGuidesPreview(it.entry, guides);
    return; // 吸附輔助線畫在 overlay canvas 上，上面那行 redraw 已經重畫過一次了
  } else if (it.mode === "groupResize") {
    const dx = pt.x - it.start.x, dy = pt.y - it.start.y;
    if (!it.historyPushed && (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3)) {
      pushHistory(it.entry);
      it.historyPushed = true;
    }
    const b = it.groupBBox;
    let sx = Math.max(5, b.w + dx) / b.w;
    let sy = Math.max(5, b.h + dy) / b.h;
    if (ctrl) {
      // 按住 Ctrl：維持原本的長寬比例，用拖曳幅度較大的那一軸決定縮放比例
      const s = Math.abs(dx) > Math.abs(dy) ? sx : sy;
      sx = sy = s;
    }
    it.objs.forEach((obj, i) => applyGroupScale(obj, it.origs[i], b, sx, sy));
  } else if (it.mode === "marquee") {
    it.current = pt;
    redraw(it.entry);
    drawMarqueePreview(it.entry, it.start, it.current);
    return; // 框選預覽畫在 overlay canvas 上，上面那行 redraw 已經重畫過一次了
  } else if (it.mode === "rotate") {
    let ang = normalizeAngle((Math.atan2(pt.y - it.center.y, pt.x - it.center.x) * 180) / Math.PI + 90);
    if (ctrl) ang = normalizeAngle(Math.round(ang / 90) * 90);
    if (!it.historyPushed && Math.abs(normalizeAngle(ang - it.startRotation) % 360) > 0.5) {
      pushHistory(it.entry);
      it.historyPushed = true;
    }
    it.obj.rotation = ang;
  } else if (it.mode === "freehand") {
    if (ctrl) {
      it.obj.points = [it.obj.points[0], pt];
    } else {
      it.obj.points.push(pt);
    }
  } else if (it.mode === "shape") {
    let w = pt.x - it.obj.x, h = pt.y - it.obj.y;
    if (ctrl || it.obj.type === "indexmark") {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * m;
      h = (h < 0 ? -1 : 1) * m;
    }
    it.obj.w = w;
    it.obj.h = h;
  } else if (it.mode === "crop") {
    it.current = snapToPageEdge(it.entry, pt);
    updateCropPreviewEl(it.entry, it.start, it.current);
    return; // 裁切預覽框是獨立的 DOM 元素，不需要（也不應該）重畫 overlay canvas
  } else if (it.mode === "cropResize") {
    const snapped = snapToPageEdge(it.entry, pt);
    const r = it.orig;
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    if (it.handle.includes("w")) x0 = snapped.x;
    if (it.handle.includes("e")) x1 = snapped.x;
    if (it.handle.includes("n")) y0 = snapped.y;
    if (it.handle.includes("s")) y1 = snapped.y;
    const rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    it.entry.pendingCropRect = rect;
    renderCropPreviewFromRect(it.entry, rect);
    return; // 同上
  }
  redraw(it.entry);
}

function finishInteraction() {
  const it = state.interaction;
  state.interaction = null;
  if (!it) return;
  if (it.mode === "freehand") {
    if (it.obj.points.length < 2) it.entry.objects.splice(it.entry.objects.indexOf(it.obj), 1);
  } else if (it.mode === "shape") {
    normalizeShape(it.obj);
    if (Math.abs(it.obj.w) < 3 || Math.abs(it.obj.h) < 3) {
      it.entry.objects.splice(it.entry.objects.indexOf(it.obj), 1);
    } else {
      // 用「圖形」工具拖曳建立完成後，直接切回瀏覽工具並選取它，方便立刻調整位置／大小，
      // 不用再手動點一次瀏覽鈕（索引符號也走這個分支，一併套用）。
      setSelected({ entry: it.entry, objs: [it.obj] });
      setTool("pan");
      return;
    }
  } else if (it.mode === "crop") {
    if (it.current == null) return; // 沒有真的拖曳移動過（例如雙擊確認時前兩次單擊），保留原本的框
    const rect = cropRectFromPoints(it.start, it.current);
    if (rect.w > 10 && rect.h > 10) {
      it.entry.pendingCropRect = rect;
      renderCropPreviewFromRect(it.entry, rect);
    }
    return; // 同上，裁切預覽框不走 overlay canvas 的重繪
  } else if (it.mode === "cropResize") {
    return; // 拖曳把手微調的過程中已經即時更新過了，放開滑鼠不用再做什麼
  } else if (it.mode === "groupResize") {
    // 縮放比例永遠是正數（見 updateInteraction 的 Math.max(5, ...) 鉗制），不會讓 w/h 變號，
    // 所以這裡不需要再 normalizeShape
  } else if (it.mode === "marquee") {
    const box = cropRectFromPoints(it.start, it.current);
    if (box.w > 3 || box.h > 3) {
      const hitObjs = it.entry.objects.filter((o) => bboxIntersects(getBBox(o), box));
      const objs = Array.from(new Set(it.additive.concat(hitObjs)));
      if (objs.length) {
        setSelected({ entry: it.entry, objs });
        renderToolOptions();
      }
    }
  }
  redraw(it.entry);
}

function applyMove(obj, orig, dx, dy) {
  if (obj.points) {
    obj.points = orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  } else {
    obj.x = orig.x + dx;
    obj.y = orig.y + dy;
  }
}

const RESIZE_MIN_SIZE = 10; // 單一物件縮放把手拖曳時的最小寬／高（point）

function applyResize(obj, orig, pt, ctrl, entry) {
  // 旋轉中心要用「目前」的中心即時算，不能用拖曳開始那一刻的舊值：縮放把手拖曳中 w/h 會
  // 一直變化，物件的中心點也跟著一直變化，畫面上旋轉時實際用的錨點就是這個會變動的中心；
  // 如果拿拖曳開始時的舊中心點去反轉滑鼠座標，隨著w/h改變只會越轉越偏，基準點就跑掉了。
  const center = getCenter(obj);
  // 索引符號的外框不隨旋轉變化，縮放要用原始座標，不能先轉回局部座標（見 toLocalPointForBBox 的說明）
  const lp = obj.type === "indexmark" ? pt : rotatePointAround(pt, center, obj.rotation || 0);
  let guides = [];
  if (obj.type === "text") {
    const d0 = Math.hypot(orig._w || 40, orig._h || 20) || 1;
    const d1 = Math.hypot(lp.x - orig.x, lp.y - orig.y);
    const ratio = Math.max(0.2, Math.min(6, d1 / d0));
    obj.fontSize = Math.max(6, Math.min(300, orig.fontSize * ratio));
  } else if (obj.type === "indexmark") {
    let w = lp.x - obj.x;
    let h = lp.y - obj.y;
    const m = Math.max(Math.abs(w), Math.abs(h));
    obj.w = (w < 0 ? -1 : 1) * m;
    obj.h = (h < 0 ? -1 : 1) * m;
  } else {
    // 其他物件（矩形／圖片等）縮放時固定以左上角（obj.x, obj.y）為基準點，右下角把手只能把
    // 寬高拉大或縮小到最小值，不能縮過頭變成負的——否則寬高變號會讓 getBBox 的
    // Math.min/abs 把左上角跟右下角互換，看起來就像基準點突然跳到對角去。
    let x1 = lp.x, y1 = lp.y;
    const ratioLocked = ctrl && obj.type === "image" && orig.w;
    if (entry) {
      if (ratioLocked) {
        // 鎖定比例時 x、y 不是獨立的兩軸，用專門的函式吸附（吸附後仍維持比例精確）
        const snap = computeResizeSnapRatioLocked(entry, obj, x1, y1, orig.h / orig.w);
        x1 = snap.x1;
        y1 = snap.y1;
        guides = snap.guides;
      } else {
        const snap = computeResizeSnap(entry, obj, x1, y1);
        x1 = snap.x1;
        y1 = snap.y1;
        guides = snap.guides;
      }
    }
    let w = Math.max(RESIZE_MIN_SIZE, x1 - obj.x);
    let h = Math.max(RESIZE_MIN_SIZE, y1 - obj.y);
    if (ratioLocked) {
      h = w * (orig.h / orig.w); // 按住 Ctrl：維持圖片原本的長寬比例（用鉗制過的 w 重算一次，避免最小尺寸鉗制把比例帶偏）
    }
    obj.w = w;
    obj.h = h;
    keepResizeAnchorFixed(obj, orig, w, h);
  }
  return guides;
}

// 物件轉過角度時，縮放中心是會隨 w/h 即時改變的「目前」中心（見上面 applyResize 開頭的說明，
// 那是為了讓拖曳中的那個角緊貼滑鼠），但這會讓沒被拖動的那個角（基準點）繞著移動中的中心
// 一起被轉，畫面上看起來基準點自己跑掉了。這裡用拖曳開始那一刻、基準點原本所在的世界座標
// 當作目標，每一步都反推 obj.x/y，讓基準點在畫面上整個拖曳過程都釘死在原地不動。
function keepResizeAnchorFixed(obj, orig, w, h) {
  const rotation = orig.rotation || 0;
  if (!rotation) return; // 沒有旋轉時 obj.x/y 本來就等於世界座標，不需要額外校正
  const anchorWorld = localCornerToWorld(orig, { x: orig.x, y: orig.y });
  const rotVec = rotatePointAround({ x: -w / 2, y: -h / 2 }, { x: 0, y: 0 }, -rotation);
  obj.x = anchorWorld.x - w / 2 - rotVec.x;
  obj.y = anchorWorld.y - h / 2 - rotVec.y;
}

// 多選群組縮放：以整體外框的左上角為錨點，把每個物件的位置／大小依 sx,sy 比例縮放
// （文字只縮放字級大小；畫筆／螢光筆的每個點座標跟著縮放，線條粗細用平均比例近似）
function applyGroupScale(obj, orig, anchor, sx, sy) {
  const scalePt = (p) => ({ x: anchor.x + (p.x - anchor.x) * sx, y: anchor.y + (p.y - anchor.y) * sy });
  if (orig.points) {
    obj.points = orig.points.map(scalePt);
    if (orig.width != null) obj.width = Math.max(1, orig.width * ((sx + sy) / 2));
  } else if (orig.type === "text") {
    const p = scalePt({ x: orig.x, y: orig.y });
    obj.x = p.x;
    obj.y = p.y;
    obj.fontSize = Math.max(6, orig.fontSize * ((sx + sy) / 2));
  } else {
    const p = scalePt({ x: orig.x, y: orig.y });
    obj.x = p.x;
    obj.y = p.y;
    obj.w = orig.w * sx;
    obj.h = orig.h * sy;
  }
}

function normalizeShape(obj) {
  if (obj.w < 0) {
    obj.x += obj.w;
    obj.w = -obj.w;
  }
  if (obj.h < 0) {
    obj.y += obj.h;
    obj.h = -obj.h;
  }
}

function deleteSelected() {
  if (!state.selected) return;
  const { entry, objs } = state.selected;
  const toDelete = objs.filter((o) => !o.locked);
  const lockedCount = objs.length - toDelete.length;
  if (!toDelete.length) {
    toast("物件已鎖定，請先解鎖才能刪除", true);
    return;
  }
  pushHistory(entry);
  toDelete.forEach((obj) => {
    const idx = entry.objects.indexOf(obj);
    if (idx >= 0) entry.objects.splice(idx, 1);
  });
  setSelected(null);
  redraw(entry);
  renderToolOptions();
  if (lockedCount) toast(`已鎖定的 ${lockedCount} 個物件未被刪除`);
}

/* ---------------- 物件疊放順序（誰蓋在誰上面）：entry.objects 陣列順序本身就是疊放順序，
   畫的時候跟 hitTest 都是從陣列尾端算最上層，所以「移到最上層」= 搬到陣列最後面，
   「移到最下層」= 搬到陣列最前面，「上移/下移一層」= 跟相鄰那一個交換位置。 ---------------- */

function bringObjToFront(entry, obj) {
  const i = entry.objects.indexOf(obj);
  if (i < 0 || i === entry.objects.length - 1) return false;
  entry.objects.splice(i, 1);
  entry.objects.push(obj);
  return true;
}
function sendObjToBack(entry, obj) {
  const i = entry.objects.indexOf(obj);
  if (i <= 0) return false;
  entry.objects.splice(i, 1);
  entry.objects.unshift(obj);
  return true;
}
function moveObjUpOne(entry, obj) {
  const i = entry.objects.indexOf(obj);
  if (i < 0 || i === entry.objects.length - 1) return false;
  [entry.objects[i], entry.objects[i + 1]] = [entry.objects[i + 1], entry.objects[i]];
  return true;
}
function moveObjDownOne(entry, obj) {
  const i = entry.objects.indexOf(obj);
  if (i <= 0) return false;
  [entry.objects[i], entry.objects[i - 1]] = [entry.objects[i - 1], entry.objects[i]];
  return true;
}
// 多選時「移到最上/最下層」：保留選取物件彼此之間原本的相對順序，整批搬到最前面或最後面。
function bringObjsToFront(entry, objs) {
  const set = new Set(objs);
  if (entry.objects.filter((o) => set.has(o)).length !== objs.length) return false;
  const rest = entry.objects.filter((o) => !set.has(o));
  const selected = entry.objects.filter((o) => set.has(o));
  entry.objects = rest.concat(selected);
  return true;
}
function sendObjsToBack(entry, objs) {
  const set = new Set(objs);
  const rest = entry.objects.filter((o) => !set.has(o));
  const selected = entry.objects.filter((o) => set.has(o));
  entry.objects = selected.concat(rest);
  return true;
}
// 加在物件面板上的「疊放順序」按鈕列，單選／多選共用。fn 回傳 false（已經在最上/最下層、
// 沒有東西可以動）時就不產生任何變化，也不需要多推一筆復原紀錄。
function addLayerButtons(container, entry, target) {
  const row = document.createElement("div");
  row.className = "btn-group";
  row.style.flexWrap = "wrap";
  const mk = (label, title, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => {
      let changed = false;
      withObjHistory(entry, () => {
        changed = fn();
      });
      if (!changed) return;
      renderToolOptions();
    });
    row.appendChild(b);
  };
  if (Array.isArray(target)) {
    mk("⬆ 移到最上層", "整批移到所有物件的最上面（最後蓋上去）", () => bringObjsToFront(entry, target));
    mk("⬇ 移到最下層", "整批移到所有物件的最下面（最先被蓋住）", () => sendObjsToBack(entry, target));
  } else {
    mk("⬆ 移到最上層", "移到所有物件的最上面（最後蓋上去）", () => bringObjToFront(entry, target));
    mk("↑ 上移一層", "跟上面那一個物件交換疊放順序", () => moveObjUpOne(entry, target));
    mk("↓ 下移一層", "跟下面那一個物件交換疊放順序", () => moveObjDownOne(entry, target));
    mk("⬇ 移到最下層", "移到所有物件的最下面（最先被蓋住）", () => sendObjToBack(entry, target));
  }
  container.appendChild(row);
}

/* ---------------- 文字內容編輯（新增文字 / 取代既有文字 / 雙擊再編輯共用） ---------------- */

function openObjectTextEditor(entry, obj, opts) {
  opts = opts || {};
  closeTextEditor(true);
  obj._editing = true;
  redraw(entry);

  // 編輯框要直接顯示「排版完成後的樣子」：大小依目前文字內容即時算出（跟 drawTextObject
  // 用同一套公式），底色／外框也比照 obj.bg／obj.border，不再是固定的藍框＋可以手動拖拉縮放
  // ——反正文字物件的大小本來就是純粹由內容算出來的，手動拖的大小最後也會被蓋掉。
  const editor = document.createElement("textarea");
  editor.className = "inline-editor";
  editor.value = obj.text;
  // box-sizing 用 content-box：寬高只算「文字內容」本身，padding／外框都另外疊加、
  // 不會反過來把內容區擠變窄——這樣文字換行的位置才會跟最後畫出來的結果一致。
  // 外框改用 box-shadow（inset，不佔版面）模擬，才會跟 canvas 的 strokeRect（畫在邊線正中央、
  // 不會吃掉內部空間）一致；如果用真的 CSS border 配 border-box，邊框粗細會讓內容區變窄，
  // 造成文字提早換行，框框就不是「最後排版的樣子」了。
  editor.style.boxSizing = "content-box";
  editor.style.resize = "none";
  editor.style.overflow = "hidden";
  editor.style.minWidth = "0";
  editor.style.minHeight = "0";
  editor.style.border = "none";
  // 量測／最終畫出來的文字框（measureTextBoxPt／drawTextObject）只在明確的 \n 才換行，
  // 完全不做自動換行；這裡的即時編輯框如果用textarea預設的自動換行，寬度每次都是依「這次打完
  // 的文字」量出來剛好貼合、沒有多餘空間，新打一個字時瀏覽器會先用舊寬度自動換成兩行，
  // 下一拍 syncEditorSize 才又依新文字量出夠寬的單行寬度、把它折回一行——框框寬高就會一直
  // 跳動／閃爍，甚至因為行數瞬間變化看起來像在移動。改成 pre，讓文字只在打 Enter 時才換行，
  // 跟量測函式的假設完全一致，就不會有這種寬高打架的情況。
  editor.style.whiteSpace = "pre";
  // 縮放很小時字級會被下限頂住（下面用 Math.max(10,...)，避免小到打字看不到），這時字級
  // 「實際放大的比例」已經不等於 state.zoom 了。框框的寬高如果還是用 state.zoom 去算，
  // 就會比實際文字還窄，造成文字被擠到一行只能放一個字、框框變成一直條——這裡統一改用
  // 「字級實際被放大的比例」(fontScale) 來算框框大小，兩者才會一致，不會提早換行。
  const fontPx = Math.max(10, obj.fontSize * state.zoom);
  const fontScale = fontPx / obj.fontSize;
  editor.style.fontSize = fontPx + "px";
  editor.style.lineHeight = "1.3";
  editor.style.padding = TEXT_PAD * fontScale + "px";
  editor.style.color = obj.color;
  editor.style.background = obj.bg && obj.bg.enabled ? obj.bg.color : "transparent";
  editor.style.boxShadow = obj.border && obj.border.enabled
    ? `inset 0 0 0 ${Math.max(1, obj.border.width * fontScale)}px ${obj.border.color}`
    : "none";
  // 不管本來有沒有外框，都加一圈淡淡的提示外框（outline 不佔版面、不影響最終大小），
  // 方便看出目前正在編輯哪一個，不會跟排版用的實際外框混在一起
  editor.style.outline = "1px dashed rgba(37,99,235,.6)";
  editor.style.outlineOffset = "2px";

  const syncEditorSize = () => {
    const box = measureTextBoxPt(editor.value, obj.fontSize);
    editor.style.width = (box.w - TEXT_PAD * 2) * fontScale + "px";
    editor.style.height = (box.h - TEXT_PAD * 2) * fontScale + "px";
  };
  syncEditorSize();
  editor.style.left = (obj.x - TEXT_PAD - entry.cropX) * state.zoom + "px";
  editor.style.top = (obj.y - TEXT_PAD - entry.cropY) * state.zoom + "px";
  // 編輯框本身的 content-box（文字＋padding）剛好等於物件的外框，中心點跟畫布上轉的中心一樣，
  // 用預設的 transform-origin（50% 50%）轉，角度才會跟沒在編輯時畫出來的樣子一致，
  // 不然雙擊編輯時框框會突然變回「沒轉過」的樣子。
  editor.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : "";
  editor.addEventListener("input", syncEditorSize);

  entry.innerEl.appendChild(editor);
  editor.focus();
  if (opts.selectAll) editor.select();

  let committed = false;
  const commit = (cancel) => {
    if (committed) return;
    committed = true;
    editor.remove();
    obj._editing = false;
    state.currentTextEditor = null;
    if (!cancel) {
      obj.text = editor.value;
      if (!obj.text || !obj.text.trim()) {
        const idx = entry.objects.indexOf(obj);
        if (idx >= 0) entry.objects.splice(idx, 1);
        if (state.selected && state.selected.objs.includes(obj)) setSelected(null);
      } else if (opts.switchToPanAfter) {
        // 用「新增文字」工具插入的文字，打完字結束編輯後直接切回瀏覽工具並選取它，
        // 不用再手動點一次瀏覽鈕才能調整位置／大小。
        setSelected({ entry, objs: [obj] });
        setTool("pan");
        return;
      }
    }
    redraw(entry);
    renderToolOptions();
  };
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      commit(true);
    }
  });
  editor.addEventListener("blur", () => commit(false));
  state.currentTextEditor = { commit: () => commit(false) };
}
function closeTextEditor(commit) {
  if (!state.currentTextEditor) return;
  state.currentTextEditor.commit();
}

// 圖形／索引符號的輸入框最小尺寸（CSS px）：圖形本身縮得再小，輸入框也不會小過這個值，
// 不然會變成一個點不到、打字看不到游標的迷你方塊。
const MIN_EDITOR_SIZE = { w: 44, h: 28 };

// 在圖形（方形／橢圓）中間輸入文字：編輯區覆蓋整個圖形外框，文字置中，
// 與一般文字物件不同的是：清空文字不會刪除圖形本身，圖形可以單純當外框使用。
function openShapeTextEditor(entry, obj) {
  closeTextEditor(true);
  if (obj.text == null) obj.text = "";
  if (!obj.textColor) obj.textColor = "#000000";
  if (!obj.fontSize) obj.fontSize = 16;
  obj._editing = true;
  redraw(entry);

  const b = getBBox(obj);
  const editor = document.createElement("textarea");
  editor.className = "inline-editor";
  editor.value = obj.text;
  // 圖形本身太小時，輸入框不跟著縮到看不清楚、打不到字——至少維持一個看得清楚、
  // 點得到的最小尺寸，並以圖形中心為準往外擴，不會因為尺寸被撐大就偏到一邊去。
  const boxW = Math.max(MIN_EDITOR_SIZE.w, b.w * state.zoom);
  const boxH = Math.max(MIN_EDITOR_SIZE.h, b.h * state.zoom);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  editor.style.left = (cx - entry.cropX) * state.zoom - boxW / 2 + "px";
  editor.style.top = (cy - entry.cropY) * state.zoom - boxH / 2 + "px";
  editor.style.width = boxW + "px";
  editor.style.height = boxH + "px";
  editor.style.fontSize = Math.max(12, obj.fontSize * state.zoom) + "px";
  editor.style.color = obj.textColor;
  editor.style.textAlign = "center";
  editor.style.resize = "none";
  editor.style.background = "rgba(255,255,255,.9)";
  // 編輯框的中心點就是 getBBox(obj) 的中心，用預設 transform-origin 轉，角度才會跟沒在編輯時
  // 畫出來的樣子一致，不會雙擊編輯時突然變回沒轉過的樣子。
  editor.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : "";
  entry.innerEl.appendChild(editor);
  editor.focus();
  editor.select();

  let committed = false;
  const commit = (cancel) => {
    if (committed) return;
    committed = true;
    editor.remove();
    obj._editing = false;
    state.currentTextEditor = null;
    if (!cancel) obj.text = editor.value;
    redraw(entry);
    renderToolOptions();
  };
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      commit(true);
    }
  });
  editor.addEventListener("blur", () => commit(false));
  state.currentTextEditor = { commit: () => commit(false) };
}

// 索引符號有上／下兩段文字，用兩個輸入框分別蓋在圓圈的上半、下半，置中對齊
function openIndexMarkEditor(entry, obj) {
  closeTextEditor(true);
  if (obj.text == null) obj.text = "";
  if (!obj.textColor) obj.textColor = "#000000";
  if (!obj.fontSize) obj.fontSize = 28;
  obj._editing = true;
  redraw(entry);

  const b = getBBox(obj);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const R = b.w * 0.33;

  const editor = document.createElement("textarea");
  editor.className = "inline-editor";
  editor.value = obj.text;
  const wPt = R * 1.6, hPt = R * 1.2;
  // 索引符號縮得很小時 R 會跟著變得很小，輸入框一樣要有個看得清楚的最小尺寸（見
  // MIN_EDITOR_SIZE），不然會變成點不到、看不到游標的迷你方塊。
  const boxW = Math.max(MIN_EDITOR_SIZE.w, wPt * state.zoom);
  const boxH = Math.max(MIN_EDITOR_SIZE.h, hPt * state.zoom);
  editor.style.left = (cx - entry.cropX) * state.zoom - boxW / 2 + "px";
  editor.style.top = (cy - entry.cropY) * state.zoom - boxH / 2 + "px";
  editor.style.width = boxW + "px";
  editor.style.height = boxH + "px";
  editor.style.fontSize = Math.max(12, obj.fontSize * state.zoom) + "px";
  editor.style.color = obj.textColor;
  editor.style.textAlign = "center";
  editor.style.resize = "none";
  editor.style.background = "rgba(255,255,255,.9)";
  entry.innerEl.appendChild(editor);
  editor.focus();
  editor.select();

  let committed = false;
  const commit = (cancel) => {
    if (committed) return;
    committed = true;
    editor.remove();
    obj._editing = false;
    state.currentTextEditor = null;
    if (!cancel) obj.text = editor.value;
    redraw(entry);
    renderToolOptions();
  };
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      commit(true);
    }
  });
  editor.addEventListener("blur", () => commit(false));
  state.currentTextEditor = { commit: () => commit(false) };
}

/* ---------------- 浮水印（套用到所有頁面，存成每頁的設定，之後都會跟著重繪） ---------------- */

const wmState = { dataUrl: null, fileName: null };

function updateWatermarkModalUI() {
  const hasImage = !!wmState.dataUrl;
  $("#wmImagePreviewWrap").hidden = !hasImage;
  if (hasImage) $("#wmImagePreview").src = wmState.dataUrl;
  $("#wmTextLabel").hidden = hasImage;
  $("#wmColorLabel").hidden = hasImage;
  $("#wmSizeLabel").textContent = hasImage ? "圖片寬度" : "字型大小";
}

$("#wmImageInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    wmState.dataUrl = await fileToDataUrl(f);
    wmState.fileName = f.name;
    updateWatermarkModalUI();
  } catch (err) {
    console.error(err);
    toast("讀取圖片失敗：" + err.message, true);
  }
});
$("#wmImageClear").addEventListener("click", () => {
  wmState.dataUrl = null;
  wmState.fileName = null;
  updateWatermarkModalUI();
});

function openWatermarkModal() {
  updateWatermarkModalUI();
  $("#watermarkModal").hidden = false;
}
$("#wmCancel").addEventListener("click", () => ($("#watermarkModal").hidden = true));
$("#wmApply").addEventListener("click", () => {
  let cfg;
  if (wmState.dataUrl) {
    cfg = {
      mode: "image",
      dataUrl: wmState.dataUrl,
      size: Number($("#wmSize").value),
      opacity: Number($("#wmOpacity").value) / 100,
      rotate: Number($("#wmRotate").value),
      tile: $("#wmTile").checked,
    };
  } else {
    const text = $("#wmText").value.trim();
    if (!text) {
      toast("請輸入浮水印文字，或是改選圖片", true);
      return;
    }
    cfg = {
      mode: "text",
      text,
      size: Number($("#wmSize").value),
      opacity: Number($("#wmOpacity").value) / 100,
      rotate: Number($("#wmRotate").value),
      color: $("#wmColor").value,
      tile: $("#wmTile").checked,
    };
  }
  state.pages.forEach((entry) => {
    pushHistory(entry);
    entry.watermark = { ...cfg };
    redraw(entry);
  });
  $("#watermarkModal").hidden = true;
  toast(`已套用浮水印到 ${state.pages.length} 頁`);
});

/* ---------------- 新增空白頁面（可自訂紙張尺寸） ---------------- */

const BLANK_PAGE_PRESETS = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210], B5: [176, 250],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6],
};
function updateBlankPageModalUI() {
  const preset = $("#bpPreset").value;
  $("#bpCustomRow").hidden = preset !== "custom";
  if (preset !== "custom") {
    const [w, h] = BLANK_PAGE_PRESETS[preset];
    $("#bpWidth").value = w;
    $("#bpHeight").value = h;
  }
}
$("#bpPreset").addEventListener("change", updateBlankPageModalUI);
function openBlankPageModal() {
  $("#bpPreset").value = "A4";
  $("#bpLandscape").checked = false;
  $("#bpCount").value = 1;
  updateBlankPageModalUI();
  $("#blankPageModal").hidden = false;
}
$("#btnBlankPage").addEventListener("click", openBlankPageModal);
$("#bpCancel").addEventListener("click", () => ($("#blankPageModal").hidden = true));
$("#bpApply").addEventListener("click", async () => {
  let w = Number($("#bpWidth").value), h = Number($("#bpHeight").value);
  if (!(w > 0) || !(h > 0)) {
    toast("請輸入正確的寬度與高度", true);
    return;
  }
  const landscape = $("#bpLandscape").checked;
  if (landscape && w < h) { const t = w; w = h; h = t; }
  else if (!landscape && w > h) { const t = w; w = h; h = t; }
  const count = Math.max(1, Math.min(200, Math.round(Number($("#bpCount").value) || 1)));
  const wPt = (w * 72) / 25.4, hPt = (h * 72) / 25.4;
  $("#blankPageModal").hidden = true;
  await appendBlankPages(wPt, hPt, count);
});

/* ---------------- 頁碼（全域設定，套用到所有頁面；數字依頁面目前順序即時算出） ---------------- */

function updatePageNumberModalUI() {
  $("#pnBgColorLabel").hidden = !$("#pnBgEnabled").checked;
}
$("#pnBgEnabled").addEventListener("change", updatePageNumberModalUI);

function openPageNumberModal() {
  const cfg = state.pageNumberConfig;
  $("#pnFormat").value = cfg ? cfg.format : "{n}";
  $("#pnStart").value = cfg ? cfg.startAt : 1;
  $("#pnSkipFirst").checked = cfg ? !!cfg.skipFirst : false;
  $("#pnPosition").value = cfg ? cfg.position : "bottom-center";
  $("#pnSize").value = cfg ? cfg.fontSize : 12;
  $("#pnColor").value = cfg ? cfg.color : "#000000";
  $("#pnBgEnabled").checked = cfg && cfg.bg ? !!cfg.bg.enabled : false;
  $("#pnBgColor").value = cfg && cfg.bg ? cfg.bg.color : "#ffeb3b";
  updatePageNumberModalUI();
  $("#pageNumberModal").hidden = false;
}
$("#pnCancel").addEventListener("click", () => ($("#pageNumberModal").hidden = true));
$("#pnClear").addEventListener("click", () => {
  state.pageNumberConfig = null;
  state.pages.forEach((entry) => redraw(entry));
  $("#pageNumberModal").hidden = true;
  toast("已清除頁碼");
});
$("#pnApply").addEventListener("click", () => {
  const format = $("#pnFormat").value.trim();
  if (!format) {
    toast("請輸入頁碼格式", true);
    return;
  }
  state.pageNumberConfig = {
    format,
    startAt: Number($("#pnStart").value) || 0,
    skipFirst: $("#pnSkipFirst").checked,
    position: $("#pnPosition").value,
    fontSize: Number($("#pnSize").value),
    color: $("#pnColor").value,
    bg: { enabled: $("#pnBgEnabled").checked, color: $("#pnBgColor").value },
  };
  state.pages.forEach((entry) => redraw(entry));
  $("#pageNumberModal").hidden = true;
  scheduleAutosave();
  toast(`已套用頁碼到 ${state.pages.length} 頁`);
});

/* ---------------- 復原 ---------------- */

// 序列化物件時去掉內部暫存欄位（例如圖片物件快取的 <img> 元素、文字編輯中旗標），
// 避免存進復原紀錄／IndexedDB 時序列化失敗或留下過期狀態。
function cleanReplacer(key, value) {
  if (typeof key === "string" && key.startsWith("_")) return undefined;
  return value;
}
function cleanObjects(objects) {
  return JSON.parse(JSON.stringify(objects, cleanReplacer));
}

function pushHistory(entry) {
  entry.history.push(JSON.stringify({ objects: entry.objects, watermark: entry.watermark }, cleanReplacer));
  if (entry.history.length > 30) entry.history.shift();
  state.lastActiveEntry = entry;
  $("#btnUndo").disabled = false;
  scheduleAutosave();
}

function undo() {
  const entry = state.lastActiveEntry;
  if (!entry || !entry.history.length) return;
  const snap = JSON.parse(entry.history.pop());
  entry.objects = snap.objects;
  entry.watermark = snap.watermark;
  if (state.selected && state.selected.entry === entry) {
    const stillExisting = state.selected.objs
      .map((o) => entry.objects.find((o2) => o2.id === o.id))
      .filter(Boolean);
    setSelected(stillExisting.length ? { entry, objs: stillExisting } : null);
  }
  redraw(entry);
  renderToolOptions();
  scheduleAutosave();
  if (!entry.history.length) $("#btnUndo").disabled = true;
}
$("#btnUndo").addEventListener("click", undo);

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA";
  if (e.ctrlKey && e.key.toLowerCase() === "z" && !typing) {
    e.preventDefault();
    undo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && !typing && state.selected) {
    e.preventDefault();
    deleteSelected();
  } else if (e.ctrlKey && e.key.toLowerCase() === "c" && !typing && state.selected) {
    e.preventDefault();
    copySelectedObject();
  }
  // Ctrl+V 不在這裡處理：交給下面的瀏覽器原生 paste 事件，才讀得到「電腦目前真正的剪貼簿內容」
  // （keydown 事件本身拿不到剪貼簿資料），這樣從系統其他地方複製文字／圖片過來，貼上才會生效。
});

/* ---------------- 複製／貼上選取的物件（Ctrl+C／Ctrl+V） ----------------
   複製時除了存一份在記憶體裡（state.objectClipboard，當系統剪貼簿寫入失敗時的備援），
   也會把物件資料包成一段帶標記的 JSON 字串寫進「真正的系統剪貼簿」。這樣使用者複製物件
   之後，如果又跑去外面複製了別的文字或圖片，系統剪貼簿裡最新的就是那份外面複製的內容，
   回到這裡按 Ctrl+V 時（見下面的 paste 事件）會優先讀系統剪貼簿目前真正裝的是什麼，
   而不是死守著「這個分頁記得的上一次複製」，符合「隨時貼的都是電腦最新複製的東西」。 */

const CLIP_TAG = "__pdfEditorClip";

function copySelectedObject() {
  if (!state.selected) return;
  const entry = state.selected.entry;
  const objs = state.selected.objs.map((o) => JSON.parse(JSON.stringify(o, cleanReplacer)));
  state.objectClipboard = { sourceEntry: entry, objs };
  const payload = JSON.stringify({ [CLIP_TAG]: true, sourceRotation: getPageRotation(entry), objs });
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload).catch(() => {
      // 系統剪貼簿寫入失敗（例如權限被擋）時，還是有上面的 state.objectClipboard 當備援，
      // 同一個分頁裡還是能貼上，只是換到別的分頁/視窗就讀不到了。
    });
  }
  const n = objs.length;
  toast(n > 1 ? `已複製 ${n} 個物件` : "已複製物件");
}

function getPageRotation(entry) {
  return (((entry.baseRotation + entry.userDelta) % 360) + 360) % 360;
}

// 把還原出來的物件陣列實際貼進目前作用中的頁面；offset 固定會加一點位移，
// 不管貼到同一頁還是別頁，都能馬上看出「這是新貼上的一份」、不會跟原本的疊在一起看不出來。
function pasteObjectsIntoActivePage(objs, sourceRotation) {
  const targetEntry = pickActivePage();
  if (!targetEntry) return;
  const offset = 16;
  const rotationFix = sourceRotation != null ? sourceRotation - getPageRotation(targetEntry) : 0;
  const newObjs = objs.map((o) => {
    const obj = JSON.parse(JSON.stringify(o, cleanReplacer));
    obj.id = newId();
    obj.locked = false; // 貼上永遠是新的一份，不繼承來源物件的鎖定狀態
    if (rotationFix && typeof obj.rotation === "number") {
      obj.rotation = normalizeAngle(obj.rotation + rotationFix);
    }
    if (obj.points) obj.points = obj.points.map((p) => ({ x: p.x + offset, y: p.y + offset }));
    else {
      obj.x = (obj.x || 0) + offset;
      obj.y = (obj.y || 0) + offset;
    }
    return obj;
  });
  pushHistory(targetEntry);
  newObjs.forEach((obj) => targetEntry.objects.push(obj));
  setTool("pan");
  setSelected({ entry: targetEntry, objs: newObjs });
  redraw(targetEntry);
  renderToolOptions();
  toast(newObjs.length > 1 ? `已貼上 ${newObjs.length} 個物件` : "已貼上物件");
}

// 貼上一段純文字（從系統剪貼簿來的，不是我們自己複製的物件）：直接當成一個新的文字物件
// 插入目前作用中的頁面正中央，套用「新增文字」工具目前的預設樣式（顏色／字級等）。
function pasteTextAsObject(text) {
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) return;
  const entry = pickActivePage();
  if (!entry) return;
  ensureCropDefaults(entry);
  const d = state.defaults.text;
  const box = measureTextBoxPt(text, d.fontSize);
  const x = entry.cropX + (entry.cropW - box.w) / 2 + TEXT_PAD;
  const y = entry.cropY + (entry.cropH - box.h) / 2 + TEXT_PAD;
  const obj = {
    id: newId(), type: "text", x, y, text, rotation: normalizeAngle(-getPageRotation(entry)),
    color: d.color, fontSize: d.fontSize,
    bg: { enabled: d.bg.enabled, color: d.bg.color },
    border: { enabled: d.border.enabled, color: d.border.color, width: d.border.width },
  };
  pushHistory(entry);
  entry.objects.push(obj);
  setTool("pan");
  setSelected({ entry, objs: [obj] });
  redraw(entry);
  renderToolOptions();
  toast("已貼上文字");
}

/* ---------------- 貼上（Ctrl+V）：一律看系統剪貼簿「現在真正裝的是什麼」 ---------------- */

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function getImageDims(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}
function pickActivePage() {
  if (state.selected) return state.selected.entry;
  if (!state.pages.length) return null;
  const viewerRect = viewerScroll.getBoundingClientRect();
  let best = state.pages[0], bestOverlap = -1;
  for (const p of state.pages) {
    const r = p.outerEl.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(r.bottom, viewerRect.bottom) - Math.max(r.top, viewerRect.top));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = p;
    }
  }
  return best;
}

// 把一個圖片檔案變成頁面上的「圖片」物件（貼上、拖曳插入共用這段）。沒給 centerPt 就放在頁面正中央；
// 外框套用目前「蓋章工具」記住的外框預設值（state.defaults.stamp.border），讓貼上／拖曳／蓋章
// 三種插入照片的方式套用同一份外框設定，不用三個地方分別記一份。呼叫端自己負責 pushHistory。
async function insertImageObjectAt(entry, file, centerPt) {
  const dataUrl = await fileToDataUrl(file);
  const dims = await getImageDims(dataUrl);
  ensureCropDefaults(entry);
  const pageW = entry.cropW, pageH = entry.cropH;
  const maxW = pageW * 0.7, maxH = pageH * 0.7;
  const ratio = Math.min(1, maxW / dims.w, maxH / dims.h);
  const w = dims.w * ratio, h = dims.h * ratio;
  const cx = centerPt ? centerPt.x : entry.cropX + pageW / 2;
  const cy = centerPt ? centerPt.y : entry.cropY + pageH / 2;
  const bd = state.defaults.stamp.border;
  const obj = {
    id: newId(), type: "image", x: cx - w / 2, y: cy - h / 2, w, h,
    rotation: normalizeAngle(-getPageRotation(entry)), dataUrl,
    border: { enabled: bd.enabled, color: bd.color, width: bd.width },
  };
  entry.objects.push(obj);
  return obj;
}

/* ---------------- 圖片物件裁切（彈窗內拖框選範圍，套用後縮小顯示框，原始照片保留不變） ---------------- */

const IMG_CROP_HANDLE_KEYS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const IMG_CROP_MIN = 24; // 裁切框最小寬／高（彈窗內顯示用的 CSS px）
let imageCropState = null; // { entry, obj, natW, natH, dispW, dispH, rect:{x,y,w,h} } rect 是顯示尺寸下的像素
let imageCropDrag = null;

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function ensureImageCropHandleEls() {
  const stage = $("#icStage");
  if (stage._handles) return stage._handles;
  const els = {};
  IMG_CROP_HANDLE_KEYS.forEach((key) => {
    const el = document.createElement("div");
    el.className = "img-crop-handle img-crop-handle-" + key;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件沒有有效 pointer 時略過即可 */ }
      imageCropDrag = { mode: "resize", handle: key, startX: e.clientX, startY: e.clientY, orig: { ...imageCropState.rect } };
    });
    stage.appendChild(el);
    els[key] = el;
  });
  stage._handles = els;
  return els;
}

function renderImageCropBox() {
  const r = imageCropState.rect;
  const box = $("#icBox");
  box.style.left = r.x + "px";
  box.style.top = r.y + "px";
  box.style.width = r.w + "px";
  box.style.height = r.h + "px";
  const handles = ensureImageCropHandleEls();
  const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h, xm = x0 + r.w / 2, ym = y0 + r.h / 2;
  const pos = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] };
  IMG_CROP_HANDLE_KEYS.forEach((key) => {
    const [hx, hy] = pos[key];
    handles[key].style.left = hx + "px";
    handles[key].style.top = hy + "px";
  });
}

function resizeImgCropRect(orig, handle, dx, dy, dispW, dispH) {
  let x = orig.x, y = orig.y, x1 = orig.x + orig.w, y1 = orig.y + orig.h;
  if (handle.includes("w")) x = clampNum(x + dx, 0, x1 - IMG_CROP_MIN);
  if (handle.includes("e")) x1 = clampNum(x1 + dx, x + IMG_CROP_MIN, dispW);
  if (handle.includes("n")) y = clampNum(y + dy, 0, y1 - IMG_CROP_MIN);
  if (handle.includes("s")) y1 = clampNum(y1 + dy, y + IMG_CROP_MIN, dispH);
  return { x, y, w: x1 - x, h: y1 - y };
}

window.addEventListener("pointermove", (e) => {
  if (!imageCropDrag || !imageCropState) return;
  const st = imageCropState;
  const dx = e.clientX - imageCropDrag.startX, dy = e.clientY - imageCropDrag.startY;
  if (imageCropDrag.mode === "move") {
    const o = imageCropDrag.orig;
    st.rect = {
      x: clampNum(o.x + dx, 0, st.dispW - o.w),
      y: clampNum(o.y + dy, 0, st.dispH - o.h),
      w: o.w, h: o.h,
    };
  } else {
    st.rect = resizeImgCropRect(imageCropDrag.orig, imageCropDrag.handle, dx, dy, st.dispW, st.dispH);
  }
  renderImageCropBox();
});
window.addEventListener("pointerup", () => {
  imageCropDrag = null;
});

$("#icBox").addEventListener("pointerdown", (e) => {
  if (!imageCropState) return;
  e.stopPropagation();
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* 同上 */ }
  imageCropDrag = { mode: "move", startX: e.clientX, startY: e.clientY, orig: { ...imageCropState.rect } };
});

async function openImageCropModal(entry, obj) {
  const img = $("#icImg");
  img.src = obj.dataUrl;
  $("#imageCropModal").hidden = false;
  if (!(img.complete && img.naturalWidth)) {
    await new Promise((resolve) => { img.onload = resolve; });
  }
  requestAnimationFrame(() => {
    const dispW = img.clientWidth, dispH = img.clientHeight;
    const crop = obj.crop || { x: 0, y: 0, w: 1, h: 1 };
    imageCropState = {
      entry, obj, natW: img.naturalWidth, natH: img.naturalHeight, dispW, dispH,
      rect: { x: crop.x * dispW, y: crop.y * dispH, w: crop.w * dispW, h: crop.h * dispH },
    };
    renderImageCropBox();
  });
}

function closeImageCropModal() {
  $("#imageCropModal").hidden = true;
  imageCropState = null;
  imageCropDrag = null;
}

$("#icCancel").addEventListener("click", closeImageCropModal);
$("#icReset").addEventListener("click", () => {
  if (!imageCropState) return;
  imageCropState.rect = { x: 0, y: 0, w: imageCropState.dispW, h: imageCropState.dispH };
  renderImageCropBox();
});
$("#icApply").addEventListener("click", () => {
  if (!imageCropState) return;
  const { entry, obj, natW, natH, dispW, dispH, rect } = imageCropState;
  const cropFrac = { x: rect.x / dispW, y: rect.y / dispH, w: rect.w / dispW, h: rect.h / dispH };
  // 維持目前「每像素對應多少 point」的比例不變：裁切後顯示框跟著縮小，左上角位置不動，
  // 這樣套用完看起來就是「挖掉不要的部分」，不會整張圖突然被放大或縮小。
  const prevCrop = obj.crop || { x: 0, y: 0, w: 1, h: 1 };
  const scaleX = obj.w / (prevCrop.w * natW);
  const scaleY = obj.h / (prevCrop.h * natH);
  const newW = cropFrac.w * natW * scaleX;
  const newH = cropFrac.h * natH * scaleY;
  withObjHistory(entry, () => {
    obj.crop = cropFrac;
    obj.w = newW;
    obj.h = newH;
  });
  renderToolOptions();
  closeImageCropModal();
  toast("已套用圖片裁切");
});

window.addEventListener("paste", async (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return; // 讓一般文字欄位的貼上照常運作
  if (!state.pages.length) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let imageFile = null;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      imageFile = item.getAsFile();
      break;
    }
  }
  if (imageFile) {
    e.preventDefault();
    const entry = pickActivePage();
    if (!entry) return;
    try {
      pushHistory(entry);
      const obj = await insertImageObjectAt(entry, imageFile);
      setTool("pan");
      setSelected({ entry, objs: [obj] });
      redraw(entry);
      renderToolOptions();
      toast("已貼上圖片");
    } catch (err) {
      console.error(err);
      toast("貼上圖片失敗：" + err.message, true);
    }
    return;
  }

  // 沒有圖片 → 看系統剪貼簿裡現在裝的文字：如果是我們自己複製物件時寫進去、帶著
  // CLIP_TAG 標記的那種 JSON，就還原成原本的物件（顏色／大小／旋轉都跟原本一樣）；
  // 不是的話（真的只是一段文字，從別的地方複製來的）就直接貼成一個新的文字物件。
  const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
  if (text && text.trim()) {
    e.preventDefault();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
    if (parsed && parsed[CLIP_TAG] && Array.isArray(parsed.objs) && parsed.objs.length) {
      pasteObjectsIntoActivePage(parsed.objs, parsed.sourceRotation);
    } else {
      pasteTextAsObject(text);
    }
    return;
  }

  // 系統剪貼簿讀不到文字也沒有圖片（例如寫入系統剪貼簿失敗過、或瀏覽器權限擋住讀取）時，
  // 退回去用這個分頁自己記得的上一次複製內容，至少同一個分頁裡複製貼上還能正常運作。
  if (state.objectClipboard) {
    e.preventDefault();
    pasteObjectsIntoActivePage(state.objectClipboard.objs, getPageRotation(state.objectClipboard.sourceEntry));
  }
});

/* ---------------- 工具選項面板（新物件預設值 / 已選取物件的樣式） ---------------- */

function withObjHistory(entry, mutateFn) {
  if (!pendingObjEditPushed) {
    pushHistory(entry);
    pendingObjEditPushed = true;
  }
  mutateFn();
  redraw(entry);
}

function addImageFileInput(container, label, onPicked) {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      const dims = await getImageDims(dataUrl);
      onPicked(dataUrl, dims, f.name);
    } catch (err) {
      console.error(err);
      toast("讀取圖片失敗：" + err.message, true);
    }
  });
  l.appendChild(input);
  container.appendChild(l);
  return input;
}
// 常用顏色快速選取：點一下就套用，不用每次都打開色盤慢慢挑，也方便多個物件要選同一個顏色時對齊
const PRESET_COLORS = ["#000000", "#ffffff", "#ff0000", "#ff8c00", "#ffeb3b", "#22c55e", "#2563eb", "#9333ea", "#6b7280"];

function addColorInput(container, label, value, onChange) {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "color";
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  l.appendChild(input);

  const swatches = document.createElement("div");
  swatches.className = "color-swatches";
  PRESET_COLORS.forEach((hex) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch";
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener("click", () => {
      input.value = hex;
      onChange(hex);
    });
    swatches.appendChild(sw);
  });
  l.appendChild(swatches);

  container.appendChild(l);
  return input;
}
function addDateInput(container, label, value, onChange) {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "date";
  if (value) input.value = value;
  input.addEventListener("input", () => {
    if (input.value) onChange(input.value);
  });
  l.appendChild(input);
  container.appendChild(l);
  return input;
}
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addRangeInput(container, label, value, min, max, onChange) {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.value = value;
  input.addEventListener("input", () => onChange(Number(input.value)));
  l.appendChild(input);
  container.appendChild(l);
  return input;
}
function addCheckbox(container, label, checked, onChange) {
  const l = document.createElement("label");
  l.className = "checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  l.appendChild(input);
  l.appendChild(document.createTextNode(label));
  container.appendChild(l);
  return input;
}
function addButtonGroup(container, label, options, current, onChange) {
  const l = document.createElement("label");
  l.textContent = label;
  const wrap = document.createElement("div");
  wrap.className = "btn-group";
  options.forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.label;
    b.className = opt.value === current ? "mini active" : "mini";
    b.addEventListener("click", () => onChange(opt.value));
    wrap.appendChild(b);
  });
  l.appendChild(wrap);
  container.appendChild(l);
}
function addDeleteButton(container) {
  const b = document.createElement("button");
  b.textContent = "🗑 刪除物件";
  b.title = "刪除目前選取的物件（Delete 鍵也可以）";
  b.addEventListener("click", deleteSelected);
  container.appendChild(b);
}

function buildMultiObjectPanel(objs, entry) {
  const info = document.createElement("span");
  info.style.cssText = "font-size:13px;color:var(--label-b);";
  info.textContent = `已選取 ${objs.length} 個物件`;
  toolOptionsEl.appendChild(info);
  const lockedCount = objs.filter((o) => o.locked).length;
  if (lockedCount) {
    const lockedHint = document.createElement("span");
    lockedHint.style.cssText = "font-size:12px;color:var(--label-c);";
    lockedHint.textContent = `其中 ${lockedCount} 個已鎖定，不會被移動／縮放／刪除`;
    toolOptionsEl.appendChild(lockedHint);
  }
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:12px;color:var(--label-c);";
  hint.textContent = "拖曳其中一個可整批移動；拖右下角把手可整批縮放（按住 Ctrl 鎖定原本的長寬比例）";
  toolOptionsEl.appendChild(hint);

  const lockBtn = document.createElement("button");
  lockBtn.textContent = "🔒 鎖定所選";
  lockBtn.title = "鎖定後這些物件就不能被移動／縮放／刪除，避免編輯時不小心動到";
  lockBtn.addEventListener("click", () => {
    pushHistory(entry);
    objs.forEach((o) => (o.locked = true));
    redraw(entry);
    renderToolOptions();
  });
  toolOptionsEl.appendChild(lockBtn);

  const unlockBtn = document.createElement("button");
  unlockBtn.textContent = "🔓 解鎖所選";
  unlockBtn.addEventListener("click", () => {
    pushHistory(entry);
    objs.forEach((o) => (o.locked = false));
    redraw(entry);
    renderToolOptions();
  });
  toolOptionsEl.appendChild(unlockBtn);

  const imageObjs = objs.filter((o) => o.type === "image");
  if (imageObjs.length) {
    const dateHint = document.createElement("span");
    dateHint.style.cssText = "font-size:12px;color:var(--label-c);";
    dateHint.textContent = `幫其中 ${imageObjs.length} 張照片加入相機日期章（左下角）`;
    toolOptionsEl.appendChild(dateHint);
    let pickedDate = todayISO();
    addDateInput(toolOptionsEl, "日期", pickedDate, (v) => (pickedDate = v));
    const applyDateBtn = document.createElement("button");
    applyDateBtn.textContent = "📅 套用到所選照片";
    applyDateBtn.addEventListener("click", () => {
      pushHistory(entry);
      imageObjs.forEach((o) => (o.dateStamp = { enabled: true, date: pickedDate }));
      redraw(entry);
      renderToolOptions();
      toast(`已幫 ${imageObjs.length} 張照片加入日期`);
    });
    toolOptionsEl.appendChild(applyDateBtn);
    const clearDateBtn = document.createElement("button");
    clearDateBtn.textContent = "移除日期章";
    clearDateBtn.addEventListener("click", () => {
      pushHistory(entry);
      imageObjs.forEach((o) => { if (o.dateStamp) o.dateStamp.enabled = false; });
      redraw(entry);
      renderToolOptions();
    });
    toolOptionsEl.appendChild(clearDateBtn);
  }

  addLayerButtons(toolOptionsEl, entry, objs);
  addDeleteButton(toolOptionsEl);
}

function renderToolOptions() {
  toolOptionsEl.innerHTML = "";
  if (state.selected) {
    if (state.selected.objs.length === 1) buildObjectPanel(state.selected.objs[0], state.selected.entry);
    else buildMultiObjectPanel(state.selected.objs, state.selected.entry);
    return;
  }
  if (state.tool === "text") buildTextDefaultsPanel(state.defaults.text);
  else if (state.tool === "highlight") buildStrokeDefaultsPanel(state.defaults.highlight);
  else if (state.tool === "pen") buildStrokeDefaultsPanel(state.defaults.pen);
  else if (state.tool === "shape") buildShapeDefaultsPanel(state.defaults.shape);
  else if (state.tool === "stamp") buildStampDefaultsPanel(state.defaults.stamp);
  else if (state.tool === "crop") buildCropOptionsPanel();
}

function buildTextDefaultsPanel(d) {
  addColorInput(toolOptionsEl, "顏色", d.color, (v) => (d.color = v));
  addRangeInput(toolOptionsEl, "大小", d.fontSize, 8, 72, (v) => (d.fontSize = v));
  addCheckbox(toolOptionsEl, "底色", d.bg.enabled, (v) => {
    d.bg.enabled = v;
    renderToolOptions();
  });
  if (d.bg.enabled) addColorInput(toolOptionsEl, "底色顏色", d.bg.color, (v) => (d.bg.color = v));
  addCheckbox(toolOptionsEl, "外框", d.border.enabled, (v) => {
    d.border.enabled = v;
    renderToolOptions();
  });
  if (d.border.enabled) {
    addColorInput(toolOptionsEl, "外框顏色", d.border.color, (v) => (d.border.color = v));
    addRangeInput(toolOptionsEl, "外框粗細", d.border.width, 1, 10, (v) => (d.border.width = v));
  }
}
function buildStrokeDefaultsPanel(d) {
  addColorInput(toolOptionsEl, "顏色", d.color, (v) => (d.color = v));
  addRangeInput(toolOptionsEl, "粗細", d.width, 1, 40, (v) => (d.width = v));
}
function buildShapeDefaultsPanel(d) {
  addButtonGroup(
    toolOptionsEl, "形狀",
    [
      { label: "方形", value: "rect" },
      { label: "橢圓", value: "ellipse" },
      { label: "雲型線", value: "cloud" },
      { label: "索引符號", value: "indexmark" },
    ],
    d.kind,
    (v) => {
      d.kind = v;
      renderToolOptions();
    }
  );
  if (d.kind === "indexmark") {
    buildIndexMarkDefaultsPanel(state.defaults.indexmark);
    return;
  }
  addColorInput(toolOptionsEl, "邊框顏色", d.stroke, (v) => (d.stroke = v));
  addRangeInput(toolOptionsEl, "邊框粗細", d.strokeWidth, 0, 20, (v) => (d.strokeWidth = v));
  addCheckbox(toolOptionsEl, "填色", d.fill.enabled, (v) => {
    d.fill.enabled = v;
    renderToolOptions();
  });
  if (d.fill.enabled) {
    addColorInput(toolOptionsEl, "填色顏色", d.fill.color, (v) => (d.fill.color = v));
    addRangeInput(toolOptionsEl, "填色透明度", Math.round((d.fill.opacity == null ? 1 : d.fill.opacity) * 100), 0, 100, (v) => (d.fill.opacity = v / 100));
  }
  addColorInput(toolOptionsEl, "文字顏色", d.textColor, (v) => (d.textColor = v));
  addRangeInput(toolOptionsEl, "文字大小", d.fontSize, 8, 120, (v) => (d.fontSize = v));
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:12px;color:var(--label-c);";
  hint.textContent = "雙擊圖形可在中間打字";
  toolOptionsEl.appendChild(hint);
}

function buildIndexMarkDefaultsPanel(d) {
  addColorInput(toolOptionsEl, "顏色", d.stroke, (v) => (d.stroke = v));
  addRangeInput(toolOptionsEl, "線條粗細", d.strokeWidth, 1, 10, (v) => (d.strokeWidth = v));
  addCheckbox(toolOptionsEl, "填色", d.fill.enabled, (v) => {
    d.fill.enabled = v;
    renderToolOptions();
  });
  if (d.fill.enabled) {
    addColorInput(toolOptionsEl, "填色顏色", d.fill.color, (v) => (d.fill.color = v));
    addRangeInput(toolOptionsEl, "填色透明度", Math.round((d.fill.opacity == null ? 1 : d.fill.opacity) * 100), 0, 100, (v) => (d.fill.opacity = v / 100));
  }
  addColorInput(toolOptionsEl, "文字顏色", d.textColor, (v) => (d.textColor = v));
  addRangeInput(toolOptionsEl, "文字大小", d.fontSize, 8, 80, (v) => (d.fontSize = v));
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:12px;color:var(--label-c);";
  hint.textContent = "拖曳新增後雙擊可輸入文字；拖旋轉把手只會轉三角指標，文字不會跟著轉";
  toolOptionsEl.appendChild(hint);
}

function buildStampDefaultsPanel(d) {
  addImageFileInput(toolOptionsEl, d.dataUrl ? "更換印章圖片" : "選擇印章圖片", (dataUrl, dims, fileName) => {
    d.dataUrl = dataUrl;
    d.fileName = fileName;
    d.naturalW = dims.w;
    d.naturalH = dims.h;
    renderToolOptions();
  });
  if (d.dataUrl) {
    const preview = document.createElement("img");
    preview.src = d.dataUrl;
    preview.style.cssText = "max-width:36px;max-height:36px;border:1px solid var(--chip-border);border-radius:4px;vertical-align:middle;";
    toolOptionsEl.appendChild(preview);
    addRangeInput(toolOptionsEl, "印章大小", d.targetW, 20, 400, (v) => (d.targetW = v));
    const hint = document.createElement("span");
    hint.style.cssText = "font-size:12px;color:var(--label-c);";
    hint.textContent = "點頁面即可蓋章";
    toolOptionsEl.appendChild(hint);
  }
  // 外框設定不限定要先選好印章圖片才能調：拖照片進頁面／貼上(Ctrl+V)照片時也是套用這裡的設定，
  // 讓使用者只靠拖曳／貼上插入照片時，一樣有地方可以先設定好「新插入的照片要不要外框」。
  if (!d.border) d.border = { enabled: false, color: "#000000", width: 2 };
  addCheckbox(toolOptionsEl, "新插入照片加外框", d.border.enabled, (v) => {
    d.border.enabled = v;
    renderToolOptions();
  });
  if (d.border.enabled) {
    addColorInput(toolOptionsEl, "外框顏色", d.border.color, (v) => (d.border.color = v));
    addRangeInput(toolOptionsEl, "外框粗細", d.border.width, 1, 10, (v) => (d.border.width = v));
  }
  const dropHint = document.createElement("span");
  dropHint.style.cssText = "font-size:12px;color:var(--label-c);";
  dropHint.textContent = "照片也可以直接從電腦拖曳到頁面上，或用 Ctrl+V 貼上剪貼簿裡的照片";
  toolOptionsEl.appendChild(dropHint);
}

function buildCropOptionsPanel() {
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:12px;color:var(--label-c);";
  hint.textContent = "拖曳框選範圍（可超出頁面邊緣，靠近原始頁面邊界會自動吸附）；放開後可拖曳四邊／四角的把手微調範圍，雙擊頁面套用裁切";
  toolOptionsEl.appendChild(hint);
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "取消框選";
  cancelBtn.title = "清掉目前還沒套用的框選範圍";
  cancelBtn.addEventListener("click", () => {
    const entry = pickActivePage();
    if (entry) clearCropPreview(entry);
  });
  toolOptionsEl.appendChild(cancelBtn);
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "↺ 重設裁切";
  resetBtn.title = "恢復成原始、未裁切的頁面大小";
  resetBtn.addEventListener("click", async () => {
    const entry = pickActivePage();
    if (!entry) return;
    clearCropPreview(entry);
    const view = entry.pdfjsPage.view;
    await applyCrop(entry, 0, 0, view[2] - view[0], view[3] - view[1]);
  });
  toolOptionsEl.appendChild(resetBtn);
}

function buildObjectPanel(obj, entry) {
  addCheckbox(toolOptionsEl, "🔒 鎖定物件", !!obj.locked, (v) => {
    withObjHistory(entry, () => (obj.locked = v));
    renderToolOptions();
  });
  if (obj.locked) {
    const hint = document.createElement("span");
    hint.style.cssText = "font-size:12px;color:var(--label-c);";
    hint.textContent = "已鎖定：無法移動／縮放／旋轉／刪除／編輯，取消勾選即可恢復";
    toolOptionsEl.appendChild(hint);
    return;
  }
  if (obj.type === "text") {
    addColorInput(toolOptionsEl, "顏色", obj.color, (v) => withObjHistory(entry, () => (obj.color = v)));
    addRangeInput(toolOptionsEl, "大小", Math.round(obj.fontSize), 8, 150, (v) => withObjHistory(entry, () => (obj.fontSize = v)));
    addCheckbox(toolOptionsEl, "底色", obj.bg.enabled, (v) => {
      withObjHistory(entry, () => (obj.bg.enabled = v));
      renderToolOptions();
    });
    if (obj.bg.enabled) addColorInput(toolOptionsEl, "底色顏色", obj.bg.color, (v) => withObjHistory(entry, () => (obj.bg.color = v)));
    addCheckbox(toolOptionsEl, "外框", obj.border.enabled, (v) => {
      withObjHistory(entry, () => (obj.border.enabled = v));
      renderToolOptions();
    });
    if (obj.border.enabled) {
      addColorInput(toolOptionsEl, "外框顏色", obj.border.color, (v) => withObjHistory(entry, () => (obj.border.color = v)));
      addRangeInput(toolOptionsEl, "外框粗細", obj.border.width, 1, 10, (v) => withObjHistory(entry, () => (obj.border.width = v)));
    }
  } else if (obj.type === "highlight" || obj.type === "pen") {
    addColorInput(toolOptionsEl, "顏色", obj.color, (v) => withObjHistory(entry, () => (obj.color = v)));
    addRangeInput(toolOptionsEl, "粗細", obj.width, 1, 40, (v) => withObjHistory(entry, () => (obj.width = v)));
  } else if (obj.type === "image") {
    if (!obj.border) obj.border = { enabled: false, color: "#000000", width: 2 };
    const cropBtn = document.createElement("button");
    cropBtn.textContent = "✂ 裁切圖片";
    cropBtn.title = "裁掉圖片不要的部分，照片原始內容不會被破壞，之後可以再重新調整裁切範圍";
    cropBtn.addEventListener("click", () => openImageCropModal(entry, obj));
    toolOptionsEl.appendChild(cropBtn);
    addCheckbox(toolOptionsEl, "外框", obj.border.enabled, (v) => {
      withObjHistory(entry, () => (obj.border.enabled = v));
      renderToolOptions();
    });
    if (obj.border.enabled) {
      addColorInput(toolOptionsEl, "外框顏色", obj.border.color, (v) => withObjHistory(entry, () => (obj.border.color = v)));
      addRangeInput(toolOptionsEl, "外框粗細", obj.border.width, 1, 10, (v) => withObjHistory(entry, () => (obj.border.width = v)));
    }
    if (!obj.dateStamp) obj.dateStamp = { enabled: false, date: todayISO() };
    addCheckbox(toolOptionsEl, "📅 相機日期章（左下角）", obj.dateStamp.enabled, (v) => {
      withObjHistory(entry, () => (obj.dateStamp.enabled = v));
      renderToolOptions();
    });
    if (obj.dateStamp.enabled) {
      addDateInput(toolOptionsEl, "日期", obj.dateStamp.date, (v) => withObjHistory(entry, () => (obj.dateStamp.date = v)));
    }
  } else if (obj.type === "rect" || obj.type === "ellipse" || obj.type === "cloud") {
    addColorInput(toolOptionsEl, "邊框顏色", obj.stroke, (v) => withObjHistory(entry, () => (obj.stroke = v)));
    addRangeInput(toolOptionsEl, "邊框粗細", obj.strokeWidth, 0, 20, (v) => withObjHistory(entry, () => (obj.strokeWidth = v)));
    addCheckbox(toolOptionsEl, "填色", obj.fill.enabled, (v) => {
      withObjHistory(entry, () => (obj.fill.enabled = v));
      renderToolOptions();
    });
    if (obj.fill.enabled) {
      addColorInput(toolOptionsEl, "填色顏色", obj.fill.color, (v) => withObjHistory(entry, () => (obj.fill.color = v)));
      addRangeInput(
        toolOptionsEl, "填色透明度", Math.round((obj.fill.opacity == null ? 1 : obj.fill.opacity) * 100), 0, 100,
        (v) => withObjHistory(entry, () => (obj.fill.opacity = v / 100))
      );
    }
    if (obj.text == null) obj.text = "";
    if (!obj.textColor) obj.textColor = "#000000";
    if (!obj.fontSize) obj.fontSize = 16;
    addColorInput(toolOptionsEl, "文字顏色", obj.textColor, (v) => withObjHistory(entry, () => (obj.textColor = v)));
    addRangeInput(toolOptionsEl, "文字大小", obj.fontSize, 8, 120, (v) => withObjHistory(entry, () => (obj.fontSize = v)));
    const editBtn = document.createElement("button");
    editBtn.textContent = obj.text ? "✏️ 編輯文字" : "➕ 輸入文字";
    editBtn.title = "在圖形中間輸入或修改文字（雙擊圖形也可以）";
    editBtn.addEventListener("click", () => openShapeTextEditor(entry, obj));
    toolOptionsEl.appendChild(editBtn);
  } else if (obj.type === "indexmark") {
    if (!obj.fill) obj.fill = { enabled: false, color: "#e21818", opacity: 1 };
    addColorInput(toolOptionsEl, "顏色", obj.stroke, (v) => withObjHistory(entry, () => (obj.stroke = v)));
    addRangeInput(toolOptionsEl, "線條粗細", obj.strokeWidth, 1, 10, (v) => withObjHistory(entry, () => (obj.strokeWidth = v)));
    addCheckbox(toolOptionsEl, "填色", obj.fill.enabled, (v) => {
      withObjHistory(entry, () => (obj.fill.enabled = v));
      renderToolOptions();
    });
    if (obj.fill.enabled) {
      addColorInput(toolOptionsEl, "填色顏色", obj.fill.color, (v) => withObjHistory(entry, () => (obj.fill.color = v)));
      addRangeInput(
        toolOptionsEl, "填色透明度", Math.round((obj.fill.opacity == null ? 1 : obj.fill.opacity) * 100), 0, 100,
        (v) => withObjHistory(entry, () => (obj.fill.opacity = v / 100))
      );
    }
    addColorInput(toolOptionsEl, "文字顏色", obj.textColor, (v) => withObjHistory(entry, () => (obj.textColor = v)));
    addRangeInput(toolOptionsEl, "文字大小", obj.fontSize, 8, 80, (v) => withObjHistory(entry, () => (obj.fontSize = v)));
    const editBtn = document.createElement("button");
    editBtn.textContent = obj.text ? "✏️ 編輯文字" : "➕ 輸入文字";
    editBtn.title = "輸入編號文字（雙擊符號也可以）";
    editBtn.addEventListener("click", () => openIndexMarkEditor(entry, obj));
    toolOptionsEl.appendChild(editBtn);
  }
  addLayerButtons(toolOptionsEl, entry, obj);
  addDeleteButton(toolOptionsEl);
}

/* ---------------- 匯出 ---------------- */

$("#btnDownload").addEventListener("click", () => exportPages(state.pages, suggestFileName()));

function suggestFileName() {
  const first = state.sources[0];
  const base = first ? first.fileName.replace(/\.pdf$/i, "") : "文件";
  return base + "_已編輯.pdf";
}

async function dataUrlToBytes(dataUrl) {
  const res = await fetch(dataUrl);
  return new Uint8Array(await res.arrayBuffer());
}

async function getLibDoc(sourceIndex) {
  const src = state.sources[sourceIndex];
  if (!src.libDoc) {
    src.libDoc = await PDFDocument.load(src.buffer.slice(0));
  }
  return src.libDoc;
}

const EXPORT_SCALE = 3; // 匯出時每個 point 用幾個像素繪製，與畫面縮放無關，確保品質穩定

function ensureImagesLoaded(entry) {
  const imgs = entry.objects.filter((o) => o.type === "image");
  return Promise.all(
    imgs.map(
      (o) =>
        new Promise((resolve) => {
          if (o._img && o._img.complete && o._img.naturalWidth) {
            resolve();
            return;
          }
          const img = o._img || new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          if (!o._img) {
            img.src = o.dataUrl;
            o._img = img;
          }
        })
    )
  );
}

async function exportPages(pageEntries, fileName) {
  showLoading("匯出 PDF 中…");
  try {
    const outDoc = await PDFDocument.create();
    for (const entry of pageEntries) {
      const totalRotation = (((entry.baseRotation + entry.userDelta) % 360) + 360) % 360;

      if (isCropped(entry)) {
        // 頁面裁切／延伸過：無法只覆蓋一張標註用的透明 PNG 了事（原始內容的座標系沒有跟著變），
        // 改成把原始頁面內容＋我們自己的標註一起畫成一張完整的圖片，當作整個新頁面的內容。
        // 這樣裁切後的頁面就不再保留可選取／搜尋的文字層了，是裁切／延伸頁面必要的取捨。
        await ensureImagesLoaded(entry);
        const cw = entry.cropW, ch = entry.cropH;
        const scale = EXPORT_SCALE * CSS_SCALE;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(cw * EXPORT_SCALE));
        c.height = Math.max(1, Math.round(ch * EXPORT_SCALE));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        const viewport = entry.pdfjsPage.getViewport({
          scale, rotation: 0,
          offsetX: -entry.cropX * scale,
          offsetY: -entry.cropY * scale,
        });
        await entry.pdfjsPage.render({ canvasContext: ctx, viewport }).promise;
        renderPageObjects(entry, ctx, EXPORT_SCALE, { withHandles: false, noClear: true });
        const dataUrl = c.toDataURL("image/png");
        const bytes = await dataUrlToBytes(dataUrl);
        const png = await outDoc.embedPng(bytes);
        const newPage = outDoc.addPage([cw, ch]);
        newPage.drawImage(png, { x: 0, y: 0, width: cw, height: ch });
        newPage.setRotation(degrees(totalRotation));
        continue;
      }

      const libDoc = await getLibDoc(entry.sourceIndex);
      const [copied] = await outDoc.copyPages(libDoc, [entry.pageIndexInSource]);
      outDoc.addPage(copied);
      copied.setRotation(degrees(totalRotation));

      if ((entry.objects && entry.objects.length) || entry.watermark || state.pageNumberConfig) {
        await ensureImagesLoaded(entry);
        const w = copied.getWidth(), h = copied.getHeight();
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * EXPORT_SCALE));
        c.height = Math.max(1, Math.round(h * EXPORT_SCALE));
        renderPageObjects(entry, c.getContext("2d"), EXPORT_SCALE, { withHandles: false });
        const dataUrl = c.toDataURL("image/png");
        const bytes = await dataUrlToBytes(dataUrl);
        const png = await outDoc.embedPng(bytes);
        copied.drawImage(png, { x: 0, y: 0, width: w, height: h });
      }
    }
    try {
      const backup = await buildEditableBackup(pageEntries);
      await outDoc.attach(new TextEncoder().encode(JSON.stringify(backup.manifest)), EDITABLE_DATA_NAME, {
        mimeType: "application/json",
        description: "43PDF 編輯器內部資料，用這個編輯器重新開啟時會用來還原成可編輯的物件；其他 PDF 軟體可以忽略，不影響正常開啟與列印。",
      });
      await outDoc.attach(backup.srcBytes, EDITABLE_SRC_NAME, {
        mimeType: "application/pdf",
        description: "43PDF 編輯器內部資料：未加註的原始頁面內容。",
      });
    } catch (err) {
      // 附加失敗不影響檔案本身能不能正常開啟，只是下次用這個編輯器重開時物件不能再編輯而已
      console.warn("附加可編輯備份資料失敗", err);
    }

    const bytes = await outDoc.save();
    downloadBytes(bytes, fileName);
    toast("匯出完成，已開始下載");
  } catch (err) {
    console.error(err);
    toast("匯出失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

/* ---------------- 下載後用這個編輯器重新打開，物件仍然可以編輯 ---------------- */
// 匯出時，除了一般看得到的內容（物件已經畫成圖蓋在頁面上，任何 PDF 軟體都看得到），
// 額外用 PDF 的「嵌入檔案」偷偷多存一份「原始未加註頁面」＋「物件資料（位置／顏色／文字…）」。
// 一般 PDF 閱讀器會忽略這兩個附件；只有這個編輯器自己重新開啟同一個檔案時，才會認出來，
// 用那份乾淨的原始內容＋物件資料重建編輯狀態，而不是用匯出時蓋上去、已經印死的那張圖。
const EDITABLE_DATA_NAME = "43pdf-editor-data.json";
const EDITABLE_SRC_NAME = "43pdf-editor-original.pdf";

async function buildEditableBackup(pageEntries) {
  const srcDoc = await PDFDocument.create();
  const pages = [];
  for (const entry of pageEntries) {
    if (isCropped(entry)) {
      // 裁切／延伸過的頁面本來就沒有乾淨的向量內容可以保留，只好另外畫一張「沒有疊物件」
      // 的乾淨版本當作這一頁的原始內容（跟匯出主流程的做法一樣，只是不疊 renderPageObjects）。
      const totalRotation = (((entry.baseRotation + entry.userDelta) % 360) + 360) % 360;
      const cw = entry.cropW, ch = entry.cropH;
      const scale = EXPORT_SCALE * CSS_SCALE;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(cw * EXPORT_SCALE));
      c.height = Math.max(1, Math.round(ch * EXPORT_SCALE));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      const viewport = entry.pdfjsPage.getViewport({
        scale, rotation: 0,
        offsetX: -entry.cropX * scale,
        offsetY: -entry.cropY * scale,
      });
      await entry.pdfjsPage.render({ canvasContext: ctx, viewport }).promise;
      const bytes = await dataUrlToBytes(c.toDataURL("image/png"));
      const png = await srcDoc.embedPng(bytes);
      srcDoc.addPage([cw, ch]).drawImage(png, { x: 0, y: 0, width: cw, height: ch });
      pages.push({
        objects: cleanObjects(entry.objects), watermark: entry.watermark,
        baseRotation: 0, userDelta: totalRotation,
        cropX: 0, cropY: 0, cropW: cw, cropH: ch,
      });
    } else {
      const libDoc = await getLibDoc(entry.sourceIndex);
      const [copied] = await srcDoc.copyPages(libDoc, [entry.pageIndexInSource]);
      srcDoc.addPage(copied);
      pages.push({
        objects: cleanObjects(entry.objects), watermark: entry.watermark,
        baseRotation: entry.baseRotation, userDelta: entry.userDelta,
        cropX: entry.cropX, cropY: entry.cropY, cropW: entry.cropW, cropH: entry.cropH,
      });
    }
  }
  const srcBytes = await srcDoc.save();
  const manifest = { app: "43pdf-editor", version: 1, pageNumberConfig: state.pageNumberConfig, pages };
  return { manifest, srcBytes };
}

// 檢查剛讀進來的 PDF 裡有沒有藏著我們自己的備份資料，有的話就用它重建可編輯的頁面，
// 回傳 true／false 表示有沒有成功還原（false 的話呼叫端要照一般方式把頁面加進去）。
async function tryRestoreEditableBackup(pdfjsDoc, fileName, isFirst) {
  let attachments;
  try {
    attachments = await pdfjsDoc.getAttachments();
  } catch (err) {
    return false;
  }
  if (!attachments) return false;
  const list = Object.values(attachments);
  const dataAtt = list.find((a) => a.filename === EDITABLE_DATA_NAME);
  const srcAtt = list.find((a) => a.filename === EDITABLE_SRC_NAME);
  if (!dataAtt || !srcAtt) return false;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(dataAtt.content));
    if (!manifest || manifest.app !== "43pdf-editor" || !Array.isArray(manifest.pages)) return false;
    const pristineDoc = await pdfjsLib.getDocument({ data: srcAtt.content.slice() }).promise;
    if (pristineDoc.numPages !== manifest.pages.length) return false; // 資料對不上，保守起見當作沒有備份

    const sourceIndex = state.sources.length;
    state.sources.push({ buffer: srcAtt.content.slice().buffer, pdfjsDoc: pristineDoc, libDoc: null, fileName });
    for (let i = 0; i < manifest.pages.length; i++) {
      const saved = manifest.pages[i];
      const pdfjsPage = await pristineDoc.getPage(i + 1);
      const entry = {
        sourceIndex, pageIndexInSource: i, pdfjsPage,
        baseRotation: saved.baseRotation || 0, userDelta: saved.userDelta || 0,
        objects: saved.objects || [], watermark: saved.watermark || null, history: [],
        cropX: saved.cropX, cropY: saved.cropY, cropW: saved.cropW, cropH: saved.cropH,
      };
      state.pages.push(entry);
      await buildPageDOM(entry);
      buildThumb(entry);
    }
    if (isFirst && manifest.pageNumberConfig) {
      state.pageNumberConfig = manifest.pageNumberConfig;
      state.pages.forEach((p) => redraw(p));
    }
    toast("偵測到先前用這個編輯器加過的物件，已還原成可以繼續編輯");
    return true;
  } catch (err) {
    console.warn("還原可編輯備份資料失敗，改用一般方式開啟", err);
    return false;
  }
}

function downloadBytes(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------------- 自動儲存／還原（避免 F5 / 關閉分頁時整個洗掉） ---------------- */
// 編輯內容會自動存進瀏覽器的 IndexedDB（只在本機，不會上傳）。
// 重新整理或不小心關掉分頁後，再次打開這個頁面時會詢問是否要還原。

const IDB_NAME = "pdfEditorDB";
const IDB_STORE = "session";
const IDB_KEY = "current";

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("此瀏覽器不支援 IndexedDB"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveSession, 900);
}

async function saveSession() {
  try {
    if (!state.pages.length) {
      await idbDelete(IDB_KEY);
      return;
    }
    const data = {
      zoom: state.zoom,
      pageNumberConfig: state.pageNumberConfig,
      sources: state.sources.map((s) => ({ fileName: s.fileName, buffer: s.buffer })),
      pages: state.pages.map((p) => ({
        sourceIndex: p.sourceIndex,
        pageIndexInSource: p.pageIndexInSource,
        baseRotation: p.baseRotation,
        userDelta: p.userDelta,
        objects: cleanObjects(p.objects),
        watermark: p.watermark,
        cropX: p.cropX, cropY: p.cropY, cropW: p.cropW, cropH: p.cropH,
      })),
      savedAt: Date.now(),
    };
    await idbSet(IDB_KEY, data);
  } catch (err) {
    console.warn("自動儲存失敗（不影響繼續編輯）", err);
  }
}

async function restoreSession(data) {
  showLoading("還原上次編輯中…");
  try {
    clearAll();
    state.zoom = data.zoom || 1.0;
    state.pageNumberConfig = data.pageNumberConfig || null;
    for (const s of data.sources) {
      const pdfjsDoc = await pdfjsLib.getDocument({ data: s.buffer.slice(0) }).promise;
      state.sources.push({ buffer: s.buffer, pdfjsDoc, libDoc: null, fileName: s.fileName });
    }
    for (const saved of data.pages) {
      const src = state.sources[saved.sourceIndex];
      const pdfjsPage = await src.pdfjsDoc.getPage(saved.pageIndexInSource + 1);
      const entry = {
        sourceIndex: saved.sourceIndex,
        pageIndexInSource: saved.pageIndexInSource,
        pdfjsPage,
        baseRotation: saved.baseRotation,
        userDelta: saved.userDelta,
        objects: saved.objects || [],
        watermark: saved.watermark || null,
        history: [],
        cropX: saved.cropX, cropY: saved.cropY, cropW: saved.cropW, cropH: saved.cropH,
      };
      state.pages.push(entry);
      await buildPageDOM(entry);
      buildThumb(entry);
    }
    updateZoomLabel();
    setControlsEnabled(true);
    toast("已還原上次編輯");
  } catch (err) {
    console.error(err);
    toast("還原失敗：" + err.message, true);
  } finally {
    hideLoading();
  }
}

// 「強制重新整理」按鈕自己觸發的離開不用跳瀏覽器原生的「確定要離開嗎」確認視窗——
// 已經在按下去的當下就先手動存檔了，這裡的提示是給「不小心」關掉分頁/視窗的情境用的。
let skipUnloadConfirm = false;
window.addEventListener("beforeunload", (e) => {
  if (skipUnloadConfirm || !state.pages.length) return;
  saveSession(); // 盡力即時存一次，不等 debounce
  e.preventDefault();
  e.returnValue = "";
});

(async function checkSavedSession() {
  try {
    const data = await idbGet(IDB_KEY);
    if (data && data.sources && data.sources.length) {
      const ok = await showConfirm("偵測到上次未存檔的編輯紀錄，要恢復嗎？");
      if (ok) await restoreSession(data);
      else await idbDelete(IDB_KEY);
    }
  } catch (err) {
    console.warn("讀取自動儲存紀錄失敗", err);
  }
})();

renderToolOptions();

/* ====== 暗黑模式／一般模式（白底）切換 ====== */
// 套用主題時機分兩段：<head>裡的inline script在CSS解析前就先依localStorage設好
// data-theme屬性（避免切換瞬間畫面先閃一下舊主題再變成新主題），這裡只負責切換鈕
// 文字同步、以及使用者按下按鈕時的即時切換+記住選擇。
const THEME_KEY = "pdf_editor_theme";
function getTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
}
function applyTheme(theme) {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  const btn = $("#btnThemeToggle");
  if (btn) btn.textContent = theme === "light" ? "🌙 暗黑模式" : "☀️ 一般模式";
}
applyTheme(getTheme());
$("#btnThemeToggle").addEventListener("click", () => {
  const next = getTheme() === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
});

/* ====== 強制重新整理（清除快取）======
   畫面更新完看起來還是舊的、或是已安裝的 PWA 視窗卡在舊版 Service Worker 快取時用：
   先盡力存一次目前編輯中的內容（可以在重整後的「要恢復上次編輯嗎」選擇要不要救回來），
   再把 Service Worker 註冊與 Cache Storage 整個清掉，最後帶一個不會重複的網址參數重新
   整理，確保瀏覽器不會用 HTTP 快取擋下重新抓取，一定會跟伺服器要最新的 index.html／
   app.js／style.css。 */
async function forceHardRefresh() {
  try { saveSession(); } catch (e) {}
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {}
  skipUnloadConfirm = true;
  location.href = location.pathname + "?_r=" + Date.now();
}
$("#btnHardRefresh").addEventListener("click", forceHardRefresh);

/* ====== 手機版：頁面縮圖側邊欄改成滑出式抽屜 ======
   手機螢幕太窄，側邊欄平常收起來，按工具列的「📑 頁面」按鈕才滑出，
   點背景遮罩或關閉鈕收回去；桌面版因為CSS media query沒套用.open相關樣式，
   這些class切換不會影響桌面版外觀。 */
function setSidebarOpen(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#sidebarBackdrop").hidden = !open;
  if (open) setMoreMenuOpen(false);
}
$("#btnToggleSidebar").addEventListener("click", () => setSidebarOpen(true));
$("#btnCloseSidebar").addEventListener("click", () => setSidebarOpen(false));
$("#sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));

/* ====== 縮圖區寬度調整（拖曳分隔線／一鍵展開）與縮圖大小縮放（滑桿／按鈕／Ctrl+滾輪）======
   把縮圖區拉寬＋縮圖調小，就可以一次在多欄格狀清單裡看到很多頁，直接用拖曳快速調整順序；
   把縮圖調大時若縮圖區太窄，會順便幫你把縮圖區撐寬一點讓縮圖真的變大、不用手動拉兩次。 */
const SIDEBAR_WIDTH_KEY = "pdf_editor_sidebar_width";
const THUMB_SIZE_KEY = "pdf_editor_thumb_size";
const DEFAULT_SIDEBAR_WIDTH = 190;
const MIN_SIDEBAR_WIDTH = 140;
const DEFAULT_THUMB_SIZE = 150;
const MIN_THUMB_SIZE = 72;
const MAX_THUMB_SIZE = 360;

const sidebarEl = $("#sidebar");
const sidebarResizerEl = $("#sidebarResizer");
const btnExpandSidebar = $("#btnExpandSidebar");
const thumbSizeRange = $("#thumbSizeRange");
const btnThumbZoomOut = $("#btnThumbZoomOut");
const btnThumbZoomIn = $("#btnThumbZoomIn");

function maxSidebarWidth() {
  return Math.max(220, window.innerWidth - 180);
}
function loadStoredNumber(key, fallback) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

let sidebarWidth = loadStoredNumber(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH);
let thumbSize = loadStoredNumber(THUMB_SIZE_KEY, DEFAULT_THUMB_SIZE);
let savedNarrowSidebarWidth = DEFAULT_SIDEBAR_WIDTH;

function isSidebarExpanded() {
  return sidebarWidth >= Math.min(maxSidebarWidth() - 20, Math.max(420, window.innerWidth * 0.55));
}
function updateExpandSidebarBtn() {
  if (!btnExpandSidebar) return;
  const expanded = isSidebarExpanded();
  btnExpandSidebar.textContent = expanded ? "⤡" : "⤢";
  btnExpandSidebar.title = expanded ? "還原縮圖區寬度" : "展開縮圖區以便多欄拖曳排序";
}
function applySidebarWidth(width, opts) {
  const clamped = Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth(), width)));
  sidebarWidth = clamped;
  sidebarEl.style.setProperty("--sidebar-width", clamped + "px");
  updateExpandSidebarBtn();
  if (!opts || opts.save !== false) {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped)); } catch (e) {}
  }
}
function applyThumbSize(size, opts) {
  const clamped = Math.round(Math.max(MIN_THUMB_SIZE, Math.min(MAX_THUMB_SIZE, size)));
  thumbSize = clamped;
  thumbList.style.setProperty("--thumb-size", clamped + "px");
  thumbList.classList.toggle("compact-thumbs", clamped < 110);
  if (thumbSizeRange) thumbSizeRange.value = String(clamped);
  if (btnThumbZoomOut) btnThumbZoomOut.disabled = clamped <= MIN_THUMB_SIZE;
  if (btnThumbZoomIn) btnThumbZoomIn.disabled = clamped >= MAX_THUMB_SIZE;
  // 桌面版放大縮圖時，如果目前縮圖區比單張縮圖還窄，主動把縮圖區撐寬到裝得下，畫面才會立刻看到變大
  if (opts && opts.autoExpand && window.innerWidth > 760) {
    const needed = clamped + 40;
    if (sidebarWidth < needed) applySidebarWidth(needed);
  }
  if (!opts || opts.save !== false) {
    try { localStorage.setItem(THUMB_SIZE_KEY, String(clamped)); } catch (e) {}
  }
}

applySidebarWidth(sidebarWidth, { save: false });
applyThumbSize(thumbSize, { save: false });

if (sidebarResizerEl) {
  let resizing = false;
  sidebarResizerEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || window.innerWidth <= 760) return;
    e.preventDefault();
    resizing = true;
    sidebarResizerEl.classList.add("dragging");
    document.body.classList.add("resizing-sidebar");
    try { sidebarResizerEl.setPointerCapture(e.pointerId); } catch (err) {}
  });
  sidebarResizerEl.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const left = sidebarEl.getBoundingClientRect().left;
    applySidebarWidth(e.clientX - left, { save: false });
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = false;
    sidebarResizerEl.classList.remove("dragging");
    document.body.classList.remove("resizing-sidebar");
    try { sidebarResizerEl.releasePointerCapture(e.pointerId); } catch (err) {}
    applySidebarWidth(sidebarWidth, { save: true });
  };
  sidebarResizerEl.addEventListener("pointerup", endResize);
  sidebarResizerEl.addEventListener("pointercancel", endResize);
  sidebarResizerEl.addEventListener("dblclick", () => {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  });
}

if (btnExpandSidebar) {
  btnExpandSidebar.addEventListener("click", () => {
    if (isSidebarExpanded()) {
      applySidebarWidth(savedNarrowSidebarWidth || DEFAULT_SIDEBAR_WIDTH);
    } else {
      savedNarrowSidebarWidth = sidebarWidth;
      applySidebarWidth(Math.round(window.innerWidth * 0.72));
    }
  });
}

if (thumbSizeRange) {
  thumbSizeRange.addEventListener("input", () => {
    const next = Number(thumbSizeRange.value);
    applyThumbSize(next, { autoExpand: next > thumbSize });
  });
}
if (btnThumbZoomOut) {
  btnThumbZoomOut.addEventListener("click", () => applyThumbSize(thumbSize - 24));
}
if (btnThumbZoomIn) {
  btnThumbZoomIn.addEventListener("click", () => applyThumbSize(thumbSize + 24, { autoExpand: true }));
}
sidebarEl.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 16 : -16;
    applyThumbSize(thumbSize + delta, { autoExpand: delta > 0 });
  },
  { passive: false }
);
window.addEventListener("resize", () => {
  if (window.innerWidth > 760) applySidebarWidth(sidebarWidth, { save: false });
});

/* ====== 手機版：「更多功能」面板（次要的檔案操作／檢視模式／翻頁／偏好設定）======
   從右邊滑出，跟左邊滑出的頁面縮圖抽屜對稱；兩個抽屜互斥，開一個會自動關掉另一個，
   避免畫面上同時疊兩層背景遮罩。桌面版因為 #moreMenuPanel 是 display:contents，
   這些 class 切換不會影響桌面版外觀（面板本身在桌面版的版面裡「不存在」）。 */
function setMoreMenuOpen(open) {
  $("#moreMenuPanel").classList.toggle("open", open);
  $("#moreMenuBackdrop").hidden = !open;
  if (open) setSidebarOpen(false);
}
$("#btnMoreMenu").addEventListener("click", () => setMoreMenuOpen(true));
$("#btnCloseMoreMenu").addEventListener("click", () => setMoreMenuOpen(false));
$("#moreMenuBackdrop").addEventListener("click", () => setMoreMenuOpen(false));
// 這幾個是一次性動作（開啟彈窗或立刻切換），點了之後就把面板收起來，不用使用者自己關；
// 檢視模式／翻頁按鈕刻意不收起來，不然連續翻頁還要一直重新打開面板
["#btnAppend", "#btnBlankPage", "#btnToolLibrary", "#btnThemeToggle", "#btnHardRefresh"].forEach((sel) => {
  $(sel).addEventListener("click", () => setMoreMenuOpen(false));
});

/* ====== 工具庫：把用不到的工具從工具列隱藏起來 ====== */
// 「瀏覽」工具不列在這裡——它是基本的瀏覽／選取操作，藏起來會讓人卡住沒辦法選物件，
// 所以固定顯示，不開放隱藏。
const TOOL_LIBRARY_DEFS = [
  { tool: "text", label: "🔤 新增文字" },
  { tool: "highlight", label: "🖍 螢光筆" },
  { tool: "pen", label: "✍️ 畫筆" },
  { tool: "shape", label: "⬛ 圖形" },
  { tool: "stamp", label: "🖼 蓋章" },
  { tool: "edittext", label: "✏️ 編輯文字" },
  { tool: "watermark", label: "💧 浮水印" },
  { tool: "crop", label: "✂ 裁切頁面" },
  { tool: "pagenum", label: "🔢 頁碼" },
];
const HIDDEN_TOOLS_KEY = "pdf_editor_hidden_tools";
function loadHiddenTools() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_TOOLS_KEY) || "[]")); } catch (e) { return new Set(); }
}
function saveHiddenTools(set) {
  try { localStorage.setItem(HIDDEN_TOOLS_KEY, JSON.stringify([...set])); } catch (e) {}
}
let hiddenTools = loadHiddenTools();

function applyToolVisibility() {
  TOOL_LIBRARY_DEFS.forEach(({ tool }) => {
    const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
    if (btn) btn.hidden = hiddenTools.has(tool);
  });
  // 如果正在用的工具被藏起來了，切回瀏覽工具，避免卡在一個按鈕點不到的工具上
  if (hiddenTools.has(state.tool)) setTool("pan");
}

function renderToolLibraryList() {
  const wrap = $("#toolLibraryList");
  wrap.innerHTML = TOOL_LIBRARY_DEFS.map(({ tool, label }) => `
    <label class="checkbox">
      <input type="checkbox" data-tool-lib="${tool}" ${hiddenTools.has(tool) ? "" : "checked"}>
      ${label}
    </label>`).join("");
  wrap.querySelectorAll("input[data-tool-lib]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const tool = cb.dataset.toolLib;
      if (cb.checked) hiddenTools.delete(tool);
      else hiddenTools.add(tool);
      saveHiddenTools(hiddenTools);
      applyToolVisibility();
    });
  });
}

applyToolVisibility();
$("#btnToolLibrary").addEventListener("click", () => {
  renderToolLibraryList();
  $("#toolLibraryModal").hidden = false;
});
$("#tlClose").addEventListener("click", () => { $("#toolLibraryModal").hidden = true; });
$("#tlSelectAll").addEventListener("click", () => {
  hiddenTools.clear();
  saveHiddenTools(hiddenTools);
  applyToolVisibility();
  renderToolLibraryList();
});
