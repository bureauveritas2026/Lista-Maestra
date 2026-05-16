/* 
    Lista Maestra - Core Logic 
    Powered by Dexie.js & Supabase
*/

// Initialize Local Database
const db = new Dexie("ListaMaestraDB");
db.version(2).stores({
    documentos: '++id, area, titulo, version, codigo, tipo, fecha, fileBlob, fileName',
    settings: 'key, value'
});

// Supabase Configuration
let supabase = null;
let isCloud = false;

async function initSupabase() {
    const url = localStorage.getItem('supabaseUrl');
    const key = localStorage.getItem('supabaseKey');

    if (url && key) {
        try {
            supabase = supabase.createClient(url, key);
            isCloud = true;
            document.getElementById('syncStatus').innerHTML = '<span class="dot"></span> Sincronizado en la Nube';
            document.getElementById('syncStatus').style.color = 'var(--primary)';
            
            // Subscribe to real-time changes
            supabase
                .channel('schema-db-changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'documentos' }, () => {
                    loadData();
                })
                .subscribe();
        } catch (err) {
            console.error("Supabase connection error:", err);
            isCloud = false;
        }
    }
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
        let query = supabase.from('documentos').select('*');
        if (area) query = query.eq('area', area);
        const { data, error } = await query;
        if (!error) docs = data;
    } else {
        let collection = db.documentos.toCollection();
        if (area) collection = db.documentos.where('area').equals(area);
        docs = await collection.toArray();
    }

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
                const { data, error } = await supabase.storage.from('documentos').upload(filePath, fileBlob);
                if (error) throw error;
                fileUrl = filePath;
            }

            const payload = { ...docData, fileName, fileBlob: fileUrl };
            if (editModeId) {
                const { error } = await supabase.from('documentos').update(payload).eq('id', editModeId);
                if (error) throw error;
                showToast("Documento actualizado en la nube");
            } else {
                const { error } = await supabase.from('documentos').insert([payload]);
                if (error) throw error;
                showToast("Documento guardado en la nube");
            }
        } else {
            const localPayload = { ...docData, fileName, fileBlob };
            if (editModeId) {
                const oldDoc = await db.documentos.get(editModeId);
                if (!fileBlob) {
                    localPayload.fileBlob = oldDoc.fileBlob;
                    localPayload.fileName = oldDoc.fileName;
                }
                await db.documentos.update(editModeId, localPayload);
                showToast("Documento actualizado localmente");
            } else {
                await db.documentos.add(localPayload);
                showToast("Documento guardado localmente");
            }
        }
        
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
        if (isCloud) {
            const { error } = await supabase.from('documentos').delete().eq('id', id);
            if (error) {
                showToast("Error al eliminar en la nube", "danger");
                return;
            }
        } else {
            await db.documentos.delete(id);
        }
        showToast("Registro eliminado");
        loadData();
    }
}

async function downloadFile(id) {
    const doc = currentDocs.find(d => d.id === id);
    if (!doc) return;

    if (isCloud && doc.fileBlob) {
        const { data, error } = await supabase.storage.from('documentos').download(doc.fileBlob);
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

// Cloud Settings
function saveCloudSettings() {
    const url = document.getElementById('supabaseUrl').value.trim();
    const key = document.getElementById('supabaseKey').value.trim();

    if (!url || !key) {
        showToast("Por favor ingresa URL y Key", "warning");
        return;
    }

    localStorage.setItem('supabaseUrl', url);
    localStorage.setItem('supabaseKey', key);
    showToast("Ajustes guardados. Recargando...");
    setTimeout(() => location.reload(), 1000);
}

function disconnectCloud() {
    localStorage.removeItem('supabaseUrl');
    localStorage.removeItem('supabaseKey');
    showToast("Desconectado de la nube. Recargando...");
    setTimeout(() => location.reload(), 1000);
}

// Initialization
window.onload = async () => {
    await initTheme();
    await initSupabase();
    
    // Seed local data if empty and not in cloud
    if (!isCloud) {
        const count = await db.documentos.count();
        if (count === 0) {
            const sampleData = [
                { area: 'GG', titulo: 'Plan Estratégico 2026', version: '01', codigo: 'PE-GG-FO-001', tipo: 'FORMATO', fecha: '2026-01-01' },
                { area: 'GI', titulo: 'Manual de Calidad', version: '02', codigo: 'PE-GI-FO-001', tipo: 'MANUAL', fecha: '2026-02-15' },
                { area: 'FO', titulo: 'Checklist de Check-in', version: '00', codigo: 'PM-FO-FO-001', tipo: 'FORMATO', fecha: '2026-05-10' }
            ];
            await db.documentos.bulkAdd(sampleData);
        }
    }

    loadData();
    searchInput.oninput = loadData;
    areaFilter.onchange = loadData;
    lucide.createIcons();

    // Load saved keys into modal if exist
    document.getElementById('supabaseUrl').value = localStorage.getItem('supabaseUrl') || '';
    document.getElementById('supabaseKey').value = localStorage.getItem('supabaseKey') || '';
};
