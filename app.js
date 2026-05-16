/* 
    Lista Maestra - Core Logic 
    Powered by Dexie.js & Supabase (Online Professional)
*/

// Initialize Local Database
const db = new Dexie("ListaMaestraDB");
db.version(2).stores({
    documentos: '++id, area, titulo, version, codigo, tipo, fecha, fileBlob, fileName',
    settings: 'key, value'
});

// Cloud State
let supabaseClient = null;
let isCloud = false;

async function initCloud() {
    const url = localStorage.getItem('supabaseUrl');
    const key = localStorage.getItem('supabaseKey');

    if (url && key) {
        try {
            supabaseClient = supabase.createClient(url, key);
            isCloud = true;
            document.getElementById('statusDot').style.background = 'var(--secondary)';
            document.getElementById('statusText').textContent = 'Sincronizado (Nube)';
            
            // Subscribe to real-time changes
            supabaseClient
                .channel('schema-db-changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'documentos' }, () => {
                    loadData();
                })
                .subscribe();
                
            return true;
        } catch (err) {
            console.error("Cloud connection error:", err);
            isCloud = false;
        }
    }
    return false;
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

    if (isCloud) {
        try {
            const { data, error } = await supabaseClient.from('documentos').select('*');
            if (!error && data) {
                docs = data;
                // Background sync to local for offline access (caching)
                for (let d of data) {
                    const localDoc = { ...d };
                    // If we already have a real Blob locally, don't overwrite it with the URL string yet
                    // (Real sync would be more complex, but this keeps the UI responsive)
                    const existing = await db.documentos.get(d.id);
                    if (!existing) await db.documentos.put(localDoc);
                }
            } else {
                docs = await db.documentos.toArray();
            }
        } catch (e) {
            docs = await db.documentos.toArray();
        }
    } else {
        let collection = db.documentos.toCollection();
        if (area) collection = db.documentos.where('area').equals(area);
        docs = await collection.toArray();
    }

    if (area && isCloud) docs = docs.filter(d => d.area === area);

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
    };

    try {
        if (isCloud) {
            let fileUrl = null;
            if (fileBlob) {
                const filePath = `${Date.now()}_${fileName}`;
                const { error } = await supabaseClient.storage.from('documentos').upload(filePath, fileBlob);
                if (error) throw error;
                fileUrl = filePath;
            }

            const payload = { ...docData, fileName, fileBlob: fileUrl };
            if (editModeId) {
                const { error } = await supabaseClient.from('documentos').update(payload).eq('id', editModeId);
                if (error) throw error;
                showToast("Actualizado en la nube");
            } else {
                const { error } = await supabaseClient.from('documentos').insert([payload]);
                if (error) throw error;
                showToast("Guardado en la nube");
            }
        } else {
            const localPayload = { ...docData, fileName, fileBlob };
            if (editModeId) {
                await db.documentos.update(editModeId, localPayload);
                showToast("Actualizado localmente");
            } else {
                await db.documentos.add(localPayload);
                showToast("Guardado localmente");
            }
        }
        
        resetForm();
        loadData();
    } catch (err) {
        console.error(err);
        showToast("Error: " + err.message, "danger");
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
    const doc = isCloud ? currentDocs.find(d => d.id === id) : await db.documentos.get(id);
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
        if (isCloud) {
            await supabaseClient.from('documentos').delete().eq('id', id);
        }
        await db.documentos.delete(id);
        showToast("Registro eliminado");
        loadData();
    }
}

async function downloadFile(id) {
    const doc = currentDocs.find(d => d.id === id);
    if (!doc) return;

    if (isCloud && doc.fileBlob && typeof doc.fileBlob === 'string') {
        const { data, error } = await supabaseClient.storage.from('documentos').download(doc.fileBlob);
        if (error) {
            showToast("Error al descargar de la nube", "danger");
            return;
        }
        const url = URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName;
        a.click();
    } else if (doc.fileBlob) {
        const url = URL.createObjectURL(doc.fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName;
        a.click();
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
    XLSX.writeFile(wb, `Lista_Maestra_${new Date().toISOString().split('T')[0]}.xlsx`);
}

async function exportToJSON() {
    const data = await db.documentos.toArray();
    const processedData = await Promise.all(data.map(async d => {
        if (d.fileBlob instanceof Blob) {
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

// Cloud Management
async function saveCloudSettings() {
    const url = document.getElementById('supabaseUrl').value.trim();
    const key = document.getElementById('supabaseKey').value.trim();

    if (!url || !key) {
        showToast("Por favor ingresa URL y Key", "warning");
        return;
    }

    localStorage.setItem('supabaseUrl', url);
    localStorage.setItem('supabaseKey', key);
    
    showToast("Conectando...");
    const success = await initCloud();
    if (success) {
        // Migration: Upload local data to cloud
        const localData = await db.documentos.toArray();
        if (localData.length > 0 && confirm("¿Deseas subir tus datos locales a la nube para que otros los vean?")) {
            for (let doc of localData) {
                const { id, ...payload } = doc;
                await supabaseClient.from('documentos').insert([payload]);
            }
        }
        showToast("¡Conectado exitosamente!", "success");
        setTimeout(() => location.reload(), 1000);
    } else {
        showToast("Error de conexión. Verifica las llaves.", "danger");
    }
}

function disconnectCloud() {
    localStorage.removeItem('supabaseUrl');
    localStorage.removeItem('supabaseKey');
    showToast("Desconectado de la nube");
    setTimeout(() => location.reload(), 500);
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
    await initCloud();
    
    // Seed local data if empty
    const count = await db.documentos.count();
    if (count === 0 && !isCloud) {
        const sampleData = [
            { area: 'GG', titulo: 'Plan Estratégico 2026', version: '01', codigo: 'PE-GG-FO-001', tipo: 'FORMATO', fecha: '2026-01-01' },
            { area: 'GI', titulo: 'Manual de Calidad', version: '02', codigo: 'PE-GI-FO-001', tipo: 'MANUAL', fecha: '2026-02-15' },
            { area: 'FO', titulo: 'Checklist de Check-in', version: '00', codigo: 'PM-FO-FO-001', tipo: 'FORMATO', fecha: '2026-05-10' }
        ];
        await db.documentos.bulkAdd(sampleData);
    }

    loadData();
    searchInput.oninput = loadData;
    areaFilter.onchange = loadData;
    lucide.createIcons();

    document.getElementById('supabaseUrl').value = localStorage.getItem('supabaseUrl') || '';
    document.getElementById('supabaseKey').value = localStorage.getItem('supabaseKey') || '';
};
