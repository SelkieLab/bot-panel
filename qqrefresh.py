import ctypes, time
x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
d = x11.XOpenDisplay(b":1")
if not d:
    raise SystemExit("no display")
xtst.XTestFakeMotionEvent(ctypes.c_void_p(d), -1, 958, 577, 0)
x11.XFlush(ctypes.c_void_p(d))
time.sleep(0.2)
for _ in range(2):
    xtst.XTestFakeButtonEvent(ctypes.c_void_p(d), 1, 1, 0)
    xtst.XTestFakeButtonEvent(ctypes.c_void_p(d), 1, 0, 0)
    x11.XFlush(ctypes.c_void_p(d))
    time.sleep(0.4)
print("ok")
