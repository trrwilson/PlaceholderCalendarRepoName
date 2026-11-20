import type { PhotoItem } from './types'

// Human-readable camera facts for the photo details view.

/** "Samsung SM-G960U": the make is dropped when the model already starts with it. */
export function cameraName(photo: PhotoItem): string | null {
  const make = photo.camera_make?.trim() ?? ''
  const model = photo.camera_model?.trim() ?? ''
  if (!make && !model) return null
  const niceMake = make ? make.charAt(0).toUpperCase() + make.slice(1).toLowerCase() : ''
  if (!model) return niceMake
  return model.toLowerCase().startsWith(make.toLowerCase()) && make ? model : `${niceMake} ${model}`.trim()
}

/** "ƒ/1.7 · 1/120 s · ISO 50 · 4.3 mm", leaving out whatever the photo lacks. */
export function exposureLine(photo: PhotoItem): string | null {
  const parts: string[] = []
  if (photo.f_number) parts.push(`ƒ/${trim(photo.f_number)}`)
  if (photo.exposure_seconds) parts.push(photo.exposure_seconds >= 1 ? `${trim(photo.exposure_seconds)} s` : `1/${Math.round(1 / photo.exposure_seconds)} s`)
  if (photo.iso) parts.push(`ISO ${photo.iso}`)
  if (photo.focal_length_mm) parts.push(`${trim(photo.focal_length_mm)} mm`)
  return parts.length ? parts.join(' · ') : null
}

function trim(value: number): string {
  return String(Math.round(value * 10) / 10)
}
