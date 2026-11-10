FROM python:3.11-slim

WORKDIR /app

# Install server dependencies
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the server files
COPY server/ ./server/

# Glama needs the container to behave as an MCP server (stdio).
# We run the bundled demo server, which speaks the MCP protocol over stdio.
CMD ["python", "server/examples/demo_mcp_server.py"]
