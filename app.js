/* 
    Lista Maestra - Core Logic 
    Powered by Dexie.js & Gun.js (Real-time Online)
*/

// Initialize Local Database
const db = new Dexie("ListaMaestraDB");
db.version(2).stores({
    documentos: '++id, area, titulo, version, codigo, tipo, fecha, fileBlob, fileName',
    settings: 'key, value'
});

// Initialize Gun.js (Zero-Setup Online DB)
// Using a unique key based on the repository to avoid collisions
const GUN_KEY = 'bureauveritas2026-lista-maestra-production-v2';
const gun = Gun({
    peers: [
        'https://gun-manhattan.herokuapp.com/gun',
        'https://gun-ams1.herokuapp.com/gun',
        'https://gun-us-east1.herokuapp.com/gun',
        'https://gundb.herokuapp.com/gun'
    ],
    localStorage: false // We use Dexie for local storage
});
const gunDocs = gun.get(GUN_KEY).get('documentos');

function initSync() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    statusDot.style.background = 'var(--accent)';
    statusText.textContent = 'Conectando a la red...';
    
    // Connection Monitor
    let peerCount = 0;
    
    setInterval(() => {
        // Check peers
        const peers = gun.back('opt.peers');
        peerCount = Object.keys(peers).filter(k => peers[k].wire && peers[k].wire.readyState === 1).length;
        
        if (peerCount > 0) {
            statusDot.style.background = 'var(--secondary)';
            statusText.textContent = `Online (${peerCount} pares)`;
        } else {
            statusDot.style.background = 'var(--danger)';
            statusText.textContent = 'Offline (Buscando pares...)';
        }
    }, 5000);

    // Listen for changes from other peers
    gunDocs.map().on(async (data, gunId) => {
        if (!data || !data.id) return;
        
        try {
            const local = await db.documentos.get(data.id);
            if (!local || (data.fecha_actualizacion > (local.fecha_actualizacion || 0))) {
                let fileBlob = data.fileBlob;
                if (typeof fileBlob === 'string' && fileBlob.startsWith('data:')) {
                    const res = await fetch(fileBlob);
                    fileBlob = await res.blob();
                }
                
                await db.documentos.put({ ...data, fileBlob });
                loadData();
                showToast("Datos actualizados desde la red", "info");
            }
        } catch (e) { console.error("Sync error:", e); }
    });
}

async function forceSync() {
    const icon = document.getElementById('syncIcon');
    if (icon) icon.style.animation = 'spin 1s infinite linear';
    
    const localData = await db.documentos.toArray();
    for (const doc of localData) {
        const syncDoc = { ...doc };
        if (doc.fileBlob instanceof Blob) {
            const base64 = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(doc.fileBlob);
            });
            syncDoc.fileBlob = base64;
        }
        gunDocs.get(doc.id.toString()).put(syncDoc);
    }
    
    setTimeout(() => {
        if (icon) icon.style.animation = 'none';
        showToast("Sincronización forzada completada", "success");
    }, 2000);
}

// App State
let currentDocs = [];
let editModeId = null;

// DOM Elements
const docForm = document.getElementById('docForm');
const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('searchInput');
const areaFilter = document.getElementById('areaFilter');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

// Theme Management
async function initTheme() {
    const savedTheme = await db.settings.get('theme');
    if (savedTheme?.value === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('themeToggle').innerHTML = '<i data-lucide="sun"></i>';
    }
}

async function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    await db.settings.put({ key: 'theme', value: newTheme });
    document.getElementById('themeToggle').innerHTML = `<i data-lucide="${isDark ? 'moon' : 'sun'}"></i>`;
    lucide.createIcons();
}

// Data Loading
async function loadData() {
    const searchTerm = searchInput.value.toLowerCase();
    const area = areaFilter.value;

    let docs = [];

    // Always load from local Dexie (which is synced with Gun)
    let collection = db.documentos.toCollection();
    if (area) collection = db.documentos.where('area').equals(area);
    docs = await collection.toArray();

    if (searchTerm) {
        docs = docs.filter(d => 
            d.titulo.toLowerCase().includes(searchTerm) || 
            d.codigo.toLowerCase().includes(searchTerm)
        );
    }

    currentDocs = docs.sort((a, b) => b.id - a.id);
    renderTable();
    updateStats();
}

// UI Rendering
function renderTable() {
    if (currentDocs.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-muted);">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">📂</div>
                    <p>No se encontraron documentos</p>
                </td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML = currentDocs.map((doc, idx) => `
        <tr class="fade-in">
            <td>${idx + 1}</td>
            <td><span class="badge badge-primary">${doc.area}</span></td>
            <td>
                <div style="font-weight: 600;">${doc.titulo}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">${doc.tipo}</div>
            </td>
            <td><span class="badge badge-warning">v${doc.version}</span></td>
            <td><code>${doc.codigo}</code></td>
            <td>${new Date(doc.fecha).toLocaleDateString()}</td>
            <td>
                ${doc.fileBlob ? `
                    <button class="btn btn-secondary btn-icon" onclick="downloadFile(${doc.id})" title="Descargar Documento">
                        <i data-lucide="download" style="width: 16px;"></i>
                    </button>
                ` : '<span style="color: var(--text-muted); font-size: 0.8rem;">Sin doc</span>'}
            </td>
            <td>
                <div class="actions">
                    <button class="btn btn-secondary btn-icon" onclick="editDoc(${doc.id})" title="Editar">
                        <i data-lucide="edit-2" style="width: 16px;"></i>
                    </button>
                    <button class="btn btn-secondary btn-icon" onclick="deleteDoc(${doc.id})" title="Eliminar" style="color: var(--danger);">
                        <i data-lucide="trash-2" style="width: 16px;"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

function updateStats() {
    document.getElementById('statTotal').textContent = currentDocs.length;
    const uniqueAreas = new Set(currentDocs.map(d => d.area)).size;
    document.getElementById('statAreas').textContent = uniqueAreas;
    
    const docsWithFiles = currentDocs.filter(d => d.fileBlob).length;
    document.getElementById('statFiles').textContent = docsWithFiles;
}

// Form Handling
docForm.onsubmit = async (e) => {
    e.preventDefault();
    
    const file = fileInput.files[0];
    let fileBlob = null;
    let fileName = '';

    if (file) {
        fileBlob = file;
        fileName = file.name;
    }

    const docData = {
        area: document.getElementById('area').value,
        titulo: document.getElementById('titulo').value,
        version: document.getElementById('version').value,
        codigo: document.getElementById('codigo').value,
        tipo: document.getElementById('tipo').value,
        fecha: document.getElementById('fecha').value,
        fecha_actualizacion: Date.now()
    };

    try {
        let id = editModeId || Date.now();
        let gunPayload = { ...docData, fileName, id: id };

        // Handle File (Convert to Base64 for Gun sync if small enough)
        if (fileBlob) {
            if (fileBlob.size > 2 * 1024 * 1024) { // 2MB Limit for network sync
                showToast("Archivo muy grande (>2MB). Solo se verá en esta PC.", "warning");
                // gunPayload will have no fileBlob for the network
            } else {
                const reader = new FileReader();
                const base64 = await new Promise(resolve => {
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(fileBlob);
                });
                gunPayload.fileBlob = base64;
            }
        } else if (editModeId) {
            const oldDoc = await db.documentos.get(editModeId);
            gunPayload.fileBlob = oldDoc.fileBlob; // Could be Base64 or Blob
            gunPayload.fileName = oldDoc.fileName;
        }

        // Save to Local (Dexie) - Always save the real Blob if available
        const localPayload = { ...docData, id, fileName, fileBlob: fileBlob || gunPayload.fileBlob };
        await db.documentos.put(localPayload);

        // Save to Gun (Online) - Must be Base64 or string for the network
        if (gunPayload.fileBlob instanceof Blob) {
            // Convert Blob to Base64 before sending to Gun
            const reader = new FileReader();
            reader.onload = () => {
                gunPayload.fileBlob = reader.result;
                gunDocs.get(id.toString()).put(gunPayload);
            };
            reader.readAsDataURL(gunPayload.fileBlob);
        } else {
            gunDocs.get(id.toString()).put(gunPayload);
        }

        showToast(editModeId ? "Documento actualizado" : "Documento guardado");
        resetForm();
        loadData();
    } catch (err) {
        console.error(err);
        showToast("Error al guardar: " + err.message, "danger");
    }
};

function resetForm() {
    docForm.reset();
    editModeId = null;
    document.getElementById('formTitle').textContent = "Nuevo Documento";
    document.getElementById('submitBtn').innerHTML = '<i data-lucide="plus"></i> Agregar Documento';
    document.getElementById('fileStatus').textContent = "Ningún archivo seleccionado";
    lucide.createIcons();
}

// Actions
async function editDoc(id) {
    const doc = await db.documentos.get(id);
    if (!doc) return;

    editModeId = id;
    document.getElementById('area').value = doc.area;
    document.getElementById('titulo').value = doc.titulo;
    document.getElementById('version').value = doc.version;
    document.getElementById('codigo').value = doc.codigo;
    document.getElementById('tipo').value = doc.tipo;
    document.getElementById('fecha').value = doc.fecha;
    
    document.getElementById('formTitle').textContent = "Editar Documento";
    document.getElementById('submitBtn').innerHTML = '<i data-lucide="save"></i> Guardar Cambios';
    document.getElementById('fileStatus').textContent = doc.fileName ? `Archivo actual: ${doc.fileName}` : "Sin archivo";
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
    lucide.createIcons();
}

async function deleteDoc(id) {
    if (confirm("¿Estás seguro de eliminar este registro?")) {
        // Delete from Gun
        gunDocs.get(id.toString()).put(null);
        // Delete from Local
        await db.documentos.delete(id);
        
        showToast("Registro eliminado");
        loadData();
    }
}

async function downloadFile(id) {
    const doc = await db.documentos.get(id);
    if (doc && doc.fileBlob) {
        let blob = doc.fileBlob;
        if (typeof blob === 'string' && blob.startsWith('data:')) {
            const res = await fetch(blob);
            blob = await res.blob();
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName;
        a.click();
        URL.revokeObjectURL(url);
    }
}

// File Input Logic
dropzone.onclick = () => fileInput.click();
fileInput.onchange = () => {
    if (fileInput.files.length > 0) {
        document.getElementById('fileStatus').textContent = `Seleccionado: ${fileInput.files[0].name}`;
    }
};

// Export/Import
async function exportToExcel() {
    const data = await db.documentos.toArray();
    if (data.length === 0) {
        showToast("No hay datos para exportar", "warning");
        return;
    }

    const worksheetData = data.map((d, i) => ({
        "#": i + 1,
        "Área": d.area,
        "Título": d.titulo,
        "Versión": d.version,
        "Código": d.codigo,
        "Tipo": d.tipo,
        "Fecha": d.fecha,
        "Tiene Archivo": d.fileBlob ? "Sí" : "No"
    }));

    const ws = XLSX.utils.json_to_sheet(worksheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lista Maestra");
    
    // Auto-size columns
    const max_width = worksheetData.reduce((w, r) => Math.max(w, r.Título.length), 10);
    ws['!cols'] = [ { wch: 5 }, { wch: 10 }, { wch: max_width }, { wch: 8 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 12 } ];

    XLSX.writeFile(wb, `Lista_Maestra_${new Date().toISOString().split('T')[0]}.xlsx`);
}

async function exportToJSON() {
    const data = await db.documentos.toArray();
    const processedData = await Promise.all(data.map(async d => {
        if (d.fileBlob) {
            const reader = new FileReader();
            const base64 = await new Promise(resolve => {
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(d.fileBlob);
            });
            return { ...d, fileBlob: base64 };
        }
        return d;
    }));

    const blob = new Blob([JSON.stringify(processedData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Lista_Maestra_Backup_${Date.now()}.json`;
    a.click();
}

async function importFromExcel(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);

            // Map Excel columns to our schema
            const mappedData = jsonData.map(row => ({
                area: row['Área'] || row['area'] || '',
                titulo: row['Título'] || row['titulo'] || '',
                version: String(row['Versión'] || row['version'] || '00'),
                codigo: row['Código'] || row['codigo'] || '',
                tipo: row['Tipo'] || row['tipo'] || 'FORMATO',
                fecha: row['Fecha'] || row['fecha'] || new Date().toISOString().split('T')[0]
            }));

            for (let item of mappedData) {
                await db.documentos.add(item);
            }
            showToast(`Importados ${mappedData.length} registros desde Excel`);
            loadData();
        } catch (err) {
            console.error(err);
            showToast("Error al importar el archivo Excel", "danger");
        }
    };
    reader.readAsArrayBuffer(file);
}

async function importFromJSON(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            for (let item of data) {
                if (item.fileBlob && typeof item.fileBlob === 'string' && item.fileBlob.startsWith('data:')) {
                    const res = await fetch(item.fileBlob);
                    item.fileBlob = await res.blob();
                }
                delete item.id;
                await db.documentos.add(item);
            }
            showToast("Importación JSON completada");
            loadData();
        } catch (err) {
            showToast("Error al importar el archivo JSON", "danger");
        }
    };
    reader.readAsText(file);
}

// Toast System
function showToast(msg, type = "success") {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; top: 2rem; right: 2rem; 
        padding: 1rem 1.5rem; border-radius: 12px; 
        color: white; z-index: 9999; box-shadow: var(--shadow-lg);
        animation: slideIn 0.3s ease;
        background: ${type === 'success' ? 'var(--secondary)' : type === 'danger' ? 'var(--danger)' : 'var(--accent)'};
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Auto-generate code logic
document.getElementById('area').addEventListener('change', async () => {
    const area = document.getElementById('area').value;
    if (!area) return;

    const processMap = {
        'GG': 'PE', 'GI': 'PE',
        'HK': 'PM', 'FO': 'PM', 'AB': 'PM',
        'CO': 'PA', 'GR': 'PA', 'MT': 'PA', 'MD': 'PA', 'TH': 'PA', 'TI': 'PA'
    };

    const processType = processMap[area] || 'XX';
    const count = await db.documentos.where('area').equals(area).count();
    const nextNumber = String(count + 1).padStart(3, '0');
    
    document.getElementById('codigo').value = `${processType}-${area}-FO-${nextNumber}`;
});

// Initialization
window.onload = async () => {
    await initTheme();
    initSync();
    
    // Seed local data if empty
    const count = await db.documentos.count();
    if (count === 0) {
        const sampleData = [
            { id: 1, area: 'GG', titulo: 'Plan Estratégico 2026', version: '01', codigo: 'PE-GG-FO-001', tipo: 'FORMATO', fecha: '2026-01-01', fecha_actualizacion: Date.now() },
            { id: 2, area: 'GI', titulo: 'Manual de Calidad', version: '02', codigo: 'PE-GI-FO-001', tipo: 'MANUAL', fecha: '2026-02-15', fecha_actualizacion: Date.now() },
            { id: 3, area: 'FO', titulo: 'Checklist de Check-in', version: '00', codigo: 'PM-FO-FO-001', tipo: 'FORMATO', fecha: '2026-05-10', fecha_actualizacion: Date.now() }
        ];
        await db.documentos.bulkAdd(sampleData);
        // Also sync samples to Gun
        sampleData.forEach(d => gunDocs.get(d.id.toString()).put(d));
    }

    loadData();
    searchInput.oninput = loadData;
    areaFilter.onchange = loadData;
    lucide.createIcons();
};
