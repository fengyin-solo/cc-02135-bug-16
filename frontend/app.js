// 从配置文件获取API地址
const API_BASE = CONFIG.API_BASE;

let currentShareFileId = null;
let currentShareLink = null;

// Token 管理
const TokenManager = {
    TOKEN_KEY: 'auth_token',
    USER_KEY: 'auth_user',

    save(token, username) {
        localStorage.setItem(this.TOKEN_KEY, token);
        localStorage.setItem(this.USER_KEY, username);
    },

    get() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    getUser() {
        return localStorage.getItem(this.USER_KEY);
    },

    clear() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.USER_KEY);
    },

    async isValid() {
        const token = this.get();
        if (!token) return false;

        try {
            const response = await fetch(`${API_BASE}/refresh-token?token=${token}`, {
                method: 'POST'
            });
            return response.ok;
        } catch {
            return false;
        }
    }
};

// ============================================================================
// 文件目录：唯一数据源（single source of truth）
//
// 所有渲染都从 DirectoryStore.files 出发，绝不拼接、缓存旧数组；
// 并发刷新通过“合并 + 串行循环”收口，最终落地的一定是最后一轮的最新数据。
// ============================================================================
const DirectoryStore = {
    files: [],          // 后端返回的完整目录（含已删除条目），每条记录只出现一次
    keyword: '',        // 当前筛选关键字（纯前端过滤，不触发请求）
    loaded: false,      // 是否已成功加载过
    rerun: false,       // 在途刷新期间是否又有刷新请求（合并触发再跑一轮）
    inflight: null,     // 当前刷新循环的 Promise；null 表示空闲

    setFiles(files) {
        // 防御性规整：以 id 为唯一键，重复 id 只保留最后一次出现，保证正确记录只出现一次
        const byId = new Map();
        for (const f of files) {
            if (f && typeof f.id === 'string') {
                byId.set(f.id, normalizeFile(f));
            }
        }
        this.files = Array.from(byId.values());
        this.loaded = true;
    },

    getById(id) {
        return this.files.find(f => f.id === id) || null;
    },

    visibleFiles() {
        const kw = this.keyword.trim().toLowerCase();
        if (!kw) return this.files.slice();
        return this.files.filter(f => f.name.toLowerCase().includes(kw));
    }
};

// 后端记录 -> 前端模型，列表与详情共用同一份映射，字段对得上
function normalizeFile(f) {
    return {
        id: f.id,
        name: typeof f.name === 'string' ? f.name : '',
        size: Number.isFinite(f.size) ? f.size : null,
        uploaded_at: f.uploaded_at || null,
        uploaded_by: f.uploaded_by || null,
        deleted: Boolean(f.deleted),
        deleted_at: f.deleted_at || null,
        delete_reason: f.delete_reason || null
    };
}

// 更新用户状态栏
async function updateUserBar() {
    const userBar = document.getElementById('userBar');
    const currentUser = document.getElementById('currentUser');
    const userAvatar = document.getElementById('userAvatar');
    const user = TokenManager.getUser();

    if (user && TokenManager.get() && await TokenManager.isValid()) {
        currentUser.textContent = user;
        userAvatar.textContent = user.charAt(0).toUpperCase();
        userBar.classList.remove('hidden');
        loadMyShares();
    } else {
        userBar.classList.add('hidden');
        const shareSection = document.getElementById('mySharesSection');
        if (shareSection) {
            shareSection.style.display = 'none';
        }
    }
}

// 退出登录
function logout() {
    TokenManager.clear();
    updateUserBar();
    renderDirectory();
}

// 页面加载时获取文件列表和更新用户状态
document.addEventListener('DOMContentLoaded', async () => {
    // 检查token是否有效，无效则清除
    if (TokenManager.get() && !(await TokenManager.isValid())) {
        TokenManager.clear();
    }
    await updateUserBar();
    initDirectoryToolbar();
    await refreshDirectory();
});

// 验证文件
function validateFile(file) {
    if (file.size > CONFIG.MAX_FILE_SIZE) {
        return `文件大小超过限制（最大${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB）`;
    }
    return null;
}

// 上传文件处理函数
async function uploadFile(file) {
    const validationError = validateFile(file);
    if (validationError) {
        document.getElementById('uploadStatus').textContent = `❌ ${validationError}`;
        return;
    }

    showLoading('上传中...');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData,
            headers: TokenManager.get()
                ? { 'Authorization': `Bearer ${TokenManager.get()}` }
                : undefined
        });
        const result = await response.json();

        if (response.ok && result.success) {
            // 关键：必须等目录刷新完成才提示成功，杜绝“假成功后仍是旧列表”
            await refreshDirectory();
            document.getElementById('uploadStatus').textContent = `✅ ${file.name} 上传成功！`;
        } else {
            document.getElementById('uploadStatus').textContent = `❌ 上传失败: ${result.error || '未知错误'}`;
        }
    } catch (error) {
        document.getElementById('uploadStatus').textContent = `❌ 上传失败: ${error.message}`;
    } finally {
        hideLoading();
    }
}

// 文件选择上传
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await uploadFile(file);
    e.target.value = '';
});

// 拖拽上传
const uploadZone = document.querySelector('.upload-zone');

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');

    const file = e.dataTransfer.files[0];
    if (file) {
        await uploadFile(file);
    }
});

// ============================================================================
// 目录刷新：合并并发刷新 + 串行循环。
//
// - 在途期间到达的新刷新请求不叠加并发请求，只标记 rerun，循环会在当前请求
//   返回后再发一次；所有调用方（上传、删除、手动）await 的都是同一循环 Promise，
//   因此“提示成功”时屏幕上落地的一定是最新数据；
// - 循环内请求严格串行，最后一轮发起于最近一次刷新请求之后，结果即为最新，
//   从根本上消除了旧响应晚到覆盖新数据的竞态。
// ============================================================================
function refreshDirectory() {
    if (DirectoryStore.inflight) {
        DirectoryStore.rerun = true;
        return DirectoryStore.inflight;
    }
    DirectoryStore.inflight = runRefreshLoop();
    return DirectoryStore.inflight;
}

async function runRefreshLoop() {
    setRefreshPending(true);
    if (!DirectoryStore.loaded) {
        renderDirectory();  // 首次加载展示行内 loading
    }

    let data = null;
    let lastError = null;
    do {
        DirectoryStore.rerun = false;
        // 循环内请求严格串行：最后一轮一定发起于最近一次刷新请求之后，
        // 因此其结果就是最新数据；中途每轮结果先暂存，结束时统一落地。
        data = null;
        lastError = null;
        try {
            const response = await fetch(`${API_BASE}/files`);
            if (!response.ok) {
                throw new Error(`服务异常（${response.status}）`);
            }
            const files = await response.json();
            if (!Array.isArray(files)) {
                throw new Error('目录数据格式错误');
            }
            data = files;
        } catch (error) {
            lastError = error;
        }
    } while (DirectoryStore.rerun);

    if (data !== null) {
        DirectoryStore.setFiles(data);
        renderDirectory();
    } else if (lastError) {
        // 失败时不清空已有目录数据，只显示错误提示，避免“刷新失败 → 列表变空”
        if (DirectoryStore.loaded) {
            renderDirectory();
            const list = document.getElementById('fileList');
            const note = buildMessageRow(`刷新失败: ${lastError.message}（列表为上次成功加载的数据）`, 'error');
            list.insertBefore(note, list.firstChild);
        } else {
            renderDirectoryError(lastError.message);
        }
    }

    DirectoryStore.inflight = null;
    setRefreshPending(false);
}

function setRefreshPending(pending) {
    const btn = document.getElementById('refreshBtn');
    if (btn) {
        btn.disabled = pending;
        btn.classList.toggle('spinning', pending);
    }
}

function initDirectoryToolbar() {
    const searchInput = document.getElementById('fileSearch');
    searchInput.addEventListener('input', (e) => {
        // 筛选只改本地关键字并重绘，不发请求，因此不存在与刷新的竞态
        DirectoryStore.keyword = e.target.value;
        renderDirectory();
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
        refreshDirectory();
    });
}

// ============================================================================
// 目录渲染：每条记录渲染为以 data-id 关联的一行；name/size 全部 textContent 赋值，
// 杜绝字符串拼接造成的名称错位、引号注入与重复显示。
// ============================================================================
function renderDirectory() {
    const list = document.getElementById('fileList');
    const meta = document.getElementById('directoryMeta');
    list.textContent = '';

    if (!DirectoryStore.loaded) {
        meta.textContent = '';
        list.appendChild(buildMessageRow('正在加载目录…', 'loading'));
        return;
    }

    const all = DirectoryStore.files;
    const visible = DirectoryStore.visibleFiles();
    const activeCount = all.filter(f => !f.deleted).length;
    const deletedCount = all.length - activeCount;
    const filtering = DirectoryStore.keyword.trim().length > 0;

    meta.textContent = `共 ${all.length} 条记录（可下载 ${activeCount} 条，已删除 ${deletedCount} 条）`
        + (filtering ? `，筛选命中 ${visible.length} 条` : '');

    // 空目录 与 条件无结果 必须区分
    if (all.length === 0) {
        list.appendChild(buildMessageRow('目录为空：暂无任何文件记录', 'empty'));
        return;
    }
    if (visible.length === 0) {
        list.appendChild(buildMessageRow(
            `没有文件名包含“${DirectoryStore.keyword.trim()}”的记录（目录中实际有 ${all.length} 条）`,
            'no-result'
        ));
        return;
    }

    for (const file of visible) {
        list.appendChild(buildFileRow(file));
    }
}

function renderDirectoryError(message) {
    const list = document.getElementById('fileList');
    list.textContent = '';
    list.appendChild(buildMessageRow(`加载失败: ${message}（点击右上角“刷新”重试）`, 'error'));
}

function buildMessageRow(text, kind) {
    const row = document.createElement('div');
    row.className = `directory-message directory-message-${kind}`;
    row.textContent = text;
    return row;
}

function buildFileRow(file) {
    const row = document.createElement('div');
    row.className = 'file-item' + (file.deleted ? ' file-item-deleted' : '');
    row.dataset.id = file.id;

    const info = document.createElement('div');
    info.className = 'file-info';

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = getFileIcon(file.name);

    const details = document.createElement('div');
    details.className = 'file-details';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;   // 名称严格绑定本行记录，不依赖拼接顺序

    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = file.deleted
        ? `原大小 ${formatSize(file.size)} · 已删除`
        : formatSize(file.size);    // 大小与名称来自同一对象，不可能错位到别的记录

    details.append(name, size);

    if (file.deleted && file.delete_reason) {
        const reason = document.createElement('div');
        reason.className = 'file-delete-reason';
        reason.textContent = `删除原因：${file.delete_reason}`;
        details.appendChild(reason);
    }

    info.append(icon, details);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const detailBtn = document.createElement('button');
    detailBtn.className = 'detail-btn';
    detailBtn.textContent = '详情';
    detailBtn.dataset.action = 'detail';
    detailBtn.dataset.id = file.id;
    actions.appendChild(detailBtn);

    if (!file.deleted) {
        if (TokenManager.get()) {
            const shareBtn = document.createElement('button');
            shareBtn.className = 'share-btn';
            shareBtn.textContent = '分享';
            shareBtn.dataset.action = 'share';
            shareBtn.dataset.id = file.id;
            shareBtn.dataset.name = file.name;
            actions.appendChild(shareBtn);
        }
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = '下载';
        downloadBtn.dataset.action = 'download';
        downloadBtn.dataset.id = file.id;
        actions.appendChild(downloadBtn);
    }

    row.append(info, actions);
    return row;
}

// 目录操作统一走事件委托：data-id 即稳定主键，避免内联 onclick 的引号注入
document.getElementById('fileList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id, name } = btn.dataset;

    if (action === 'detail') {
        openFileDetail(id);
    } else if (action === 'share') {
        openShareModal(id, name);
    } else if (action === 'download') {
        requestDownload(id);
    }
});

// 请求下载 - 检查token是否有效，有效则直接下载
async function requestDownload(fileId) {
    showLoading('检查授权...');

    // 检查是否有有效的token
    if (await TokenManager.isValid()) {
        // token有效，使用 fetch + Authorization 头下载
        document.getElementById('loadingText').textContent = '正在下载...';
        try {
            const response = await fetch(`${API_BASE}/download/${fileId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${TokenManager.get()}`
                }
            });
            if (response.ok) {
                await saveBlobResponse(response);
            } else {
                const result = await response.json().catch(() => ({}));
                if (response.status === 410) {
                    await refreshDirectory();
                }
                alert(`下载失败: ${result.error || '未知错误'}`);
            }
        } catch (error) {
            alert(`下载失败: ${error.message}`);
        } finally {
            hideLoading();
        }
        return;
    }

    // token无效或不存在，弹出登录框
    hideLoading();
    TokenManager.clear();
    document.getElementById('downloadFileId').value = fileId;
    document.getElementById('authModal').classList.add('active');
    document.getElementById('authError').textContent = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('username').focus();
}

// 将 fetch 得到的文件响应落盘
async function saveBlobResponse(response) {
    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'download';
    if (contentDisposition) {
        const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
        if (match) filename = decodeURIComponent(match[1]);
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
}

// 关闭验证弹窗
function closeAuthModal() {
    document.getElementById('authModal').classList.remove('active');
}

// 身份验证表单提交
document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const fileId = document.getElementById('downloadFileId').value;

    if (!username || !password) {
        document.getElementById('authError').textContent = '请输入用户名和密码';
        return;
    }

    showLoading('验证身份...');

    try {
        const response = await fetch(`${API_BASE}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            // 保存token和用户名到本地
            TokenManager.save(result.token, username);
            await updateUserBar();
            await refreshDirectory();

            closeAuthModal();
            document.getElementById('loadingText').textContent = '验证成功，正在下载...';

            // 使用 fetch + Authorization 头下载
            try {
                const downloadResponse = await fetch(`${API_BASE}/download/${fileId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${result.token}`
                    }
                });
                if (downloadResponse.ok) {
                    await saveBlobResponse(downloadResponse);
                } else {
                    const errResult = await downloadResponse.json().catch(() => ({}));
                    if (downloadResponse.status === 410) {
                        await refreshDirectory();
                    }
                    document.getElementById('authError').textContent = `下载失败: ${errResult.error || '未知错误'}`;
                }
            } catch (downloadError) {
                document.getElementById('authError').textContent = `下载失败: ${downloadError.message}`;
            } finally {
                hideLoading();
            }
        } else if (response.status === 429) {
            hideLoading();
            document.getElementById('authError').textContent = '请求过于频繁，请稍后再试';
        } else {
            hideLoading();
            document.getElementById('authError').textContent = result.error || '验证失败，请检查账号密码';
        }
    } catch (error) {
        hideLoading();
        document.getElementById('authError').textContent = `验证失败: ${error.message}`;
    }
});

// 显示加载动画
function showLoading(text = '加载中...') {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').classList.add('active');
}

// 隐藏加载动画
function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('active');
}

// 获取文件图标
function getFileIcon(filename) {
    if (!filename || !filename.includes('.')) return '📁';
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
        mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬',
        zip: '📦', rar: '📦', '7z': '📦',
        js: '💻', py: '🐍', html: '🌐', css: '🎨'
    };
    return icons[ext] || '📁';
}

// 格式化文件大小（null/undefined/非法值安全降级，不再产生 NaN 错位）
function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '未知大小';
    if (n === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
    return parseFloat((n / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化 SQLite 时间（UTC, 'YYYY-MM-DD HH:MM:SS'）
function formatDbTimestamp(timestamp) {
    if (!timestamp) return '未知时间';
    const d = new Date(timestamp.endsWith('Z') ? timestamp : timestamp.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return timestamp;
    return d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 格式化时间戳
function formatTimestamp(timestamp) {
    if (!timestamp) return '永久有效';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 格式化剩余时间
function formatRemainingTime(expiresAt) {
    if (!expiresAt) return '永久';
    const remaining = expiresAt - (Date.now() / 1000);
    if (remaining <= 0) return '已过期';

    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        return `${days} 天 ${hours % 24} 小时`;
    } else if (hours > 0) {
        return `${hours} 小时 ${minutes} 分钟`;
    } else {
        return `${minutes} 分钟`;
    }
}

// ============================================================================
// 文件详情：每次打开都按稳定 ID 重新拉取，渲染对象与列表是同一条后端记录
// ============================================================================
let detailSeq = 0;

async function openFileDetail(fileId) {
    const modal = document.getElementById('fileDetailModal');
    const body = document.getElementById('fileDetailBody');
    const seq = ++detailSeq;

    body.textContent = '';
    const loading = document.createElement('p');
    loading.className = 'detail-loading';
    loading.textContent = '正在加载详情…';
    body.appendChild(loading);
    modal.classList.add('active');

    try {
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`);
        const data = await response.json().catch(() => ({}));

        if (seq !== detailSeq) return;  // 旧请求结果丢弃，防止弹窗串状态

        if (!response.ok) {
            renderDetailError(data.error || '文件不存在');
            return;
        }
        renderFileDetail(normalizeFile(data));
    } catch (error) {
        if (seq === detailSeq) {
            renderDetailError(`加载失败: ${error.message}`);
        }
    }
}

function renderDetailError(message) {
    const body = document.getElementById('fileDetailBody');
    body.textContent = '';
    const box = document.createElement('div');
    box.className = 'detail-error';
    box.textContent = `⚠️ ${message}`;
    body.appendChild(box);
}

function renderFileDetail(file) {
    const body = document.getElementById('fileDetailBody');
    body.textContent = '';

    // 与列表行做显式对应提示
    const banner = document.createElement('p');
    banner.className = 'detail-id-banner';
    banner.textContent = `记录 ID：${file.id}`;
    body.appendChild(banner);

    const addRow = (label, value, extraClass = '') => {
        const item = document.createElement('div');
        item.className = 'detail-row' + (extraClass ? ` ${extraClass}` : '');
        const l = document.createElement('span');
        l.className = 'detail-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'detail-value';
        v.textContent = value;
        item.append(l, v);
        body.appendChild(item);
    };

    const iconLine = document.createElement('div');
    iconLine.className = 'detail-icon';
    iconLine.textContent = getFileIcon(file.name);
    body.appendChild(iconLine);

    addRow('文件名称', file.name);
    addRow('文件大小', formatSize(file.size));
    addRow('上传时间', formatDbTimestamp(file.uploaded_at));
    addRow('上传者', file.uploaded_by || '匿名用户');
    addRow('状态', file.deleted ? '已删除（记录保留）' : '正常', file.deleted ? 'status-deleted' : 'status-active');

    if (file.deleted) {
        addRow('删除时间', formatTimestamp(file.deleted_at));
        addRow('删除原因', file.delete_reason || '未记录', 'status-deleted');
    }

    if (!file.deleted) {
        const actions = document.createElement('div');
        actions.className = 'detail-actions';

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn-primary';
        downloadBtn.textContent = '下载此文件';
        downloadBtn.addEventListener('click', () => {
            closeFileDetail();
            requestDownload(file.id);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-secondary btn-danger';
        deleteBtn.textContent = '删除此文件';
        deleteBtn.addEventListener('click', () => deleteFile(file.id));

        actions.append(downloadBtn, deleteBtn);
        body.appendChild(actions);
    }
}

function closeFileDetail() {
    detailSeq++;  // 使任何在途详情请求失效，下次打开从 loading 状态开始
    document.getElementById('fileDetailModal').classList.remove('active');
}

// ============================================================================
// 文件删除：软删除，原行保留并展示原因
// ============================================================================
async function deleteFile(fileId) {
    if (!TokenManager.get()) {
        alert('请先登录后再删除文件');
        return;
    }

    const current = DirectoryStore.getById(fileId);
    if (current && current.deleted) {
        alert(`该文件已删除。\n删除原因：${current.delete_reason || '未记录'}`);
        return;
    }

    const reason = prompt(
        `确定删除文件「${current ? current.name : fileId}」吗？\n`
        + '删除后记录会保留在目录中并标注原因，文件将不可下载。\n请填写删除原因：',
        ''
    );
    if (reason === null) return;  // 用户取消

    showLoading('删除中...');
    try {
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TokenManager.get()}`
            },
            body: JSON.stringify({ reason: reason.trim() })
        });
        const result = await response.json().catch(() => ({}));

        if (response.ok && result.success) {
            closeFileDetail();
            await refreshDirectory();  // 等刷新完成再收尾，行保留、原因可见
        } else if (response.status === 409) {
            // 已被他人删除：原行仍保留，展示既有原因
            await refreshDirectory();
            alert(`该文件已被删除。\n删除原因：${result.delete_reason || '未记录'}`);
        } else if (response.status === 401) {
            alert('登录已过期，请重新验证后再试');
            TokenManager.clear();
            await updateUserBar();
            renderDirectory();
        } else {
            alert(`删除失败: ${result.error || '未知错误'}`);
        }
    } catch (error) {
        alert(`删除失败: ${error.message}`);
    } finally {
        hideLoading();
    }
}

// 打开分享设置弹窗
function openShareModal(fileId, fileName) {
    currentShareFileId = fileId;
    document.getElementById('shareFileName').textContent = fileName;
    document.getElementById('shareError').textContent = '';
    document.getElementById('expireHours').value = '24';
    document.getElementById('maxDownloads').value = '10';
    document.getElementById('shareModal').classList.add('active');
}

// 关闭分享设置弹窗
function closeShareModal() {
    document.getElementById('shareModal').classList.remove('active');
    currentShareFileId = null;
}

// 确认创建分享链接
async function confirmCreateShare() {
    if (!currentShareFileId) return;

    const expireHours = parseInt(document.getElementById('expireHours').value);
    const maxDownloads = parseInt(document.getElementById('maxDownloads').value);

    showLoading('生成分享链接...');
    document.getElementById('shareError').textContent = '';

    try {
        const response = await fetch(`${API_BASE}/share`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TokenManager.get()}`
            },
            body: JSON.stringify({
                file_id: currentShareFileId,
                expire_hours: expireHours,
                max_downloads: maxDownloads
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            closeShareModal();
            showShareSuccessModal(result);
            loadMyShares();
        } else {
            document.getElementById('shareError').textContent = result.error || '生成分享链接失败';
        }
    } catch (error) {
        document.getElementById('shareError').textContent = `错误: ${error.message}`;
    } finally {
        hideLoading();
    }
}

// 显示分享成功弹窗
function showShareSuccessModal(result) {
    currentShareLink = `${window.location.origin}/share.html#${result.share_id}`;

    document.getElementById('shareLinkInput').value = currentShareLink;
    document.getElementById('shareInfoName').textContent = result.filename;
    document.getElementById('shareInfoExpire').textContent = formatTimestamp(result.expires_at);
    document.getElementById('shareInfoDownloads').textContent = result.max_downloads ? `${result.max_downloads} 次` : '无限制';
    document.getElementById('copyBtnText').textContent = '复制';

    const copyBtn = document.querySelector('.copy-btn');
    copyBtn.classList.remove('copied');

    document.getElementById('shareSuccessModal').classList.add('active');
}

// 关闭分享成功弹窗
function closeShareSuccessModal() {
    document.getElementById('shareSuccessModal').classList.remove('active');
    currentShareLink = null;
}

// 复制分享链接
async function copyShareLink() {
    const linkInput = document.getElementById('shareLinkInput');
    const copyBtnText = document.getElementById('copyBtnText');
    const copyBtn = document.querySelector('.copy-btn');

    try {
        await navigator.clipboard.writeText(linkInput.value);
        copyBtnText.textContent = '已复制';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyBtnText.textContent = '复制';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (error) {
        linkInput.select();
        document.execCommand('copy');
        copyBtnText.textContent = '已复制';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyBtnText.textContent = '复制';
            copyBtn.classList.remove('copied');
        }, 2000);
    }
}

// 加载我的分享列表
async function loadMyShares() {
    const section = document.getElementById('mySharesSection');
    const list = document.getElementById('mySharesList');

    if (!(await TokenManager.isValid())) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';

    try {
        const response = await fetch(`${API_BASE}/shares`, {
            headers: {
                'Authorization': `Bearer ${TokenManager.get()}`
            }
        });

        const shares = await response.json();

        if (shares.length === 0) {
            list.textContent = '';
            list.appendChild(buildMessageRow('暂无分享链接', 'empty'));
            return;
        }

        list.textContent = '';
        for (const share of shares) {
            list.appendChild(buildShareRow(share));
        }
    } catch (error) {
        list.textContent = '';
        list.appendChild(buildMessageRow(`加载失败: ${error.message}`, 'error'));
    }
}

function buildShareRow(share) {
    const item = document.createElement('div');
    item.className = 'share-item';
    item.dataset.shareId = share.share_id;

    const header = document.createElement('div');
    header.className = 'share-item-header';

    const filename = document.createElement('span');
    filename.className = 'share-item-filename';
    filename.textContent = share.filename;

    const status = document.createElement('span');
    const valid = Boolean(share.is_valid);
    status.className = `share-item-status ${valid ? 'valid' : 'invalid'}`;
    status.textContent = valid ? '有效' : (share.error_msg || '无效');

    header.append(filename, status);

    const details = document.createElement('div');
    details.className = 'share-item-details';
    const addDetail = (label, value) => {
        const box = document.createElement('div');
        box.className = 'share-item-detail';
        const l = document.createElement('span');
        l.className = 'share-item-detail-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'share-item-detail-value';
        v.textContent = value;
        box.append(l, v);
        details.appendChild(box);
    };
    addDetail('剩余时间', formatRemainingTime(share.expires_at));
    addDetail('已下载', `${share.download_count} / ${share.max_downloads || '∞'}`);
    addDetail('创建时间', new Date(share.created_at).toLocaleString('zh-CN'));

    const actions = document.createElement('div');
    actions.className = 'share-item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-link-btn';
    copyBtn.textContent = '🔗 复制链接';
    copyBtn.addEventListener('click', () => copyShareLinkFromList(share.share_id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-share-btn';
    deleteBtn.textContent = '🗑️ 删除';
    deleteBtn.addEventListener('click', () => deleteShare(share.share_id));

    actions.append(copyBtn, deleteBtn);

    item.append(header, details, actions);
    return item;
}

// 从分享列表复制链接
async function copyShareLinkFromList(shareId) {
    const link = `${window.location.origin}/share.html#${shareId}`;
    try {
        await navigator.clipboard.writeText(link);
        alert('分享链接已复制到剪贴板');
    } catch (error) {
        prompt('请手动复制链接:', link);
    }
}

// 删除分享链接
async function deleteShare(shareId) {
    if (!confirm('确定要删除此分享链接吗？删除后链接将立即失效。')) {
        return;
    }

    showLoading('删除中...');

    try {
        const response = await fetch(`${API_BASE}/share/${shareId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${TokenManager.get()}`
            }
        });

        if (response.ok) {
            await loadMyShares();
        } else {
            const result = await response.json();
            alert(`删除失败: ${result.error || '未知错误'}`);
        }
    } catch (error) {
        alert(`删除失败: ${error.message}`);
    } finally {
        hideLoading();
    }
}
