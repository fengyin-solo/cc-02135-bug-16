"""文件模块测试"""
import io
import time


def _upload(client, name='test.txt', content=b'test content'):
    """辅助：上传文件，返回 (file_id, 响应json)"""
    data = {'file': (io.BytesIO(content), name)}
    resp = client.post('/api/upload', data=data, content_type='multipart/form-data')
    return resp.get_json()['file_id'], resp.get_json()


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


# ============================================================================
# 文件目录：软删除、详情、列表一致性
# ============================================================================

def test_upload_response_contains_full_file_record(client):
    """上传响应应返回完整记录，可直接并入目录，不依赖旧列表缓存"""
    _, result = _upload(client, 'fresh.txt', b'fresh')
    assert result['success'] is True
    assert result['file']['name'] == 'fresh.txt'
    assert result['file']['size'] == len(b'fresh')
    assert result['file']['deleted'] is False
    assert result['file']['delete_reason'] is None


def test_list_files_includes_deleted_flag_fields(client):
    """列表记录含软删除字段，且每条记录只出现一次"""
    _upload(client, 'one.txt', b'1')
    _upload(client, 'two.txt', b'22')

    resp = client.get('/api/files')
    files = resp.get_json()
    ids = [f['id'] for f in files]
    assert len(ids) == len(set(ids))  # 主键唯一，不重复
    for f in files:
        assert set(['id', 'name', 'size', 'uploaded_at', 'uploaded_by',
                    'deleted', 'deleted_at', 'delete_reason']).issubset(f.keys())
        assert 'path' not in f  # 服务端路径不下发


def test_get_file_detail_matches_list_record(client):
    """详情与列表看到的是同一对象（同 id、同字段）"""
    file_id, _ = _upload(client, 'detail_match.txt', b'match')

    list_item = next(f for f in client.get('/api/files').get_json() if f['id'] == file_id)
    detail = client.get(f'/api/files/{file_id}').get_json()

    assert detail == list_item
    assert detail['name'] == 'detail_match.txt'


def test_get_file_detail_not_found(client):
    """打开不存在的详情返回 404 而不是 500"""
    resp = client.get('/api/files/no-such-id')
    assert resp.status_code == 404
    assert 'error' in resp.get_json()


def test_delete_without_auth(client):
    """未登录不能删除"""
    file_id, _ = _upload(client)
    resp = client.delete(f'/api/files/{file_id}', json={'reason': 'x'})
    assert resp.status_code == 401


def test_soft_delete_keeps_row_with_reason(client, auth_token):
    """删除后：行保留、标记删除、原因写回；默认原因兜底"""
    file_id, _ = _upload(client, 'keep.txt', b'keep me')

    resp = client.delete(
        f'/api/files/{file_id}',
        json={'reason': '内容过期'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['success'] is True
    assert body['file']['deleted'] is True
    assert body['file']['delete_reason'] == '内容过期'
    assert body['file']['deleted_at'] is not None

    # 列表中原行仍在
    files = client.get('/api/files').get_json()
    row = next(f for f in files if f['id'] == file_id)
    assert row['deleted'] is True
    assert row['delete_reason'] == '内容过期'

    # 详情同样可打开并看到原因
    detail = client.get(f'/api/files/{file_id}').get_json()
    assert detail['deleted'] is True
    assert detail['delete_reason'] == '内容过期'

    # 空原因使用默认值
    other_id, _ = _upload(client, 'noreason.txt', b'x')
    resp2 = client.delete(
        f'/api/files/{other_id}',
        json={'reason': '   '},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp2.get_json()['file']['delete_reason'] == '用户未填写删除原因'


def test_delete_nonexistent_returns_404(client, auth_token):
    resp = client.delete(
        '/api/files/ghost-id',
        json={'reason': 'x'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 404


def test_double_delete_conflict_keeps_original_reason(client, auth_token):
    """重复删除返回 409，且不覆盖第一次的删除原因"""
    file_id, _ = _upload(client, 'twice.txt', b'x')
    client.delete(
        f'/api/files/{file_id}',
        json={'reason': '第一次原因'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    resp = client.delete(
        f'/api/files/{file_id}',
        json={'reason': '第二次原因'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 409
    assert resp.get_json()['delete_reason'] == '第一次原因'

    row = next(f for f in client.get('/api/files').get_json() if f['id'] == file_id)
    assert row['delete_reason'] == '第一次原因'


def test_download_deleted_file_rejected(client, auth_token):
    """已删除文件不可下载，返回原因"""
    file_id, _ = _upload(client, 'gone.txt', b'gone')
    client.delete(
        f'/api/files/{file_id}',
        json={'reason': '违规内容'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    resp = client.get(
        f'/api/download/{file_id}',
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 410
    assert '违规内容' in resp.get_json()['error']


def test_share_deleted_file_is_invalid(client, auth_token):
    """文件删除后，其分享链接自动失效并说明原因"""
    file_id, _ = _upload(client, 'shared_then_deleted.txt', b'x')
    share_resp = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    share_id = share_resp.get_json()['share_id']

    client.delete(
        f'/api/files/{file_id}',
        json={'reason': '撤回'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )

    info = client.get(f'/api/share/{share_id}').get_json()
    assert info['is_valid'] is False
    assert '已被删除' in info['error_msg']

    dl = client.get(f'/api/share/{share_id}/download')
    assert dl.status_code == 404


def test_cannot_create_share_for_deleted_file(client, auth_token):
    file_id, _ = _upload(client, 'deleted_first.txt', b'x')
    client.delete(
        f'/api/files/{file_id}',
        json={'reason': '误传'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    resp = client.post(
        '/api/share',
        json={'file_id': file_id},
        headers={'Authorization': f'Bearer {auth_token}'}
    )
    assert resp.status_code == 410


def test_list_ordering_stable_active_before_deleted(client, auth_token):
    """连续刷新顺序稳定：未删除在前、已删除在后"""
    id_a, _ = _upload(client, 'aaa.txt', b'a')
    id_b, _ = _upload(client, 'bbb.txt', b'b')
    client.delete(
        f'/api/files/{id_a}',
        json={'reason': 'r'},
        headers={'Authorization': f'Bearer {auth_token}'}
    )

    ids_first = [f['id'] for f in client.get('/api/files').get_json()]
    ids_second = [f['id'] for f in client.get('/api/files').get_json()]
    assert ids_first == ids_second
    assert ids_first.index(id_b) < ids_first.index(id_a)
