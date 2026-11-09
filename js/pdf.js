import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

const asset = (path) => new URL(`../vendor/pdfjs/${path}`, import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

// PDF.js는 넘겨받은 데이터를 워커로 옮겨 원본 버퍼를 비우므로, 복사본을 넘깁니다.
export function loadPdf(buffer) {
  return pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)),
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    isEvalSupported: false,
  }).promise;
}

export async function makeThumbnail(doc, width = 360) {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  canvas.width = 0;
  return blob;
}
