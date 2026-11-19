// PLACEHOLDER - the crop dialog (ui/crop.ts openImageCrop): image, frame, drag, pinch, zoom slider.
import { Modal } from './Modal';
import { CROP_MODAL_ID, cropRequest } from './crop';

export function ImageCropper() {
  return <Modal id={CROP_MODAL_ID} title={cropRequest()?.title}>{null}</Modal>;
}
