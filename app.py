import atexit
import json
import os
import socket
import ssl
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, render_template, request, Response, stream_with_context

from p2p.config import APP_HOST, APP_PORT, BASE_DIR, TMP_DIR, TCP_HOST, TCP_PORT, USE_HTTPS
from p2p.network import get_all_local_ips, get_local_ip
from p2p.tcp_server import TCPReceiverServer
from p2p.transfer_manager import TransferManager

app = Flask(__name__)
# Allow large file uploads (no limit - based on system memory)
app.config['MAX_CONTENT_LENGTH'] = None
transfer_manager = TransferManager()
receiver = TCPReceiverServer(TCP_HOST, TCP_PORT, transfer_manager)
receiver.start()

# Cleanup any leftover temp files on startup
def cleanup_temp_files():
    """Clean up any leftover temp files"""
    try:
        for file_path in TMP_DIR.iterdir():
            if file_path.is_file():
                try:
                    file_path.unlink()
                except OSError:
                    pass
    except Exception:
        pass

cleanup_temp_files()
atexit.register(cleanup_temp_files)


@app.route("/")
def home():
    return render_template("index.html", local_ip=get_local_ip(), app_port=APP_PORT, tcp_port=TCP_PORT)


@app.get("/api/local-info")
def local_info():
    return jsonify(
        {
            "ip": get_local_ip(),
            "all_ips": get_all_local_ips(),
            "app_port": APP_PORT,
            "tcp_port": TCP_PORT,
            "protocol": request.scheme,
            "settings": transfer_manager.get_settings(),
        }
    )


def _fetch_peer_local_info(peer_ip: str, app_port: int) -> tuple[dict, str]:
    errors = []
    for protocol in ("https", "http"):
        url = f"{protocol}://{peer_ip}:{app_port}/api/local-info"
        try:
            if protocol == "https":
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                opener = urllib.request.urlopen(url, timeout=5.0, context=ctx)  # noqa: S310
            else:
                opener = urllib.request.urlopen(url, timeout=5.0)  # noqa: S310
            with opener as response:
                body = response.read().decode("utf-8")
                return json.loads(body), body
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as e:
            errors.append(f"{protocol}: {e}")
    raise urllib.error.URLError("; ".join(errors))


@app.get("/features")
def features_page():
    return render_template("info_page.html", page_title="Features", page_id="features")


@app.get("/get-app")
def get_app_page():
    return render_template("info_page.html", page_title="Download", page_id="get-app")


@app.get("/about")
def about_page():
    return render_template("info_page.html", page_title="About", page_id="about")


@app.get("/contact")
def contact_page():
    return render_template(
        "info_page.html",
        page_title="Contact",
        page_id="contact",
        contact_email="pranav2410991479@gmail.com",
    )


@app.post("/api/settings")
def update_settings():
    data = request.get_json(force=True)
    pin = str(data.get("pin", "")).strip()
    auto_delete_outbox = bool(data.get("auto_delete_outbox", False))
    allow_unknown = bool(data.get("allow_unknown", True))
    settings = transfer_manager.update_settings(pin, auto_delete_outbox, allow_unknown)
    return jsonify({"ok": True, "settings": settings})


@app.post("/api/connect")
def connect_peer():
    data = request.get_json(force=True)
    peer_ip = str(data.get("peer_ip", "")).strip()
    app_port = int(data.get("app_port", APP_PORT))
    tcp_port = int(data.get("tcp_port", TCP_PORT))
    if not peer_ip:
        return jsonify({"ok": False, "error": "Peer IP is required."}), 400

    try:
        peer_info, body = _fetch_peer_local_info(peer_ip, app_port)
    except urllib.error.URLError as e:
        error_msg = f"Could not connect to peer API at {peer_ip}:{app_port}. {str(e)}"
        return jsonify({"ok": False, "error": error_msg}), 400

    # Test TCP connectivity
    try:
        test_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        test_sock.settimeout(5.0)
        test_sock.connect((peer_ip, tcp_port))
        test_sock.close()
    except (socket.error, OSError) as e:
        error_msg = f"Peer HTTP API accessible but TCP port {tcp_port} not reachable at {peer_ip}. {str(e)}"
        return jsonify({"ok": False, "error": error_msg}), 400

    transfer_manager.add_allowed_ip(peer_ip)
    return jsonify({"ok": True, "peer_ip": peer_ip, "peer_info": body})


@app.post("/api/upload")
def upload_files():
    try:
        files = request.files.getlist("files")
    except OSError as e:
        if getattr(e, "errno", None) == 28:
            return jsonify({"ok": False, "error": "Insufficient disk space. Please free up storage on this Mac and try again."}), 507
        raise

    if not files:
        return jsonify({"ok": False, "error": "No files provided."}), 400

    saved = []
    for item in files:
        if not item.filename:
            continue
        try:
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                item.save(tmp.name)
                info = transfer_manager.register_upload(Path(tmp.name), item.filename)
                saved.append(info)
        except OSError as e:
            if getattr(e, "errno", None) == 28:
                return jsonify({"ok": False, "error": "Insufficient disk space. Please free up storage on this Mac and try again."}), 507
            raise

    return jsonify({"ok": True, "files": saved, "outbox": transfer_manager.list_outbox()})


@app.get("/api/outbox")
def outbox():
    return jsonify({"files": transfer_manager.list_outbox()})


@app.get("/api/inbox")
def inbox():
    return jsonify({"files": transfer_manager.list_inbox()})


@app.get("/download/<path:filename>")
def download_file(filename: str):
    safe_name = os.path.basename(filename)
    incoming = transfer_manager.get_incoming_file(safe_name)
    if not incoming:
        return jsonify({"error": "File not found"}), 404

    file_path = Path(incoming["stored_path"])
    if not file_path.exists() or not file_path.is_file():
        return jsonify({"error": "File not found"}), 404

    file_size = file_path.stat().st_size
    
    content_type = "application/octet-stream"
    if safe_name.lower().endswith(('.txt', '.md', '.py', '.js', '.html', '.css', '.json', '.xml')):
        content_type = "text/plain"
    elif safe_name.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp')):
        content_type = "image/jpeg"
    elif safe_name.lower().endswith(('.mp4', '.avi', '.mkv', '.mov')):
        content_type = "video/mp4"
    elif safe_name.lower().endswith(('.mp3', '.wav', '.flac')):
        content_type = "audio/mpeg"
    elif safe_name.lower().endswith(('.pdf',)):
        content_type = "application/pdf"
    elif safe_name.lower().endswith(('.zip', '.rar', '.7z', '.tar', '.gz')):
        content_type = "application/zip"

    def generate():
        with file_path.open("rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk

    response = Response(
        stream_with_context(generate()),
        content_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename={safe_name}",
            "Content-Length": str(file_size),
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-Accel-Buffering": "no",
            "Accept-Ranges": "none",
        },
    )
    return response


@app.post("/api/send")
def send_files():
    data = request.get_json(force=True)
    peer_ip = str(data.get("peer_ip", "")).strip()
    file_ids = data.get("file_ids", [])
    tcp_port = int(data.get("tcp_port", TCP_PORT))

    if not peer_ip:
        return jsonify({"ok": False, "error": "Peer IP is required."}), 400
    if not file_ids:
        return jsonify({"ok": False, "error": "Select at least one file."}), 400

    file_map = {f["file_id"]: f for f in transfer_manager.list_outbox()}
    files = [file_map[fid] for fid in file_ids if fid in file_map]
    if not files:
        return jsonify({"ok": False, "error": "Selected files are not available."}), 400

    transfer_id = transfer_manager.create_transfer(peer_ip, files)
    thread = threading.Thread(
        target=transfer_manager.send_files_to_peer,
        args=(transfer_id, peer_ip, tcp_port, files),
        daemon=True,
    )
    thread.start()
    return jsonify({"ok": True, "transfer_id": transfer_id})


@app.get("/api/transfers")
def transfers():
    return jsonify({"transfers": transfer_manager.list_transfers()})


@app.get("/api/transfers/<transfer_id>")
def transfer_status(transfer_id: str):
    transfer = transfer_manager.get_transfer(transfer_id)
    if not transfer:
        return jsonify({"ok": False, "error": "Transfer not found."}), 404
    return jsonify({"ok": True, "transfer": transfer})


@app.post("/api/transfers/<transfer_id>/cancel")
def cancel_transfer(transfer_id: str):
    canceled = transfer_manager.cancel_transfer(transfer_id)
    if not canceled:
        return jsonify({"ok": False, "error": "Transfer not found."}), 404
    return jsonify({"ok": True, "transfer_id": transfer_id, "status": "cancelled"})


@app.get("/api/receiving")
def receiving_progress():
    """Get progress of files being received from peers"""
    progress = transfer_manager.get_receiving_progress()
    return jsonify({"ok": True, "progress": progress})


@app.delete("/api/outbox/<file_id>")
def remove_outbox_file(file_id: str):
    success = transfer_manager.remove_outbox_file(file_id)
    if not success:
        return jsonify({"ok": False, "error": "File not found."}), 404
    return jsonify({"ok": True})


@app.delete("/api/inbox/<path:filename>")
def remove_inbox_file(filename: str):
    success = transfer_manager.remove_inbox_file(filename)
    if not success:
        return jsonify({"ok": False, "error": "File not found."}), 404
    return jsonify({"ok": True})


def _ensure_local_cert() -> tuple[str, str] | None:
    cert_dir = BASE_DIR / "certs"
    cert_file = cert_dir / "flashdrop.pem"
    key_file = cert_dir / "flashdrop.key"
    if cert_file.exists() and key_file.exists():
        return str(cert_file), str(key_file)

    cert_dir.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(key_file),
                "-out",
                str(cert_file),
                "-days",
                "3650",
                "-nodes",
                "-subj",
                "/CN=FlashDrop Local/O=FlashDrop",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return str(cert_file), str(key_file)
    except (OSError, subprocess.CalledProcessError):
        return None


def _ssl_context():
    if not USE_HTTPS:
        return None

    cert_paths = _ensure_local_cert()
    if cert_paths:
        return cert_paths

    try:
        import OpenSSL  # noqa: F401
    except ImportError:
        print("HTTPS disabled: install OpenSSL CLI or pyOpenSSL to enable secure downloads.")
        return None
    return "adhoc"


if __name__ == "__main__":
    ssl_context = _ssl_context()
    protocol = "https" if ssl_context else "http"
    local_ip = get_local_ip()
    print(f"FlashDrop running at {protocol}://{local_ip}:{APP_PORT}")
    if ssl_context:
        print("Using HTTPS so files save directly without Chrome download warnings.")
    app.run(
        host=APP_HOST,
        port=APP_PORT,
        debug=True,
        use_reloader=False,
        ssl_context=ssl_context,
    )
