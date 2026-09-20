"""文件路由"""
import os
import re
import uuid
import time
import logging
from flask import request, jsonify, send_file
from werkzeug.utils import secure_filename
from routes import files_bp
from database import get_db
from auth import verify_token, get_username_from_token, login_required
from config import UPLOAD_FOLDER, MAX_FILE_SIZE, BLOCKED_EXTENSIONS, SHARE_LINK_EXPIRE_HOURS, SHARE_LINK_MAX_DOWNLOADS

logger = logging.getLogger(__name__)


def allowed_file(filename):
    """检查文件扩展名是否被禁止"""
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    return ext not in BLOCKED_EXTENSIONS


def serialize_file(row):
    """统一的文件记录序列化出口。

    列表与详情必须经过同一个映射函数，保证两端看到的同一对象字段一致；
    服务端绝对路径 path 不下发到前端。
    """
    return {
        'id': row['id'],
        'name': row['name'],
        'size': row['size'],
        'uploaded_at': row['uploaded_at'],
        'uploaded_by': row['uploaded_by'],
        'deleted': bool(row['deleted']),
        'deleted_at': row['deleted_at'],
        'delete_reason': row['delete_reason'],
    }


def safe_remove_disk_file(path):
    """尽力删除磁盘文件，失败仅记录日志（数据库状态仍是权威来源）。"""
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError as exc:
        logger.warning(f'删除磁盘文件失败: {path}, {exc}')


@files_bp.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '未选择文件'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': '不支持的文件类型'}), 400

    file.seek(0, 2)
    file_size = file.tell()
    file.seek(0)

    if file_size > MAX_FILE_SIZE:
        return jsonify({'error': f'文件大小超过限制（最大{MAX_FILE_SIZE // 1024 // 1024}MB）'}), 400

    file_id = str(uuid.uuid4())
    # 保留原始文件名用于显示（去掉路径分隔符防止注入）
    original_name = re.sub(r'[/\\]', '_', file.filename).strip()
    if not original_name:
        original_name = file_id

    # 磁盘上用 UUID + 扩展名存储，避免文件名编码问题
    ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    safe_filename = f"{file_id}.{ext}" if ext else file_id
    filepath = os.path.join(UPLOAD_FOLDER, safe_filename)
    file.save(filepath)

    file_size = os.path.getsize(filepath)

    # 上传者可能携带 token（可选），用于目录展示
    username = None
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        username = get_username_from_token(auth_header[7:])

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO files (id, name, path, size, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        (file_id, original_name, filepath, file_size, username)
    )
    conn.commit()
    cursor.execute(
        'SELECT id, name, size, uploaded_at, uploaded_by, deleted, deleted_at, delete_reason '
        'FROM files WHERE id = ?',
        (file_id,)
    )
    record = serialize_file(cursor.fetchone())
    conn.close()

    logger.info(f"文件上传成功: {original_name} (ID: {file_id}, 大小: {file_size} bytes)")
    # 返回完整记录，前端可直接并入目录，不依赖旧列表缓存
    return jsonify({'success': True, 'file': record, 'file_id': file_id, 'filename': original_name})


@files_bp.route('/api/files', methods=['GET'])
def list_files():
    """文件目录：返回全部记录（含已删除条目，保留行与删除原因）。

    排序固定：未删除在前、已删除在后，各自按上传时间倒序、id 兜底，
    保证连续刷新顺序稳定，同一条记录只出现一次（主键唯一 + 单层映射）。
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, name, size, uploaded_at, uploaded_by, deleted, deleted_at, delete_reason
        FROM files
        ORDER BY deleted ASC,
                 datetime(uploaded_at) DESC,
                 id ASC
    ''')
    files = [serialize_file(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(files)


@files_bp.route('/api/files/<file_id>', methods=['GET'])
def get_file(file_id):
    """文件详情：列表与详情通过同一稳定 ID 拿到同一对象。"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id, name, size, uploaded_at, uploaded_by, deleted, deleted_at, delete_reason '
        'FROM files WHERE id = ?',
        (file_id,)
    )
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({'error': '文件不存在或已从目录中移除'}), 404

    return jsonify(serialize_file(row))


@files_bp.route('/api/files/<file_id>', methods=['DELETE'])
@login_required
def delete_file(file_id):
    """软删除：保留原行，写入删除原因与删除时间。

    - 不存在的记录：404
    - 已删除的记录：409 冲突，并回传原删除原因（重复删除不覆盖、不丢原因）
    """
    data = request.get_json(silent=True) or {}
    reason = (data.get('reason') or '').strip() or '用户未填写删除原因'
    if len(reason) > 200:
        reason = reason[:200]

    token = get_token_from_request()
    username = get_username_from_token(token)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT path, deleted, delete_reason FROM files WHERE id = ?', (file_id,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({'error': '文件不存在或已从目录中移除'}), 404

    if row['deleted']:
        conn.close()
        return jsonify({
            'error': '该文件已删除',
            'delete_reason': row['delete_reason']
        }), 409

    deleted_at = time.time()
    cursor.execute(
        'UPDATE files SET deleted = 1, deleted_at = ?, delete_reason = ? WHERE id = ?',
        (deleted_at, reason, file_id)
    )
    conn.commit()
    cursor.execute(
        'SELECT id, name, size, uploaded_at, uploaded_by, deleted, deleted_at, delete_reason '
        'FROM files WHERE id = ?',
        (file_id,)
    )
    record = serialize_file(cursor.fetchone())
    conn.close()

    # 数据库落库后再移除磁盘文件；失败不影响删除结果
    safe_remove_disk_file(row['path'])

    logger.info(f"文件软删除: ID {file_id}, 操作者 {username}, 原因: {reason}")
    return jsonify({'success': True, 'message': '文件已删除', 'file': record})


@files_bp.route('/api/download/<file_id>', methods=['GET'])
def download_file(file_id):
    # 优先从 Authorization 头获取 token，兼容查询参数（已废弃）
    token = get_token_from_request()

    if not token or not verify_token(token):
        return jsonify({'error': '未授权或token已过期'}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT name, path, deleted, delete_reason FROM files WHERE id = ?', (file_id,))
    file_info = cursor.fetchone()
    conn.close()

    if not file_info:
        return jsonify({'error': '文件不存在'}), 404

    if file_info['deleted']:
        return jsonify({
            'error': f"文件已删除，无法下载（删除原因：{file_info['delete_reason'] or '未记录'}）"
        }), 410

    if not os.path.abspath(file_info['path']).startswith(os.path.abspath(UPLOAD_FOLDER)):
        return jsonify({'error': '非法文件路径'}), 403

    if not os.path.exists(file_info['path']):
        return jsonify({'error': '文件不存在'}), 404

    logger.info(f"文件下载: {file_info['name']} (ID: {file_id})")
    return send_file(file_info['path'], as_attachment=True, download_name=file_info['name'])


def generate_short_id():
    """生成短的分享链接ID"""
    return uuid.uuid4().hex[:12]


def get_share_link_info(share_id):
    """获取分享链接信息，包含文件信息和有效性检查"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT s.id, s.file_id, s.created_by, s.expires_at, s.max_downloads, s.download_count, s.created_at,
               f.name as filename, f.size as filesize, f.deleted as file_deleted
        FROM share_links s
        JOIN files f ON s.file_id = f.id
        WHERE s.id = ?
    ''', (share_id,))
    share = cursor.fetchone()
    conn.close()
    return share


def is_share_valid(share):
    """检查分享链接是否有效"""
    if not share:
        return False, '分享链接不存在'

    if share['file_deleted']:
        return False, '分享的文件已被删除'

    if share['expires_at'] is not None and share['expires_at'] < time.time():
        return False, '分享链接已过期'

    if share['max_downloads'] is not None and share['download_count'] >= share['max_downloads']:
        return False, '分享链接下载次数已用完'

    return True, None


def increment_download_count(share_id):
    """增加下载次数"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'UPDATE share_links SET download_count = download_count + 1 WHERE id = ?',
        (share_id,)
    )
    conn.commit()
    conn.close()


def get_token_from_request():
    """从请求中获取 token"""
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:]
    return request.args.get('token')


@files_bp.route('/api/share', methods=['POST'])
@login_required
def create_share():
    """创建分享链接"""
    data = request.get_json()
    if not data:
        return jsonify({'error': '无效的请求数据'}), 400

    file_id = data.get('file_id', '').strip()
    expire_hours = data.get('expire_hours')
    max_downloads = data.get('max_downloads')

    if not file_id:
        return jsonify({'error': '文件ID不能为空'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, name, deleted, delete_reason FROM files WHERE id = ?', (file_id,))
    file_info = cursor.fetchone()

    if not file_info:
        conn.close()
        return jsonify({'error': '文件不存在'}), 404

    if file_info['deleted']:
        conn.close()
        return jsonify({
            'error': f"文件已删除，无法分享（删除原因：{file_info['delete_reason'] or '未记录'}）"
        }), 410

    if expire_hours is None:
        expire_hours = SHARE_LINK_EXPIRE_HOURS

    if expire_hours < 0:
        expire_hours = None

    if expire_hours is not None:
        expires_at = time.time() + expire_hours * 3600
    else:
        expires_at = None

    if max_downloads is None:
        max_downloads = SHARE_LINK_MAX_DOWNLOADS

    if max_downloads < 0:
        max_downloads = None

    token = get_token_from_request()
    username = get_username_from_token(token)

    share_id = generate_short_id()

    cursor.execute('''
        INSERT INTO share_links (id, file_id, created_by, expires_at, max_downloads)
        VALUES (?, ?, ?, ?, ?)
    ''', (share_id, file_id, username, expires_at, max_downloads))

    conn.commit()
    conn.close()

    logger.info(f"分享链接创建成功: 文件 {file_info['name']}, 分享ID {share_id}, 创建者 {username}")

    return jsonify({
        'success': True,
        'share_id': share_id,
        'expires_at': expires_at,
        'max_downloads': max_downloads,
        'filename': file_info['name']
    })


@files_bp.route('/api/share/<share_id>', methods=['GET'])
def get_share(share_id):
    """获取分享链接信息（公开访问）"""
    share = get_share_link_info(share_id)
    valid, error_msg = is_share_valid(share)

    if not share:
        return jsonify({'error': '分享链接不存在'}), 404

    share_data = {
        'share_id': share['id'],
        'filename': share['filename'],
        'filesize': share['filesize'],
        'created_by': share['created_by'],
        'expires_at': share['expires_at'],
        'max_downloads': share['max_downloads'],
        'download_count': share['download_count'],
        'created_at': share['created_at'],
        'is_valid': valid,
        'error_msg': error_msg
    }

    return jsonify(share_data)


@files_bp.route('/api/share/<share_id>/download', methods=['GET'])
def download_by_share(share_id):
    """通过分享链接下载文件（公开访问）"""
    share = get_share_link_info(share_id)
    valid, error_msg = is_share_valid(share)

    if not valid:
        return jsonify({'error': error_msg}), 404

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT name, path FROM files WHERE id = ?', (share['file_id'],))
    file_info = cursor.fetchone()
    conn.close()

    if not file_info:
        return jsonify({'error': '文件不存在'}), 404

    if not os.path.abspath(file_info['path']).startswith(os.path.abspath(UPLOAD_FOLDER)):
        return jsonify({'error': '非法文件路径'}), 403

    if not os.path.exists(file_info['path']):
        return jsonify({'error': '文件不存在'}), 404

    increment_download_count(share_id)

    logger.info(f"分享下载: 文件 {file_info['name']}, 分享ID {share_id}, 下载次数 {share['download_count'] + 1}")
    return send_file(file_info['path'], as_attachment=True, download_name=file_info['name'])


@files_bp.route('/api/shares', methods=['GET'])
@login_required
def list_shares():
    """获取当前用户的所有分享链接"""
    token = get_token_from_request()
    username = get_username_from_token(token)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT s.id, s.file_id, s.created_by, s.expires_at, s.max_downloads, s.download_count, s.created_at,
               f.name as filename, f.size as filesize, f.deleted as file_deleted
        FROM share_links s
        JOIN files f ON s.file_id = f.id
        WHERE s.created_by = ?
        ORDER BY s.created_at DESC
    ''', (username,))
    shares = cursor.fetchall()
    conn.close()

    result = []
    for share in shares:
        valid, error_msg = is_share_valid(share)
        result.append({
            'share_id': share['id'],
            'file_id': share['file_id'],
            'filename': share['filename'],
            'filesize': share['filesize'],
            'expires_at': share['expires_at'],
            'max_downloads': share['max_downloads'],
            'download_count': share['download_count'],
            'created_at': share['created_at'],
            'is_valid': valid,
            'error_msg': error_msg
        })

    return jsonify(result)


@files_bp.route('/api/share/<share_id>', methods=['DELETE'])
@login_required
def delete_share(share_id):
    """删除分享链接"""
    token = get_token_from_request()
    username = get_username_from_token(token)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT created_by, file_id FROM share_links WHERE id = ?', (share_id,))
    share = cursor.fetchone()

    if not share:
        conn.close()
        return jsonify({'error': '分享链接不存在'}), 404

    if share['created_by'] != username:
        conn.close()
        return jsonify({'error': '无权限删除此分享链接'}), 403

    cursor.execute('DELETE FROM share_links WHERE id = ?', (share_id,))
    conn.commit()
    conn.close()

    logger.info(f"分享链接删除: 分享ID {share_id}, 文件ID {share['file_id']}, 操作者 {username}")
    return jsonify({'success': True, 'message': '分享链接已删除'})
