import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import GestionaleGate from './Components/GestionaleGate';
import { isFramed } from './services/gestionaleHost';
import './index.css'; // Assicurati di creare questo file vuoto o con le direttive tailwind

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Aperta da sola: l'app di sempre. Dentro un'altra pagina (iframe): solo se
// è il gestionale autorizzato, con l'accesso del gestionale.
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {isFramed(window)
      ? <GestionaleGate>{ctx => <App gestionale={ctx} />}</GestionaleGate>
      : <App />}
  </React.StrictMode>
);
