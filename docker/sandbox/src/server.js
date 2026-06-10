// docker/sandbox/src/server.js
// Stub Unix socket listener. Real JSON-RPC protocol implemented in Phase 4.
// This stub allows the container to build and start without crashing.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const socketFlagIndex = args.indexOf('--socket');
const socketPath = socketFlagIndex !== -1 ? args[socketFlagIndex + 1] : '/run/sandbox/op.sock';

// Remove stale socket file from previous run.
try { fs.unlinkSync(socketPath); } catch {}

// Ensure parent directory exists.
fs.mkdirSync(path.dirname(socketPath), { recursive: true });

const server = net.createServer((socket) => {
  console.log('[sandbox-vm] client connected');
  socket.on('data', (data) => {
    // Stub: echo back with error until real implementation is in place.
    const response = JSON.stringify({
      id: null,
      error: { code: -32603, message: 'sandbox-vm not yet implemented' }
    });
    socket.write(response + '\n');
  });
  socket.on('end', () => console.log('[sandbox-vm] client disconnected'));
});

server.listen(socketPath, () => {
  console.log(`[sandbox-vm] listening on ${socketPath}`);
});

process.on('SIGTERM', () => {
  console.log('[sandbox-vm] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
