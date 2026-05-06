import socket


def _ip_priority(ip: str) -> int:
    if ip.startswith("192.168."):
        return 1
    if ip.startswith("10."):
        return 2
    if ip.startswith("172."):
        parts = ip.split(".")
        if len(parts) >= 2:
            try:
                second = int(parts[1])
                if 16 <= second <= 31:
                    return 3
            except ValueError:
                pass
    return 4


def _is_valid_ipv4(ip: str) -> bool:
    return ip and not ip.startswith("127.") and not ip.startswith("169.254.") and ":" not in ip


def get_local_ip() -> str:
    """Get the local IP address that can be used to connect from other machines on the network."""
    # Method 1: Connect to external host to get local IP
    try:
        probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe_socket.connect(("8.8.8.8", 80))
        ip = probe_socket.getsockname()[0]
        probe_socket.close()
        if _is_valid_ipv4(ip):
            return ip
    except OSError:
        pass

    # Fallback to all local IPs sorted by preferred private ranges
    local_ips = get_all_local_ips()
    if local_ips:
        return local_ips[0]

    return "127.0.0.1"


def get_all_local_ips() -> list[str]:
    """Get all local IP addresses."""
    ips = []
    try:
        hostname = socket.gethostname()
        addresses = socket.getaddrinfo(hostname, None)
        for addr in addresses:
            ip = addr[4][0]
            if _is_valid_ipv4(ip) and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    
    try:
        probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe_socket.connect(("8.8.8.8", 80))
        ip = probe_socket.getsockname()[0]
        probe_socket.close()
        if _is_valid_ipv4(ip) and ip not in ips:
            ips.append(ip)
    except OSError:
        pass
    
    return sorted(ips, key=lambda ip: (_ip_priority(ip), ip))
