#!/usr/bin/env python3
"""
install_service.py — Install the MCP bridge so it starts ON login by itself.

Run once. After that you only need the extension: the bridge will already be
listening in the background.

Other options:
    python server/install_service.py --purge       # remove auto-starts of OTHER copies of the project (Startup + tasks)
    python server/install_service.py --uninstall   # remove auto-start
    python server/install_service.py --dry-run     # show what it would do without touching anything

The MCP servers exposed here are defined in `server/servers.json`
(created automatically the first time; edit it and re-run this script).
"""
from __future__ import annotations

import argparse
import json
import shutil
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "mcp_ws_bridge.py"
CONFIG = HERE / "servers.json"
LOG = HERE / "bridge.log"
LAUNCHER = HERE / "start_bridge_loop.pyw"
NAME = "WebMCPBridge"


def default_config() -> dict:
    py = sys.executable
    return {
        "control_port": 8199,
        "launcher_port": 8198,
        "servers": [
            {"name": "astrax-mcp", "port": 8180, "command": [py, "-m", "astrax_mcp"], "disabled": True},
            {"name": "demo", "port": 8190, "command": [py, str(HERE / "examples" / "demo_mcp_server.py")]},
        ],
    }


def ensure_config(dry: bool) -> None:
    if CONFIG.exists():
        print(f"* Using existing configuration: {CONFIG}")
        return
    print(f"* Creating {CONFIG} (edit it to add more servers)")
    if not dry:
        CONFIG.write_text(json.dumps(default_config(), indent=2, ensure_ascii=False), encoding="utf-8")


def launcher_command(windowless: bool = False) -> list[str]:
    """Launcher command: this is what starts with Windows and keeps the bridge alive."""
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(LAUNCHER)]


def _ports() -> tuple[int, int]:
    """(bridge control port, launcher port) from servers.json."""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except Exception:
        cfg = {}
    return int(cfg.get("control_port", 8199)), int(cfg.get("launcher_port", 8198))


def _post(port: int, path: str, timeout: float = 4) -> bool:
    """POST without Origin header (the bridge and launcher accept it). True if it replied."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST", data=b"")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:
        return False


def start_launcher() -> None:
    """Leave the launcher running now: if one is running, ask it to restart; otherwise start it detached."""
    control, launcher = _ports()
    if _post(launcher, "/restart"):
        print("-> Launcher already running: bridge restarted.")
        return
    _post(control, "/shutdown")  # a loose bridge (without launcher) would hold the ports
    time.sleep(1.5)
    flags = 0
    if sys.platform == "win32":
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(launcher_command(windowless=True), cwd=str(HERE), creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("-> Launcher started in the background.")


def stop_launcher() -> None:
    control, launcher = _ports()
    _post(launcher, "/quit")
    _post(control, "/shutdown")

def restart_bridge() -> int:
    """Restart the bridge: stop the previous one (or an old bridge holding the ports) and start a fresh one in the background."""
    cmd = [sys.executable, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG), "--restart"]
    return subprocess.run(cmd).returncode


def bridge_command(windowless: bool = False) -> list[str]:
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG)]


# ───────────────────────── Windows ─────────────────────────

TASK_NAME = "WebMCPBridgeLauncher"          # own scheduled task (retries every minute if the launcher dies)
MARKERS = ("start_bridge_loop", "mcp_ws_bridge")


def _canon(path) -> str:
    return str(path or "").lower().replace("\\", "/").rstrip("/")


def _is_here(text: str) -> bool:
    """The text (command, script...) points to a file in THIS folder."""
    return (_canon(HERE) + "/") in _canon(text)


def _has_marker(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in MARKERS)


def _ps(script: str, timeout: int = 45) -> tuple[int, str]:
    res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                         capture_output=True, text=True, timeout=timeout, creationflags=0x08000000 if sys.platform == "win32" else 0)
    return res.returncode, (res.stdout or "").strip()


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def purge_foreign_autostarts(dry: bool) -> int:
    """Windows: remove bridge auto-starts that point to OTHER folders (the cause of the 'old bridge that never dies').
    Startup folder: back up and delete foreign files. Foreign scheduled tasks: DISABLE them (do not delete). Returns how many it touched."""
    if sys.platform != "win32":
        return 0
    touched = 0
    startup = windows_startup_file().parent
    backup = HERE / "_autostart_backup"
    if startup.exists():
        for item in sorted(startup.iterdir()):
            if not item.is_file():
                continue
            try:
                if item.suffix.lower() == ".lnk":
                    _, out = _ps("$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s); $s.TargetPath + ' ' + $s.Arguments" % _ps_quote(str(item)), 20)
                    text = out
                elif item.suffix.lower() in (".vbs", ".cmd", ".bat", ".ps1", ".js"):
                    text = item.read_text(encoding="utf-8-sig", errors="replace")
                else:
                    continue
            except Exception:
                continue
            if _has_marker(text) and not _is_here(text):
                print(f"* Foreign startup entry: {item.name} (points to another folder) -> backup and delete")
                touched += 1
                if not dry:
                    backup.mkdir(exist_ok=True)
                    shutil.copy2(item, backup / item.name)
                    item.unlink(missing_ok=True)
    code, out = _ps("Get-ScheduledTask | ForEach-Object { $a = ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)\" }) -join ' '; "
                    "if ($a -match 'start_bridge_loop|mcp_ws_bridge') { [pscustomobject]@{Name=$_.TaskName;Path=$_.TaskPath;Action=$a;State=[string]$_.State} } } | ConvertTo-Json -Compress")
    try:
        tasks = json.loads(out or "[]")
    except ValueError:
        tasks = []
    for task in ([tasks] if isinstance(tasks, dict) else tasks):
        if task.get("Name") == TASK_NAME or _is_here(task.get("Action", "")):
            continue
        print(f"* Foreign scheduled task: {task.get('Name')} ({task.get('Action', '')[:90]}) -> disabled")
        touched += 1
        if not dry and task.get("State") != "Disabled":
            _ps("Disable-ScheduledTask -TaskName %s -TaskPath %s | Out-Null" % (_ps_quote(task["Name"]), _ps_quote(task.get("Path") or "\\")))
    if not touched:
        print("* No auto-starts of other copies.")
    return touched


def register_task(dry: bool) -> None:
    """Own scheduled task: starts the launcher on login and retries it every minute if it dies. Extra safety net for the .vbs."""
    if sys.platform != "win32":
        return
    cmd = launcher_command(windowless=True)
    print(f"* Registering scheduled task {TASK_NAME} (retry every minute)")
    if dry:
        return
    script = (
        "$a = New-ScheduledTaskAction -Execute %s -Argument %s -WorkingDirectory %s; "
        "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; "
        "$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) "
        "-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew; "
        "Register-ScheduledTask -TaskName %s -Action $a -Trigger $t -Settings $s -Force | Out-Null"
    ) % (_ps_quote(cmd[0]), _ps_quote('"%s"' % cmd[1]), _ps_quote(str(HERE)), _ps_quote(TASK_NAME))
    code, out = _ps(script)
    if code != 0:
        print(f"  (could not register the task: {out[:160]}; the Startup folder auto-start still works)")


def unregister_task(dry: bool) -> None:
    if sys.platform == "win32" and not dry:
        _ps("Unregister-ScheduledTask -TaskName %s -Confirm:$false -ErrorAction SilentlyContinue" % _ps_quote(TASK_NAME), 20)


def windows_startup_file() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup" / f"{NAME}.vbs"


def install_windows(dry: bool) -> None:
    cmd = " ".join(f'""{part}""' for part in launcher_command(windowless=True))
    script = f'CreateObject("Wscript.Shell").Run "{cmd}", 0, False\n'
    target = windows_startup_file()
    purge_foreign_autostarts(dry)  # first remove auto-starts of other copies: only ONE should remain
    print(f"* Registering auto-start: {target}")
    if dry:
        register_task(dry)
        return
    target.write_text(script, encoding="utf-8")
    register_task(dry)
    start_launcher()  # start the launcher now (or restart it if running); the launcher starts the bridge


def uninstall_windows(dry: bool) -> None:
    target = windows_startup_file()
    print(f"* Removing {target}")
    if not dry:
        target.unlink(missing_ok=True)
        unregister_task(dry)
        stop_launcher()
        subprocess.run(["taskkill", "/F", "/FI", "WINDOWTITLE eq mcp_ws_bridge*"], capture_output=True)


# ───────────────────────── macOS ─────────────────────────

def mac_plist() -> Path:
    return Path.home() / "Library/LaunchAgents/com.webmcpbridge.plist"


def install_macos(dry: bool) -> None:
    args = "".join(f"<string>{a}</string>" for a in bridge_command())
    plist = (
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
        "<key>Label</key><string>com.webmcpbridge</string>"
        f"<key>ProgramArguments</key><array>{args}</array>"
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>"
    )
    print(f"* Registering LaunchAgent: {mac_plist()}")
    if dry:
        return
    mac_plist().parent.mkdir(parents=True, exist_ok=True)
    mac_plist().write_text(plist, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
    subprocess.run(["launchctl", "load", "-w", str(mac_plist())], check=True)


def uninstall_macos(dry: bool) -> None:
    print(f"* Removing {mac_plist()}")
    if not dry:
        subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
        mac_plist().unlink(missing_ok=True)


# ───────────────────────── Linux (systemd --user) ─────────────────────────

def linux_unit() -> Path:
    return Path.home() / ".config/systemd/user/web-mcp-bridge.service"


def install_linux(dry: bool) -> None:
    exec_start = " ".join(f'"{a}"' for a in bridge_command())
    unit = (
        "[Unit]\nDescription=Web MCP Bridge\n\n"
        f"[Service]\nExecStart={exec_start}\nRestart=always\nRestartSec=3\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    print(f"* Registering user systemd service: {linux_unit()}")
    if dry:
        return
    linux_unit().parent.mkdir(parents=True, exist_ok=True)
    linux_unit().write_text(unit, encoding="utf-8")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "web-mcp-bridge.service"], check=True)


def uninstall_linux(dry: bool) -> None:
    print(f"* Removing {linux_unit()}")
    if not dry:
        subprocess.run(["systemctl", "--user", "disable", "--now", "web-mcp-bridge.service"], capture_output=True)
        linux_unit().unlink(missing_ok=True)


# ───────────────────────── Main ─────────────────────────

def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # cp1252 consoles: symbols must not crash the script
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Install the MCP bridge as a start-on-login service.")
    parser.add_argument("--uninstall", action="store_true", help="Remove the auto-start")
    parser.add_argument("--dry-run", action="store_true", help="Show the steps without running them")
    parser.add_argument("--purge", action="store_true", help="Remove auto-starts of OTHER copies of the project (Startup + scheduled tasks) and exit")
    parser.add_argument("--restart", action="store_true", help="Restart the bridge now (closes the previous one even if it holds the ports)")
    args = parser.parse_args()

    if args.restart:
        return restart_bridge()
    if args.purge:
        n = purge_foreign_autostarts(args.dry_run)
        print(f"OK: {n} foreign auto-start(s) handled.")
        return 0

    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
    actions = {
        "windows": (install_windows, uninstall_windows),
        "macos": (install_macos, uninstall_macos),
        "linux": (install_linux, uninstall_linux),
    }[system]

    if args.uninstall:
        actions[1](args.dry_run)
        print("OK: auto-start removed.")
        return 0

    print("* Installing dependencies (websockets)...")
    if not args.dry_run:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(HERE / "requirements.txt")], check=True)
    ensure_config(args.dry_run)
    actions[0](args.dry_run)
    print("\nOK: done. The bridge runs in the background and will start automatically with your session.")
    print(f"  Logs: {LOG}")
    print("  Now open the extension popup: it should show the servers in green.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
