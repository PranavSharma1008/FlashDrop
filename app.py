import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

from p2p.config import APP_HOST, APP_PORT, INBOX_DIR, TCP_HOST, TCP_PORT
from p2p.network import get_local_ip
from p2p.tcp_server import TCPReceiverServer
from p2p.transfer_manager import TransferManager

app = Flask(__name__)
transfer_manager = TransferManager()
receiver = TCPReceiverServer(TCP_HOST, TCP_PORT, transfer_manager)
receiver.start()


@app.route("/")
def home():
    return render_template("index.html", local_ip=get_local_ip(), app_port=APP_PORT, tcp_port=TCP_PORT)


@app.get("/api/local-info")
def local_info():
    return jsonify(
        {
            "ip": get_local_ip(),
            "app_port": APP_PORT,
            "tcp_port": TCP_PORT,
            "settings": transfer_manager.get_settings(),
        }
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
    if not peer_ip:
        return jsonify({"ok": False, "error": "Peer IP is required."}), 400

    url = f"http://{peer_ip}:{app_port}/api/local-info"
    try:
        with urllib.request.urlopen(url, timeout=2.5) as response:  # noqa: S310
            body = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return jsonify({"ok": False, "error": "Could not connect to peer."}), 400

    transfer_manager.add_allowed_ip(peer_ip)
    return jsonify({"ok": True, "peer_ip": peer_ip, "peer_info": body})


@app.post("/api/upload")
def upload_files():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"ok": False, "error": "No files provided."}), 400

    saved = []
    for item in files:
        if not item.filename:
            continue
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            item.save(tmp.name)
            info = transfer_manager.register_upload(Path(tmp.name), item.filename)
            saved.append(info)

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
    return send_from_directory(INBOX_DIR, safe_name, as_attachment=True)


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


if __name__ == "__main__":
    app.run(host=APP_HOST, port=APP_PORT, debug=True, use_reloader=False)
