/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: 'var(--bg-canvas)',
          subtle: 'var(--bg-canvas-subtle)',
        },
        surface: {
          DEFAULT: 'var(--bg-surface)',
          hover: 'var(--bg-surface-hover)',
          raised: 'var(--bg-surface-raised)',
          overlay: 'var(--bg-surface-overlay)',
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        line: {
          DEFAULT: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
        },
        wxm: {
          DEFAULT: 'var(--accent-wxm)',
          hover: 'var(--accent-wxm-hover)',
          subtle: 'var(--accent-wxm-subtle)',
          border: 'var(--accent-wxm-border)',
        },
        muse: {
          DEFAULT: 'var(--accent-muse)',
          hover: 'var(--accent-muse-hover)',
          subtle: 'var(--accent-muse-subtle)',
          border: 'var(--accent-muse-border)',
        },
        mesh: {
          DEFAULT: 'var(--accent-mesh)',
          hover: 'var(--accent-mesh-hover)',
          subtle: 'var(--accent-mesh-subtle)',
          border: 'var(--accent-mesh-border)',
        },
        state: {
          success: 'var(--state-success)',
          'success-bg': 'var(--state-success-bg)',
          'success-border': 'var(--state-success-border)',
          warning: 'var(--state-warning)',
          'warning-bg': 'var(--state-warning-bg)',
          'warning-border': 'var(--state-warning-border)',
          danger: 'var(--state-danger)',
          'danger-bg': 'var(--state-danger-bg)',
          'danger-border': 'var(--state-danger-border)',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'sans-serif'],
        sans: ['var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      borderRadius: {
        card: '14px',
        pill: '9999px',
      },
      boxShadow: {
        card: '0 8px 32px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        'glow-wxm': '0 0 28px rgba(10, 132, 255, 0.18)',
        'glow-muse': '0 0 28px rgba(16, 185, 129, 0.18)',
        'glow-mesh': '0 0 28px rgba(103, 234, 148, 0.16)',
      },
    },
  },
  plugins: [],
};
