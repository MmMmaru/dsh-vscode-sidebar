// Vite build for the sidebar webview React app: src/webview -> media/.
// Library mode with fixed output names so sidebar-provider.ts can reference
// media/main.js and media/style.css without an HTML manifest.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/webview',
  define: {
    // Lib mode does not apply Vite's NODE_ENV define; markdown deps reference it.
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: '../../media',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'main.tsx',
      formats: ['es'],
      fileName: () => 'main.js',
      cssFileName: 'style',
    },
    rollupOptions: {
      output: {
        assetFileNames: '[name][extname]',
      },
    },
  },
})
