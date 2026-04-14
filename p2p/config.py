from pathlib import Path

APP_HOST = "0.0.0.0"
APP_PORT = 5000
TCP_HOST = "0.0.0.0"
TCP_PORT = 9009
CHUNK_SIZE = 1024 * 1024  # 1 MB chunks

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
OUTBOX_DIR = DATA_DIR / "outbox"
INBOX_DIR = DATA_DIR / "inbox"
TMP_DIR = DATA_DIR / "tmp"

for path in (DATA_DIR, OUTBOX_DIR, INBOX_DIR, TMP_DIR):
    path.mkdir(parents=True, exist_ok=True)
