import { createRoot } from 'react-dom/client';
import App from './App.js';
import { PreviewPage } from './DesignSystem.js';
import { guardDrafts } from './draft-guard.js';
import './styles.css';
import './pixel.css';
const preview = new URLSearchParams(location.search).get('preview') === '1';
if (preview) document.body.classList.add('preview-body');
// Fenêtre de l'atelier seulement : les cadres de preview partagent le stockage.
else guardDrafts();
createRoot(document.getElementById('root')!).render(
  preview ? <PreviewPage /> : <App />,
);
