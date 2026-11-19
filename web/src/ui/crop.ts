// Cropping a picture before it is uploaded: profile pictures (square, 256x256) and event covers (16:9, 1280x720).
// The dialog with the image, the frame, dragging, pinching and the zoom slider is ui/ImageCropper.tsx (mounted at the
// root by the shell); this is how features ask for a crop.
import { createSignal } from 'solid-js';
import { openModal } from '../app/modals';

export type CropShape = 'square' | 'wide';
export interface CropRequest {
  file: File;
  shape: CropShape;
  /** Dialog title and subtitle (translated). */
  title: string;
  subtitle?: string;
  /** Text of the confirm button (translated); "Apply" by default. */
  confirmLabel?: string;
  /** Called with the cropped JPEG when the person confirms; the dialog shows its busy state until it resolves and
   *  closes when it resolves to true (false: stays open, e.g. the upload failed). */
  onConfirm: (blob: Blob) => Promise<boolean>;
}

export const CROP_MODAL_ID = 'image-crop-modal';
const [cropRequest, setCropRequest] = createSignal<CropRequest | null>(null);
export { cropRequest };

/** Opens the crop dialog for [request.file]. */
export function openImageCrop(request: CropRequest) {
  setCropRequest(request);
  openModal(CROP_MODAL_ID);
}
