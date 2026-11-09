// 악보, 필기, 녹음, 연습 음원을 파일 하나로 저장하고 되살립니다.
//
// 파일 구조: [표시 문자열][목록 길이 4바이트][목록 JSON][음원·PDF 등 내용]
// 큰 파일도 메모리에 한꺼번에 올리지 않도록 내용은 JSON 밖에 이어 붙입니다.
import * as db from './db.js';
import { saveBlob } from './platform.js';

const MAGIC = 'AKBOHAM-BACKUP-1\n';
const encoder = new TextEncoder();

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

function fileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function exportBackup(onProgress = () => {}) {
  const scores = await db.listScores();
  if (!scores.length) return { saved: false, count: 0 };

  const parts = [];
  let offset = 0;
  const addPart = (blob) => {
    parts.push(blob);
    const ref = { offset, size: blob.size, type: blob.type };
    offset += blob.size;
    return ref;
  };
  const withoutBlob = ({ blob, ...rest }) => ({ ...rest, content: addPart(blob) });

  const entries = [];
  for (const [i, score] of scores.entries()) {
    onProgress(i + 1, scores.length);
    const { thumb, ...info } = score;
    const data = await db.getFile(score.id);
    entries.push({
      score: info,
      thumb: thumb ? addPart(thumb) : null,
      file: data ? addPart(new Blob([data], { type: 'application/pdf' })) : null,
      notes: await db.listNotes(score.id),
      recordings: (await db.listRecordings(score.id)).map(withoutBlob),
      tracks: (await db.listTracks(score.id)).map((track) => (track.blob ? withoutBlob(track) : track)),
    });
  }

  const manifest = encoder.encode(JSON.stringify({ version: 1, createdAt: Date.now(), entries }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, manifest.length);
  const blob = new Blob([MAGIC, length, manifest, ...parts], { type: 'application/octet-stream' });
  const saved = await saveBlob(blob, `악보함-백업-${fileStamp()}.scorebackup`);
  return { saved, count: scores.length, size: blob.size };
}

export class BackupFormatError extends Error {}

async function readManifest(file) {
  const headerSize = encoder.encode(MAGIC).length;
  const head = await file.slice(0, headerSize + 4).arrayBuffer();
  if (head.byteLength < headerSize + 4
      || new TextDecoder().decode(head.slice(0, headerSize)) !== MAGIC) {
    throw new BackupFormatError('악보함 백업 파일이 아닙니다.');
  }
  const length = new DataView(head).getUint32(headerSize);
  const start = headerSize + 4;
  if (start + length > file.size) throw new BackupFormatError('백업 파일이 손상되었습니다.');
  try {
    const manifest = JSON.parse(await file.slice(start, start + length).text());
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('version');
    return { manifest, contentStart: start + length };
  } catch {
    throw new BackupFormatError('백업 파일이 손상되었습니다.');
  }
}

export async function restoreBackup(file, onProgress = () => {}) {
  const { manifest, contentStart } = await readManifest(file);

  // 고른 파일과의 연결이 끊겨도 남도록 내용을 복사해 저장합니다.
  const read = async (ref) => {
    const end = contentStart + ref.offset + ref.size;
    if (end > file.size) throw new BackupFormatError('백업 파일이 손상되었습니다.');
    return file.slice(contentStart + ref.offset, end).arrayBuffer();
  };
  const readBlob = async (ref) => new Blob([await read(ref)], { type: ref.type });
  const restoreItem = async ({ content, ...rest }) => (
    content ? { ...rest, blob: await readBlob(content) } : rest
  );

  const existing = await db.listScores();
  const ids = new Set(existing.map((s) => s.id));
  let added = 0;
  const skipped = [];

  for (const [i, entry] of manifest.entries.entries()) {
    onProgress(i + 1, manifest.entries.length);
    if (!entry.file) continue;
    // 같은 백업을 두 번 복원해도 악보가 겹치지 않습니다.
    if (ids.has(entry.score.id)) {
      skipped.push(entry.score.name);
      continue;
    }
    const data = await read(entry.file);
    let same = null;
    for (const score of existing) {
      if (score.size !== data.byteLength) continue;
      const stored = await db.getFile(score.id);
      if (stored && sameBytes(stored, data)) {
        same = score;
        break;
      }
    }
    if (same) {
      skipped.push(entry.score.name);
      continue;
    }
    const score = { ...entry.score, thumb: entry.thumb ? await readBlob(entry.thumb) : null };
    await db.restoreScore({
      score,
      data,
      notes: entry.notes ?? [],
      recordings: await Promise.all((entry.recordings ?? []).map(restoreItem)),
      tracks: await Promise.all((entry.tracks ?? []).map(restoreItem)),
    });
    existing.push(score);
    ids.add(score.id);
    added += 1;
  }
  return { added, skipped };
}
