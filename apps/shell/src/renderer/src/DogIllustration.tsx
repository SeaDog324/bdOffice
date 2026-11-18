import welcome from './assets/dog/dog-welcome-v2.png'
import memory from './assets/dog/dog-memory-v1.png'
import search from './assets/dog/dog-search-v1.png'
import inspect from './assets/dog/dog-inspect-v1.png'
import './dog-illustrations.css'

/** Decorative scenes never change or imply an Agent/task execution state. */
const scenes = { welcome, memory, search, inspect } as const
export type DogScene = keyof typeof scenes

export function DogIllustration({
  scene,
  className = '',
}: {
  scene: DogScene
  className?: string
}) {
  return (
    <div className={`dog-illustration ${className}`} aria-hidden="true" data-scene={scene}>
      <img
        className="dog-illustration-image"
        src={scenes[scene]}
        width={512}
        height={512}
        alt=""
        draggable={false}
        decoding="async"
      />
    </div>
  )
}
