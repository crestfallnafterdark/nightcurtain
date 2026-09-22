import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';
import fs from 'fs';
import path from 'path';

function telemetryPlugin() {
  return {
    name: 'telemetry-logger',
    configureServer(server) {
      server.middlewares.use('/api/telemetry', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', () => {
            const logLine = `[${new Date().toISOString()}] ${body}\n`;
            fs.appendFileSync(path.resolve('telemetry.log'), logLine);
            res.statusCode = 200;
            res.end('ok');
          });
        }
      });
    }
  }
}

export default defineConfig({
  plugins: [wasm(), svelte(), telemetryPlugin()],
  resolve: {
    alias: {
      '$lib': path.resolve('./src/lib')
    }
  },
  build: {
    target: 'esnext'
  },
  define: {
    'process.env': {},
    'process.platform': JSON.stringify('browser'),
    'process.version': JSON.stringify(''),
    'process.arch': JSON.stringify('x64'),
    global: 'globalThis'
  }
});
