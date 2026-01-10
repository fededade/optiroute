import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css'; // Assicurati di creare questo file vuoto o con le direttive tailwind

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);