import socket
import threading

from .transfer_manager import TransferManager


class TCPReceiverServer:
    def __init__(self, host: str, port: int, transfer_manager: TransferManager):
        self.host = host
        self.port = port
        self.transfer_manager = transfer_manager
        self._thread = None
        self._sock = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((self.host, self.port))
            server.listen(8)
            self._sock = server
            while True:
                conn, addr = server.accept()
                thread = threading.Thread(
                    target=self._handle_client,
                    args=(conn, addr[0]),
                    daemon=True,
                )
                thread.start()

    def _handle_client(self, conn: socket.socket, peer_ip: str) -> None:
        with conn:
            try:
                self.transfer_manager.receive_files_from_peer(conn, peer_ip)
            except Exception:
                # Keep receiver resilient even if a peer sends malformed data.
                return
