import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fbrx/ui/styles.css';
import './desktop.css';
import { ToastProvider } from '@fbrx/ui';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
