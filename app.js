/* 
    Lista Maestra - Core Logic v2.1
    Modern, Robust & Cloud-Ready
*/

// Initialize Local Database (Dexie)
const db = new Dexie("ListaMaestraDB");
db.version(2).stores({
    documentos: '++id, area, titulo, version, codigo, tipo, fecha, fileBlob, fileName',
    settings: 'key, value'
});

// Global State
let supabaseClient = null;
let isCloud = false;
let currentDocs = [];
let editModeId = null;

// DOM Elements
const docForm = document.getElementById('docForm');
const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('searchInput');
const areaFilter = document.getElementById('areaFilter');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

// --- Initialization ---
window.onload = async () => {
    await initTheme();
    await initCloud();
    
    // Seed sample data if totally empty
    const count = await db.documentos.count();
    if (count === 0 && !isCloud) {
        await db.documentos.bulkAdd([
            { area: 'GG', titulo: 'Plan Estratégico 2026', version: '01', codigo: 'PE-GG-FO-001', tipo: 'PROCEDIMIENTO', fecha: '2026-01-01' },
            { area: 'GI', titulo: 'Manual de Gestión de Calidad', version: '02', codigo: 'PE-GI-FO-001', tipo: 'MANUAL', fecha: '2026-02-15' },
            { area: 'FO', titulo: 'Checklist Recepción', version: '00', codigo: 'PM-FO-FO-001', tipo: 'FORMATO', fecha: '2026-05-10' }
        ]);
    }

    loadData();
    
    // Event Listeners
    searchInput.oninput = loadData;
    areaFilter.onchange = loadData;
    dropzone.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        if (fileInput.files.length > 0) {
            document.getElementById('fileStatus').innerHTML = `<b>Adjunto:</b> ${fileInput.files[0].name}`;
        }
    };
    
    // Auto-generate Code
    document.getElementById('area').addEventListener('change', generateCode);
    
    lucide.createIcons();
};

// --- Cloud Logic ---
async function initCloud() {
    const url = localStorage.getItem('supabaseUrl');
    const key = localStorage.getItem('supabaseKey');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    if (url && key) {
        try {
            supabaseClient = supabase.createClient(url, key);
            isCloud = true;
            statusDot.style.background = 'var(--secondary)';
            statusText.textContent = 'Cloud Online';
            
            // Real-time subscription
            supabaseClient.channel('db-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'documentos' }, loadData).subscribe();
            
            document.getElementById('supabaseUrl').value = url;
            document.getElementById('supabaseKey').value = key;
        } catch (err) {
            console.error("Cloud Error:", err);
            statusText.textContent = 'Error Cloud';
        }
    } else {
        statusDot.style.background = 'var(--danger)';
        statusText.textContent = 'Modo Local';
    }
}

async function saveCloudSettings() {
    const url = document.getElementById('supabaseUrl').value.trim();
    const key = document.getElementById('supabaseKey').value.trim();

    if (!url || !key) {
        showToast("Ingresa URL y Key", "danger");
        return;
    }

    showToast("Conectando con la nube...", "info");
    const success = await initCloud();
    if (success) {
        const localData = await db.documentos.toArray();
        if (localData.length > 0 && confirm("¿Deseas subir tus datos locales a la nube para que otros dispositivos puedan verlos?")) {
            for (const doc of localData) {
                const { id, ...payload } = doc;
                await supabaseClient.from('documentos').insert([payload]);
            }
        }
        showToast("¡Conectado exitosamente!", "success");
        setTimeout(() => location.reload(), 1500);
    }
}

function disconnectCloud() {
    localStorage.removeItem('supabaseUrl');
    localStorage.removeItem('supabaseKey');
    showToast("Desconectado de la nube", "info");
    setTimeout(() => location.reload(), 1000);
}

// --- Data Operations ---
async function loadData() {
    let docs = [];

    if (isCloud) {
        const { data, error } = await supabaseClient.from('documentos').select('*');
        if (!error) docs = data;
        else docs = await db.documentos.toArray();
    } else {
        docs = await db.documentos.toArray();
    }

    const searchTerm = searchInput.value.toLowerCase();
    const area = areaFilter.value;

    if (area) docs = docs.filter(d => d.area === area);
    if (searchTerm) {
        docs = docs.filter(d => d.titulo.toLowerCase().includes(searchTerm) || d.codigo.toLowerCase().includes(searchTerm));
    }

    currentDocs = docs.sort((a, b) => b.id - a.id);
    renderTable();
    updateStats();
}

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
        fileName: fileName
    };

    try {
        if (isCloud) {
            let fileRef = null;
            if (fileBlob) {
                const path = `${Date.now()}_${fileName}`;
                const { error } = await supabaseClient.storage.from('documentos').upload(path, fileBlob);
                if (error) throw error;
                fileRef = path;
            }

            const payload = { ...docData, fileBlob: fileRef };
            if (editModeId) {
                await supabaseClient.from('documentos').update(payload).eq('id', editModeId);
            } else {
                await supabaseClient.from('documentos').insert([payload]);
            }
        } else {
            const payload = { ...docData, fileBlob };
            if (editModeId) await db.documentos.update(editModeId, payload);
            else await db.documentos.add(payload);
        }

        showToast(editModeId ? "Actualizado correctamente" : "Guardado correctamente");
        resetForm();
        loadData();
    } catch (err) {
        showToast("Error: " + err.message, "danger");
    }
};

async function deleteDoc(id) {
    if (confirm("¿Seguro de eliminar este documento?")) {
        if (isCloud) await supabaseClient.from('documentos').delete().eq('id', id);
        await db.documentos.delete(id);
        showToast("Eliminado");
        loadData();
    }
}

async function downloadFile(id) {
    const doc = currentDocs.find(d => d.id === id);
    if (!doc || !doc.fileBlob) return;

    let url;
    if (isCloud && typeof doc.fileBlob === 'string') {
        const { data, error } = await supabaseClient.storage.from('documentos').download(doc.fileBlob);
        if (error) return showToast("Error al descargar", "danger");
        url = URL.createObjectURL(data);
    } else {
        url = URL.createObjectURL(doc.fileBlob);
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = doc.fileName || 'documento';
    a.click();
}

// --- UI Helpers ---
function renderTable() {
    tableBody.innerHTML = currentDocs.length ? currentDocs.map((doc, idx) => `
        <tr class="fade-in">
            <td>${idx + 1}</td>
            <td><span class="badge badge-primary">${doc.area}</span></td>
            <td style="font-weight: 500;">${doc.titulo} <br><small style="color: var(--text-muted);">${doc.tipo}</small></td>
            <td><span class="badge badge-warning">v${doc.version}</span></td>
            <td><code>${doc.codigo}</code></td>
            <td>${new Date(doc.fecha).toLocaleDateString()}</td>
            <td>
                ${doc.fileBlob ? `<button class="btn btn-secondary btn-icon" onclick="downloadFile(${doc.id})"><i data-lucide="download" style="width:16px;"></i></button>` : '<small>No</small>'}
            </td>
            <td>
                <div class="actions">
                    <button class="btn btn-secondary btn-icon" onclick="editDoc(${doc.id})"><i data-lucide="edit-2" style="width:16px;"></i></button>
                    <button class="btn btn-secondary btn-icon" onclick="deleteDoc(${doc.id})" style="color: var(--danger);"><i data-lucide="trash-2" style="width:16px;"></i></button>
                </div>
            </td>
        </tr>
    `).join('') : '<tr><td colspan="8" style="text-align:center; padding: 2rem;">No hay registros</td></tr>';
    lucide.createIcons();
}

function updateStats() {
    document.getElementById('statTotal').textContent = currentDocs.length;
    document.getElementById('statAreas').textContent = new Set(currentDocs.map(d => d.area)).size;
    document.getElementById('statFiles').textContent = currentDocs.filter(d => d.fileBlob).length;
}

function resetForm() {
    docForm.reset();
    editModeId = null;
    document.getElementById('formTitle').textContent = "Registro de Documento";
    document.getElementById('fileStatus').textContent = "Haz clic para adjuntar archivo";
    lucide.createIcons();
}

async function editDoc(id) {
    const doc = isCloud ? currentDocs.find(d => d.id === id) : await db.documentos.get(id);
    if (!doc) return;

    editModeId = id;
    document.getElementById('area').value = doc.area;
    document.getElementById('titulo').value = doc.titulo;
    document.getElementById('version').value = doc.version;
    document.getElementById('codigo').value = doc.codigo;
    document.getElementById('tipo').value = doc.tipo;
    document.getElementById('fecha').value = doc.fecha;
    document.getElementById('formTitle').textContent = "Editando Documento";
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Utils ---
async function generateCode() {
    const area = document.getElementById('area').value;
    if (!area) return;
    const map = { 'GG': 'PE', 'GI': 'PE', 'HK': 'PM', 'FO': 'PM', 'AB': 'PM', 'CO': 'PA', 'MT': 'PA', 'TH': 'PA', 'TI': 'PA' };
    const count = await db.documentos.where('area').equals(area).count();
    document.getElementById('codigo').value = `${map[area] || 'XX'}-${area}-FO-${String(count + 1).padStart(3, '0')}`;
}

function openSettings() { document.getElementById('settingsModal').style.display = 'flex'; }
function closeSettings() { document.getElementById('settingsModal').style.display = 'none'; }

async function initTheme() {
    const theme = await db.settings.get('theme');
    if (theme?.value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
}

async function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await db.settings.put({ key: 'theme', value: next });
    lucide.createIcons();
}

function showToast(msg, type = "success") {
    const toast = document.createElement('div');
    toast.style.cssText = `position: fixed; bottom: 2rem; right: 2rem; padding: 1rem 2rem; border-radius: 12px; color: white; background: ${type === 'danger' ? 'var(--danger)' : 'var(--secondary)'}; box-shadow: var(--shadow-lg); z-index: 9999; animation: slideUp 0.3s ease;`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

async function exportToExcel() {
    const ws = XLSX.utils.json_to_sheet(currentDocs.map(d => ({ Área: d.area, Título: d.titulo, Ver: d.version, Código: d.codigo, Tipo: d.tipo, Fecha: d.fecha })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lista Maestra");
    XLSX.writeFile(wb, "Lista_Maestra.xlsx");
}

async function exportToJSON() {
    const blob = new Blob([JSON.stringify(currentDocs, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = "Lista_Maestra_Backup.json";
    a.click();
}
