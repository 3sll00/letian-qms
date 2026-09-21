/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: '#2563EB',
          'blue-dark': '#1D4ED8',
          'blue-light': '#3B82F6',
        },
        sidebar: {
          bg: '#1E293B',
          active: '#203055',
          hover: '#2D3D5A',
        },
        industrial: {
          bg: '#F5F7FA',
          card: '#FFFFFF',
          surface: '#FFFFFF',
          border: '#E2E8F0',
          text: '#1E293B',
          muted: '#64748B',
          subtle: '#94A3B8',
          accent: '#2563EB',
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
