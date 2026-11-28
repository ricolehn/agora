// Cropping a picture before it is uploaded: profile pictures (square, 256x256) and event covers (16:9, 1280x720).
// The dialog with the image, the frame, dragging, pinching and the zoom slider is ui/ImageCropper.tsx (mounted at the
// root by the shell); this is how features ask for a crop.
import { createSignal } from 'solid-js';
import { openModal } from '../app/modals';
import { convertHeic, loadImage, readAsDataUrl } from '../app/util';

export type CropShape = 'square' | 'wide';
export interface CropRequest {
  file: File;
  shape: CropShape;
  /** Dialog title and subtitle (translated). square: the subtitle replaces the hint under the slider. */
  title: string;
  subtitle?: string;
  /** Text of the confirm button (translated); "Save" (square) or "Apply crop" (wide) by default. */
  confirmLabel?: string;
  /** Called with the cropped JPEG when the person confirms; the dialog shows its busy state until it resolves and
   *  closes when it resolves to true (false: stays open, e.g. the upload failed). */
  onConfirm: (blob: Blob) => Promise<boolean>;
}

/** The picture to crop: a data URL and its size in pixels. */
export interface CropSource {
  src: string;
  width: number;
  height: number;
}

export const CROP_MODAL_ID = 'image-crop-modal';
const [cropRequest, setCropRequest] = createSignal<CropRequest | null>(null);
const [cropSource, setCropSource] = createSignal<CropSource | null>(null);
export { cropRequest, cropSource };

async function prepare(request: CropRequest) {
  const square = request.shape === 'square';
  // iPhone photos (HEIC) become JPEG first
  const file = await convertHeic(request.file, square ? 0.9 : 0.85, request.file.name || 'image');
  const src = await readAsDataUrl(file);
  const image = await loadImage(src).catch(() => null);
  // A picture the browser cannot read: the profile crop does not open; a cover is cropped as 800x600 (as before)
  const size = image ? [image.naturalWidth, image.naturalHeight] : square ? null : [800, 600];
  if (!size) return;
  setCropSource({ src, width: size[0], height: size[1] });
  setCropRequest(request);
  openModal(CROP_MODAL_ID);
}

/** Opens the crop dialog for [request.file] once the picture is ready (a HEIC photo is converted first). */
export function openImageCrop(request: CropRequest) {
  void prepare(request);
}
