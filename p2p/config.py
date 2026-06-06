import os
import socket
from pathlib import Path

APP_HOST = "0.0.0.0"
APP_PORT = 5000
USE_HTTPS = os.environ.get("USE_HTTPS", "1") == "1"
APP_PROTOCOL = "https" if USE_HTTPS else "http"
TCP_HOST = "0.0.0.0"
TCP_PORT = 9009
CHUNK_SIZE = 16 * 1024 * 1024  # 16 MB chunks (larger = faster, less overhead)
MAX_WORKERS = 1  # Sequential transfer through single socket (faster than fake parallelism)
SOCKET_BUFFER_SIZE = 8 * 1024 * 1024  # 8MB socket buffer
MAX_RETRIES = 3  # Retry failed chunks
CONNECTION_TIMEOUT = 10  # seconds
TRANSFER_TIMEOUT = 300  # 5 minutes - timeout for entire transfer (accounts for large files)

def find_free_port(start_port: int, search_range: int = 50) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        for port in range(start_port, start_port + search_range):
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
        s.bind(("0.0.0.0", 0))
        return s.getsockname()[1]

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
OUTBOX_DIR = DATA_DIR / "outbox"
INBOX_DIR = DATA_DIR / "inbox"
TMP_DIR = DATA_DIR / "tmp"

APP_PORT = int(os.environ.get("APP_PORT", find_free_port(5000)))
TCP_PORT = int(os.environ.get("TCP_PORT", find_free_port(9009)))

for path in (DATA_DIR, OUTBOX_DIR, INBOX_DIR, TMP_DIR):
    path.mkdir(parents=True, exist_ok=True)
