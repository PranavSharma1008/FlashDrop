import hashlib
import json
import os
import socket
import struct
import threading
import time
import uuid
from pathlib import Path

from .config import CHUNK_SIZE, INBOX_DIR, OUTBOX_DIR, TMP_DIR


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


class TransferManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.uploaded_files = {}
        self.transfers = {}
        self.settings = {
            "pin": "",
            "auto_delete_outbox": False,
            "allow_unknown": True,
            "allowed_ips": set(),
        }

    def register_upload(self, source_path: Path, original_name: str) -> dict:
        file_id = str(uuid.uuid4())
        safe_name = os.path.basename(original_name)
        stored_path = OUTBOX_DIR / f"{file_id}_{safe_name}"
        source_path.replace(stored_path)
        file_info = {
            "file_id": file_id,
            "name": safe_name,
            "stored_path": str(stored_path),
            "size": stored_path.stat().st_size,
            "created_at": time.time(),
        }
        with self._lock:
            self.uploaded_files[file_id] = file_info
        return file_info

    def list_outbox(self) -> list:
        with self._lock:
            return list(self.uploaded_files.values())

    def list_inbox(self) -> list:
        files = []
        for p in sorted(INBOX_DIR.iterdir()):
            if p.is_file():
                files.append({"name": p.name, "size": p.stat().st_size})
        return files

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
                "error": "",
            }
        return transfer_id

    def get_transfer(self, transfer_id: str) -> dict | None:
        with self._lock:
            transfer = self.transfers.get(transfer_id)
            if not transfer:
                return None
            return dict(transfer)

    def list_transfers(self) -> list:
        with self._lock:
            return list(self.transfers.values())

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

    def send_files_to_peer(self, transfer_id: str, target_ip: str, tcp_port: int, files: list) -> None:
        with self._lock:
            t = self.transfers[transfer_id]
            t["status"] = "running"
            t["started_at"] = time.time()

        pin = self.settings["pin"]
        total_sent = 0
        started = time.time()

        try:
            with socket.create_connection((target_ip, tcp_port), timeout=8) as conn:
                conn.settimeout(20)
                _send_json_line(
                    conn,
                    {
                        "type": "session_start",
                        "pin": pin,
                        "files": [{"name": f["name"], "size": f["size"]} for f in files],
                    },
                )
                response = _recv_json_line(conn)
                if not response.get("ok"):
                    raise RuntimeError(response.get("error", "Receiver rejected transfer."))

                for file_meta in files:
                    file_path = Path(file_meta["stored_path"])
                    _send_json_line(
                        conn,
                        {
                            "type": "file_start",
                            "name": file_meta["name"],
                            "size": file_meta["size"],
                        },
                    )
                    with file_path.open("rb") as fh:
                        while True:
                            chunk = fh.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            conn.sendall(struct.pack("!I", len(chunk)))
                            conn.sendall(chunk)
                            total_sent += len(chunk)
                            self._update_progress(transfer_id, total_sent, time.time() - started)
                    conn.sendall(struct.pack("!I", 0))

                _send_json_line(conn, {"type": "session_end"})
                done = _recv_json_line(conn)
                if not done.get("ok"):
                    raise RuntimeError(done.get("error", "Transfer finished with remote error."))

            if self.settings["auto_delete_outbox"]:
                for file_meta in files:
                    p = Path(file_meta["stored_path"])
                    if p.exists():
                        p.unlink()
                        with self._lock:
                            self.uploaded_files.pop(file_meta["file_id"], None)

            with self._lock:
                t = self.transfers[transfer_id]
                t["status"] = "completed"
                t["ended_at"] = time.time()
                t["bytes_sent"] = t["bytes_total"]
                elapsed = max(t["ended_at"] - t["started_at"], 0.001)
                t["speed_mbps"] = (t["bytes_total"] / elapsed) / (1024 * 1024)
                t["eta_seconds"] = 0
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                t = self.transfers[transfer_id]
                t["status"] = "failed"
                t["ended_at"] = time.time()
                t["error"] = str(exc)

    def receive_files_from_peer(self, conn: socket.socket, peer_ip: str) -> None:
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

        while True:
            msg = _recv_json_line(conn)
            if msg.get("type") == "session_end":
                _send_json_line(conn, {"ok": True})
                break
            if msg.get("type") != "file_start":
                raise RuntimeError("Invalid file start message.")

            file_name = os.path.basename(msg["name"])
            expected_size = int(msg["size"])
            temp_path = TMP_DIR / f"{uuid.uuid4()}_{file_name}.part"
            output_path = INBOX_DIR / file_name
            if output_path.exists():
                output_path = INBOX_DIR / f"{uuid.uuid4()}_{file_name}"

            hasher = hashlib.sha256()
            received = 0

            with temp_path.open("wb") as fh:
                while True:
                    length = struct.unpack("!I", _recv_exact(conn, 4))[0]
                    if length == 0:
                        break
                    chunk = _recv_exact(conn, length)
                    fh.write(chunk)
                    hasher.update(chunk)
                    received += len(chunk)

            if received != expected_size:
                if temp_path.exists():
                    temp_path.unlink()
                raise RuntimeError(f"Size mismatch for {file_name}.")

            temp_path.replace(output_path)

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
        file_path = INBOX_DIR / safe_name
        if file_path.exists() and file_path.is_file():
            file_path.unlink()
            return True
        return False
