import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './connection';
import { receive, setStatus } from './store';
import './styles.css';

connect({ onMessage: receive, onStatus: setStatus });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
