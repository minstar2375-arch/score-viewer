// 공개 사이트와 Play 스토어 앱의 차이를 한곳에 모읍니다.

// Play 스토어 앱은 앱 안의 파일을 이 주소로 엽니다.
export const isStoreApp = location.hostname === 'appassets.androidplatform.net';

// YouTube 정책상 유료 앱에는 내장 플레이어를 넣지 않습니다.
export const youTubeEnabled = !isStoreApp;

const CHUNK_BYTES = 512 * 1024;
let saveCounter = 0;
const pendingTargets = new Map();

// 안드로이드 앱이 사용자가 고른 저장 위치의 결과를 알려 줄 때 호출합니다.
window.onNativeSaveTarget = (id, ok) => {
  pendingTargets.get(id)?.(ok);
  pendingTargets.delete(id);
};

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(text);
}

async function saveThroughApp(bridge, blob, name) {
  saveCounter += 1;
  const id = String(saveCounter);
  const chosen = new Promise((resolve) => pendingTargets.set(id, resolve));
  bridge.beginSave(id, name, blob.type || 'application/octet-stream');
  if (!(await chosen)) return false;
  try {
    for (let start = 0; start < blob.size; start += CHUNK_BYTES) {
      const part = await blob.slice(start, start + CHUNK_BYTES).arrayBuffer();
      if (!bridge.writeChunk(id, toBase64(part))) throw new Error('파일에 쓰지 못했습니다');
    }
  } catch (err) {
    bridge.abortSave(id);
    throw err;
  }
  if (!bridge.endSave(id)) throw new Error('파일을 저장하지 못했습니다');
  return true;
}

// 파일을 기기에 저장합니다. 사용자가 취소하면 false를 돌려줍니다.
export async function saveBlob(blob, name) {
  if (window.AndroidApp) return saveThroughApp(window.AndroidApp, blob, name);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}
