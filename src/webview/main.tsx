/** Webview entry: mount the React root. Vite lib-mode entry (media/main.js). */

// base.css MUST bundle before every component stylesheet: equal-specificity
// modifiers (e.g. .status-dot-done over base .status-dot) only win when they
// come later. (Root cause of the "unread dot never shows" bug: this import
// used to follow the App import, so base.css bundled last and its grey
// .status-dot background silently overrode the unread/waiting colors.)
import './styles/base.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root container')
createRoot(container).render(<App />)
