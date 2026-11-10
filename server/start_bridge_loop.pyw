"""Launcher for the MCP bridge. v1.7.0 (fork)

Keeps the bridge alive (restarts it if it dies) and listens on 127.0.0.1:8198 so the EXTENSION can
START, RESTART and STOP it from its panel (an extension cannot launch processes by itself).

  pythonw start_bridge_loop.pyw                -> normal mode (loop + control server)
  python  start_bridge_loop.pyw --ctl ACTION   -> ACTION = start | stop | restart | status | killall | quit

"Stop" leaves the bridge off until "Start" is pressed (the .paused marker survives PC reboots).
Security: only serves the extension (chrome-extension:// Origin) or clients without Origin (CLI), and only with a local Host.

Notes 1.7.0 ("previous bridge stays alive" bug)
-----------------------------------------------
* The launcher checks WHOSE bridge is answering: if its servers.json is not the one in this folder (another copy
  of the project, an old auto-start...) it closes it and starts its own. Before, it accepted any "alive" bridge.
* If the launcher port (8198) is held by the launcher of ANOTHER folder, it replaces it instead of exiting.
* Stop / Restart / Start are GLOBAL: they close the bridges (and launchers) of ANY folder.
* While off on purpose, if something starts a bridge again it is closed again.
"""
import json
import os
import socket
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.7.0"
DIR = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(sys.executable), "python.exe") if sys.executable.lower().endswith("pythonw.exe") else sys.executable
LOG = os.path.join(DIR, "bridge.log")
ALOG = os.path.join(DIR, "loop.log")
CONFIG = os.path.join(DIR, "servers.json")
EXAMPLE = os.path.join(DIR, "servers.example.json")
PAUSED_FILE = os.path.join(DIR, ".paused")
DEFAULT_CONTROL_PORT = 8199
DEFAULT_LAUNCHER_PORT = 8198
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
SWEEP_EVERY = 6.0      # minimum seconds between two process sweeps (listing processes is slow)
OWNER_EVERY = 5.0      # minimum seconds between two "who owns the answering bridge" checks


def _log(msg):
    try:
        with open(ALOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def _canon(path):
    """Comparable path: lowercase and with '/' (Windows is case- and separator-insensitive)."""
    return str(path or "").lower().replace("\\", "/").rstrip("/")


def read_config(path=CONFIG):
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def ensure_config(path=CONFIG):
    """If servers.json is missing it is created from the example (never overwrites an existing one)."""
    try:
        if not os.path.exists(path) and os.path.exists(EXAMPLE) and _canon(path) == _canon(CONFIG):
            shutil.copyfile(EXAMPLE, path)
            _log("servers.json created from servers.example.json")
    except Exception as err:
        _log("could not create servers.json: %r" % (err,))


def alive(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def port_open(port, timeout=0.4):
    """Is anything listening on the port? On Windows a closed port takes ~2s to reject the connection; here it is cut earlier."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def http_json(method, port, path, timeout=4):
    """Request without an Origin header (the bridge and this launcher accept it). Returns the JSON or None."""
    try:
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except Exception:
        return None


# ---------------------------------------------------------------- processes (bridges and launchers of any folder)

def list_bridge_procs():
    """[(pid, command_line, 'bridge'|'launcher')] of ALL running bridges and launchers, in any folder (except this process)."""
    rows = []
    try:
        if sys.platform == "win32":
            ps = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and "
                  "($_.CommandLine -like '*mcp_ws_bridge.py*' -or $_.CommandLine -like '*start_bridge_loop.pyw*') -and "
                  "$_.CommandLine -notlike '*Get-CimInstance*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress")
            res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                                 capture_output=True, text=True, timeout=25, creationflags=NO_WINDOW)
            data = json.loads((res.stdout or "").strip() or "[]")
            data = [data] if isinstance(data, dict) else data
            rows = [(int(d["ProcessId"]), d.get("CommandLine") or "") for d in data]
        else:
            res = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True, timeout=10)
            for line in (res.stdout or "").splitlines():
                pid, _, cmd = line.strip().partition(" ")
                if pid.isdigit():
                    rows.append((int(pid), cmd.strip()))
    except Exception as err:
        _log("could not list processes: %r" % (err,))
    found = []
    me = os.getpid()
    for pid, cmd in rows:
        low = cmd.lower()
        if pid == me:
            continue
        if "start_bridge_loop" in low:
            found.append((pid, cmd, "launcher"))
        elif "mcp_ws_bridge.py" in low:
            found.append((pid, cmd, "bridge"))
    return found


def is_ours(cmd):
    """The command line points to a file in THIS folder."""
    return (_canon(DIR) + "/") in _canon(cmd)


def kill_tree(pid):
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True, timeout=15, creationflags=NO_WINDOW)
        else:
            os.kill(pid, 15)
    except Exception as err:
        _log("could not close %s: %r" % (pid, err))


def kill_bridges(ours=True, foreign=True, launchers=False):
    """Closes running bridges. ours: from this folder; foreign: from OTHER folders;
    launchers: also the FOREIGN launchers (never our own). Returns the closed pids."""
    if os.environ.get("WMB_NO_KILL") == "1":  # automated tests
        return []
    killed = []
    for pid, cmd, kind in list_bridge_procs():
        mine = is_ours(cmd)
        if kind == "launcher":
            if mine or not (launchers and foreign):
                continue
        elif (mine and not ours) or (not mine and not foreign):
            continue
        _log("closing %s foreign/old pid %s: %s" % (kind, pid, cmd[:160]) if not mine else "closing %s pid %s" % (kind, pid))
        kill_tree(pid)
        killed.append(pid)
    return killed


def spawn_bridge(launcher):
    """Starts the bridge and waits for it to finish. Returns its exit code."""
    # WMB_SUPERVISED=1: if the bridge restarts from the extension, it just closes and this loop starts it again.
    done = subprocess.run([PY, "mcp_ws_bridge.py", "--config", launcher.config, "--log-file", LOG], cwd=DIR,
                          env={**os.environ, "WMB_SUPERVISED": "1"}, creationflags=NO_WINDOW)
    return done.returncode


class Launcher:
    def __init__(self, config=CONFIG, paused_file=PAUSED_FILE, spawn=spawn_bridge, killer=None):
        self.config = config
        self.paused_file = paused_file
        self.spawn = spawn
        self.killer = killer or kill_bridges
        self.wake = threading.Event()
        self.quit = threading.Event()
        self._last_sweep = 0.0
        self._last_owner = 0.0

    @property
    def control_port(self):
        try:
            return int(read_config(self.config).get("control_port", DEFAULT_CONTROL_PORT))
        except (TypeError, ValueError):
            return DEFAULT_CONTROL_PORT

    @property
    def launcher_port(self):
        try:
            return int(read_config(self.config).get("launcher_port", DEFAULT_LAUNCHER_PORT))
        except (TypeError, ValueError):
            return DEFAULT_LAUNCHER_PORT

    @property
    def paused(self):
        return os.path.exists(self.paused_file)

    def set_paused(self, flag):
        try:
            if flag:
                with open(self.paused_file, "w", encoding="utf-8") as f:
                    f.write("stopped from the extension\n")
            elif os.path.exists(self.paused_file):
                os.remove(self.paused_file)
        except OSError as err:
            _log("could not change .paused: %r" % (err,))

    def status(self):
        # port_open (not alive): with the bridge off, alive() waited 2 s and the extension (1.5 s) assumed the launcher was dead.
        return {"ok": True, "launcher": True, "version": VERSION, "dir": DIR, "pid": os.getpid(),
                "paused": self.paused, "bridge": port_open(self.control_port)}

    def foreign_bridge(self):
        """True if the bridge answering on the control port is NOT using this folder's servers.json."""
        info = http_json("GET", self.control_port, "/servers", timeout=3)
        if info is None:
            return alive(self.control_port)  # answers /health but not /servers: old bridge -> replaced
        theirs = _canon(os.path.abspath(info.get("config"))) if info.get("config") else ""
        return theirs != _canon(os.path.abspath(self.config))

    def _shutdown_current(self, wait=3.0):
        """Asks the current bridge to close gracefully and waits a bit."""
        if not alive(self.control_port):
            return
        http_json("POST", self.control_port, "/shutdown")
        end = time.time() + wait
        while time.time() < end and alive(self.control_port):
            time.sleep(0.2)

    # ---- actions (used by the HTTP server). GLOBAL: affect bridges in any folder ----
    def do_start(self):
        self.set_paused(False)
        self.killer(ours=False, foreign=True, launchers=True)   # out with the foreign ones: this launcher rules
        self.wake.set()

    def do_stop(self):
        self.set_paused(True)
        self._shutdown_current(2.5)
        self.killer(ours=True, foreign=True, launchers=True)    # and anything still alive, in any folder
        self.wake.set()

    def do_restart(self):
        self.set_paused(False)
        self._shutdown_current(3.0)
        self.killer(ours=True, foreign=True, launchers=True)
        self.wake.set()

    def do_killall(self):
        """Closes all foreign bridges/launchers and our own bridges WITHOUT changing the on/off state."""
        return self.killer(ours=True, foreign=True, launchers=True)

    # ---- main loop ----
    def supervise(self):
        _log("launcher START v%s dir=%s" % (VERSION, DIR))
        while not self.quit.is_set():
            try:
                now = time.time()
                if self.paused:
                    # Off on purpose: if another copy (old auto-start) starts a bridge, close it again.
                    if now - self._last_sweep > SWEEP_EVERY and alive(self.control_port):
                        self._last_sweep = now
                        _log("a bridge is alive while paused: closing it")
                        self.killer(ours=True, foreign=True, launchers=True)
                    self.wake.wait(1.0)
                    self.wake.clear()
                    continue
                if alive(self.control_port):
                    if now - self._last_owner > OWNER_EVERY:
                        self._last_owner = now
                        if self.foreign_bridge():
                            _log("the answering bridge is NOT from this folder: closing it and starting mine")
                            self.killer(ours=False, foreign=True, launchers=True)
                            self.wake.wait(1.0)
                            self.wake.clear()
                            continue
                    self.wake.wait(3.0)
                    self.wake.clear()
                    continue
                _log("bridge down -> starting")
                delay = 5
                try:
                    if self.spawn(self) == 0:
                        delay = 1  # clean close (restart or requested stop): look again right away
                except Exception as err:
                    _log("bridge error: %r" % (err,))
                _log("bridge exited, retrying in %ds" % delay)
                self.wake.wait(delay)
                self.wake.clear()
            except Exception as err:
                _log("loop error: %r" % (err,))
                self.wake.wait(5)
        _log("launcher STOP")


class Handler(BaseHTTPRequestHandler):
    server_version = "WMBLauncher/2"

    def log_message(self, *args):
        pass

    def _origin(self):
        return self.headers.get("Origin")

    def _allowed(self):
        origin = self._origin()
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("127.0.0.1", "localhost") and (origin is None or origin.startswith(ALLOWED_ORIGIN_PREFIXES))

    def _reply(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        origin = self._origin()
        if origin and origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._reply(204 if self._allowed() else 403)

    def do_GET(self):
        if not self._allowed():
            return self._reply(403, {"ok": False, "error": "origin not allowed"})
        if self.path == "/status":
            return self._reply(200, self.server.launcher.status())
        self._reply(404, {"ok": False, "error": "unknown route"})

    def do_POST(self):
        if not self._allowed():
            return self._reply(403, {"ok": False, "error": "origin not allowed"})
        launcher = self.server.launcher
        actions = {"/start": launcher.do_start, "/stop": launcher.do_stop, "/restart": launcher.do_restart}
        if self.path in actions:
            actions[self.path]()
            return self._reply(200, launcher.status())
        if self.path == "/killall":
            killed = launcher.do_killall()
            return self._reply(200, {**launcher.status(), "killed": killed})
        if self.path == "/quit":
            self._reply(200, {"ok": True, "bye": True})
            launcher.quit.set()
            launcher.wake.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        self._reply(404, {"ok": False, "error": "unknown route"})


def make_server(launcher):
    server = ThreadingHTTPServer(("127.0.0.1", launcher.launcher_port), Handler)
    server.daemon_threads = True
    server.launcher = launcher
    return server


def run_forever(launcher):
    ensure_config(launcher.config)
    server = None
    for _attempt in range(6):
        try:
            server = make_server(launcher)
            break
        except OSError:
            port = launcher.launcher_port
            st = http_json("GET", port, "/status", timeout=2)
            if st and _canon(st.get("dir")) == _canon(DIR):
                _log("port %d is already held by this folder's launcher: exiting" % port)
                return 0
            # Launcher from ANOTHER folder (or old version without 'dir'): replaced. This launcher rules.
            _log("port %d is held by a launcher from another folder (%s): replacing it" % (port, (st or {}).get("dir", "old version")))
            if st:
                http_json("POST", port, "/quit", timeout=3)
                pid = st.get("pid")
                if isinstance(pid, int) and pid != os.getpid() and os.environ.get("WMB_NO_KILL") != "1":
                    kill_tree(pid)
            time.sleep(1.2)
    if server is None:
        _log("could not open the launcher port: it is used by another program")
        return 1
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        launcher.supervise()
    finally:
        server.shutdown()
        server.server_close()
    return 0


def ctl(action):
    """Terminal mode: --ctl start|stop|restart|status|killall|quit."""
    launcher = Launcher()
    port = launcher.launcher_port
    method = "GET" if action == "status" else "POST"
    data = http_json(method, port, "/" + action, timeout=25)
    if data is None:
        print("The launcher is not active (port %d)." % port)
        return 3
    if action == "status":
        print("Launcher active (pid %s, folder %s) - bridge: %s%s" % (
            data.get("pid"), data.get("dir"), "on" if data.get("bridge") else "off",
            " (off on purpose)" if data.get("paused") else ""))
    else:
        print("Done: %s." % action)
    return 0


if __name__ == "__main__":
    os.chdir(DIR)
    if len(sys.argv) >= 3 and sys.argv[1] == "--ctl":
        sys.exit(ctl(sys.argv[2]))
    sys.exit(run_forever(Launcher()))
