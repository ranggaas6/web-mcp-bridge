@echo off
rem Restarts the MCP bridge (closes the previous one even if it holds port 8180 and starts a new one in the background).
python "%~dp0mcp_ws_bridge.py" --config "%~dp0servers.json" --restart
pause
