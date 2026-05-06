import hashlib
import json
import os
import socket
import struct
import threading
import time
import uuid
from pathlib import Path
from queue import Queue


class TransferCancelled(Exception):
    pass

from .config import CHUNK_SIZE, CONNECTION_TIMEOUT, MAX_RETRIES, SOCKET_BUFFER_SIZE, TMP_DIR, TRANSFER_TIMEOUT


def _recv_exact(conn: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = conn.recv(length - len(data))
        if not chunk:
            raise ConnectionError("Connection closed during receive.")
        data.extend(chunk)
    return bytes(data)


def _send_json_line(conn: socket.socket, payload: dict) -> None:
    conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))


def _recv_json_line(conn: socket.socket) -> dict:
    buffer = bytearray()
    while True:
        ch = conn.recv(1)
        if not ch:
            raise ConnectionError("Connection closed before JSON line.")
        if ch == b"\n":
            break
        buffer.extend(ch)
    return json.loads(buffer.decode("utf-8"))


def _calculate_file_checksum(file_path: Path) -> str:
    """Calculate SHA-256 checksum of file."""
    hasher = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _send_chunk_with_retry(conn: socket.socket, chunk_data: bytes, chunk_index: int, max_retries: int = MAX_RETRIES) -> bool:
    """Send a chunk with retry mechanism."""
    for attempt in range(max_retries):
        try:
            # Send chunk header: index (4 bytes) + length (4 bytes)
            conn.sendall(struct.pack("!II", chunk_index, len(chunk_data)))
            conn.sendall(chunk_data)
            return True
        except (OSError, ConnectionError) as e:
            if attempt == max_retries - 1:
                return False
            time.sleep(0.1 * (attempt + 1))  # Exponential backoff
    return False


def _recv_chunk_with_retry(conn: socket.socket, max_retries: int = MAX_RETRIES) -> tuple[int, bytes, bool]:
    """Receive a chunk with retry mechanism. Returns (chunk_index, chunk_data, success)"""
    for attempt in range(max_retries):
        try:
            header = _recv_exact(conn, 8)
            chunk_index, length = struct.unpack("!II", header)
            chunk = _recv_exact(conn, length)
            return chunk_index, chunk, True
        except (OSError, ConnectionError) as e:
            if attempt == max_retries - 1:
                return -1, b"", False
            time.sleep(0.1 * (attempt + 1))
    return -1, b"", False


class TransferManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.uploaded_files = {}
        self.transfers = {}
        self.incoming_files = {}
        self.receiving_progress = {}  # Track incoming files from peers
        self.receiving_transfers = {}
        self.cancel_flags = {}
        self.settings = {
            "pin": "",
            "auto_delete_outbox": False,
            "allow_unknown": True,
            "allowed_ips": set(),
        }

    def register_upload(self, source_path: Path, original_name: str) -> dict:
        file_id = str(uuid.uuid4())
        safe_name = os.path.basename(original_name)
        stored_path = TMP_DIR / f"{file_id}_{safe_name}"
        source_path.replace(stored_path)
        file_info = {
            "file_id": file_id,
            "name": safe_name,
            "stored_path": str(stored_path),
            "size": stored_path.stat().st_size,
            "created_at": time.time(),
            "status": "ready",
        }
        with self._lock:
            self.uploaded_files[file_id] = file_info
        return file_info

    def list_outbox(self) -> list:
        with self._lock:
            return list(self.uploaded_files.values())

    def list_inbox(self) -> list:
        with self._lock:
            return [
                {
                    "file_id": file_id,
                    "name": file_meta["name"],
                    "size": file_meta["size"],
                    "created_at": file_meta["created_at"],
                }
                for file_id, file_meta in self.incoming_files.items()
                if Path(file_meta["stored_path"]).is_file()
            ]

    def get_incoming_file(self, filename: str) -> dict | None:
        with self._lock:
            for file_meta in self.incoming_files.values():
                if file_meta["name"] == filename and Path(file_meta["stored_path"]).is_file():
                    return dict(file_meta)
        return None

    def _register_incoming_file(self, peer_ip: str, filename: str, stored_path: Path, size: int) -> dict:
        file_id = str(uuid.uuid4())
        metadata = {
            "file_id": file_id,
            "peer_ip": peer_ip,
            "name": filename,
            "stored_path": str(stored_path),
            "size": size,
            "created_at": time.time(),
            "status": "received",
        }
        with self._lock:
            self.incoming_files[file_id] = metadata
        return metadata

    def create_transfer(self, target_ip: str, files: list) -> str:
        transfer_id = str(uuid.uuid4())
        now = time.time()
        with self._lock:
            self.transfers[transfer_id] = {
                "id": transfer_id,
                "target_ip": target_ip,
                "status": "queued",
                "created_at": now,
                "started_at": None,
                "ended_at": None,
                "bytes_total": sum(f["size"] for f in files),
                "bytes_sent": 0,
                "speed_mbps": 0.0,
                "eta_seconds": None,
                "files": [{"name": f["name"], "size": f["size"]} for f in files],
                "current_file_name": "",
                "current_file_size": 0,
                "current_file_index": 0,
                "error": "",
                "cancelled": False,
            }
            self.cancel_flags[transfer_id] = False
        return transfer_id

    def get_transfer(self, transfer_id: str) -> dict | None:
        with self._lock:
            transfer = self.transfers.get(transfer_id) or self.receiving_transfers.get(transfer_id)
            if not transfer:
                return None
            return dict(transfer)

    def list_transfers(self) -> list:
        with self._lock:
            return list(self.transfers.values()) + list(self.receiving_transfers.values())

    def _cleanup_outbox_files(self, files: list) -> None:
        for file_meta in files:
            stored_path = Path(file_meta["stored_path"])
            if stored_path.exists():
                try:
                    stored_path.unlink()
                except OSError:
                    pass
            with self._lock:
                self.uploaded_files.pop(file_meta["file_id"], None)

    def cancel_transfer(self, transfer_id: str) -> bool:
        with self._lock:
            if transfer_id in self.transfers:
                self.cancel_flags[transfer_id] = True
                self.transfers[transfer_id]["cancelled"] = True
                return True
            if transfer_id in self.receiving_transfers:
                self.cancel_flags[transfer_id] = True
                self.receiving_transfers[transfer_id]["cancelled"] = True
                return True
            return False

    def is_transfer_cancelled(self, transfer_id: str) -> bool:
        with self._lock:
            return self.cancel_flags.get(transfer_id, False)

    def get_receiving_progress(self) -> list:
        """Get progress of files currently being received"""
        with self._lock:
            # Filter out completed transfers (older than 5 minutes)
            now = time.time()
            active = [p for p in self.receiving_progress.values() if now - p.get("updated_at", now) < 300]
            return active

    def _update_receiving_progress(self, transfer_id: str, peer_ip: str, file_name: str, bytes_received: int, bytes_total: int) -> None:
        """Update progress for incoming file from peer"""
        with self._lock:
            key = f"{peer_ip}:{file_name}"
            speed_bps = 0
            eta_seconds = None
            
            if key in self.receiving_progress:
                prev = self.receiving_progress[key]
                elapsed = time.time() - prev.get("started_at", time.time())
                if elapsed > 0:
                    speed_bps = bytes_received / elapsed
                    remaining = max(bytes_total - bytes_received, 0)
                    eta_seconds = remaining / speed_bps if speed_bps > 0 else None
            
            self.receiving_progress[key] = {
                "transfer_id": transfer_id,
                "peer_ip": peer_ip,
                "file_name": file_name,
                "bytes_received": bytes_received,
                "bytes_total": bytes_total,
                "speed_mbps": speed_bps / (1024 * 1024),
                "eta_seconds": eta_seconds,
                "progress_percent": int((bytes_received / bytes_total * 100) if bytes_total > 0 else 0),
                "started_at": self.receiving_progress.get(key, {}).get("started_at", time.time()),
                "updated_at": time.time(),
            }

    def _update_receiving_transfer(self, transfer_id: str, bytes_received: int) -> None:
        with self._lock:
            transfer = self.receiving_transfers.get(transfer_id)
            if not transfer:
                return
            transfer["bytes_received"] = bytes_received
            elapsed = time.time() - transfer.get("started_at", time.time())
            speed_bps = bytes_received / elapsed if elapsed > 0 else 0.0
            transfer["speed_mbps"] = speed_bps / (1024 * 1024)
            remaining = max(transfer.get("bytes_total", 0) - bytes_received, 0)
            transfer["eta_seconds"] = remaining / speed_bps if speed_bps > 0 else None

    def update_settings(self, pin: str, auto_delete_outbox: bool, allow_unknown: bool) -> dict:
        with self._lock:
            self.settings["pin"] = pin
            self.settings["auto_delete_outbox"] = auto_delete_outbox
            self.settings["allow_unknown"] = allow_unknown
        return self.get_settings()

    def add_allowed_ip(self, ip: str) -> None:
        with self._lock:
            self.settings["allowed_ips"].add(ip)

    def get_settings(self) -> dict:
        with self._lock:
            return {
                "pin_enabled": bool(self.settings["pin"]),
                "auto_delete_outbox": self.settings["auto_delete_outbox"],
                "allow_unknown": self.settings["allow_unknown"],
            }

    def can_accept(self, peer_ip: str, pin: str) -> tuple[bool, str]:
        with self._lock:
            if self.settings["pin"] and pin != self.settings["pin"]:
                return False, "Invalid PIN."
            if not self.settings["allow_unknown"] and peer_ip not in self.settings["allowed_ips"]:
                return False, "Peer IP is not allowed."
        return True, ""

    def _update_progress(self, transfer_id: str, bytes_sent: int, elapsed: float) -> None:
        with self._lock:
            t = self.transfers[transfer_id]
            t["bytes_sent"] = bytes_sent
            speed_bps = bytes_sent / elapsed if elapsed > 0 else 0.0
            t["speed_mbps"] = speed_bps / (1024 * 1024)
            remaining = max(t["bytes_total"] - bytes_sent, 0)
            t["eta_seconds"] = (remaining / speed_bps) if speed_bps > 0 else None

    def _send_single_file(self, transfer_id: str, conn: socket.socket, file_meta: dict, file_index: int, total_files: int, total_sent: int, started: float) -> int:
        file_path = Path(file_meta["stored_path"])
        file_size = file_meta["size"]
        file_checksum = _calculate_file_checksum(file_path)

        _send_json_line(
            conn,
            {
                "type": "session_start",
                "pin": self.settings["pin"],
                "files": [
                    {
                        "name": file_meta["name"],
                        "size": file_size,
                        "checksum": file_checksum,
                    }
                ],
            },
        )
        response = _recv_json_line(conn)
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "Receiver rejected transfer."))

        num_chunks = (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE
        _send_json_line(
            conn,
            {
                "type": "file_start",
                "name": file_meta["name"],
                "size": file_size,
                "num_chunks": num_chunks,
                "chunk_size": CHUNK_SIZE,
            },
        )

        chunk_index = 0
        with file_path.open("rb") as fh:
            while True:
                if self.is_transfer_cancelled(transfer_id):
                    raise TransferCancelled("Transfer cancelled by user.")

                chunk_data = fh.read(CHUNK_SIZE)
                if not chunk_data:
                    break

                if not _send_chunk_with_retry(conn, chunk_data, chunk_index):
                    raise RuntimeError(f"Failed to send chunk {chunk_index} for {file_meta['name']}")

                total_sent += len(chunk_data)
                self._update_progress(transfer_id, total_sent, time.time() - started)
                chunk_index += 1

        conn.sendall(struct.pack("!II", 0xFFFFFFFF, 0))
        _send_json_line(conn, {"type": "session_end"})
        done = _recv_json_line(conn)
        if not done.get("ok"):
            raise RuntimeError(done.get("error", "Transfer finished with remote error."))

        return total_sent

    def send_files_to_peer(self, transfer_id: str, target_ip: str, tcp_port: int, files: list) -> None:
        with self._lock:
            t = self.transfers[transfer_id]
            t["status"] = "running"
            t["started_at"] = time.time()

        pin = self.settings["pin"]
        total_sent = 0
        started = time.time()

        try:
            for index, file_meta in enumerate(files, start=1):
                if self.is_transfer_cancelled(transfer_id):
                    raise TransferCancelled("Transfer cancelled by user.")

                file_size = file_meta["size"]
                with self._lock:
                    t = self.transfers[transfer_id]
                    t["current_file_name"] = file_meta["name"]
                    t["current_file_size"] = file_size
                    t["current_file_index"] = index

                with socket.create_connection((target_ip, tcp_port), timeout=CONNECTION_TIMEOUT) as conn:
                    conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SOCKET_BUFFER_SIZE)
                    conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, SOCKET_BUFFER_SIZE)
                    conn.settimeout(TRANSFER_TIMEOUT)

                    total_sent = self._send_single_file(
                        transfer_id,
                        conn,
                        file_meta,
                        index,
                        len(files),
                        total_sent,
                        started,
                    )

            # Cleanup temp outbox files after transfer end
            self._cleanup_outbox_files(files)

            with self._lock:
                t = self.transfers[transfer_id]
                t["status"] = "completed"
                t["ended_at"] = time.time()
                t["bytes_sent"] = t["bytes_total"]
                elapsed = max(t["ended_at"] - t["started_at"], 0.001)
                t["speed_mbps"] = (t["bytes_total"] / elapsed) / (1024 * 1024)
                t["eta_seconds"] = 0

        except Exception as exc:
            with self._lock:
                t = self.transfers[transfer_id]
                if isinstance(exc, TransferCancelled):
                    t["status"] = "cancelled"
                    t["error"] = str(exc)
                else:
                    t["status"] = "failed"
                    t["error"] = str(exc)
                t["ended_at"] = time.time()
            self._cleanup_outbox_files(files)

    def receive_files_from_peer(self, conn: socket.socket, peer_ip: str) -> None:
        # Optimize socket buffers
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SOCKET_BUFFER_SIZE)
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, SOCKET_BUFFER_SIZE)
        conn.settimeout(TRANSFER_TIMEOUT)

        session = _recv_json_line(conn)
        if session.get("type") != "session_start":
            _send_json_line(conn, {"ok": False, "error": "Invalid protocol start."})
            return

        allowed, error = self.can_accept(peer_ip, session.get("pin", ""))
        if not allowed:
            _send_json_line(conn, {"ok": False, "error": error})
            return

        self.add_allowed_ip(peer_ip)
        _send_json_line(conn, {"ok": True})

        transfer_id = str(uuid.uuid4())
        total_expected = sum(int(f.get("size", 0)) for f in session.get("files", []))
        with self._lock:
            self.receiving_transfers[transfer_id] = {
                "id": transfer_id,
                "peer_ip": peer_ip,
                "status": "running",
                "created_at": time.time(),
                "started_at": time.time(),
                "ended_at": None,
                "bytes_total": total_expected,
                "bytes_received": 0,
                "speed_mbps": 0.0,
                "eta_seconds": None,
                "files": [{"name": f.get("name"), "size": int(f.get("size", 0))} for f in session.get("files", [])],
                "error": "",
                "cancelled": False,
            }
            self.cancel_flags[transfer_id] = False

        try:
            while True:
                msg = _recv_json_line(conn)
                if msg.get("type") == "session_end":
                    _send_json_line(conn, {"ok": True})
                    break
                if msg.get("type") != "file_start":
                    raise RuntimeError("Invalid file start message.")

                if self.is_transfer_cancelled(transfer_id):
                    raise TransferCancelled("Receiving cancelled by user.")

                file_name = os.path.basename(msg["name"])
                expected_size = int(msg["size"])
                expected_checksum = msg.get("checksum", "")
                num_chunks = int(msg.get("num_chunks", (expected_size + CHUNK_SIZE - 1) // CHUNK_SIZE))
                written_bytes = 0
                hasher = hashlib.sha256()
                temp_path = TMP_DIR / f"{uuid.uuid4()}_{file_name}.part"

                try:
                    with temp_path.open("wb") as fh:
                        while written_bytes < expected_size:
                            if self.is_transfer_cancelled(transfer_id):
                                raise TransferCancelled("Receiving cancelled by user.")

                            chunk_index, chunk, success = _recv_chunk_with_retry(conn)
                            if not success:
                                raise RuntimeError(f"Failed to receive chunk {written_bytes // CHUNK_SIZE}")
                            if chunk_index == 0xFFFFFFFF and len(chunk) == 0:
                                break

                            fh.write(chunk)
                            hasher.update(chunk)
                            written_bytes += len(chunk)
                            self._update_receiving_progress(transfer_id, peer_ip, file_name, written_bytes, expected_size)
                            self._update_receiving_transfer(transfer_id, written_bytes)

                        header = _recv_exact(conn, 8)
                        eof_index, eof_length = struct.unpack("!II", header)
                        if eof_index != 0xFFFFFFFF or eof_length != 0:
                            raise RuntimeError("Invalid end of file marker")

                    if written_bytes != expected_size:
                        raise RuntimeError(
                            f"Size mismatch for {file_name}: expected {expected_size}, got {written_bytes}"
                        )

                    actual_checksum = hasher.hexdigest()
                    if expected_checksum and actual_checksum != expected_checksum:
                        raise RuntimeError(f"Checksum mismatch for {file_name}")

                    final_metadata = self._register_incoming_file(peer_ip, file_name, temp_path, expected_size)
                    # Keep file in temp storage until user downloads or deletes.

                except Exception as e:
                    if temp_path.exists():
                        temp_path.unlink()
                    raise RuntimeError(f"Failed to receive {file_name}: {str(e)}")

        except Exception as exc:
            with self._lock:
                transfer = self.receiving_transfers.get(transfer_id)
                if transfer:
                    if isinstance(exc, TransferCancelled):
                        transfer["status"] = "cancelled"
                        transfer["error"] = str(exc)
                    else:
                        transfer["status"] = "failed"
                        transfer["error"] = str(exc)
                    transfer["ended_at"] = time.time()
            return

        with self._lock:
            transfer = self.receiving_transfers.get(transfer_id)
            if transfer:
                transfer["status"] = "completed"
                transfer["ended_at"] = time.time()
                transfer["bytes_received"] = transfer["bytes_total"]
                elapsed = max(transfer["ended_at"] - transfer["started_at"], 0.001)
                transfer["speed_mbps"] = (transfer["bytes_total"] / elapsed) / (1024 * 1024)
                transfer["eta_seconds"] = 0

    def remove_outbox_file(self, file_id: str) -> bool:
        with self._lock:
            file_info = self.uploaded_files.get(file_id)
            if not file_info:
                return False
            stored_path = Path(file_info["stored_path"])
            if stored_path.exists():
                stored_path.unlink()
            del self.uploaded_files[file_id]
            return True

    def remove_inbox_file(self, filename: str) -> bool:
        safe_name = os.path.basename(filename)
        with self._lock:
            for file_id, file_meta in list(self.incoming_files.items()):
                if file_meta["name"] == safe_name:
                    file_path = Path(file_meta["stored_path"])
                    if file_path.exists() and file_path.is_file():
                        try:
                            file_path.unlink()
                        except OSError:
                            pass
                    del self.incoming_files[file_id]
                    return True
        return False
