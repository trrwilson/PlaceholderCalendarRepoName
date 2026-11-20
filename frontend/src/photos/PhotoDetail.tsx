import { useEffect, type ReactNode } from 'react'

import { resolveCaption } from './captionLayout'
import { cameraName, exposureLine } from './photoFacts'
import type { PhotoItem } from './types'
import { photoUrl } from './usePhotoStream'

/**
 * "More details" for one photo, opened by tapping the middle of the Home photo
 * tile. Same dismissable modal grammar as the camera clip player (scrim tap,
 * ×, Escape). Display only: nothing here edits or deletes the photo. Rows with
 * no data are left out rather than shown empty.
 */
export function PhotoDetail({ photo, apiBaseUrl, onClose }: { photo: PhotoItem; apiBaseUrl: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const caption = resolveCaption(photo)
  const title = caption?.kind === 'caption' ? caption.text : null
  const camera = cameraName(photo)
  const settings = exposureLine(photo)
  const file = [formatType(photo.original_type), photo.width && photo.height ? `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}` : null, photo.original_bytes ? formatBytes(photo.original_bytes) : null].filter(Boolean).join(' · ')
  const tags = photo.tags ?? []

  return (
    <div className="clip-modal-scrim" role="presentation" onClick={onClose}>
      <section className="clip-modal photo-detail" role="dialog" aria-label="Photo details" onClick={(event) => event.stopPropagation()}>
        <button className="close-detail" onClick={onClose} aria-label="Close photo details">×</button>
        <div className="photo-detail-media">
          <img src={photoUrl(apiBaseUrl, photo.id, photo.version)} alt={caption?.text ?? photo.name} draggable={false} />
        </div>
        <div className="photo-detail-info">
          <p className="section-kicker">Photo</p>
          {title ? <h2>{title}</h2> : <h2 className="photo-detail-untitled">{caption?.text ?? 'Untitled photo'}</h2>}
          <dl className="photo-detail-facts">
            <Fact label="Taken">{photo.taken_at ? formatWhen(photo.taken_at) : <span className="photo-detail-muted">Date unknown</span>}</Fact>
            {photo.added_at && <Fact label="Added">{new Date(photo.added_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</Fact>}
            {(photo.place_detail || coordinates(photo)) && <Fact label="Place">{photo.place_detail}{coordinates(photo) && <small>{coordinates(photo)}</small>}</Fact>}
            {(camera || settings) && <Fact label="Camera">{camera}{settings && <small>{settings}</small>}</Fact>}
            {tags.length > 0 && <Fact label="Tags"><span className="photo-detail-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</span></Fact>}
            <Fact label="File">{photo.name}{file && <small>{file}</small>}</Fact>
          </dl>
          <div className="detail-actions"><button onClick={onClose}>Done</button></div>
        </div>
      </section>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="photo-detail-fact"><dt>{label}</dt><dd>{children}</dd></div>
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function coordinates(photo: PhotoItem): string | null {
  if (photo.latitude == null || photo.longitude == null) return null
  const lat = `${Math.abs(photo.latitude).toFixed(4)}° ${photo.latitude >= 0 ? 'N' : 'S'}`
  const lon = `${Math.abs(photo.longitude).toFixed(4)}° ${photo.longitude >= 0 ? 'E' : 'W'}`
  return `${lat}, ${lon}`
}

function formatType(mime: string | null | undefined): string | null {
  return mime ? mime.replace(/^image\//, '').toUpperCase() : null
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}
