import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#7B4DFF',
          light: '#9B6DFF',
          dark: '#4D2E99',
        },
        text: {
          primary: '#000000',
          muted: '#6B7280',
        },
        card: {
          raised: '#F9FAFB',
          bg: '#FFFFFF',
        },
        status: {
          green: '#10B981',
        },
      },
      fontFamily: {
        sans: ['var(--font-nunito)', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0, 0, 0, 0.08)',
        'card-md': '0 4px 12px rgba(0, 0, 0, 0.1)',
        button: '0 2px 8px rgba(123, 77, 255, 0.3)',
      },
      borderRadius: {
        lg: '12px',
        md: '8px',
        sm: '4px',
      },
      keyframes: {
        'drop-in': {
          '0%': { opacity: '0', transform: 'translateY(-20px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fabric-wave': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'drop-in': 'drop-in 0.4s ease-out forwards',
        'fabric-wave': 'fabric-wave 0.5s ease-out forwards',
        'fade-in': 'fade-in 0.3s ease-out forwards',
      },
    },
  },
  plugins: [],
};

export default config;
