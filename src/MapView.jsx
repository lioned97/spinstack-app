// ─────────────────────────────────────────────────────────────
// Travel map — Leaflet + OpenStreetMap tiles, pinning harvested
// places that carry coordinates (Wikivoyage/Wikipedia items).
// Lazy-loaded so Leaflet stays out of the main bundle. Markers use
// a divIcon (pure CSS dot) so no image assets are needed.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default function MapView({ items, onClose }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: true, attributionControl: true });
    mapRef.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const icon = L.divIcon({
      className: "map-pin",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -10],
    });

    const bounds = [];
    for (const p of items) {
      const [lat, lon] = p.coordinates;
      bounds.push([lat, lon]);
      L.marker([lat, lon], { icon })
        .addTo(map)
        .bindPopup(
          `<b>${esc(p.title)}</b><br/><span style="font-size:11px">${esc(p.venue || "")}</span>` +
            (p.url ? `<br/><a href="${esc(p.url)}" target="_blank" rel="noreferrer">Open page →</a>` : "")
        );
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
    else map.setView([32, 35], 5);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="map-overlay">
      <header className="reader-hdr">
        <button onClick={onClose} aria-label="Close map">
          <X size={18} color="var(--dim)" />
        </button>
        <span className="reader-title">Places map</span>
        <span className="spacer" />
        <span className="reader-pages-lbl">
          {items.length} pinned
        </span>
      </header>
      <div ref={divRef} className="map-canvas" />
    </div>
  );
}
