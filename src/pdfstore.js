// ─────────────────────────────────────────────────────────────
// Device-local PDF files for the reader, keyed by paper id.
// IndexedDB because PDFs are megabytes: localStorage can't hold
// them and ss2_pool must stay light. Like ss2_pool, this store is
// intentionally NOT synced — upload the file on the device you
// read on.
// ─────────────────────────────────────────────────────────────

const DB_NAME = "ss2-pdfs";
const STORE = "pdfs";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePdf(paperId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, paperId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPdf(paperId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(paperId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
