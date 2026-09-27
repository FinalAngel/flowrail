// Serves a one-page stand-in for the docs site on 127.0.0.1:4791 (the demo's Docs site app).
const http = require('node:http');
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Paper Plane docs</title><h1>Paper Plane docs</h1><p>Started from the Runs page.</p>');
}).listen(4791, '127.0.0.1', () => console.log('docs on http://127.0.0.1:4791'));
