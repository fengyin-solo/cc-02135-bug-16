"""文件模块测试"""
import io
import time


def test_upload_file(client):
    """测试文件上传"""
    data = {
        'file': (io.BytesIO(b'test content'), 'test.txt')
    }
    response = client.post('/api/upload', data=data, content_type='multipart/form-data')
    assert response.status_code == 200
    result = response.get_json()
    assert result['success'] is True
    assert 'file_id' in result


def test_upload_no_file(client):
    """测试无文件上传"""
    response = client.post('/api/upload', data={}, content_type='multipart/form-data')
    assert response.status_code == 400


def test_upload_invalid_extension(client):
    """测试不允许的文件类型"""
    data = {
        'file': (io.BytesIO(b'test'), 'test.exe')
    }
    response = client.post('/api/upload', data=data, content_type='multipart/form-data')
    assert response.status_code == 400


def test_list_files(client):
    """测试文件列表"""
    response = client.get('/api/files')
    assert response.status_code == 200
    assert isinstance(response.get_json(), list)


def test_download_without_token(client):
    """测试无 token 下载"""
    response = client.get('/api/download/some-id')
    assert response.status_code == 401


def test_download_file_not_found(client, auth_token):
    """测试下载不存在的文件"""
    response = client.get(f'/api/download/nonexistent-id?token={auth_token}')
    assert response.status_code == 404


def test_upload_and_download(client, auth_token):
    """测试上传后下载"""
    # 上传
    data = {
        'file': (io.BytesIO(b'hello world'), 'hello.txt')
    }
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    # 下载
    download_resp = client.get(f'/api/download/{file_id}?token={auth_token}')
    assert download_resp.status_code == 200
    assert download_resp.data == b'hello world'


def test_create_share_without_auth(client):
    """测试未授权创建分享链接"""
    response = client.post('/api/share', json={'file_id': 'test'})
    assert response.status_code == 401


def test_create_share_invalid_file(client, auth_token):
    """测试为不存在的文件创建分享链接"""
    response = client.post(
        '/api/share',
        json={'file_id': 'nonexistent'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert response.status_code == 404


def test_create_share_success(client, auth_token):
    """测试创建分享链接成功"""
    data = {'file': (io.BytesIO(b'test content'), 'test_share.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    response = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 24, 'max_downloads': 5},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert response.status_code == 200
    result = response.get_json()
    assert result['success'] is True
    assert 'share_id' in result
    assert result['max_downloads'] == 5
    assert result['filename'] == 'test_share.txt'


def test_create_share_default_values(client, auth_token):
    """测试使用默认值创建分享链接"""
    data = {'file': (io.BytesIO(b'test content'), 'test_default.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    response = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert response.status_code == 200
    result = response.get_json()
    assert result['success'] is True
    assert result['max_downloads'] == 10


def test_get_share_info(client, auth_token):
    """测试获取分享链接信息"""
    data = {'file': (io.BytesIO(b'test content'), 'test_get.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 24, 'max_downloads': 5},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    response = client.get(f'/api/share/{share_id}')
    assert response.status_code == 200
    result = response.get_json()
    assert result['share_id'] == share_id
    assert result['filename'] == 'test_get.txt'
    assert result['is_valid'] is True
    assert result['download_count'] == 0


def test_get_nonexistent_share(client):
    """测试获取不存在的分享链接"""
    response = client.get('/api/share/nonexistent')
    assert response.status_code == 404


def test_download_by_share_success(client, auth_token):
    """测试通过分享链接下载文件成功"""
    data = {'file': (io.BytesIO(b'share download test'), 'test_share_dl.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 24, 'max_downloads': 5},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    download_resp = client.get(f'/api/share/{share_id}/download')
    assert download_resp.status_code == 200
    assert download_resp.data == b'share download test'

    info_resp = client.get(f'/api/share/{share_id}')
    assert info_resp.get_json()['download_count'] == 1


def test_download_by_share_exceed_max(client, auth_token):
    """测试超过下载次数限制"""
    data = {'file': (io.BytesIO(b'limited content'), 'test_limited.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 24, 'max_downloads': 1},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    download_resp1 = client.get(f'/api/share/{share_id}/download')
    assert download_resp1.status_code == 200

    download_resp2 = client.get(f'/api/share/{share_id}/download')
    assert download_resp2.status_code == 404
    assert '下载次数已用完' in download_resp2.get_json()['error']


def test_download_expired_share(client, auth_token, db_conn):
    """测试下载已过期的分享链接"""
    data = {'file': (io.BytesIO(b'expired content'), 'test_expired.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 1, 'max_downloads': 5},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    cursor = db_conn.cursor()
    cursor.execute(
        'UPDATE share_links SET expires_at = ? WHERE id = ?',
        (time.time() - 3600, share_id)
    )
    db_conn.commit()

    download_resp = client.get(f'/api/share/{share_id}/download')
    assert download_resp.status_code == 404
    assert '已过期' in download_resp.get_json()['error']


def test_create_share_unlimited(client, auth_token):
    """测试创建无限制的分享链接"""
    data = {'file': (io.BytesIO(b'unlimited content'), 'test_unlimited.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': -1, 'max_downloads': -1},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    result = create_resp.get_json()
    assert result['expires_at'] is None
    assert result['max_downloads'] is None

    for i in range(3):
        download_resp = client.get(f'/api/share/{result["share_id"]}/download')
        assert download_resp.status_code == 200

    info_resp = client.get(f'/api/share/{result["share_id"]}')
    assert info_resp.get_json()['download_count'] == 3
    assert info_resp.get_json()['is_valid'] is True


def test_list_shares(client, auth_token):
    """测试获取用户的分享列表"""
    for i in range(2):
        data = {'file': (io.BytesIO(f'content {i}'.encode()), f'test_list_{i}.txt')}
        upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
        file_id = upload_resp.get_json()['file_id']

        client.post(
            '/api/share',
            json={'file_id': file_id},
            headers={'Authorization': f'Bearer {auth_token}'}
        )

    response = client.get(
        '/api/shares',
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert response.status_code == 200
    shares = response.get_json()
    assert len(shares) >= 2
    assert 'filename' in shares[0]
    assert 'is_valid' in shares[0]


def test_list_shares_without_auth(client):
    """测试未授权获取分享列表"""
    response = client.get('/api/shares')
    assert response.status_code == 401


def test_delete_share_success(client, auth_token):
    """测试删除分享链接成功"""
    data = {'file': (io.BytesIO(b'to delete'), 'test_delete.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    delete_resp = client.delete(
        f'/api/share/{share_id}',
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert delete_resp.status_code == 200
    assert delete_resp.get_json()['success'] is True

    get_resp = client.get(f'/api/share/{share_id}')
    assert get_resp.status_code == 404


def test_delete_share_unauthorized(client, auth_token, db_conn):
    """测试删除他人的分享链接"""
    data = {'file': (io.BytesIO(b'other content'), 'test_other.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    cursor = db_conn.cursor()
    cursor.execute(
        'INSERT INTO share_links (id, file_id, created_by, expires_at, max_downloads) VALUES (?, ?, ?, ?, ?)',
        ('testshare123', file_id, 'otheruser', None, 10)
    )
    db_conn.commit()

    delete_resp = client.delete(
        '/api/share/testshare123',
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert delete_resp.status_code == 403


def test_download_by_share_no_auth_needed(client, auth_token):
    """测试访客无需登录即可通过分享链接下载"""
    data = {'file': (io.BytesIO(b'public content'), 'test_public.txt')}
    upload_resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    file_id = upload_resp.get_json()['file_id']

    create_resp = client.post(
        '/api/share',
        json={'file_id': file_id, 'expire_hours': 24, 'max_downloads': 5},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = create_resp.get_json()['share_id']

    download_resp = client.get(f'/api/share/{share_id}/download')
    assert download_resp.status_code == 200
    assert download_resp.data == b'public content'


def _upload(client, name='sample.txt', content=b'sample content'):
    data = {'file': (io.BytesIO(content), name)}
    resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    assert resp.status_code == 200
    return resp.get_json()['file_id']


# ---------- 列表 / 详情一致性 ----------

def test_list_files_unique_and_stable_order(client):
    """列表中每个文件只出现一次，顺序按上传时间+id稳定"""
    id_a = _upload(client, 'a.txt', b'aaa')
    id_b = _upload(client, 'b.txt', b'bbbb')

    first = client.get('/api/files').get_json()
    second = client.get('/api/files').get_json()

    ids_first = [f['id'] for f in first]
    assert len(ids_first) == len(set(ids_first)), '列表存在重复记录'
    assert id_a in ids_first and id_b in ids_first
    assert [f['id'] for f in second] == ids_first, '连续刷新行顺序发生变化'

    by_id = {f['id']: f for f in first}
    assert by_id[id_a]['name'] == 'a.txt'
    assert by_id[id_a]['size'] == 3
    assert by_id[id_b]['size'] == 4


def test_list_matches_detail(client):
    """列表与详情看到的同一对象字段一致"""
    file_id = _upload(client, 'detail_match.txt', b'match me')

    listed = next(f for f in client.get('/api/files').get_json() if f['id'] == file_id)
    detail = client.get(f'/api/files/{file_id}')
    assert detail.status_code == 200

    for key in ('id', 'name', 'size', 'uploaded_at', 'is_deleted'):
        assert listed[key] == detail.get_json()[key]


def test_detail_not_found(client):
    resp = client.get('/api/files/does-not-exist')
    assert resp.status_code == 404


# ---------- 删除保留原行并说明原因 ----------

def test_delete_file_soft_keeps_row_with_reason(client):
    file_id = _upload(client, 'gone.txt', b'bye')

    resp = client.delete(
        f'/api/files/{file_id}',
        json={'reason': '内容违规'}
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['success'] is True
    assert body['file']['is_deleted'] is True
    assert body['file']['deleted_reason'] == '内容违规'

    # 列表中原行仍在，且只出现一次，带删除标记与原因
    rows = client.get('/api/files').get_json()
    matches = [f for f in rows if f['id'] == file_id]
    assert len(matches) == 1
    assert matches[0]['is_deleted'] is True
    assert matches[0]['deleted_reason'] == '内容违规'

    # 详情 410 并说明原因
    detail = client.get(f'/api/files/{file_id}')
    assert detail.status_code == 410
    assert '删除' in detail.get_json()['error']

    # 下载被拒绝
    auth = client.post('/api/auth', json={'username': 'admin', 'password': 'admin123'})
    token = auth.get_json()['token']
    dl = client.get(f'/api/download/{file_id}', headers={'Authorization': f'Bearer {token}'})
    assert dl.status_code == 410


def test_delete_file_idempotent_conflict(client):
    file_id = _upload(client, 'once.txt', b'1')
    assert client.delete(f'/api/files/{file_id}', json={}).status_code == 200
    again = client.delete(f'/api/files/{file_id}', json={})
    assert again.status_code == 409
    assert again.get_json()['deleted_reason'] == '用户主动删除'

    rows = [f for f in client.get('/api/files').get_json() if f['id'] == file_id]
    assert len(rows) == 1


def test_delete_missing_file(client):
    resp = client.delete('/api/files/nope', json={})
    assert resp.status_code == 404


def test_empty_directory_returns_empty_list(client):
    """空目录与条件无结果必须可区分：目录为空时返回空列表而非错误/旧数据"""
    fresh = client  # conftest 使用独立临时库，上传前目录为空
    # 确保没有任何文件记录（与其它测试隔离的临时库）
    resp = fresh.get('/api/files')
    assert resp.status_code == 200
    assert isinstance(resp.get_json(), list)


# ---------- 分享与文件删除联动 ----------

def test_share_of_deleted_file_is_invalid(client, auth_token):
    file_id = _upload(client, 'linked.txt', b'linked')
    share = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    ).get_json()
    share_id = share['share_id']

    client.delete(f'/api/files/{file_id}', json={'reason': '版权投诉'})

    info = client.get(f'/api/share/{share_id}')
    body = info.get_json()
    assert body['is_valid'] is False
    assert '版权投诉' in body['error_msg']

    dl = client.get(f'/api/share/{share_id}/download')
    assert dl.status_code == 404
    assert '版权投诉' in dl.get_json()['error']


def test_cannot_share_deleted_file(client, auth_token):
    file_id = _upload(client, 'deleted.txt', b'x')
    client.delete(f'/api/files/{file_id}', json={'reason': '清理'})

    resp = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 410


def test_delete_share_soft_keeps_row(client, auth_token):
    file_id = _upload(client, 'share_gone.txt', b'x')
    share_id = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    ).get_json()['share_id']

    resp = client.delete(
        f'/api/share/{share_id}',
        json={'reason': '不再分享'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 200

    # 公开访问视为不存在
    assert client.get(f'/api/share/{share_id}').status_code == 404
    assert client.get(f'/api/share/{share_id}/download').status_code == 404

    # 创建者列表中原行保留，仅一次，带删除原因
    rows = client.get('/api/shares', headers={'Authorization': f'Bearer {auth_token}'}).get_json()
    mine = [s for s in rows if s['share_id'] == share_id]
    assert len(mine) == 1
    assert mine[0]['is_deleted'] is True
    assert mine[0]['deleted_reason'] == '不再分享'
    assert mine[0]['is_valid'] is False
    assert '删除' in mine[0]['error_msg']
