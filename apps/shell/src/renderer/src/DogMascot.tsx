import { DOG_MOOD_FRAMES, DOG_MOOD_LABELS, type DogMood } from './dog-assets'

export interface DogMascotProps {
  mood: DogMood
  /** Set to false for decorative uses that should not add a visible label. */
  label?: string | false
  className?: string
  compact?: boolean
  /** Keep the event frame static while retaining the gentle CSS float animation. */
  animate?: boolean
  /** Explicit event frame; when omitted, the mood's canonical frame is used. */
  frame?: string
}

export function DogMascot({
  mood,
  label,
  className = '',
  compact = false,
  animate = true,
  frame: explicitFrame,
}: DogMascotProps) {
  const frame = explicitFrame ?? DOG_MOOD_FRAMES[mood]
  const classes = [
    'dog-mascot',
    `dog-mascot-${mood}`,
    compact ? 'dog-mascot-compact' : '',
    animate ? '' : 'dog-mascot-static',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} data-mood={mood}>
      <img
        key={frame}
        className="dog-mascot-image"
        src={frame}
        alt=""
        aria-hidden="true"
      />
      {label !== false ? (
        <span className="dog-mascot-label">{label ?? DOG_MOOD_LABELS[mood]}</span>
      ) : null}
    </div>
  )
}
