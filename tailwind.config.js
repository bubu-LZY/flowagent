/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
        },
        agent: {
          designer: '#8b5cf6',
          architect: '#3b82f6',
          reviewer: '#10b981',
          documenter: '#f59e0b',
          executor: '#ec4899',
          newbie: '#94a3b8',
        }
      },
    },
  },
  plugins: [],
}
