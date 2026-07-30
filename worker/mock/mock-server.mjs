#!/usr/bin/env node
// Trivial preview stand-in for selftest: PREVIEW_CMD="node mock/mock-server.mjs --port"
// (the worker appends the chosen port). Serves 200 "ok" until killed.
import http from 'node:http';

const i = process.argv.indexOf('--port');
const port = Number(process.argv[i + 1] ?? 0);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: mock-server.mjs --port <port>');
  process.exit(2);
}

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  })
  .listen(port, '127.0.0.1', () => console.log(`mock preview listening on ${port}`));
