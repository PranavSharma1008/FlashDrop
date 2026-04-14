import socket


def get_local_ip() -> str:
    probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe_socket.connect(("8.8.8.8", 80))
        ip = probe_socket.getsockname()[0]
    except OSError:
        ip = "127.0.0.1"
    finally:
        probe_socket.close()
    return ip
