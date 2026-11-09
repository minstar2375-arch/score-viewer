// 녹음을 MP3로 바꿉니다. 긴 녹음도 화면이 멈추지 않도록 별도 작업 공간에서 실행합니다.
importScripts('../vendor/lamejs/lame.min.js');

const BLOCK = 1152;

self.onmessage = ({ data: { samples, sampleRate, kbps } }) => {
  try {
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const parts = [];
    const block = new Int16Array(BLOCK);
    for (let start = 0; start < samples.length; start += BLOCK) {
      const end = Math.min(samples.length, start + BLOCK);
      for (let i = start; i < end; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        block[i - start] = value < 0 ? value * 32768 : value * 32767;
      }
      const encoded = encoder.encodeBuffer(end - start === BLOCK ? block : block.subarray(0, end - start));
      if (encoded.length) parts.push(new Uint8Array(encoded));
    }
    const last = encoder.flush();
    if (last.length) parts.push(new Uint8Array(last));
    self.postMessage({ blob: new Blob(parts, { type: 'audio/mpeg' }) });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
