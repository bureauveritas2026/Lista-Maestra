/**
 * Lista Maestra — app.js
 * Firebase Firestore (online, gratuito, sin configuración por el usuario)
 * Import: Excel / JSON  |  Export: Excel / JSON  |  Files: Base64 en Firestore
 */

/* ============================================================
   1. FIREBASE CONFIG (proyecto dedicado bureauveritas2026)
   ============================================================ */
const firebaseConfig = {
  apiKey:            "AIzaSyDw-BJLLgqNGWuDwc5m-tSuAz8o-k6G1Ak",
  authDomain:        "lista-maestra-bv-2026.firebaseapp.com",
  projectId:         "lista-maestra-bv-2026",
  storageBucket:     "lista-maestra-bv-2026.firebasestorage.app",
  messagingSenderId: "1003549153501",
  appId:             "1:1003549153501:web:99a37d89630f2911ae6334"
};

firebase.initializeApp(firebaseConfig);
const fsdb = firebase.firestore();
const COLLECTION = "documentos";

/* ============================================================
   GOOGLE APPS SCRIPT — para subir archivos a Drive sin login
   ============================================================ */
// IMPORTANTE: Aquí debes pegar la URL Web App generada por Google Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyMiHlhZYpZQrb31-qtmqCwVfklnItH4oOxpOO21bC2j8MFPH7Nw-hH5oAJG8WuKPqSyQ/exec";

function fileToBase64String(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // remove data:mime/type;base64,
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadToAppsScript(file, onProgress) {
  if (APPS_SCRIPT_URL === "PEGAR_AQUI_LA_URL_DEL_SCRIPT") {
    throw new Error("Falta configurar la URL del Google Apps Script en el código.");
  }
  
  if (onProgress) onProgress(10); // Fake initial progress

  const base64Data = await fileToBase64String(file);
  
  if (onProgress) onProgress(40); // Fake processing progress

  const payload = JSON.stringify({
    base64: base64Data,
    filename: file.name,
    mimeType: file.type || "application/octet-stream"
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", APPS_SCRIPT_URL);
    // Use text/plain to avoid CORS preflight OPTIONS request from the browser
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
    
    xhr.upload.onprogress = e => { 
      // XHR upload progress works for sending the payload to the Apps Script server
      if (e.lengthComputable && onProgress) {
        // Map upload payload progress to 40% -> 90%
        const pct = 40 + Math.round((e.loaded / e.total) * 50);
        onProgress(pct); 
      }
    };
    
    xhr.onload = () => {
      try {
        if (onProgress) onProgress(100);
        const res = JSON.parse(xhr.responseText);
        if (res.status === 'success') {
          resolve({
            id: res.id,
            name: res.name,
            webViewLink: res.url
          });
        } else {
          reject(new Error(res.message || "Error en Apps Script"));
        }
      } catch (err) {
        reject(new Error("Error parseando respuesta de Apps Script"));
      }
    };
    xhr.onerror = () => reject(new Error("Error de red al subir a Apps Script. Verifica que el script esté configurado como 'Cualquier persona'."));
    xhr.send(payload);
  });
}

/* ============================================================
   2. LOCAL FALLBACK (IndexedDB via raw API — no Dexie needed)
   ============================================================ */
let localDB;
function openLocalDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("ListaMaestraLocal", 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("docs"))
        db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess  = e => { localDB = e.target.result; res(); };
    req.onerror    = e => rej(e);
  });
}

function localPut(store, obj) {
  return new Promise((res, rej) => {
    const tx = localDB.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = res;
    tx.onerror    = rej;
  });
}

function localGetAll(store) {
  return new Promise((res, rej) => {
    const tx = localDB.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = rej;
  });
}

function localDelete(store, id) {
  return new Promise((res, rej) => {
    const tx = localDB.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = res;
    tx.onerror    = rej;
  });
}

/* ============================================================
   3. STATE
   ============================================================ */
let allDocs      = [];   // documents in memory
let editId       = null; // null = new, string = editing
let importBuffer = [];   // rows pending confirmation
let theme        = localStorage.getItem("lm_theme") || "light";

/* ============================================================
   4. DOM REFS
   ============================================================ */
const $ = id => document.getElementById(id);

const form        = $("docForm");
const tableBody   = $("tableBody");
const searchInput = $("searchInput");
const areaFilter  = $("areaFilter");
const tipoFilter  = $("tipoFilter");
const dropzone    = $("dropzone");
const fileInput   = $("fileInput");
const fileLabel   = $("fileLabel");
const submitBtn   = $("submitBtn");
const formTitle   = $("formTitle");
const statusDot   = $("statusDot");
const statusText  = $("statusText");

/* ============================================================
   5. INIT
   ============================================================ */
(async () => {
  await openLocalDB();
  applyTheme(theme);
  bindUI();
  await initFirestore();
})();

/* ============================================================
   6. FIRESTORE INIT & REALTIME LISTENER
   ============================================================ */
async function initFirestore() {
  setStatus("connecting");

  try {
    fsdb.collection(COLLECTION)
      .orderBy("createdAt", "desc")
      .onSnapshot(
        snap => {
          allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          renderTable();
          updateStats();
          setStatus("online");
        },
        err => {
          console.warn("Firestore snapshot error:", err);
          setStatus("offline");
          loadFromLocal();
        }
      );
  } catch (e) {
    console.error("Firestore init error:", e);
    setStatus("offline");
    loadFromLocal();
  }
}

async function loadFromLocal() {
  allDocs = await localGetAll("docs");
  renderTable();
  updateStats();
}

function setStatus(state) {
  const configs = {
    connecting: { cls: "",        text: "Conectando..." },
    online:     { cls: "online",  text: "Cloud Online" },
    offline:    { cls: "offline", text: "Sin conexión" },
    saving:     { cls: "",        text: "Guardando..." },
  };
  const cfg = configs[state] || configs.connecting;
  statusDot.className = "dot " + cfg.cls;
  statusText.textContent = cfg.text;
}

/* ============================================================
   7. CRUD
   ============================================================ */
form.onsubmit = async e => {
  e.preventDefault();
  setStatus("saving");

  // Gather form data
  const data = {
    area:    $("area").value,
    titulo:  $("titulo").value.trim(),
    version: $("version").value.trim(),
    codigo:  $("codigo").value.trim(),
    tipo:    $("tipo").value,
    fecha:   $("fecha").value,
    updatedAt: Date.now(),
  };

  // Handle file attachment (Base64 for cloud storage)
  const file = fileInput.files[0];
  if (file) {
    if (file.size > 3 * 1024 * 1024) {
      toast("El archivo supera 3 MB. Usa un archivo más pequeño.", "warning");
      setStatus("online");
      return;
    }
    data.fileName = file.name;
    data.fileType = file.type;
    data.fileData = await fileToBase64(file);
  } else if (editId) {
    // Keep existing file if no new one selected
    const existing = allDocs.find(d => d.id === editId);
    if (existing?.fileData) {
      data.fileName = existing.fileName;
      data.fileType = existing.fileType;
      data.fileData = existing.fileData;
    }
  }

  try {
    if (editId) {
      await fsdb.collection(COLLECTION).doc(editId).update(data);
      toast("Documento actualizado ✓", "success");
    } else {
      data.createdAt = Date.now();
      await fsdb.collection(COLLECTION).add(data);
      toast("Documento guardado ✓", "success");
    }
    resetForm();
  } catch (err) {
    console.error(err);
    toast("Error al guardar: " + err.message, "error");
    // Save locally as fallback
    const localDoc = { ...data, id: editId || ("local_" + Date.now()) };
    await localPut("docs", localDoc);
    toast("Guardado localmente como respaldo", "info");
  } finally {
    setStatus("online");
  }
};

async function deleteDoc(id) {
  if (!confirm("¿Eliminar este registro?")) return;
  try {
    await fsdb.collection(COLLECTION).doc(id).delete();
    await localDelete("docs", id);
    toast("Documento eliminado", "info");
  } catch (e) {
    toast("Error al eliminar: " + e.message, "error");
  }
}

async function editDoc(id) {
  const doc = allDocs.find(d => d.id === id);
  if (!doc) return;

  editId = id;
  $("area").value    = doc.area;
  $("titulo").value  = doc.titulo;
  $("version").value = doc.version;
  $("codigo").value  = doc.codigo;
  $("tipo").value    = doc.tipo;
  $("fecha").value   = doc.fecha;

  formTitle.textContent = "Editando Documento";
  submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Guardar Cambios`;
  fileLabel.innerHTML = doc.fileName
    ? `<strong>Archivo actual:</strong> ${doc.fileName} (elige otro para reemplazar)`
    : `<strong>Clic o arrastra</strong> para adjuntar archivo`;

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function downloadFile(id) {
  const doc = allDocs.find(d => d.id === id);
  if (!doc?.fileData) return;

  const a       = document.createElement("a");
  a.href        = doc.fileData;       // already a data-URL
  a.download    = doc.fileName || "documento";
  a.click();
}

function resetForm() {
  form.reset();
  editId = null;
  formTitle.textContent = "Nuevo Documento";
  submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Agregar Documento`;
  fileLabel.innerHTML = `<strong>Clic o arrastra</strong> para adjuntar archivo`;
}

/* ============================================================
   8. RENDER TABLE
   ============================================================ */
function getFilteredDocs() {
  const q    = searchInput.value.toLowerCase();
  const area = areaFilter.value;
  const tipo = tipoFilter.value;

  return allDocs.filter(d => {
    const matchQ    = !q    || d.titulo.toLowerCase().includes(q) || d.codigo.toLowerCase().includes(q) || d.area.toLowerCase().includes(q);
    const matchArea = !area || d.area === area;
    const matchTipo = !tipo || d.tipo === tipo;
    return matchQ && matchArea && matchTipo;
  });
}

function renderTable() {
  const docs = getFilteredDocs();

  if (docs.length === 0) {
    tableBody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <h3>Sin documentos</h3>
          <p>Agrega el primer registro usando el formulario</p>
        </div>
      </td></tr>`;
    return;
  }

  const areaBadge = {
    GG:"badge-blue", GI:"badge-blue",
    HK:"badge-green", FO:"badge-green", AB:"badge-green",
    CO:"badge-amber", GR:"badge-amber", MT:"badge-amber",
    MD:"badge-violet", TH:"badge-violet", TI:"badge-violet",
  };

  const tipoBadge = {
    FORMATO:"badge-blue", MANUAL:"badge-green",
    PROCEDIMIENTO:"badge-amber", "GUÍA":"badge-violet",
    "POLÍTICA":"badge-red", INSTRUCTIVO:"badge-amber",
  };

  tableBody.innerHTML = docs.map((doc, i) => `
    <tr class="fade-in">
      <td style="color:var(--text-muted);font-weight:600">${i + 1}</td>
      <td><span class="badge ${areaBadge[doc.area] || 'badge-blue'}">${doc.area}</span></td>
      <td style="max-width:260px">
        <div
          class="doc-title-cell"
          style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:context-menu"
          title="${doc.titulo}"
          oncontextmenu="showCtxMenu(event,'${doc.titulo.replace(/'/g,"\\'")}')"
        >${doc.titulo}</div>
      </td>
      <td><span class="badge badge-amber">v${doc.version}</span></td>
      <td><code>${doc.codigo}</code></td>
      <td><span class="badge ${tipoBadge[doc.tipo] || 'badge-blue'}">${doc.tipo}</span></td>
      <td style="white-space:nowrap">${formatDate(doc.fecha)}</td>
      <td>
        ${doc.fileData
          ? `<span class="file-chip" onclick="downloadFile('${doc.id}')" title="Descargar ${doc.fileName}">
               <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
               ${doc.fileName || "archivo"}
             </span>`
          : `<span style="color:var(--text-light);font-size:.78rem">—</span>`}
      </td>
      <td>
        <div class="row-actions">
          <button class="btn btn-ghost btn-icon" onclick="editDoc('${doc.id}')" title="Editar">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" onclick="deleteDoc('${doc.id}')" title="Eliminar" style="color:var(--c-red)">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function updateStats() {
  $("statTotal").textContent     = allDocs.length;
  $("statAreas").textContent     = new Set(allDocs.map(d => d.area)).size;
  $("statFiles").textContent     = allDocs.filter(d => d.fileData).length;
  $("statVersiones").textContent = new Set(allDocs.map(d => d.version)).size;
}

/* ============================================================
   9. IMPORT — Excel & JSON
   ============================================================ */
async function handleImportFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "json") {
    await importJSON(file);
  } else if (["xlsx", "xls"].includes(ext)) {
    await importExcel(file);
  } else {
    toast("Formato no soportado. Usa .xlsx o .json", "error");
  }
}

async function importExcel(file) {
  const buffer = await file.arrayBuffer();
  const wb     = XLSX.read(buffer, { type: "array" });
  const ws     = wb.Sheets[wb.SheetNames[0]];
  const rows   = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // Flexible column mapping (same as export)
  importBuffer = rows.map(r => ({
    area:    r["Área"]   || r["area"]   || r["AREA"]   || "",
    titulo:  r["Título"] || r["titulo"] || r["TITULO"] || r["Nombre del Documento"] || "",
    version: String(r["Versión"] || r["version"] || r["VERSION"] || "00"),
    codigo:  r["Código"] || r["codigo"] || r["CODIGO"] || "",
    tipo:    r["Tipo"]   || r["tipo"]   || r["TIPO"]   || "FORMATO",
    fecha:   r["Fecha"]  || r["fecha"]  || r["FECHA"]  || new Date().toISOString().split("T")[0],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })).filter(r => r.titulo);

  showImportPreview(importBuffer.length, "Excel");
}

async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  importBuffer = (Array.isArray(data) ? data : [data]).map(r => ({
    area:      r.area     || "",
    titulo:    r.titulo   || "",
    version:   String(r.version || "00"),
    codigo:    r.codigo   || "",
    tipo:      r.tipo     || "FORMATO",
    fecha:     r.fecha    || new Date().toISOString().split("T")[0],
    fileName:  r.fileName || "",
    fileData:  r.fileData || "",
    fileType:  r.fileType || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })).filter(r => r.titulo);

  showImportPreview(importBuffer.length, "JSON");
}

function showImportPreview(count, format) {
  $("importPreviewText").innerHTML = `Se detectaron <strong>${count} registros</strong> válidos del archivo ${format}. ¿Confirmar importación?`;
  $("importPreview").style.display = "block";
}

async function confirmImport() {
  if (!importBuffer.length) return;

  const btn = $("confirmImportBtn");
  btn.textContent = "Importando...";
  btn.disabled    = true;

  let ok = 0;
  for (const doc of importBuffer) {
    try {
      await fsdb.collection(COLLECTION).add(doc);
      ok++;
    } catch (e) {
      console.warn("Import error for doc:", doc, e);
    }
  }

  importBuffer = [];
  $("importPreview").style.display = "none";
  btn.textContent = "Confirmar Importación";
  btn.disabled    = false;
  toast(`${ok} documentos importados correctamente ✓`, "success");
  closeIoModal();
}

/* ============================================================
   10. EXPORT — Excel & JSON
   ============================================================ */
function exportExcel() {
  const docs = allDocs;
  if (!docs.length) { toast("No hay datos para exportar", "warning"); return; }

  const rows = docs.map(d => ({
    "Área":                d.area,
    "Título":              d.titulo,
    "Versión":             d.version,
    "Código":              d.codigo,
    "Tipo":                d.tipo,
    "Fecha":               d.fecha,
    "Nombre del Documento": d.fileName || "Sin archivo",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws["!cols"] = [
    { wch: 8 }, { wch: 40 }, { wch: 9 }, { wch: 18 },
    { wch: 14 }, { wch: 12 }, { wch: 24 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lista Maestra");
  XLSX.writeFile(wb, `Lista_Maestra_${new Date().toISOString().split("T")[0]}.xlsx`);
  toast("Excel exportado ✓", "success");
}

function exportJSON() {
  const docs = allDocs;
  if (!docs.length) { toast("No hay datos para exportar", "warning"); return; }

  const blob = new Blob([JSON.stringify(docs, null, 2)], { type: "application/json" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `Lista_Maestra_Backup_${Date.now()}.json`;
  a.click();
  toast("Backup JSON exportado ✓", "success");
}

/* ============================================================
   CONTEXT MENU — Nombre completo del documento
   ============================================================ */
function showCtxMenu(e, fullName) {
  e.preventDefault();
  const menu = document.getElementById("ctxMenu");
  document.getElementById("ctxMenuText").textContent = fullName;
  menu.style.display = "block";

  // Position safely within viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 360, mh = 100;
  menu.style.left = Math.min(e.clientX + 8, vw - mw - 12) + "px";
  menu.style.top  = Math.min(e.clientY + 8, vh - mh - 12) + "px";

  const hide = () => { menu.style.display = "none"; document.removeEventListener("click", hide); };
  setTimeout(() => document.addEventListener("click", hide), 50);
}

/* ============================================================
   TAB NAVIGATION
   ============================================================ */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("panelLista").style.display       = tab === "lista"       ? "" : "none";
    document.getElementById("panelRepositorio").style.display = tab === "repositorio" ? "" : "none";
  });
});

/* ============================================================
   REPOSITORIO DRIVE — Firestore CRUD
   ============================================================ */
const REPO_COLLECTION = "repositorio";
const DRIVE_FOLDER_ID = "1PWUPMumEFRop6R6cj7Y0PFBHhvqFfpbu";
const DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}?usp=sharing`;
// Google Drive API key (same GCP project as Firebase — Drive API must be enabled)
const DRIVE_API_KEY = "AIzaSyDw-BJLLgqNGWuDwc5m-tSuAz8o-k6G1Ak";

let   repoAllDocs = [];
let   repoEditId  = null;
const typeBadge   = { PDF:"badge-red", Word:"badge-blue", Excel:"badge-green", ZIP:"badge-amber", Imagen:"badge-violet", Otro:"badge-blue" };

// Real-time listener
fsdb.collection(REPO_COLLECTION).orderBy("createdAt", "desc").onSnapshot(snap => {
  repoAllDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderRepoTable();
}, err => console.warn("Repo snapshot error:", err));

// Form submit — upload file to Drive then save metadata to Firestore
document.getElementById("repoForm").onsubmit = async e => {
  e.preventDefault();

  const file = document.getElementById("repoFileInput").files[0];

  // Require a file for new entries; editing is allowed without re-upload
  if (!file && !repoEditId) {
    toast("Selecciona un archivo para subir a Drive", "warning");
    return;
  }

  const btn = document.getElementById("repoSubmitBtn");
  btn.disabled = true;
  btn.textContent = file ? "Subiendo..." : "Guardando...";

  let driveLink   = DRIVE_FOLDER_URL;
  let driveFileId = repoEditId ? (repoAllDocs.find(d => d.id === repoEditId)?.driveFileId || "") : "";
  let nombre      = document.getElementById("repoNombre").value.trim() || (file ? file.name : "");

  try {
    if (file) {
      // Show progress bar
      const progress    = document.getElementById("repoUploadProgress");
      const progressBar = document.getElementById("repoProgressBar");
      const progressPct = document.getElementById("repoProgressPct");
      progress.style.display = "block";

      const driveFile = await uploadToAppsScript(file, pct => {
        progressBar.style.width = pct + "%";
        progressPct.textContent  = pct + "%";
      });

      progress.style.display = "none";
      driveLink   = driveFile.webViewLink || DRIVE_FOLDER_URL;
      driveFileId = driveFile.id;
      nombre      = nombre || driveFile.name;


      // Auto-detect tipo from mime
      const mimeToTipo = {
        "application/pdf": "PDF",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
        "application/msword": "Word",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
        "application/vnd.ms-excel": "Excel",
        "application/zip": "ZIP",
        "application/x-zip-compressed": "ZIP",
        "image/jpeg": "Imagen", "image/png": "Imagen", "image/gif": "Imagen", "image/webp": "Imagen",
      };
      const autoTipo = mimeToTipo[driveFile.mimeType];
      if (autoTipo) document.getElementById("repoTipo").value = autoTipo;
    }

    const data = {
      identificador: document.getElementById("repoIdentificador").value.trim(),
      area:          document.getElementById("repoArea").value,
      nombre,
      tipo:          document.getElementById("repoTipo").value,
      fecha:         document.getElementById("repoFecha").value,
      descripcion:   document.getElementById("repoDescripcion").value.trim(),
      driveLink,
      driveFileId,
      updatedAt:     Date.now(),
    };

    if (repoEditId) {
      await fsdb.collection(REPO_COLLECTION).doc(repoEditId).update(data);
      toast("Registro actualizado ✓", "success");
    } else {
      data.createdAt = Date.now();
      await fsdb.collection(REPO_COLLECTION).add(data);
      toast(file ? `"${nombre}" guardado en Drive ✓` : "Registro guardado ✓", "success");
    }

    repoResetForm();
  } catch (err) {
    console.error(err);
    toast("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Guardar en Drive`;
  }
};

function repoResetForm() {
  document.getElementById("repoForm").reset();
  document.getElementById("repoFileInput").value = "";
  document.getElementById("repoFileLabel").innerHTML = "<strong>Clic o arrastra</strong> cualquier archivo (PDF, Word, ZIP...)";
  repoEditId = null;
  document.getElementById("repoFormTitle").textContent = "Registrar Archivo";
  document.getElementById("repoSubmitBtn").innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Guardar en Drive`;
}

async function repoEditDoc(id) {
  const doc = repoAllDocs.find(d => d.id === id);
  if (!doc) return;
  repoEditId = id;
  document.getElementById("repoIdentificador").value  = doc.identificador || "";
  document.getElementById("repoArea").value           = doc.area          || "";
  document.getElementById("repoNombre").value         = doc.nombre        || "";
  document.getElementById("repoTipo").value           = doc.tipo          || "PDF";
  document.getElementById("repoFecha").value          = doc.fecha         || "";
  document.getElementById("repoDescripcion").value    = doc.descripcion   || "";
  document.getElementById("repoFileLabel").innerHTML  = doc.nombre
    ? `<strong>Archivo actual:</strong> ${doc.nombre} <span style='color:var(--text-muted)'>(elige otro para reemplazar)</span>`
    : "<strong>Clic o arrastra</strong> cualquier archivo";
  document.getElementById("repoFormTitle").textContent = "Editando Archivo";
  document.getElementById("repoSubmitBtn").innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Guardar Cambios`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function repoDeleteDoc(id) {
  if (!confirm("\u00bfEliminar este registro del repositorio?")) return;
  try {
    await fsdb.collection(REPO_COLLECTION).doc(id).delete();
    toast("Eliminado del repositorio", "info");
  } catch (e) { toast("Error: " + e.message, "error"); }
}

document.getElementById("repoResetBtn").onclick = repoResetForm;

function getFilteredRepoDocs() {
  const q    = (document.getElementById("repoSearch")?.value || "").toLowerCase();
  const area = document.getElementById("repoAreaFilter")?.value || "";
  const tipo = document.getElementById("repoTipoFilter")?.value || "";
  return repoAllDocs.filter(d => {
    const matchQ    = !q    || (d.identificador||"em").toLowerCase().includes(q) || (d.nombre||"").toLowerCase().includes(q) || (d.area||"").toLowerCase().includes(q);
    const matchArea = !area || d.area === area;
    const matchTipo = !tipo || d.tipo === tipo;
    return matchQ && matchArea && matchTipo;
  });
}

function renderRepoTable() {
  const tbody = document.getElementById("repoTableBody");
  if (!tbody) return;
  const docs = getFilteredRepoDocs();

  if (!docs.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12"/></svg><h3>Sin archivos registrados</h3><p>Usa el formulario para agregar archivos de Drive</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = docs.map((doc, i) => `
    <tr class="fade-in">
      <td style="color:var(--text-muted);font-weight:600">${i + 1}</td>
      <td><span class="badge badge-violet" style="font-size:.78rem">${doc.identificador || "—"}</span></td>
      <td><span class="badge ${areaBadgeMap[doc.area] || 'badge-blue'}">${doc.area}</span></td>
      <td style="max-width:200px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${doc.nombre}" oncontextmenu="showCtxMenu(event,'${(doc.nombre||'').replace(/'/g,"\\'")}')">${doc.nombre}</td>
      <td><span class="badge ${typeBadge[doc.tipo] || 'badge-blue'}">${doc.tipo}</span></td>
      <td style="white-space:nowrap">${formatDate(doc.fecha)}</td>
      <td style="max-width:180px;font-size:.82rem;color:var(--text-muted)">${doc.descripcion || "—"}</td>
      <td>
        <a href="${DRIVE_FOLDER_URL}" target="_blank" class="btn btn-secondary btn-icon" title="Abrir carpeta en Drive">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </td>
      <td>
        <div class="row-actions">
          <button class="btn btn-ghost btn-icon" onclick="repoEditDoc('${doc.id}')" title="Editar">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" onclick="repoDeleteDoc('${doc.id}')" title="Eliminar" style="color:var(--c-red)">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

// Shared area badge map (expose for repositorio render)
const areaBadgeMap = {
  GG:"badge-blue", GI:"badge-blue",
  HK:"badge-green", FO:"badge-green", AB:"badge-green",
  CO:"badge-amber", GR:"badge-amber", MT:"badge-amber",
  MD:"badge-violet", TH:"badge-violet", TI:"badge-violet",
};

// Wire repo filters
["repoSearch", "repoAreaFilter", "repoTipoFilter"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderRepoTable);
});

/* ============================================================
   11. AUTO-CODE GENERATOR
   ============================================================ */
$("area").addEventListener("change", () => {
  const area = $("area").value;
  if (!area) return;
  const map = {
    GG:"PE", GI:"PE", HK:"PM", FO:"PM", AB:"PM",
    CO:"PA", GR:"PA", MT:"PA", MD:"PA", TH:"PA", TI:"PA"
  };
  const count   = allDocs.filter(d => d.area === area).length;
  const num     = String(count + 1).padStart(3, "0");
  $("codigo").value = `${map[area] || "XX"}-${area}-FO-${num}`;
});

/* ============================================================
   12. THEME
   ============================================================ */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("lm_theme", t);
  // Swap icon
  const icon = $("themeIcon");
  if (t === "dark") {
    icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
  } else {
    icon.innerHTML = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
  }
}

/* ============================================================
   13. UI BINDINGS
   ============================================================ */
function bindUI() {
  // Theme toggle
  $("themeBtn").onclick = () => { theme = theme === "light" ? "dark" : "light"; applyTheme(theme); };

  // Reset form
  $("resetBtn").onclick = resetForm;

  // Search & filters
  [searchInput, areaFilter, tipoFilter].forEach(el => el.addEventListener("input", renderTable));

  // File dropzone
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files[0]) {
      fileLabel.innerHTML = `<strong>Adjunto:</strong> ${fileInput.files[0].name}`;
    }
  };

  // Drag & drop on dropzone
  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.style.borderColor = "var(--c-primary)"; });
  dropzone.addEventListener("dragleave", () => { dropzone.style.borderColor = ""; });
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.style.borderColor = "";
    const f = e.dataTransfer.files[0];
    if (f) {
      const dt  = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;
      fileLabel.innerHTML = `<strong>Adjunto:</strong> ${f.name}`;
    }
  });

  // Import/Export modal
  $("importExportBtn").onclick = () => $("ioModal").classList.add("open");
  $("closeIoModal").onclick    = closeIoModal;
  $("ioModal").addEventListener("click", e => { if (e.target === $("ioModal")) closeIoModal(); });

  // IO Tabs
  document.querySelectorAll(".io-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".io-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const isExport = tab.dataset.tab === "export";
      $("exportPanel").style.display = isExport ? "" : "none";
      $("importPanel").style.display = isExport ? "none" : "";
    };
  });

  // Export buttons
  $("exportExcelBtn").onclick = exportExcel;
  $("exportJsonBtn").onclick  = exportJSON;

  // Import drop area
  const importDrop = $("importDrop");
  importDrop.onclick = () => $("importFileInput").click();
  importDrop.addEventListener("dragover", e => { e.preventDefault(); importDrop.classList.add("dragover"); });
  importDrop.addEventListener("dragleave", () => importDrop.classList.remove("dragover"));
  importDrop.addEventListener("drop", async e => {
    e.preventDefault();
    importDrop.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) await handleImportFile(f);
  });

  $("importFileInput").onchange = async e => {
    const f = e.target.files[0];
    if (f) await handleImportFile(f);
  };

  $("confirmImportBtn").onclick = confirmImport;

  // ── Repo Drive file dropzone ──────────────────────────────────
  const repoDrop      = document.getElementById("repoDrop");
  const repoFileInput = document.getElementById("repoFileInput");
  const repoFileLabel = document.getElementById("repoFileLabel");

  if (repoDrop) {

    repoDrop.addEventListener("dragover",  e => { e.preventDefault(); repoDrop.style.borderColor = "var(--c-primary)"; });
    repoDrop.addEventListener("dragleave", () => { repoDrop.style.borderColor = ""; });
    repoDrop.addEventListener("drop", e => {
      e.preventDefault();
      repoDrop.style.borderColor = "";
      const f = e.dataTransfer.files[0];
      if (f) {
        const dt  = new DataTransfer();
        dt.items.add(f);
        repoFileInput.files = dt.files;
        repoFileLabel.innerHTML = `<strong>Seleccionado:</strong> ${f.name} <span style='color:var(--text-muted)'>(${(f.size/1024/1024).toFixed(2)} MB)</span>`;
        // Auto-fill nombre if empty
        const nombreEl = document.getElementById("repoNombre");
        if (!nombreEl.value) nombreEl.value = f.name;
      }
    });
    repoFileInput.onchange = () => {
      const f = repoFileInput.files[0];
      if (f) {
        repoFileLabel.innerHTML = `<strong>Seleccionado:</strong> ${f.name} <span style='color:var(--text-muted)'>(${(f.size/1024/1024).toFixed(2)} MB)</span>`;
        const nombreEl = document.getElementById("repoNombre");
        if (!nombreEl.value) nombreEl.value = f.name;
      }
    };
  }
}

function closeIoModal() {
  $("ioModal").classList.remove("open");
  importBuffer = [];
  $("importPreview").style.display = "none";
  $("importFileInput").value = "";
}

/* ============================================================
   14. UTILS
   ============================================================ */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

function formatDate(str) {
  if (!str) return "—";
  const d = new Date(str + "T12:00:00");
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
}

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      ${type === "success" ? '<polyline points="20 6 9 17 4 12"/>' : type === "error" ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
    </svg>
    ${msg}`;
  $("toast-container").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(100%)"; el.style.transition = ".3s"; setTimeout(() => el.remove(), 300); }, 3500);
}

/* ============================================================
   SYNC FROM DRIVE — Lee archivos públicos de la carpeta Drive
   ============================================================ */
async function syncFromDrive() {
  const btn = $("syncDriveBtn");
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<svg class="spinning" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Leyendo Drive...`;

  try {
    // List files in the shared folder using Drive API v3
    const url = `https://www.googleapis.com/drive/v3/files?q='${DRIVE_FOLDER_ID}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,createdTime,webViewLink,size)&orderBy=createdTime+desc&pageSize=100&key=${DRIVE_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
    const json = await res.json();
    const files = json.files || [];

    if (!files.length) {
      toast("La carpeta de Drive está vacía o no es accesible.", "info");
      return;
    }

    // Determine type from MIME
    const mimeToTipo = {
      "application/pdf":                                               "PDF",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
      "application/msword":                                            "Word",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
      "application/vnd.ms-excel":                                      "Excel",
      "application/zip":                                               "ZIP",
      "application/x-zip-compressed":                                  "ZIP",
      "image/jpeg":  "Imagen",
      "image/png":   "Imagen",
      "image/gif":   "Imagen",
      "image/webp":  "Imagen",
    };

    // Show Drive files in a modal-like summary
    let addedCount = 0;
    for (const f of files) {
      // Skip if already registered by Drive file ID
      const exists = repoAllDocs.some(d => d.driveFileId === f.id);
      if (exists) continue;

      const tipo = mimeToTipo[f.mimeType] || "Otro";
      const fecha = f.createdTime ? f.createdTime.split("T")[0] : new Date().toISOString().split("T")[0];

      await fsdb.collection(REPO_COLLECTION).add({
        identificador: "Drive-Sync",
        area:          "GG",   // default; user can edit
        nombre:        f.name,
        tipo,
        fecha,
        descripcion:   `Importado desde Drive (${f.mimeType})`,
        driveLink:     f.webViewLink || DRIVE_FOLDER_URL,
        driveFileId:   f.id,
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
      });
      addedCount++;
    }

    toast(
      addedCount
        ? `${addedCount} archivo(s) importados desde Drive \u2713`
        : "Drive sincronizado — no hay archivos nuevos.",
      "success"
    );
  } catch (err) {
    console.error("Drive sync error:", err);
    // If API key doesn't have Drive API enabled, open the folder for manual reference
    toast("No se pudo leer Drive automáticamente. Abriendo carpeta...", "warning");
    window.open(DRIVE_FOLDER_URL, "_blank");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Sincronizar Drive`;
  }
}

// Wire the Sync button
const syncDriveBtn = $("syncDriveBtn");
if (syncDriveBtn) syncDriveBtn.onclick = syncFromDrive;

