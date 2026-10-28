import { createRoot } from 'react-dom/client';
import App from './App.js';
import { PreviewPage } from './DesignSystem.js';
import './styles.css';
import './pixel.css';
const preview = new URLSearchParams(location.search).get('preview') === '1';
if (preview) document.body.classList.add('preview-body');
createRoot(document.getElementById('root')!).render(
  preview ? <PreviewPage /> : <App />,
);
