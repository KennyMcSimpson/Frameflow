const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('bitmaprenderer');
let queue = Promise.resolve();

async function encodeFrame({ id, bitmap, quality }) {
  try {
    if (!context) throw new Error('无法创建画面编码画布');
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    context.transferFromImageBitmap(bitmap);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const jpeg = await blob.arrayBuffer();
    self.postMessage({ id, jpeg }, [jpeg]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || '画面编码失败' });
  } finally {
    bitmap.close();
  }
}

self.onmessage = ({ data }) => {
  queue = queue.then(() => encodeFrame(data));
};
