import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fbrx/ui/styles.css';
import './virtual.css';
import { ToastProvider } from '@fbrx/ui';
import { App } from './app';

try {
  const theme = localStorage.getItem('fbrx.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
