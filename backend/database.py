"""数据库操作"""
import sqlite3
import hashlib
from config import DB_FILE


def get_db():
    """获取数据库连接"""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def _column_names(cursor, table):
    """返回表中已存在的列名"""
    cursor.execute(f'PRAGMA table_info({table})')
    return {row['name'] for row in cursor.fetchall()}


def _ensure_columns(cursor, table, columns):
    """为旧库补齐新增列（幂等迁移）"""
    existing = _column_names(cursor, table)
    for name, ddl in columns:
        if name not in existing:
            cursor.execute(f'ALTER TABLE {table} ADD COLUMN {name} {ddl}')


def init_db():
    """初始化数据库表"""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tokens (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            expires_at REAL NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS share_links (
            id TEXT PRIMARY KEY,
            file_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            expires_at REAL,
            max_downloads INTEGER,
            download_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        )
    ''')

    # 旧库迁移：软删除墓碑列。删除不真正抹除记录，保留原行与删除原因
    _ensure_columns(cursor, 'files', [
        ('is_deleted', 'INTEGER NOT NULL DEFAULT 0'),
        ('deleted_reason', 'TEXT'),
        ('deleted_at', 'REAL'),
    ])
    _ensure_columns(cursor, 'share_links', [
        ('is_deleted', 'INTEGER NOT NULL DEFAULT 0'),
        ('deleted_reason', 'TEXT'),
        ('deleted_at', 'REAL'),
    ])

    default_users = [
        ('admin', hashlib.sha256('admin123'.encode()).hexdigest()),
        ('user', hashlib.sha256('user123'.encode()).hexdigest()),
        ('test', hashlib.sha256('test123'.encode()).hexdigest())
    ]
    for username, password_hash in default_users:
        cursor.execute(
            'INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)',
            (username, password_hash)
        )

    conn.commit()
    conn.close()
