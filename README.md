# LocalShare P2P (No Central Server)

LocalShare P2P is a direct IP-to-IP file sharing prototype inspired by SHAREit, built with Flask + Python TCP sockets + browser UI.

## How this maps to your phases

1. **Phase 1 (Local server init)**: Flask runs on `0.0.0.0` and shows local IP URL.
2. **Phase 2 (HTTP upload/download)**: Browser uploads files to `/api/upload`; downloads via `/download/<filename>`.
3. **Phase 3 (Socket transfer)**: Sender connects directly to receiver `TCP 9009` and streams binary chunks.
4. **Phase 4 (Chunk transfer)**: 1 MB chunk framing with `.part` file safety and final atomic rename.
5. **Phase 5 (Connection UX)**: Manual IP connect + QR generation + QR scan auto-fill.
6. **Phase 6 (Progress/speed/ETA)**: Frontend polls transfer status every second.
7. **Phase 7 (Multi-file, drag-drop, queue style outbox)**: Multi-select + drag-drop uploads + select files for send.
8. **Phase 8 (Security/cleanup)**: Optional PIN, allow/deny unknown peers, auto-delete sender outbox after successful send.

## Project structure

- `app.py` - Flask API + web routes
- `p2p/config.py` - app/socket config and storage dirs
- `p2p/network.py` - local IP detection
- `p2p/tcp_server.py` - background TCP receiver service
- `p2p/transfer_manager.py` - transfer protocol, chunking, progress, settings
- `templates/index.html` - browser UI
- `static/styles.css` - styling
- `static/app.js` - UI logic, queue, connect, send, progress, QR

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open the app on another device via:

`http://<host-local-ip>:5000`

## Usage (2 devices)

1. Start this app on both devices.
2. On sender: upload files (input or drag-drop).
3. Enter receiver IP and connect.
4. Select outbox files and click **Send Selected**.
5. On receiver: download files from **Receiver Inbox** list.

## Notes

- For iOS camera QR scanning, allow camera permission in browser.
- For best speed, keep both devices on same fast WiFi/hotspot.
- This is a prototype; you can later add TLS and stronger auth.
