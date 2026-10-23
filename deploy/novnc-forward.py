#!/usr/bin/env python3
# 把 0.0.0.0:16081 (TLS) 转发到 127.0.0.1:6081（noVNC），供公网/手机访问
import socket, ssl, threading

LISTEN = ("0.0.0.0", 16081)
TARGET = ("127.0.0.1", 6081)
CERT = "/opt/bots/panel/tls/cert.pem"
KEY = "/opt/bots/panel/tls/key.pem"

CTX = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
CTX.load_cert_chain(CERT, KEY)

def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except Exception:
        pass
    finally:
        try:
            b.shutdown(socket.SHUT_WR)
        except Exception:
            pass

def handle(c):
    try:
        c = CTX.wrap_socket(c, server_side=True)
    except Exception:
        try:
            c.close()
        except Exception:
            pass
        return
    try:
        s = socket.create_connection(TARGET, timeout=10)
    except Exception:
        c.close(); return
    threading.Thread(target=pipe, args=(c, s), daemon=True).start()
    pipe(s, c)

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(64)
    while True:
        try:
            c, _ = srv.accept()
        except Exception:
            continue
        threading.Thread(target=handle, args=(c,), daemon=True).start()

if __name__ == "__main__":
    main()
