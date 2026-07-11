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

// Write a length-prefixed frame matching the client protocol defined in
// unix-socket-client.ts §7.1: [4-byte BE uint32 length][JSON bytes]['\n']
function writeFrame(socket, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body, Buffer.from('\n')]));
}

const server = net.createServer((socket) => {
  console.log('[sandbox-vm] client connected');

  let readBuffer = Buffer.alloc(0);
  const HEADER_BYTES = 4;

  socket.on('data', (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);

    // Parse all complete frames from the read buffer before replying.
    while (readBuffer.length >= HEADER_BYTES) {
      const messageLength = readBuffer.readUInt32BE(0);
      const totalFrame = HEADER_BYTES + messageLength + 1; // +1 for '\n'
      if (readBuffer.length < totalFrame) break;

      const jsonBytes = readBuffer.slice(HEADER_BYTES, HEADER_BYTES + messageLength);
      readBuffer = readBuffer.slice(totalFrame);

      let request;
      try {
        request = JSON.parse(jsonBytes.toString('utf8'));
      } catch {
        console.error('[sandbox-vm] failed to parse request frame');
        continue;
      }

      const id = request.id ?? null;
      const method = request.method ?? 'unknown';

      if (method === 'ping') {
        writeFrame(socket, {
          id,
          status: 'ok',
          result: { pong: true, runCount: 0 },
          meta: { durationMs: 0, memoryPeakMb: 0, exitCode: 0, lineCount: 0 },
        });
        continue;
      }

      if (method === 'drain') {
        writeFrame(socket, {
          id,
          status: 'ok',
          result: { drainedCount: 0, timedOutCount: 0 },
          meta: { durationMs: 0, memoryPeakMb: 0, exitCode: 0, lineCount: 0 },
        });
        continue;
      }

      writeFrame(socket, {
        id,
        status: 'error',
        error: { code: 'NOT_IMPLEMENTED', message: `sandbox-vm method '${method}' not yet implemented` },
        meta: { durationMs: 0, memoryPeakMb: 0, exitCode: 1, lineCount: 0 },
      });
    }
  });

  socket.on('end', () => console.log('[sandbox-vm] client disconnected'));
});

server.listen(socketPath, () => {
  // The execution service runs as a different UID (1001) than this sandbox
  // process (1002). Connecting to a Unix socket requires write permission on the
  // socket file, which the default 0755 creation mode denies to other users.
  // The execution container's UID (1001) is in neither the owner nor the
  // sandbox group (1002), so relax to 0666. The socket still lives on an
  // isolated volume reachable only by these two containers on the sandbox
  // network, so widening file-mode bits does not broaden real exposure.
  try { fs.chmodSync(socketPath, 0o666); } catch {}
  console.log(`[sandbox-vm] listening on ${socketPath}`);
});

process.on('SIGTERM', () => {
  console.log('[sandbox-vm] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
