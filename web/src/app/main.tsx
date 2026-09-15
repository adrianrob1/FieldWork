import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './global.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
