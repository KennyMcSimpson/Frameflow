async function encodeOnRenderer(canvas, quality) {
  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('画面编码失败（显存可能不足）');
  return blob.arrayBuffer();
}

/** JPEG 在渲染线程上会等待 Chromium 的空闲时间片，导出时交给独立的 Worker。 */
export async function createJpegEncoder(canvas) {
  if (typeof Worker !== 'function' || typeof canvas.transferToImageBitmap !== 'function') {
    return { encode: (quality) => encodeOnRenderer(canvas, quality), dispose() {} };
  }

  // Vite 将 Worker 内联为 Blob，使打包后的 file:// 页面也能启动它。
  const { default: JpegWorker } = await import('./jpegEncoder.worker.js?worker&inline');
  const worker = new JpegWorker();
  const pending = new Map();
  let seq = 0;
  let failure = null;

  function dispose(error = new Error('画面编码已停止')) {
    if (failure) return;
    failure = error;
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  worker.onmessage = ({ data: { id, jpeg, error } }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(jpeg);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    dispose(new Error('画面编码线程出错'));
  };
  worker.onmessageerror = () => dispose(new Error('无法读取编码后的画面'));

  function encode(quality) {
    if (failure) return Promise.reject(failure);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const bitmap = canvas.transferToImageBitmap();
      try {
        worker.postMessage({ id, bitmap, quality }, [bitmap]);
        pending.set(id, { resolve, reject });
      } catch (error) {
        bitmap.close();
        reject(error);
      }
    });
  }

  return { encode, dispose };
}
