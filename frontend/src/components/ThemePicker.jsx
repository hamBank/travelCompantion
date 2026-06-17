import { THEMES } from '../themes.js'

export default function ThemePicker({ current, onChange }) {
  return (
    <div className="flex items-center gap-1.5" title="Choose theme">
      {THEMES.map(theme => (
        <button
          key={theme.id}
          onClick={() => onChange(theme.id)}
          title={theme.name}
          className="rounded-full transition-transform hover:scale-110 focus:outline-none"
          style={{
            width: '1.1rem',
            height: '1.1rem',
            background: theme.swatch,
            outline: current === theme.id
              ? `2px solid ${theme.swatch}`
              : '2px solid transparent',
            outlineOffset: '2px',
          }}
        />
      ))}
    </div>
  )
}
