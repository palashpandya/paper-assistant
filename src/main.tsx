import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PdfTab } from './PdfTab';
import { isPdfTab } from './tabChannel';
import './styles.css';
import './themes.css';
import { applyTheme, savedTheme } from './themes';

applyTheme(savedTheme());

createRoot(document.getElementById('root')!).render(isPdfTab ? <PdfTab /> : <App />);
