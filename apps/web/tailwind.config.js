/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        industrial: {
          bg: '#0B1120',
          card: '#111827',
          surface: '#1E293B',
          border: '#334155',
          text: '#F8FAFC',
          muted: '#94A3B8',
          subtle: '#64748B',
          accent: '#0284C7',
          primary: '#2563EB',
          success: '#10B981',
          warning: '#F59E0B',
          danger: '#EF4444',
          cyan: '#06B6D4',
        }
      }
    },
  },
  plugins: [],
}
