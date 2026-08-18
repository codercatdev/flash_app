import type { GalleryImage } from "../api";

export function Gallery({
  images,
  emptyMessage,
  showWinner = false,
}: {
  images: GalleryImage[];
  emptyMessage: string;
  showWinner?: boolean;
}) {
  if (images.length === 0) {
    return <div className="card empty-state muted">{emptyMessage}</div>;
  }

  return (
    <div className="gallery">
      {images.map((img) => (
        <figure key={img.id} className="card tile">
          <img src={img.url} alt={img.prompt} loading="lazy" />
          <figcaption>
            <p>{img.prompt}</p>
            <div className="badges">
              <span className={`badge model ${img.model}`}>{img.label}</span>
              {showWinner && img.won && <span className="badge warm">picked</span>}
              <span className="badge gpu">{img.generateMs}ms</span>
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
