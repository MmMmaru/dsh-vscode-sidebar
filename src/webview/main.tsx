/** Webview entry: mount the React root. Vite lib-mode entry (media/main.js). */

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root container')
createRoot(container).render(<App />)
