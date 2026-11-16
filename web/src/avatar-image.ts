export function cropSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

const loadImage = (file: Blob): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
  image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The image could not be decoded.")); };
  image.src = url;
});

const decodeImage = async (file: Blob): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Some browsers recognise the file but cannot decode it through this API.
    }
  }
  return loadImage(file);
};

const encode = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob | null>((resolve) => {
  canvas.toBlob(resolve, type, .85);
});

export async function squareAvatar(file: Blob, size = 256): Promise<Blob> {
  const image = await decodeImage(file);
  const width = "naturalWidth" in image ? image.naturalWidth : image.width;
  const height = "naturalHeight" in image ? image.naturalHeight : image.height;
  const crop = cropSquare(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    if ("close" in image) image.close();
    throw new Error("The image could not be drawn.");
  }
  context.drawImage(image, crop.sx, crop.sy, crop.side, crop.side, 0, 0, size, size);
  if ("close" in image) image.close();

  const webp = await encode(canvas, "image/webp");
  if (webp?.type === "image/webp") return webp;
  const jpeg = await encode(canvas, "image/jpeg");
  if (!jpeg) throw new Error("The image could not be encoded.");
  return jpeg;
}
