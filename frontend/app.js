// 从配置文件获取API地址
const API_BASE = CONFIG.API_BASE;

let currentShareFileId = null;
let currentShareLink = null;

// ===== 文件库统一状态：列表渲染、筛选、详情全部以这里为唯一数据源 =====
const FileStore = {
    files: [],            // 后端返回的完整记录（含已删除墓碑行）
    loaded: false,        // 是否已成功加载过（区分"加载中/空目录/加载失败"）
    loadError: null,
    loadPromise: null,    // 进行中的刷新请求，合并并发触发，杜绝竞态导致的旧数据覆盖
    sequence: 0,          // 请求序号，过期响应不得覆盖新数据

    async fetch(force = false) {
        if (this.loadPromise && !force) return this.loadPromise;
        const seq = ++this.sequence;
        this.loadPromise = (async () => {
            try {
                const response = await fetch(`${API_BASE}/files`);
                if (!response.ok) throw new Error(`服务器错误 (${response.status})`);
                const files = await response.json();
                if (!Array.isArray(files)) throw new Error('列表数据格式错误');
                if (seq !== this.sequence) return files; // 已有更新的请求，丢弃本次结果

                // 以 id 为唯一键去重：正确记录只能出现一次
                const byId = new Map();
                for (const file of files) {
                    if (file && typeof file.id === 'string' && !byId.has(file.id)) {
                        byId.set(file.id, this.normalize(file));
                    }
                }
                this.files = Array.from(byId.values());
                this.loaded = true;
                this.loadError = null;
            } catch (error) {
                if (seq === this.sequence) {
                    this.loadError = error.message || '网络错误';
                    this.loaded = true; // 失败也算"有结论"，但保留旧数据不覆盖
                }
            } finally {
                if (seq === this.sequence) this.loadPromise = null;
            }
            return this.files;
        })();
        return this.loadPromise;
    },

    getById(id) {
        return this.files.find(f => f.id === id) || null;
    },

    normalize(file) {
        return {
            id: file.id,
            name: String(file.name ?? ''),
            size: Number.isFinite(file.size) ? file.size : 0,
            uploaded_at: file.uploaded_at || '',
            is_deleted: Boolean(file.is_deleted),
            deleted_reason: file.deleted_reason || '',
            deleted_at: file.deleted_at || null
        };
    },

    // 用服务端单条记录（上传/删除响应）同步本地状态，而不是依赖整表刷新时序
    upsert(file) {
        const normalized = this.normalize(file);
        const idx = this.files.findIndex(f => f.id === normalized.id);
        if (idx >= 0) this.files[idx] = normalized;
        else this.files.push(normalized);
    }
};

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
}

// 页面加载时获取文件列表和更新用户状态
document.addEventListener('DOMContentLoaded', async () => {
    // 检查token是否有效，无效则清除
    if (TokenManager.get() && !(await TokenManager.isValid())) {
        TokenManager.clear();
    }
    await updateUserBar();
    await refreshFileList();
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
            body: formData
        });
        const result = await response.json();

        if (response.ok && result.success && result.file && result.file.id) {
            // 上传成功只在服务端确认落库后提示，并用返回的权威记录更新状态，
            // 再强制刷新一次列表（await），避免"假成功"显示旧文件名
            FileStore.upsert(result.file);
            renderFileList();
            await refreshFileList({ force: true });
            document.getElementById('uploadStatus').textContent = `✅ ${result.file.name} 上传成功！`;
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

// ===== 文件列表刷新（合并并发 + 强制刷新）=====
async function refreshFileList({ force = false } = {}) {
    await FileStore.fetch(force);
    renderFileList();
}

// 筛选关键词
function getSearchKeyword() {
    const input = document.getElementById('fileSearch');
    return input ? input.value.trim().toLowerCase() : '';
}

// 渲染文件列表：纯由 FileStore 状态驱动，按 id 建立行映射
function renderFileList() {
    const fileList = document.getElementById('fileList');
    const keyword = getSearchKeyword();

    // 首次加载中
    if (!FileStore.loaded && FileStore.loadPromise) {
        fileList.innerHTML = '<p class="empty-msg">正在加载文件列表…</p>';
        return;
    }

    // 加载失败且本地无数据
    if (FileStore.loadError && FileStore.files.length === 0) {
        fileList.innerHTML =
            `<p class="empty-msg">加载失败: ${escapeHtml(FileStore.loadError)}，请点击刷新重试</p>`;
        return;
    }

    const visible = FileStore.files.filter(f => f.name.toLowerCase().includes(keyword));

    // 空目录（无任何记录）与条件无结果（有记录但筛选不命中）必须区分
    if (FileStore.files.length === 0) {
        fileList.innerHTML = '<p class="empty-msg">📂 目录为空，暂无文件</p>';
        return;
    }
    if (visible.length === 0) {
        fileList.innerHTML =
            `<p class="empty-msg">🔍 没有文件名包含 “${escapeHtml(keyword)}” 的记录</p>`;
        return;
    }

    fileList.innerHTML = visible.map(file => {
        if (file.is_deleted) {
            return `
                <div class="file-item file-item-deleted" data-id="${escapeHtml(file.id)}">
                    <div class="file-info">
                        <div class="file-icon">🗑️</div>
                        <div class="file-details">
                            <div class="file-name">${escapeHtml(file.name)}</div>
                            <div class="file-size">${formatSize(file.size)} · 原文件已删除</div>
                        </div>
                    </div>
                    <div class="file-actions">
                        <span class="deleted-reason-badge" title="删除原因">
                            已删除：${escapeHtml(file.deleted_reason || '未知原因')}
                        </span>
                        <button class="detail-btn" data-action="detail" data-id="${escapeHtml(file.id)}">详情</button>
                    </div>
                </div>
            `;
        }
        return `
            <div class="file-item" data-id="${escapeHtml(file.id)}">
                <div class="file-info">
                    <div class="file-icon">${getFileIcon(file.name)}</div>
                    <div class="file-details">
                        <div class="file-name">${escapeHtml(file.name)}</div>
                        <div class="file-size">${formatSize(file.size)}</div>
                    </div>
                </div>
                <div class="file-actions">
                    <button class="detail-btn" data-action="detail" data-id="${escapeHtml(file.id)}">详情</button>
                    <button class="delete-file-btn" data-action="delete-file" data-id="${escapeHtml(file.id)}">删除</button>
                    <button class="download-btn" data-action="download" data-id="${escapeHtml(file.id)}">
                        下载
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // 登录态决定分享按钮（避免在模板字符串里散落判断）
    injectShareButtons(fileList);
}

async function injectShareButtons(fileList) {
    const isLoggedIn = Boolean(TokenManager.get()) && await TokenManager.isValid();
    if (!isLoggedIn) return;
    fileList.querySelectorAll('.file-item:not(.file-item-deleted)').forEach(item => {
        const id = item.dataset.id;
        const actions = item.querySelector('.file-actions');
        if (actions && !actions.querySelector('[data-action="share"]')) {
            const btn = document.createElement('button');
            btn.className = 'share-btn';
            btn.dataset.action = 'share';
            btn.dataset.id = id;
            btn.textContent = '分享';
            actions.insertBefore(btn, actions.firstChild);
        }
    });
}

// 列表内事件委托：id 从 data-id 取，杜绝按行号/位置错位
document.getElementById('fileList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
        case 'detail':
            openFileDetail(id);
            break;
        case 'download':
            requestDownload(id);
            break;
        case 'delete-file':
            deleteFile(id);
            break;
        case 'share': {
            const file = FileStore.getById(id);
            if (file) openShareModal(file.id, file.name);
            break;
        }
    }
});

// 筛选输入：仅重渲染，不重新请求
document.getElementById('fileSearch').addEventListener('input', () => {
    renderFileList();
});

// 手动刷新：强制重新请求
document.getElementById('refreshFilesBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshFilesBtn');
    btn.disabled = true;
    try {
        await refreshFileList({ force: true });
    } finally {
        btn.disabled = false;
    }
});

// 删除文件：软删除，列表保留原行并显示原因
async function deleteFile(fileId) {
    const file = FileStore.getById(fileId);
    if (!file || file.is_deleted) return;

    const reason = prompt(`删除文件「${file.name}」？\n请填写删除原因（原行将保留并展示该原因）：`, '用户主动删除');
    if (reason === null) return; // 用户取消

    showLoading('删除中...');
    try {
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() || '用户主动删除' })
        });
        const result = await response.json();

        if (response.ok && result.success) {
            FileStore.upsert(result.file);
            renderFileList();
            loadMyShares(); // 文件删除会使关联分享失效，同步刷新分享列表
        } else if (response.status === 409) {
            // 已被别人/别处删除：刷新拿权威墓碑状态
            await refreshFileList({ force: true });
        } else {
            alert(`删除失败: ${result.error || '未知错误'}`);
        }
    } catch (error) {
        alert(`删除失败: ${error.message}`);
    } finally {
        hideLoading();
    }
}

// ===== 文件详情：始终按 id 请求服务端，与列表同源 =====
let detailRequestSeq = 0;

async function openFileDetail(fileId) {
    const modal = document.getElementById('fileDetailModal');
    const loading = document.getElementById('fileDetailLoading');
    const body = document.getElementById('fileDetailBody');
    const errorBox = document.getElementById('fileDetailError');
    const seq = ++detailRequestSeq;

    // 打开前先复位三个视图，避免上次详情的字段残留导致"对不上"
    loading.style.display = 'block';
    body.style.display = 'none';
    errorBox.style.display = 'none';
    modal.classList.add('active');

    try {
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`);
        const result = await response.json();
        if (seq !== detailRequestSeq) return; // 用户已切换到其它详情

        if (response.ok) {
            showFileDetailBody(result, false);
        } else if (response.status === 410 && result.file) {
            showFileDetailBody(result.file, true);
        } else {
            loading.style.display = 'none';
            errorBox.style.display = 'block';
            document.getElementById('detailErrorMessage').textContent = result.error || '文件不存在';
        }
    } catch (error) {
        if (seq !== detailRequestSeq) return;
        loading.style.display = 'none';
        errorBox.style.display = 'block';
        document.getElementById('detailErrorMessage').textContent = `加载失败: ${error.message}`;
    }
}

function showFileDetailBody(file, isDeleted) {
    document.getElementById('fileDetailLoading').style.display = 'none';
    document.getElementById('fileDetailError').style.display = 'none';
    document.getElementById('fileDetailBody').style.display = 'block';

    document.getElementById('detailIcon').textContent = isDeleted ? '🗑️' : getFileIcon(file.name);
    document.getElementById('detailName').textContent = file.name;
    document.getElementById('detailSize').textContent = formatSize(file.size);
    document.getElementById('detailUploadedAt').textContent = file.uploaded_at
        ? new Date(file.uploaded_at.replace(' ', 'T') + 'Z').toLocaleString('zh-CN')
        : '未知';
    document.getElementById('detailId').textContent = file.id;

    const note = document.getElementById('detailDeletedNote');
    if (isDeleted) {
        note.style.display = 'block';
        note.textContent = `该文件已删除，原因：${file.deleted_reason || '未知原因'}`;
    } else {
        note.style.display = 'none';
    }

    // 操作按钮：仅未删除文件可下载/分享
    const actions = document.getElementById('detailActions');
    const isLoggedIn = Boolean(TokenManager.get());
    actions.innerHTML = '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', closeFileDetail);
    actions.appendChild(closeBtn);

    if (!isDeleted) {
        if (isLoggedIn) {
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'btn-secondary';
            shareBtn.textContent = '创建分享';
            shareBtn.addEventListener('click', () => {
                closeFileDetail();
                openShareModal(file.id, file.name);
            });
            actions.appendChild(shareBtn);
        }
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'btn-primary';
        dlBtn.textContent = '下载';
        dlBtn.addEventListener('click', () => {
            closeFileDetail();
            requestDownload(file.id);
        });
        actions.appendChild(dlBtn);
    }
}

function closeFileDetail() {
    detailRequestSeq++; // 使进行中的旧请求失效
    document.getElementById('fileDetailModal').classList.remove('active');
}

// HTML转义防止XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

// 请求下载 - 检查token是否有效，有效则直接下载
async function requestDownload(fileId) {
    const file = FileStore.getById(fileId);
    if (!file) return;
    if (file.is_deleted) {
        alert(`文件已被删除：${file.deleted_reason || '未知原因'}`);
        return;
    }

    showLoading('检查授权...');

    // 检查是否有有效的token
    if (await TokenManager.isValid()) {
        // token有效，使用 fetch + Authorization 头下载
        document.getElementById('loadingText').textContent = '正在下载...';
        try {
            const response = await fetch(`${API_BASE}/download/${encodeURIComponent(fileId)}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${TokenManager.get()}`
                }
            });
            if (response.ok) {
                await saveResponseAsFile(response, file.name);
            } else if (response.status === 410) {
                const result = await response.json();
                alert(result.error || '文件已被删除');
                await refreshFileList({ force: true });
            } else {
                const result = await response.json();
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

// 从下载响应中解析文件名并触发浏览器保存
async function saveResponseAsFile(response, fallbackName) {
    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = fallbackName || 'download';
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
            renderFileList(); // 登录后出现分享按钮

            closeAuthModal();
            document.getElementById('loadingText').textContent = '验证成功，正在下载...';

            // 使用 fetch + Authorization 头下载
            try {
                const downloadResponse = await fetch(`${API_BASE}/download/${encodeURIComponent(fileId)}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${result.token}`
                    }
                });
                if (downloadResponse.ok) {
                    const file = FileStore.getById(fileId);
                    await saveResponseAsFile(downloadResponse, file ? file.name : 'download');
                } else {
                    const errResult = await downloadResponse.json();
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
    const ext = (filename || '').split('.').pop().toLowerCase();
    const icons = {
        pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
        mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬',
        zip: '📦', rar: '📦', '7z': '📦',
        js: '💻', py: '🐍', html: '🌐', css: '🎨'
    };
    return icons[ext] || '📁';
}

// 格式化文件大小
function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return n === 0 ? '0 B' : '未知大小';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
    return parseFloat((n / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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

        if (response.status === 401) {
            TokenManager.clear();
            section.style.display = 'none';
            return;
        }

        const shares = await response.json();
        if (!Array.isArray(shares)) throw new Error('数据格式错误');

        // 以 share_id 去重，已删除的墓碑行同样只出现一次
        const byId = new Map();
        for (const share of shares) {
            if (share && typeof share.share_id === 'string' && !byId.has(share.share_id)) {
                byId.set(share.share_id, share);
            }
        }
        const unique = Array.from(byId.values());

        if (unique.length === 0) {
            list.innerHTML = '<p class="empty-msg">暂无分享链接</p>';
            return;
        }

        list.innerHTML = unique.map(share => {
            const deleted = Boolean(share.is_deleted);
            const fileName = share.filename
                ? escapeHtml(share.filename)
                : '<span class="share-missing-file">（关联文件记录不存在）</span>';

            let statusBadge;
            if (deleted) {
                statusBadge = `<span class="share-item-status invalid">已删除</span>`;
            } else {
                const statusClass = share.is_valid ? 'valid' : 'invalid';
                const statusText = share.is_valid ? '有效' : (escapeHtml(share.error_msg) || '无效');
                statusBadge = `<span class="share-item-status ${statusClass}">${statusText}</span>`;
            }

            // 删除原因/失效原因行（删除操作保留原行并说明原因）
            const reasonLine = deleted
                ? `<div class="share-item-detail">
                        <span class="share-item-detail-label">删除原因</span>
                        <span class="share-item-detail-value">${escapeHtml(share.deleted_reason || '未知原因')}</span>
                   </div>`
                : (!share.is_valid
                    ? `<div class="share-item-detail">
                        <span class="share-item-detail-label">失效原因</span>
                        <span class="share-item-detail-value">${escapeHtml(share.error_msg || '')}</span>
                       </div>`
                    : '');

            const disabledAttr = deleted ? 'disabled' : '';
            const itemClass = deleted ? 'share-item share-item-deleted' : 'share-item';

            return `
                <div class="${itemClass}" data-share-id="${escapeHtml(share.share_id)}">
                    <div class="share-item-header">
                        <span class="share-item-filename">${fileName}</span>
                        ${statusBadge}
                    </div>
                    <div class="share-item-details">
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">剩余时间</span>
                            <span class="share-item-detail-value">${deleted ? '—' : formatRemainingTime(share.expires_at)}</span>
                        </div>
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">已下载</span>
                            <span class="share-item-detail-value">${share.download_count} / ${share.max_downloads || '∞'}</span>
                        </div>
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">创建时间</span>
                            <span class="share-item-detail-value">${new Date(share.created_at).toLocaleString('zh-CN')}</span>
                        </div>
                        ${reasonLine}
                    </div>
                    <div class="share-item-actions">
                        <button class="copy-link-btn" data-action="copy-share" data-id="${escapeHtml(share.share_id)}">
                            🔗 复制链接
                        </button>
                        ${deleted
                            ? '<span class="share-deleted-hint">链接已失效</span>'
                            : `<button class="delete-share-btn" data-action="delete-share" data-id="${escapeHtml(share.share_id)}">🗑️ 删除</button>`}
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        list.innerHTML = `<p class="empty-msg">加载失败: ${escapeHtml(error.message)}</p>`;
    }
}

// 分享列表事件委托
document.getElementById('mySharesList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'copy-share') {
        copyShareLinkFromList(id);
    } else if (btn.dataset.action === 'delete-share') {
        deleteShare(id);
    }
});

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

// 删除分享链接（软删除，原行保留并展示原因）
async function deleteShare(shareId) {
    if (!confirm('确定要删除此分享链接吗？删除后链接将立即失效，列表中会保留该行并注明原因。')) {
        return;
    }

    showLoading('删除中...');

    try {
        const response = await fetch(`${API_BASE}/share/${encodeURIComponent(shareId)}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TokenManager.get()}`
            },
            body: JSON.stringify({ reason: '用户主动删除' })
        });

        if (response.ok) {
            await loadMyShares();
        } else if (response.status === 409) {
            // 已删除过：刷新显示既有墓碑状态
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
