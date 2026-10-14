import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the app from /inventory-netting-optimizer/.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/inventory-netting-optimizer/' : '/',
})
