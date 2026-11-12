import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'pdf', test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 20 },
            { name: 'editor', test: /node_modules[\\/](?:@codemirror|@lezer|codemirror|style-mod|w3c-keyname|crelt)[\\/]/, priority: 20 },
            { name: 'math', test: /node_modules[\\/]katex[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
