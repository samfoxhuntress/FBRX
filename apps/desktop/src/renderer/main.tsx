import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fbrx/ui/styles.css';
import './desktop.css';
import './theme.css';
import { ToastProvider } from '@fbrx/ui';
import { App } from './app';
import { bridge } from './client';

// Platform tweaks in CSS (for example room for the macOS window buttons).
document.documentElement.dataset.platform = bridge.platform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
