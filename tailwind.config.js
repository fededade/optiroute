/** @type {import('tailwindcss').Config} */
// Sistema grafico di OptiRoute. I colori del marchio vengono dal logo:
// oro su antracite. Regola d'uso: l'antracite ("ink") è la struttura
// (navigazione, testi, azioni principali), l'oro ("brand") è l'accento e va
// usato con parsimonia (voce attiva, l'azione più importante della vista).
// I colori di stato sono quelli standard di Tailwind, sempre gli stessi:
//   confermata = emerald · proposta = sky · in attesa = amber
//   problema = rose · pilota/AI = violet · neutro/archivio = slate
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // antracite del logo: navigazione e superfici scure
        ink: {
          950: '#12141A',
          900: '#1B1E26',
          800: '#22252E',
          700: '#2E323D',
          600: '#434857',
          500: '#646A7B',
          400: '#8B91A1',
          300: '#B4B9C6',
        },
        // oro del logo: accento
        brand: {
          50: '#FCF7EA',
          100: '#F8ECCB',
          200: '#F0D898',
          300: '#E7C36A',
          400: '#DDAE49',
          500: '#CC9833',
          600: '#A97A26',
          700: '#855E1F',
          800: '#5F4318',
        },
        canvas: '#F4F5F7',   // fondo dell'area di lavoro
        surface: '#FFFFFF',  // schede e pannelli
        line: '#E4E7EC',     // bordi sottili
      },
      boxShadow: {
        card: '0 1px 2px rgba(18, 20, 26, 0.04), 0 1px 3px rgba(18, 20, 26, 0.05)',
        raised: '0 4px 12px -2px rgba(18, 20, 26, 0.08), 0 2px 4px -2px rgba(18, 20, 26, 0.05)',
        pop: '0 16px 40px -12px rgba(18, 20, 26, 0.25), 0 4px 12px -4px rgba(18, 20, 26, 0.10)',
      },
      borderRadius: {
        card: '14px',
        control: '10px',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': { from: { opacity: '0', transform: 'translateY(4px) scale(0.98)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'pop-in': 'pop-in 160ms ease-out',
      },
    },
  },
  plugins: [],
}
