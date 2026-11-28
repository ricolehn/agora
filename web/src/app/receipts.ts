// Receipts of bookings and requests: uploaded with the session (HEIC converted, large photos recompressed) and fetched
// as object URLs.
import { auth, fetchWithTimeout, API } from './api';
import { compressImage, convertHeic, toFormData } from './util';

/** Uploads a receipt (HEIC converted, large images recompressed) and resolves to the stored file name. */
export async function uploadReceipt(file: File, transactionName: string, transactionDate: string): Promise<string> {
  if (!auth.currentUser) throw new Error('Not authenticated');
  const token = await auth.currentUser.getIdToken();
  let uploadFile = (await convertHeic(file, 0.8)) as File;
  const compressible = uploadFile.type.startsWith('image/') && uploadFile.type !== 'image/gif' && uploadFile.type !== 'image/svg+xml';
  if (compressible && uploadFile.size >= 500 * 1024) {
    try {
      uploadFile = await compressImage(uploadFile, uploadFile.size > 2 * 1024 * 1024 ? 0.65 : 0.75);
    } catch (e) {
      console.error('Compression failed:', e);
    }
  }
  const res = await fetchWithTimeout(`${API}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: toFormData({ name: transactionName, date: transactionDate, receipt: uploadFile })
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.statusText);
  return ((await res.json()) as { filename: string }).filename;
}

/** Uploads several receipts; resolves to the JSON list of their file names (as records store them). */
export async function uploadAll(files: File[], name: string, date: string): Promise<string> {
  const filenames: string[] = [];
  for (const file of files) filenames.push(await uploadReceipt(file, name, date));
  return JSON.stringify(filenames);
}

/** A receipt as an object URL (HEIC shown as JPEG). The caller revokes it when it is no longer shown. */
export async function fetchReceiptImage(filename: string): Promise<string> {
  if (!auth.currentUser) throw new Error('Not authenticated');
  const token = await auth.currentUser.getIdToken();
  const res = await fetchWithTimeout(`${API}/receipts/${encodeURIComponent(filename)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Fetch failed: ' + res.statusText);
  return URL.createObjectURL((await convertHeic(await res.blob(), 0.8, filename)) as Blob);
}
